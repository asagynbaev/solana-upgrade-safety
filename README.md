# solana-upgrade-safety

[![CI](https://github.com/asagynbaev/solana-upgrade-safety/actions/workflows/ci.yml/badge.svg)](https://github.com/asagynbaev/solana-upgrade-safety/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**A pre-upgrade safety gate for live Solana programs.** It catches the single most
expensive class of mistake when upgrading a program that already has accounts
on-chain: **silently bricking those accounts by changing the data layout.**

It's **schema-breaking-change detection for on-chain account layouts** — what
[Buf](https://buf.build) does for protobuf, this does for Borsh / zero-copy Solana
accounts. Given the old (on-chain) and new builds, it tells you at the field level
whether the upgrade is `SAFE`, needs a migration, or will brick existing accounts —
and **exits non-zero so it gates CI**.

Built as a drop-in skill for the [Solana AI Kit](https://github.com/solanabr/solana-ai-kit)
(Claude Code / Codex / any agent). MIT licensed and progressive-loading; the core
differ has zero npm dependencies (it imports only `node:fs`) and just needs `tsx`
to execute the TypeScript.

---

## See it catch a bricking upgrade (30 seconds)

The bundled fixtures are a `Vault` account and two candidate upgrades. No setup
beyond `tsx`:

```bash
cd scripts && npm install   # one-time: installs tsx
# v2 inserts `paused: bool` in the MIDDLE of the struct — it compiles green and a
# fresh devnet account looks fine:
npx tsx layout-diff.ts ../examples/vault.v1.idl.json ../examples/vault.v2.idl.json
```

```text
Account layout diff  vault → vault

● BREAKING  Vault
    • field at index 2 changed identity "totalDeposited" ("u64") -> "paused" ("bool") — insertion/removal/reorder; everything from index 2 reads wrong

Summary: 1 breaking, 0 unknown, 0 need migration, 0 review, 0 safe

✗ Upgrade is UNSAFE for existing accounts. Do not ship without a migration plan.
```

Exit code **1** — it never passes CI. Without the gate that upgrade ships, and every
existing `Vault` then reads its 8-byte `totalDeposited` balance starting at a 1-byte
`paused` flag, with every field after it shifted: silent corruption a `withdraw` can
turn into a drain. The other two fixtures show the safe paths:

```bash
npx tsx layout-diff.ts ../examples/vault.v1.idl.json ../examples/vault.v3.idl.json  # NEEDS_MIGRATION (tail append) — exit 0
npx tsx layout-diff.ts ../examples/vault.v1.idl.json ../examples/vault.v1.idl.json  # SAFE — exit 0
```

> **Tested.** A regression suite (`npm test`, 90+ assertions — including the
> same-type mid-insert class that byte-coincidentally survives deserialization but
> scrambles every field) and an integration suite (`npm run test:integration`) run
> on CI, asserting both the verdict **and** the exit code for every case.

## Validated against real on-chain programs

Beyond the bundled fixtures, the differ is run against the **real on-chain IDLs** of
large mainnet Anchor programs. It's fully reproducible — each IDL is just a git tag,
so a reviewer can re-run any line below. (The IDLs aren't vendored, to keep the repo
lean; fetch them as shown.)

**Robustness — zero phantom changes on real, full-size IDLs.** Self-diffing the live
IDL of a program must be perfectly clean:

| Program | Size | Accounts | Self-diff |
| --- | --- | --- | --- |
| Drift v2 (`drift-labs/protocol-v2` @ `v2.162.0`) | 428 KB | 27 | **27 SAFE**, 0 phantom |
| OpenBook v2 (`openbook-dex/openbook-v2`) | 83 KB | 6 | **6 SAFE**, 0 phantom |

**Nested-type resolution on real data.** A real cross-version diff of two Drift
mainnet releases:

```bash
curl -sL https://raw.githubusercontent.com/drift-labs/protocol-v2/v2.140.0/sdk/src/idl/drift.json -o old.json
curl -sL https://raw.githubusercontent.com/drift-labs/protocol-v2/v2.162.0/sdk/src/idl/drift.json -o new.json
npx tsx scripts/layout-diff.ts old.json new.json
```

flags the **4 accounts whose layout definition changed** and leaves the **23
untouched accounts SAFE**. Two of the four are caught *inside a nested type* —
exactly what a shallow IDL diff misses:

- `PerpMarket` → its embedded **86-field `AMM`** struct changed at field 76.
- `User` → the embedded **`PerpPosition`** changed at field 9 (`i64 → u64`).
- `UserStats` → `disableUpdatePerpBidAskTwap` retyped `bool → u8`.
- `State` → a reserved-padding byte was consumed (`padding: [u8;9]` → `lpPoolFeatureBitFlags: u8` + `padding: [u8;8]`).

**On verdict it's deliberately conservative.** Drift engineers these as
*byte-compatible* changes so old accounts keep deserializing — a model of the
discipline `safe-evolution-patterns.md` teaches. Static IDL analysis can't *prove* a
same-width retype is safe, nor tell whether a consumed `[u8;N]` byte was reserved
padding or a meaningful hash/bitmap — the IDL doesn't encode that intent — so it
flags these for review rather than greenlight them; the **fork replay**
(`fork-simulation.md`) confirms the bytes line up. It over-reports before it
under-reports — for a pre-upgrade gate a false alarm is cheap, a missed brick is
catastrophic. (This is deliberate: auto-"healing" a byte-identical reorg to SAFE is
exactly the false-green this tool refuses to emit.)

---

## The problem

Upgrading a Solana program swaps the bytecode in **one transaction**. But every
account already stored on-chain keeps its **old byte layout**. Anchor accounts are
Borsh-encoded (positional, no schema evolution); zero-copy accounts are raw
`repr(C)` memory. So if an upgrade:

- inserts a field anywhere but the end,
- removes or reorders a field,
- changes a field's type or width,
- or renames the struct (changing its 8-byte discriminator),

…then every existing account of that type now deserializes into **garbage**. That's
silent data corruption — wrong balances, wrong owners, drained vaults, bricked
state — and it ships green because the code compiles and a fresh devnet account
looks fine.

The knowledge to avoid this is real but scattered across cookbook prose, tribal
Discord lore, and manual CLI steps. **There is no tool that, given two builds, tells
you "this upgrade will brick your accounts, and here's how to migrate them."** This
skill is that tool plus the procedure around it.

Where it sits relative to the kit: this is **not** a code audit (that's the
auditor / Trail of Bits skills) and **not** generic deploy mechanics (that's
`deployment.md` / `/deploy`). It's specifically the *account-layout safety +
migration* gate that runs between "I changed a struct" and "I hit upgrade".

## What it does

1. **Diffs account layouts** between the old (on-chain) IDL and the new build's IDL,
   and classifies every change as `SAFE`, `REVIEW` (byte-compatible but worth a
   human look), `NEEDS_MIGRATION`, `BREAKING`, or `UNKNOWN` (struct couldn't be
   resolved) — at the individual field level, with the byte-shift reason. It
   resolves nested `defined` structs, so a change *inside* an embedded struct is
   caught too. Exits non-zero on `BREAKING` so it can gate CI.
2. **Routes to the fix**: how to redesign the change so it doesn't need a migration,
   or how to write a correct on-chain `migrate` instruction (realloc rules, the
   10 KiB/ix cap, zeroing, idempotency, eager vs lazy backfill).
3. **Replays against real accounts** on a mainnet fork (Surfpool) so you catch a
   bricking upgrade in a sandbox instead of on mainnet.
4. **Proves what you ship** with verified/reproducible builds and walks the safe
   deploy: buffer staging, Squads multisig authority, the immutability decision, and
   rollback.

## How this is different (prior art)

The knowledge to avoid layout-bricking exists, but nothing packages it as a
pre-upgrade *detector*. Each neighbour answers a different question:

| Tool / source | What it does | What it does **not** do |
| --- | --- | --- |
| Anchor v1.0 `Migration<'info, From, To>` | **Executes** a migration at runtime once you've decided you need one | Detect a breaking change, or warn that an upgrade would brick accounts |
| `solana-verify` / Squads upgrade flow | Proves the deployed **bytecode** matches the source | Say whether that bytecode is compatible with existing account **data** |
| Trail of Bits / Neodyme / Sealevel attacks | Catch **attacker-facing** vulns (missing signer/owner checks, type confusion) | Catch an honest dev silently reinterpreting their **own** accounts on upgrade |
| Solana Cookbook data-migration guide | Hand-written `data_version` + conversion **prose** | Diff two builds, classify changes, or gate CI |
| **solana-upgrade-safety** (this) | **Detects & classifies** layout breaks from two IDLs, exits non-zero, routes to the fix | Audit code, or run the deploy — it defers those to the auditor / deploy skills |

So it sits *in front of* Anchor's migration runtime: this is the **detect & decide**
half, `Migration<From, To>` is the **execute** half.

## Repository layout

```
solana-upgrade-safety/
├── CLAUDE.md                       # repo guide for an agent (purpose, stack, workflow)
├── skill/
│   ├── SKILL.md                    # entry point — routes to the files below
│   ├── layout-compatibility.md     # Borsh/zero-copy rules + change classification
│   ├── safe-evolution-patterns.md  # design changes that DON'T need migration
│   ├── migration-codegen.md        # the on-chain migrate ix + backfill
│   ├── fork-simulation.md          # replay the upgrade against real accounts
│   ├── verified-builds.md          # reproducible builds (solana-verify)
│   └── upgrade-authority.md        # buffers, Squads multisig, immutability, rollback
├── agents/
│   └── upgrade-safety-reviewer.md  # Opus reviewer → go/no-go review packet
├── commands/
│   └── check-upgrade.md            # /check-upgrade — runs the whole gate
├── rules/
│   └── account-layout.md           # auto-loads on *.rs account-struct / IDL edits
├── scripts/
│   ├── layout-diff.ts              # the IDL layout differ (zero runtime deps, Node 18+)
│   ├── test.ts                     # regression suite — synthetic cases (npm test)
│   ├── integration.test.ts         # integration suite — real CLI + install.sh E2E
│   └── package.json
├── examples/
│   ├── vault.v1.idl.json           # baseline
│   ├── vault.v2.idl.json           # BREAKING upgrade (field inserted in the middle)
│   └── vault.v3.idl.json           # NEEDS_MIGRATION version (appended at tail)
├── tests/fixtures/                 # full-size Anchor 0.30+ IDLs for integration tests
│   ├── lending.v1.idl.json         # multi-account program (nested struct, enum, vec)
│   ├── lending.v2.idl.json         # v2: hits every verdict at once
│   ├── external-type.v1.idl.json   # account leans on a type missing from types[]
│   └── external-type.v2.idl.json   # → REVIEW (can't see inside it), never false SAFE
├── .github/workflows/ci.yml        # runs both suites + fixture exit-code checks
├── install.sh
├── SECURITY.md
└── LICENSE
```

## Install

### Into a Solana AI Kit project (or any `.claude` / `.agents` project)

```bash
# from your project root
bash <path-to>/solana-upgrade-safety/install.sh .
# non-Claude agents (Cursor/Windsurf/etc.) that use .agents/:
bash <path-to>/solana-upgrade-safety/install.sh . --agents
```

This copies the skill files plus `scripts/` (the differ) and `examples/` into
`.claude/skills/solana-upgrade-safety/`, and `commands/check-upgrade.md` into
`.claude/commands/`. Then run `npm install` in the installed `scripts/` dir to get
`tsx` (the installer prints the exact command) and add a route to it from the kit's
`SKILL.md` hub (the installer prints that line too).

### Integrate into the Solana AI Kit

Paste-ready artifacts for a maintainer mounting this as an `ext/` skill:

**1. Submodule it:**

```bash
git submodule add https://github.com/asagynbaev/solana-upgrade-safety \
  .claude/skills/ext/solana-upgrade-safety
```

**2. Add a routing row to the kit's `SKILL.md` hub:**

| Intent | Skill | Scope |
| --- | --- | --- |
| Upgrading a live program / changed an account struct | `ext/solana-upgrade-safety/skill/SKILL.md` | Layout diff, migration, fork replay before redeploy — *not* a code audit, *not* generic deploy |

**3. If the kit uses a `skill-registry.json`, add:**

```json
{
  "name": "solana-upgrade-safety",
  "path": "ext/solana-upgrade-safety/skill/SKILL.md",
  "command": "/check-upgrade",
  "agent": "upgrade-safety-reviewer",
  "triggers": ["upgrade program", "redeploy", "account struct change", "realloc", "migrate account", "make immutable", "verified build"]
}
```

It defers code-vulnerability review to the auditor / Trail of Bits skills and generic
deploy mechanics to `deployment.md` / `/deploy` — it fills the gap between them.

## Use the differ directly

```bash
cd scripts && npm install            # one-time, installs tsx
npm run test:all                     # optional: regression + integration suites
# fetch the live IDL of a deployed Anchor program:
anchor idl fetch <PROGRAM_ID> --provider.cluster mainnet -o old.idl.json
# diff it against your new build's IDL:
npx tsx layout-diff.ts old.idl.json ../target/idl/<program>.json --strict
# JSON output for CI:
npx tsx layout-diff.ts old.idl.json new.idl.json --json
```

Try the included fixtures to see all three verdicts:

```bash
cd scripts
npx tsx layout-diff.ts ../examples/vault.v1.idl.json ../examples/vault.v2.idl.json  # BREAKING (exit 1)
npx tsx layout-diff.ts ../examples/vault.v1.idl.json ../examples/vault.v3.idl.json  # NEEDS_MIGRATION
npx tsx layout-diff.ts ../examples/vault.v1.idl.json ../examples/vault.v1.idl.json  # SAFE
```

### Use in Claude Code

Just say what you're doing — the skill triggers on it:
> "I added a `paused` field to my Vault account, is it safe to upgrade?"

or run the command:
> `/check-upgrade <PROGRAM_ID> mainnet`

## Stack (2026)

| Area | Pinned to |
| --- | --- |
| IDL formats | Anchor legacy (fields inline on `accounts`) **and** 0.30+/Codama (`types[]` + 8-byte discriminators) |
| Anchor | 0.30/0.31 IDLs are what's on-chain today; 1.0 (1.0.0-rc) is the current line. Custom discriminators since 0.31 |
| Migration runtime | Anchor v1.0 `Migration<'info, From, To>` — the executor this detector runs in front of |
| Fork replay | Surfpool (mainnet-fork validator + MCP); LiteSVM / Mollusk for in-process unit tests |
| Verified builds | `solana-verify` (deterministic Docker build + on-chain hash; OtterSec registry `verify.osec.io`) |
| Upgrade authority | Squads v4 multisig; `solana program set-upgrade-authority --final` for immutability |
| Differ runtime | Node 18+, `tsx`; **zero** runtime dependencies (imports only `node:fs`) |

## Limitations (read these — they matter)

- **Static IDL analysis can't see C padding.** For `#[account(zero_copy)]` structs,
  the diff flags obvious changes but you must verify `size_of` / `offset_of!` by
  hand; the skill tells you when and how.
- **It can't detect semantic reinterpretation.** If a `u64` that meant lamports now
  means basis points, the layout is identical and only a human catches it. Same for
  swapping two same-type fields (e.g. two `u64`s): the bytes don't move, so the diff
  reports `REVIEW` (a name swap to confirm), not `BREAKING` — but the *meaning* of
  those bytes has flipped, and only you can judge that.
- **Nested `defined` structs/enums/aliases are resolved** against each IDL's `types[]`,
  so a change inside an embedded struct, an enum variant reorder/insert on an
  enum-typed field, or a widened type alias (`type Buf = [u8; 32]` → `[u8; 64]`), are
  all flagged. Three things fall back to a *nominal* (name-only)
  comparison: a type referenced through a **cycle**, **generic** type params, and a
  type **not present in `types[]`** at all (e.g. pulled from an external crate). The
  differ won't call such an account a confident `SAFE` — an otherwise-clean account
  whose layout leans on an unresolvable nested type is downgraded to `REVIEW` with a
  note naming the type, because a change *inside* it would be invisible here. Those,
  and any account whose own struct can't be resolved (reported `UNKNOWN`), still need
  a fork replay.
- **It compares IDLs, not source.** Keep your IDL in sync with the program
  (`anchor build`), or the diff is comparing the wrong thing.
- The differ supports Anchor's legacy (fields inline on `accounts`) and 0.30+/Codama
  (accounts reference structs in `types`, with discriminators) IDL shapes, and
  normalizes representation differences between them. Hand-rolled or exotic IDLs may
  need a tweak.

These are stated up front on purpose: the fork-replay step (`fork-simulation.md`) is
what covers everything static analysis can't. **The diff narrows the risk; the fork
replay confirms it.**

## License

MIT — see [LICENSE](./LICENSE). Built to be merged or submoduled into the Solana AI Kit.
