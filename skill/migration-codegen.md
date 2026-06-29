# Migration Codegen

When bytes must move and you can't avoid it, you migrate. This file covers the
on-chain `migrate` instruction, the `realloc` rules that trip people up, and the
client-side backfill.

> **Anchor v1.0 ships a migration runtime: `Migration<'info, From, To>`.** It's the
> *executor* — it deserializes the old account, hands you both shapes to map across,
> and reallocs/rewrites — once you've already decided a migration is needed. This skill
> is the *detector* that makes that decision (`layout-diff` → BREAKING/NEEDS_MIGRATION).
> If you're on Anchor 1.0, prefer `Migration<From, To>` for the execution; the manual
> pattern below is the version-agnostic equivalent and shows exactly what it does under
> the hood (read-old → map → realloc → write-new → stamp version), which you still want
> to understand to get the realloc/zeroing/idempotency rules right.

## The shape of a migration

A migration has three parts:
1. **Grow** the account (if the new layout is larger) via `realloc`.
2. **Re-map** old bytes → new layout (read with the old struct, write the new one).
3. **Stamp** the new `version` so it's idempotent and skippable.

> The example below assumes a **version-prefixed** `Vault` (a `version: u8` as the
> first field, per `safe-evolution-patterns.md` pattern 1). The
> `examples/vault.*.idl.json` fixtures omit `version` to keep the layout-diff demo
> focused on mid-insert vs tail-append — so this code illustrates the *pattern*, not
> a literal match for those fixtures.

```rust
#[derive(Accounts)]
pub struct MigrateVault<'info> {
    #[account(
        mut,
        // grow to the new size; payer funds the extra rent
        realloc = 8 + Vault::INIT_SPACE,
        realloc::payer = authority,
        // defensive: redundant here because try_serialize (below) overwrites the
        // whole buffer, but load-bearing the moment any field becomes
        // variable-length (Vec/String) and the tail isn't fully rewritten
        realloc::zero = true,
        // gate who can migrate
        has_one = authority,
    )]
    /// CHECK: deserialized manually below to tolerate the OLD layout
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn migrate_vault(ctx: Context<MigrateVault>) -> Result<()> {
    let info = &ctx.accounts.vault;
    let data = info.try_borrow_data()?;

    // 1. Read with the OLD struct (manual, because the account is the old shape).
    let old = VaultV1::try_from_slice(&data[8..])?;
    drop(data);

    // 2. Build the NEW struct from old values + defaults for new fields.
    let new = Vault {
        version: 2,
        owner: old.owner,
        bump: old.bump,
        total_deposited: old.total_deposited,
        fee_bps: old.fee_bps,
        paused: false, // new field default
    };

    // 3. Write it back. try_serialize writes the discriminator + all fields across
    //    the whole buffer (the discriminator also persists from the original account).
    let mut data = info.try_borrow_mut_data()?;
    new.try_serialize(&mut &mut data[..])?;
    Ok(())
}
```

Notes:
- Keep the old struct definitions around (e.g. `VaultV1`) in a `legacy` module so
  you can deserialize what's actually on-chain.
- Make it **idempotent**: if `version` is already current, return early so retries
  and double-submits are safe.

## realloc rules that bite

- **Per-instruction growth cap = `MAX_PERMITTED_DATA_INCREASE` = 10,240 bytes
  (10 KiB).** You cannot grow an account by more than 10 KiB in a single
  instruction. For larger growth, realloc in steps across multiple instructions /
  transactions.
- **`realloc::zero = true`** zeroes the newly added bytes. Use it unless you
  immediately overwrite the whole new region — stale/uninitialized bytes are a
  classic source of "works on a fresh account, corrupt on an old one" bugs.
- **Rent**: growing an account requires topping up to the new rent-exempt minimum;
  `realloc::payer` funds it. Shrinking does not auto-refund within the same ix.
- **Anchor `realloc` runs as part of account validation**, before your handler
  body — the account is already the new size when your code runs.
- Native (non-Anchor): call `account.realloc(new_len, false)` and handle rent +
  zeroing yourself; same 10 KiB cap applies.

## Eager vs lazy backfill

| | Eager (batch) | Lazy (heal on touch) |
| --- | --- | --- |
| When | Few accounts, or you need everything current now | Many accounts, no enumeration |
| How | Off-chain script enumerates all accounts and sends `migrate` for each | `migrate_in_place` at the top of every mutating handler |
| Cost | One tx per account (batch into ALTs / many per block) | Amortized; cold accounts never migrate |
| Reads | Simple once done | Must tolerate both versions until fully healed (see `safe-evolution-patterns.md` §2) |

### Enumerating accounts for an eager backfill

Use `getProgramAccounts` filtered by the account's discriminator (and a version
byte if present), then send migrate transactions in batches.

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import bs58 from "bs58";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const PROGRAM_ID = new PublicKey("<YOUR_PROGRAM_ID>");

// Anchor account discriminator = first 8 bytes of sha256("account:<StructName>").
// DERIVE it (or read accounts[].discriminator from the IDL) — never hand-type the
// bytes; a wrong filter silently matches zero accounts and migrates nothing.
const DISCRIMINATOR = createHash("sha256").update("account:Vault").digest().subarray(0, 8);

const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
  filters: [
    { memcmp: { offset: 0, bytes: bs58.encode(DISCRIMINATOR) } },
    // only if the struct stores a version byte right after the discriminator:
    { memcmp: { offset: 8, bytes: bs58.encode(Buffer.from([1])) } }, // version == 1
  ],
});
// chunk accounts, build migrate ixs, send with priority fees + retries
```

Prefer a paginated RPC (Helius/Triton) for large sets; vanilla `getProgramAccounts`
can be rate-limited or truncated.

## Before you ship a migration

1. Re-run `layout-diff` on V1→V2 IDLs and confirm the only remaining item is the
   one you're migrating.
2. **Replay on a mainnet fork** with real accounts (`fork-simulation.md`): run
   `migrate`, then run the normal instructions, and assert old balances/owners are
   intact and invariants hold.
3. Confirm idempotency: run `migrate` twice; the second must be a no-op.
4. Confirm partial-failure safety: a migration that fails mid-batch must leave each
   individual account either fully old or fully new (per-account atomicity).
5. Size the rent top-up and make sure the payer is funded for the whole batch.
