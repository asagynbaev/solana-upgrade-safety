# Layout Compatibility

How Solana account data is laid out, and exactly which changes corrupt existing
accounts. This is the reasoning behind every verdict `layout-diff` produces.

## How an account is laid out

### Anchor `#[account]` (Borsh)

```
[ 8-byte discriminator ][ Borsh-serialized fields, in declaration order ]
```

- **Discriminator**: by default the first 8 bytes of `sha256("account:<StructName>")`.
  Renaming the struct changes the discriminator → the new program no longer
  recognizes old accounts at all, even if the fields are byte-identical.
  (Anchor ≥0.31/1.0 allows custom discriminators; if you set one, keep it stable.)
- **Fields**: encoded back-to-back, **in the order they are declared**, with no
  padding and no field names on the wire. Position is everything.

Borsh sizes:

| Type | Bytes | Notes |
| --- | --- | --- |
| `bool`, `u8`/`i8` | 1 | |
| `u16`/`i16` | 2 | |
| `u32`/`i32`, `f32` | 4 | |
| `u64`/`i64`, `f64` | 8 | |
| `u128`/`i128` | 16 | |
| `Pubkey` | 32 | |
| `[T; N]` | `N * sizeof(T)` | fixed |
| `Option<T>` | 1 + (`T` if `Some`) | **variable** — 1-byte tag |
| `Vec<T>`, `String` | 4 + payload | **variable** — u32 LE length prefix |
| `enum` | 1 + variant | **variable** — u8 discriminant + variant data |

Once a **variable-length** field appears, the byte offset of everything after it
depends on runtime data. That is fine at rest, but it means you cannot "reach in"
and reinterpret later fields after a layout change.

### Anchor `#[account(zero_copy)]` / bytemuck (`Pod`)

```
[ 8-byte discriminator ][ raw repr(C) struct bytes ]
```

- The struct must be `#[repr(C)]` and `Pod`/`Zeroable`. The bytes are the literal
  in-memory representation: field order **plus C alignment and padding**.
- Adding, reordering, or retyping a field changes offsets and total size. Worse,
  changing a field can shift **alignment padding** even when the visible field
  sizes look compatible. Always keep explicit padding fields and never reorder.
- Zero-copy accounts are typically large and fixed-size; growing one still
  requires `realloc` and leaves old accounts at the old size.

## Change classification

`layout-diff` walks the shared field prefix of old vs new. The **first** point of
divergence determines the verdict, because from that byte onward the old data is
misread.

### SAFE
- **New account type** (didn't exist before): no pre-existing accounts. Only check
  that its discriminator doesn't collide with another type.
- **No layout-affecting change**: fields identical in order, name, and type.

### REVIEW (byte-compatible, but look before you ship)
- **Renaming a field without changing its type** is byte-identical **on the wire**
  (Borsh stores no field names; the discriminator keys on the *struct* name, not
  fields). It corrupts nothing by itself, but Anchor/clients key on names, so a
  rename usually signals a semantic change — confirm intent and update consumers.
- **Removing a trailing field** leaves the surviving prefix byte-identical. Old
  accounts still deserialize fine — Borsh reads exactly the bytes the shorter struct
  needs and ignores the extra trailing bytes (Anchor's account path does not enforce
  full-buffer consumption). The only consequences: the removed field's data is
  orphaned, and accounts stay over-allocated (over-rented). Reclaim space via
  `realloc`/re-init if it matters. (This is *not* corruption — contrast inserting or
  removing a field in the middle, which is BREAKING.)
- **An otherwise-clean account that leans on an unresolvable nested type.** If a
  field is typed `{defined: Foo}` and `Foo` isn't in `types[]` (external crate,
  partial/hand-edited IDL), the differ can't see inside it, so a change *within* `Foo`
  would be invisible. Rather than print a false-green SAFE, it downgrades the account
  to REVIEW and names the unresolved type. Resolve the type into `types[]` (or diff it
  separately) and fork-replay before shipping.

### NEEDS_MIGRATION (action required, not corruption-by-default)
- **Appending fields at the tail only**, with the entire old prefix unchanged.
  New code expects more bytes than old accounts contain, so deserialization of an
  un-migrated old account **fails** (`Borsh: not enough bytes` / Anchor
  `AccountDidNotDeserialize`). You must either:
  - `realloc` + backfill each old account (eager or lazy), or
  - use a versioned deserializer that tolerates the short form.
  See `safe-evolution-patterns.md` and `migration-codegen.md`.

### BREAKING (existing accounts corrupt — do not ship)
- **Insert a field anywhere but the end** → shifts every following field.
- **Remove a non-trailing field** → collapses following fields onto wrong offsets.
  (Removing only the *last* field(s) is REVIEW, not BREAKING — see above.)
- **Reorder fields** of differing types → same shift. (Swapping two fields of the
  *same* type is byte-identical and reported as renames → REVIEW.)
- **Change a field's type or size** at a position (e.g. `u32 → u64`,
  `Pubkey → [u8; 32]` is size-equal but semantically risky; `u8 → bool` is
  size-equal but a type change) → bytes reinterpreted.
- **Change a nested `defined` struct/enum** referenced by a field (the differ
  resolves it against `types[]`): if the embedded struct grows/retypes, or an enum
  variant is inserted/reordered, the embedded bytes shift exactly like a top-level
  change.
- **Change the discriminator** (incl. via struct rename) → old accounts unrecognized.

### UNKNOWN (can't be diffed — verify by hand)
- An account references a struct that isn't resolvable in the IDL's `types[]`
  (external type, missing entry, or a non-struct kind). The differ reports `UNKNOWN`
  rather than guessing, and exits non-zero under `--strict`. Resolve the type or
  diff it separately, and always cover it with a fork replay.

### Things the static diff can NOT see (check by hand)
- **Zero-copy alignment/padding** changes when fixed-size fields are added/removed
  around differently-aligned types. If you touch a `zero_copy` struct, compute
  `std::mem::size_of` and `offset_of!` for every field before and after.
- **Semantic** reinterpretation of the same bytes (e.g. a `u64` that used to be
  lamports now meaning basis points). Same layout, wrong meaning — only a human
  catches it.
- **Enum variant *renames*** at the same position — the tag is unchanged, so it's
  byte-compatible, but the differ flags it conservatively as a nested change. (Enum
  variant *reordering/insertion* IS caught, since the differ compares variant order;
  still, append variants only.)
- **Cyclic, generic, or absent-from-`types[]` `defined` types** — these fall back to
  a name-only comparison, so a change deep inside a cycle or behind a generic param
  may be missed. (An account whose layout depends on a type *missing* from `types[]`
  is at least surfaced as REVIEW with the type named — see above — but the cycle and
  generic cases compare equal silently. Fork-replay any of these.)
- **Default/`InitSpace` size assumptions** in your `init`/`realloc` space math.

## Quick decision

```
layout change?
├── new type only ........................... SAFE
├── same-type rename / trailing-only removal  REVIEW (byte-safe; confirm intent)
├── pure tail append ........................ NEEDS_MIGRATION  → migration-codegen.md
├── anything in the existing prefix moved,
│   retyped, mid-removed, reordered, or a
│   nested struct/enum changed .............. BREAKING → redesign (safe-evolution-patterns.md)
│                                                        or migrate + replay on fork
├── nested defined type missing from types[]  REVIEW (can't see inside it; resolve + replay)
├── struct can't be resolved in types[] ..... UNKNOWN → resolve the type, verify by hand
└── zero_copy touched at all ................ verify size_of/offset_of by hand, then re-run diff
```
