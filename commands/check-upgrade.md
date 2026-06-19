---
description: Run the full pre-upgrade safety gate for a live Solana program — fetch the on-chain IDL, diff account layouts, classify changes, and produce a go/no-go report with a migration + fork-replay plan.
---

# /check-upgrade

Run the upgrade-safety gate before redeploying a program that already has accounts
on-chain. Loads the `solana-upgrade-safety` skill and executes its workflow.

## Arguments

`$ARGUMENTS` may contain a program id and/or cluster. Examples:
- `/check-upgrade <PROGRAM_ID> mainnet`
- `/check-upgrade` (infer program id from `Anchor.toml` / `declare_id!`)

## Steps

1. **Resolve the program.** Find the program id (from `$ARGUMENTS`, `Anchor.toml`,
   or `declare_id!`) and the target cluster. Confirm with the user if ambiguous.

2. **Get both IDLs.**
   - OLD (what's live): `anchor idl fetch <PROGRAM_ID> --provider.cluster <cluster> -o /tmp/old.idl.json`
     (fall back to the previous tagged build's IDL if no on-chain IDL is published).
   - NEW (this build): `anchor build` then read `target/idl/<name>.json`, or use the
     working tree's IDL.

3. **Diff the layout.**
   ```bash
   npx tsx <skill>/scripts/layout-diff.ts /tmp/old.idl.json target/idl/<name>.json --strict
   ```
   Parse the verdicts. Summarize each account as SAFE / REVIEW / NEEDS_MIGRATION /
   BREAKING / UNKNOWN with the specific field-level reason.

4. **For zero-copy accounts, verify by hand.** The static diff can't see C padding.
   For any `#[account(zero_copy)]` struct that changed, compute `size_of` and
   `offset_of!` before/after and flag mismatches.

5. **Produce the go/no-go report:**
   - **All SAFE** → green. Still recommend a fork replay for anything non-trivial.
     Proceed to `verified-builds.md` + `upgrade-authority.md`.
   - **REVIEW** → green-with-a-note. Byte-compatible (a same-type rename or a
     trailing-field removal), so it doesn't block — but confirm the rename's intent /
     that the orphaned trailing data is acceptable, and update any clients keyed on
     field names.
   - **NEEDS_MIGRATION** → yellow. Generate the realloc/backfill plan from
     `migration-codegen.md`; offer to scaffold the `migrate` instruction and the
     enumeration script. Require a fork replay.
   - **BREAKING** → red. **Block.** Try to redesign the change as non-breaking using
     `safe-evolution-patterns.md`; if impossible, design a migration and require a
     fork replay against real accounts.
   - **UNKNOWN** → **Block until resolved.** The differ couldn't resolve a struct
     (external/missing type), so the layout was not diffed. Resolve the type (or diff
     it separately) and verify that account by hand on a fork before shipping.

6. **Recommend the fork replay** (`fork-simulation.md`): start Surfpool, upgrade the
   candidate over the live program on the fork, and assert real accounts survive.

7. **Output**: a short report with the verdict table, the field-level reasons, the
   recommended path (redesign vs migrate), and the exact next commands. Do not
   deploy anything — this command is read-only and advisory.

## Notes

- Never run a mainnet deploy from this command. It diffs, classifies, and plans.
- If `layout-diff` exits non-zero (BREAKING under `--strict`), the report leads with
  the block and the redesign/migration options, not the deploy steps.
- Attach the diff output + verified hash + fork-sim result as the review packet for
  the multisig proposal (`upgrade-authority.md`).
