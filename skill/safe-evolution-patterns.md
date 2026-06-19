# Safe Evolution Patterns

The cheapest migration is the one you don't have to run. Design account structs so
they can grow without breaking. Use these patterns *before* reaching for
`migration-codegen.md`.

## 1. Append-only + explicit version

Treat the struct as an append-only wire format and carry a version number from day
one (ideally as the first field after the discriminator).

```rust
#[account]
pub struct Vault {
    pub version: u8,        // bump on every layout change
    pub owner: Pubkey,
    pub bump: u8,
    pub total_deposited: u64,
    pub fee_bps: u16,
    // v2: ALWAYS add new fields here, at the end — never in the middle.
    // pub paused: bool,
}
```

Rules:
- **Never** insert, remove, reorder, or retype an existing field.
- New fields go at the **tail**, and you bump `version`.
- Reserve space up front if you can predict growth (see pattern 3).

## 2. Versioned (length-tolerant) deserialization

Appending fields still leaves old accounts physically shorter. Instead of
migrating every account, deserialize defensively and fill defaults for the missing
tail. This turns a `NEEDS_MIGRATION` into a zero-downtime read.

```rust
impl Vault {
    /// Deserialize tolerating older, shorter layouts.
    pub fn load_compat(data: &[u8]) -> Result<Self> {
        // data already past the 8-byte discriminator
        let mut v = Self::try_deserialize_unchecked(&mut &data[..])
            .or_else(|_| Self::load_v1(data))?; // fall back to the shorter form
        if v.version < CURRENT_VERSION {
            v.apply_defaults_for_new_fields(); // e.g. paused = false
            // optionally persist via realloc on next mutable touch (lazy migration)
        }
        Ok(v)
    }
}
```

Use this when you cannot or do not want to touch every account, and the new fields
have a sensible default. Combine with lazy migration (pattern 4) to heal accounts
as they're used.

## 3. Reserved padding (pre-allocated headroom)

Allocate trailing reserved bytes at creation so future fields fit without any
`realloc`. Common in production programs.

```rust
#[account]
pub struct Vault {
    pub version: u8,
    pub owner: Pubkey,
    pub bump: u8,
    pub total_deposited: u64,
    pub fee_bps: u16,
    pub _reserved: [u8; 64], // headroom; shrink this as you add real fields
}
```

When you add `paused: bool`, you shrink `_reserved` to `[u8; 63]` and place
`paused` *before* it. Net size is unchanged, so **no realloc and no rent change**
— but the bytes still move, so this is still a layout change: bump `version`,
re-run `layout-diff`, and migrate the meaning of those bytes (they were zeroed
reserved bytes, so `paused` reads as `false` — which is exactly the default).
This is the cleanest upgrade path when you planned ahead.

## 4. Lazy migration (heal on touch)

Don't migrate all accounts in a batch; migrate each one the next time an
instruction mutates it. Pair with `realloc` (if growing) and an idempotent
`migrate_in_place` step at the top of mutating handlers.

```rust
pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    migrate_in_place(&mut ctx.accounts.vault)?; // no-op if already current
    // ... normal deposit logic ...
    Ok(())
}
```

Pros: no big migration transaction, no need to enumerate accounts. Cons: cold
accounts stay on the old version indefinitely; your read paths must tolerate both
versions (pattern 2) until everything has been touched.

## 5. New-account / dual-write (no in-place change at all)

For drastic redesigns, don't mutate the old account type — introduce a **new**
account type (new discriminator, new PDA seed/version) and migrate users across on
their next interaction, leaving old accounts readable. Most robust, most code.

## Anti-patterns (these are what brick programs)

- Inserting a field "logically where it belongs" in the middle of the struct.
- Changing `u32 → u64` (or any width) on a live field to "give more room".
- Reordering fields for readability.
- Renaming + retyping in the same change and assuming the old data still maps.
- Reordering or inserting **enum variants** (the u8 tag is positional — append only).
- Touching a `zero_copy` struct without recomputing `size_of`/`offset_of`.
- Forgetting that a tail append makes old accounts fail to deserialize until
  migrated — "it compiled and devnet was empty" is not a test.

## Decision

```
Can the change be expressed as: tail append into reserved padding?   → pattern 3 (best)
Can new fields default sensibly and reads tolerate short accounts?   → pattern 2 + 4
Drastic redesign / type semantics changed?                           → pattern 5
None of the above and bytes must move?                               → migration-codegen.md
```

Always finish by re-running `layout-diff` on the redesigned IDL and replaying on a
fork (`fork-simulation.md`).
