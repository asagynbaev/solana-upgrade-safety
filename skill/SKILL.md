---
name: solana-upgrade-safety
description: >-
  Pre-upgrade safety gate for live Solana programs. Use this skill BEFORE any
  program upgrade or redeploy that already has accounts on mainnet/devnet —
  whenever the user mentions upgrading a program, redeploying, changing an
  account struct, adding/removing/reordering a field, a Borsh or zero-copy
  layout change, `realloc`, an account-data migration, "will this brick my
  accounts", upgrade authority, making a program immutable, or verified builds.
  Routes to layout-compatibility analysis, safe-evolution patterns, migration
  codegen, mainnet-fork simulation, verified-build proofs, and upgrade-authority
  procedure. Pair with the `layout-diff` script and the `/check-upgrade` command.
user-invocable: true
---

# Solana Upgrade Safety

Upgrading a Solana program swaps the bytecode in one transaction, but **every
account already on-chain keeps its old byte layout**. Borsh is positional and has
no schema evolution; zero-copy is raw `repr(C)` memory. Reorder, insert, remove,
or resize a field and existing accounts deserialize into garbage — silent data
corruption, drained vaults, bricked state. This skill is the gate that catches
that *before* you ship.

Think of it as **schema-breaking-change detection for on-chain account layouts** —
what Buf does for protobuf, this does for Borsh / zero-copy Solana accounts. It
*detects and decides* whether an upgrade is safe; Anchor v1.0's
`Migration<'info, From, To>` account type is the runtime that *executes* a migration
once you've decided you need one. This skill is the half that runs in front of it.

## When to use

Trigger on any of: "upgrade my program", "redeploy to mainnet", "I changed the
`State`/`Vault`/`Position` struct", "added a field", "realloc", "migrate account
data", "will old accounts still work", "make the program immutable", "rotate
upgrade authority", "verify the deployed program".

This is **not** a code audit (use the auditor/trailofbits skills for that) and
**not** generic deploy mechanics (use `deployment.md` / `/deploy`). It is
specifically: *is this upgrade safe for accounts that already exist, and if not,
how do I migrate them*.

## Workflow (do these in order)

1. **Diff the layout.** Get the OLD on-chain IDL and the NEW build's IDL, then run:
   ```bash
   npx tsx scripts/layout-diff.ts <old.idl.json> <new.idl.json> --strict
   ```
   To fetch the live IDL of a deployed Anchor program:
   `anchor idl fetch <PROGRAM_ID> --provider.cluster mainnet -o old.idl.json`.
   Verdicts: `SAFE` (ship), `REVIEW` (byte-compatible — a same-type rename or a
   trailing-field removal; check intent), `NEEDS_MIGRATION` (tail-append; backfill
   required), `BREAKING` (reorder/insert/non-trailing-remove/resize/nested-struct-
   change/discriminator — **do not ship**), `UNKNOWN` (struct unresolved — verify by
   hand). → Rules behind the verdicts: **`layout-compatibility.md`**.

2. **If BREAKING or NEEDS_MIGRATION, redesign or migrate.**
   First try to make the change non-breaking → **`safe-evolution-patterns.md`**
   (append-only, version byte, lazy migration). If a migration is unavoidable,
   generate it → **`migration-codegen.md`** (realloc rules, 10 KiB/ix cap,
   zeroing, idempotency, eager vs lazy backfill).

3. **Simulate against REAL accounts** on a mainnet fork before touching mainnet
   → **`fork-simulation.md`** (Surfpool: load production accounts, run the
   candidate program + migration, assert deserialization and invariants).

4. **Prove what you ship.** Build a verifiable binary so users/multisig signers
   can confirm on-chain bytecode matches source → **`verified-builds.md`**.

5. **Execute the upgrade safely** — buffer deploy, multisig authority, immutability
   decision, rollback plan → **`upgrade-authority.md`**.

## Reference files

| File | Read when |
| --- | --- |
| `layout-compatibility.md` | Deciding if a struct change is safe; understanding the diff output |
| `safe-evolution-patterns.md` | Designing a change so it *doesn't* need migration |
| `migration-codegen.md` | Writing the on-chain migrate instruction + client backfill |
| `fork-simulation.md` | Testing the upgrade against real mainnet accounts |
| `verified-builds.md` | Producing a reproducible, verifiable program binary |
| `upgrade-authority.md` | The actual deploy: buffers, Squads multisig, immutability |

## Tooling in this skill

- `scripts/layout-diff.ts` — zero-runtime-dependency IDL layout differ (imports only `node:fs`; run via `tsx`; CI-gateable, exits 1 on BREAKING).
- `commands/check-upgrade.md` — `/check-upgrade` runs the whole gate end to end.
- `agents/upgrade-safety-reviewer.md` — an Opus reviewer that runs the gate and writes the go/no-go review packet for a multisig proposal.
- `rules/account-layout.md` — auto-loads when you edit an account struct (`*.rs`) or regenerate an IDL, and reminds you to run the gate before redeploy.
- `examples/` — fixture IDLs demonstrating a bricking insert vs a safe append.

## The one rule to remember

> The program is upgradeable. The accounts are not. Treat every account struct as
> an append-only, versioned wire format, and never trust an upgrade you haven't
> replayed against real on-chain state.
