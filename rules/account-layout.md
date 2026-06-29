---
globs:
  - "**/state.rs"
  - "**/state/**/*.rs"
  - "**/accounts.rs"
  - "**/accounts/**/*.rs"
  - "**/*account*.rs"
  - "**/target/idl/*.json"
  - "**/idl/*.json"
  - "**/*.idl.json"
exclude:
  - "**/node_modules/**"
---

# Account Layout Safety

These files commonly hold Solana **account structs** (`#[account]`, `#[account(zero_copy)]`)
or the **IDL** generated from them. Account data already on-chain keeps its old byte
layout across a program upgrade — Borsh is positional with no schema evolution;
zero-copy is raw `repr(C)` memory. A layout change can silently brick existing
accounts. Apply these rules whenever you touch an account struct or regenerate an IDL.

## Hard rules

- **Never** insert, remove, reorder, or retype an existing field of a struct that has
  accounts on-chain. New fields go at the **tail** only, and you bump a `version` byte.
- **Never** reorder or insert **enum variants** — the discriminant is a positional `u8`.
  Append variants only.
- **Never** rename the account struct — it changes the 8-byte discriminator and the new
  program stops recognizing old accounts.
- For `#[account(zero_copy)]`: keep explicit padding fields, never reorder, and recompute
  `size_of` / `offset_of!` for every field before and after — alignment padding can shift
  even when visible field sizes look compatible.

## Before any redeploy of a program with live accounts

Run the upgrade-safety gate — do not skip it because "it compiled and devnet was empty":

```bash
# fetch the live IDL, then diff it against the new build
anchor idl fetch <PROGRAM_ID> --provider.cluster mainnet -o /tmp/old.idl.json
npx tsx <skill>/scripts/layout-diff.ts /tmp/old.idl.json target/idl/<name>.json --strict
```

Or run `/check-upgrade`, or hand off to the `upgrade-safety-reviewer` agent.

- `BREAKING` → **do not ship.** Redesign as a tail-append (see
  `safe-evolution-patterns.md`) or write a migration (`migration-codegen.md`).
- `NEEDS_MIGRATION` → ship the realloc/backfill path; replay on a mainnet fork first.
- `UNKNOWN` / unresolvable nested type / any zero-copy change → verify by hand and
  replay on a fork (`fork-simulation.md`) before shipping.

> The program is upgradeable. The accounts are not.
