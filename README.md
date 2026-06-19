# solana-upgrade-safety

**A pre-upgrade safety gate for live Solana programs.** It catches the single most
expensive class of mistake when upgrading a program that already has accounts
on-chain: **silently bricking those accounts by changing the data layout.**

Built as a drop-in skill for the [Solana AI Kit](https://github.com/solanabr/solana-ai-kit)
(Claude Code / Codex / any agent). MIT licensed and progressive-loading; the core
differ has zero npm dependencies (it imports only `node:fs`) and just needs `tsx`
to execute the TypeScript.

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

## Repository layout

```
solana-upgrade-safety/
├── skill/
│   ├── SKILL.md                    # entry point — routes to the files below
│   ├── layout-compatibility.md     # Borsh/zero-copy rules + change classification
│   ├── safe-evolution-patterns.md  # design changes that DON'T need migration
│   ├── migration-codegen.md        # the on-chain migrate ix + backfill
│   ├── fork-simulation.md          # replay the upgrade against real accounts
│   ├── verified-builds.md          # reproducible builds (solana-verify)
│   └── upgrade-authority.md        # buffers, Squads multisig, immutability, rollback
├── commands/
│   └── check-upgrade.md            # /check-upgrade — runs the whole gate
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
│   └── lending.v2.idl.json         # v2: hits every verdict at once
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

### As a submodule (to slot into the kit)

```bash
git submodule add https://github.com/sagynbaev6/solana-upgrade-safety \
  .claude/skills/ext/solana-upgrade-safety
```

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

## Limitations (read these — they matter)

- **Static IDL analysis can't see C padding.** For `#[account(zero_copy)]` structs,
  the diff flags obvious changes but you must verify `size_of` / `offset_of!` by
  hand; the skill tells you when and how.
- **It can't detect semantic reinterpretation.** If a `u64` that meant lamports now
  means basis points, the layout is identical and only a human catches it.
- **Nested `defined` structs/enums are resolved** against each IDL's `types[]`, so a
  change inside an embedded struct, and an enum variant reorder/insert on an
  enum-typed field, are flagged. Two exceptions fall back to a *nominal* (name-only)
  comparison: a type referenced through a **cycle**, and **generic** type params.
  Those, and any account whose struct can't be resolved at all (reported `UNKNOWN`),
  still need a fork replay.
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
