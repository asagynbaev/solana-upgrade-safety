#!/usr/bin/env node
/**
 * Zero-dependency regression suite for layout-diff.ts.
 *
 * Runs the differ as a child process (so it exercises the real CLI contract:
 * verdicts AND exit codes) against crafted IDL pairs written to a temp dir, plus
 * the bundled examples/. No test framework — just `tsx test.ts` / `npm test`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DIFF = join(HERE, "layout-diff.ts");
const tsxBin = join(HERE, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

interface Run { exit: number; verdicts: Record<string, string>; raw: string; }

function run(a: string, b: string, ...flags: string[]): Run {
  const r = spawnSync(tsxBin, [DIFF, a, b, "--json", ...flags], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const exit = r.status ?? -1;
  const verdicts: Record<string, string> = {};
  try {
    const parsed = JSON.parse(r.stdout);
    for (const f of parsed.findings ?? []) verdicts[f.account] = f.verdict;
  } catch {
    /* exit 2 (bad input) prints to stderr, no JSON — leave verdicts empty */
  }
  return { exit, verdicts, raw: (r.stdout ?? "") + (r.stderr ?? "") };
}

// ---- temp fixtures ---------------------------------------------------------

const DIR = mkdtempSync(join(tmpdir(), "layout-diff-test-"));
let n = 0;
function idl(obj: unknown): string {
  const p = join(DIR, `idl-${n++}.json`);
  writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
  return p;
}
const acct = (name: string, fields: Array<{ name: string; type: unknown }>, extra: object = {}) =>
  ({ metadata: { name: "p" }, accounts: [{ name, type: { kind: "struct", fields } }], ...extra });

// ---- assertions ------------------------------------------------------------

let pass = 0;
const failures: string[] = [];
function check(label: string, got: number | string, want: number | string) {
  if (got === want) { pass++; return; }
  failures.push(`✗ ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function expect(label: string, r: Run, account: string, verdict: string, exit: number) {
  check(`${label} [verdict]`, r.verdicts[account] ?? "(none)", verdict);
  check(`${label} [exit]`, r.exit, exit);
}

// ---- cases -----------------------------------------------------------------

const u = (t: string) => ({ name: t[0], type: t }); // tiny field helper

// bundled examples (the documented demo)
const EX = join(HERE, "..", "examples");
expect("example v1->v2 mid-insert", run(join(EX, "vault.v1.idl.json"), join(EX, "vault.v2.idl.json")), "Vault", "BREAKING", 1);
expect("example v1->v3 tail-append", run(join(EX, "vault.v1.idl.json"), join(EX, "vault.v3.idl.json")), "Vault", "NEEDS_MIGRATION", 0);
check("example v1->v3 --strict exit", run(join(EX, "vault.v1.idl.json"), join(EX, "vault.v3.idl.json"), "--strict").exit, 1);
expect("example v1->v1 identical", run(join(EX, "vault.v1.idl.json"), join(EX, "vault.v1.idl.json")), "Vault", "SAFE", 0);

// identical / new account
expect("identical", run(idl(acct("A", [u("u64")])), idl(acct("A", [u("u64")]))), "A", "SAFE", 0);
expect("new account added",
  run(idl({ metadata: { name: "p" }, accounts: [] }), idl(acct("A", [u("u64")]))), "A", "SAFE", 0);

// scalar layout changes
expect("type widen u32->u64",
  run(idl(acct("A", [{ name: "x", type: "u32" }])), idl(acct("A", [{ name: "x", type: "u64" }]))), "A", "BREAKING", 1);
expect("u8->bool same size",
  run(idl(acct("A", [{ name: "x", type: "u8" }])), idl(acct("A", [{ name: "x", type: "bool" }]))), "A", "BREAKING", 1);
expect("mid-insert",
  run(idl(acct("A", [u("u64"), { name: "z", type: "u16" }])),
      idl(acct("A", [u("u64"), { name: "mid", type: "u8" }, { name: "z", type: "u16" }]))), "A", "BREAKING", 1);
expect("tail append",
  run(idl(acct("A", [u("u64")])), idl(acct("A", [u("u64"), { name: "extra", type: "u8" }]))), "A", "NEEDS_MIGRATION", 0);
expect("reorder different types",
  run(idl(acct("A", [{ name: "a", type: "u64" }, { name: "b", type: "u32" }])),
      idl(acct("A", [{ name: "b", type: "u32" }, { name: "a", type: "u64" }]))), "A", "BREAKING", 1);

// byte-compatible (REVIEW) cases
expect("pure rename same type",
  run(idl(acct("A", [{ name: "amount", type: "u64" }])), idl(acct("A", [{ name: "balance", type: "u64" }]))), "A", "REVIEW", 0);
expect("trailing field removed",
  run(idl(acct("A", [{ name: "a", type: "u64" }, { name: "b", type: "u32" }])),
      idl(acct("A", [{ name: "a", type: "u64" }]))), "A", "REVIEW", 0);
check("REVIEW not blocked by --strict",
  run(idl(acct("A", [{ name: "amount", type: "u64" }])), idl(acct("A", [{ name: "balance", type: "u64" }])), "--strict").exit, 0);

// account removed / discriminator change
expect("account removed",
  run(idl(acct("A", [u("u64")])), idl({ metadata: { name: "p" }, accounts: [] })), "A", "BREAKING", 1);
expect("discriminator changed, fields identical",
  run(idl({ metadata: { name: "p" }, accounts: [{ name: "A", discriminator: [1, 2, 3, 4, 5, 6, 7, 8], type: { kind: "struct", fields: [u("u64")] } }] }),
      idl({ metadata: { name: "p" }, accounts: [{ name: "A", discriminator: [9, 9, 9, 9, 9, 9, 9, 9], type: { kind: "struct", fields: [u("u64")] } }] })),
  "A", "BREAKING", 1);

// nested defined struct (the critical blind spot)
const config = (fields: Array<{ name: string; type: unknown }>) => ({ name: "Config", type: { kind: "struct", fields } });
const vaultWithConfig = (cfgFields: Array<{ name: string; type: unknown }>) =>
  ({ metadata: { name: "p" }, accounts: [{ name: "Vault", type: { kind: "struct", fields: [{ name: "config", type: { defined: "Config" } }, { name: "bump", type: "u8" }] } }], types: [config(cfgFields)] });
expect("nested struct grows (was false SAFE)",
  run(idl(vaultWithConfig([{ name: "fee", type: "u16" }])), idl(vaultWithConfig([{ name: "fee", type: "u16" }, { name: "max", type: "u64" }]))), "Vault", "BREAKING", 1);
expect("nested struct field retyped",
  run(idl(vaultWithConfig([{ name: "fee", type: "u16" }])), idl(vaultWithConfig([{ name: "fee", type: "u64" }]))), "Vault", "BREAKING", 1);
expect("nested struct unchanged",
  run(idl(vaultWithConfig([{ name: "fee", type: "u16" }])), idl(vaultWithConfig([{ name: "fee", type: "u16" }]))), "Vault", "SAFE", 0);

// cross-format normalization
expect("defined legacy-string vs 0.30+-object (identical)",
  run(idl({ metadata: { name: "p" }, accounts: [{ name: "A", type: { kind: "struct", fields: [{ name: "c", type: { defined: "Foo" } }] } }], types: [{ name: "Foo", type: { kind: "struct", fields: [u("u8")] } }] }),
      idl({ metadata: { name: "p" }, accounts: [{ name: "A", type: { kind: "struct", fields: [{ name: "c", type: { defined: { name: "Foo" } } }] } }], types: [{ name: "Foo", type: { kind: "struct", fields: [u("u8")] } }] })),
  "A", "SAFE", 0);
expect("publicKey vs pubkey",
  run(idl(acct("A", [{ name: "o", type: "publicKey" }])), idl(acct("A", [{ name: "o", type: "pubkey" }]))), "A", "SAFE", 0);

// option/vec present then tail append
expect("variable-length field then tail append",
  run(idl(acct("A", [{ name: "o", type: { option: "u64" } }])),
      idl(acct("A", [{ name: "o", type: { option: "u64" } }, { name: "t", type: "u8" }]))), "A", "NEEDS_MIGRATION", 0);

// enum variant reorder (bonus: now caught via structural signature)
const enumIdl = (variants: Array<{ name: string }>) =>
  ({ metadata: { name: "p" }, accounts: [{ name: "A", type: { kind: "struct", fields: [{ name: "s", type: { defined: "St" } }] } }], types: [{ name: "St", type: { kind: "enum", variants } }] });
expect("enum variant reorder",
  run(idl(enumIdl([{ name: "Open" }, { name: "Closed" }])), idl(enumIdl([{ name: "Closed" }, { name: "Open" }]))), "A", "BREAKING", 1);

// unresolved struct → UNKNOWN, never silently SAFE/NEEDS_MIGRATION
const unresOld = idl({ metadata: { name: "p" }, accounts: [{ name: "Vault" }], types: [] });
const unresNew = idl({ metadata: { name: "p" }, accounts: [{ name: "Vault" }], types: [{ name: "Vault", type: { kind: "struct", fields: [{ name: "o", type: "pubkey" }] } }] });
expect("unresolved struct -> UNKNOWN", run(unresOld, unresNew), "Vault", "UNKNOWN", 0);
check("unresolved -> exit 1 under --strict", run(unresOld, unresNew, "--strict").exit, 1);

// nested `defined` type MISSING from types[] (in both): the account struct resolves
// but its field's inner layout can't be seen — must NOT be a confident SAFE. We
// downgrade to REVIEW with a note rather than printing a false green "all clear".
const missingNested = (extra: object = {}) =>
  ({ metadata: { name: "p" }, accounts: [{ name: "A", type: { kind: "struct", fields: [{ name: "c", type: { defined: "Config" } }, { name: "b", type: "u8" }] } }], ...extra });
expect("nested defined missing from types[] -> REVIEW not SAFE",
  run(idl(missingNested()), idl(missingNested())), "A", "REVIEW", 0);
check("...and not blocked by --strict (exit 0)", run(idl(missingNested()), idl(missingNested()), "--strict").exit, 0);
// but once the type IS in types[] and unchanged, it's a real SAFE (no over-warning)
const withConfig = (fee: string) =>
  ({ metadata: { name: "p" }, accounts: [{ name: "A", type: { kind: "struct", fields: [{ name: "c", type: { defined: "Config" } }, { name: "b", type: "u8" }] } }], types: [{ name: "Config", type: { kind: "struct", fields: [{ name: "fee", type: fee }] } }] });
expect("resolved nested + unchanged -> real SAFE", run(idl(withConfig("u16")), idl(withConfig("u16"))), "A", "SAFE", 0);

// same-type reorder: two u64 swapped. Bytes don't shift (both u64 at both offsets),
// only the names swap — byte-compatible, so REVIEW (semantic swap a human must judge),
// NOT BREAKING. Pins the boundary against the "reorder different types" BREAKING case.
expect("same-type reorder -> REVIEW (byte-compatible name swap)",
  run(idl(acct("A", [{ name: "a", type: "u64" }, { name: "b", type: "u64" }])),
      idl(acct("A", [{ name: "b", type: "u64" }, { name: "a", type: "u64" }]))), "A", "REVIEW", 0);

// fixed-array length change shifts every following byte → BREAKING
expect("array length change [u8;32]->[u8;64]",
  run(idl(acct("A", [{ name: "x", type: { array: ["u8", 32] } }])),
      idl(acct("A", [{ name: "x", type: { array: ["u8", 64] } }]))), "A", "BREAKING", 1);

// option inner-type change and option-vs-coption (1-byte vs 4-byte tag) → BREAKING
expect("option<u32> -> option<u64>",
  run(idl(acct("A", [{ name: "x", type: { option: "u32" } }])),
      idl(acct("A", [{ name: "x", type: { option: "u64" } }]))), "A", "BREAKING", 1);
expect("option<u64> -> coption<u64> (tag width differs)",
  run(idl(acct("A", [{ name: "x", type: { option: "u64" } }])),
      idl(acct("A", [{ name: "x", type: { coption: "u64" } }]))), "A", "BREAKING", 1);

// vec element retype changes per-element encoding of the heap payload → BREAKING
expect("vec<u32> -> vec<u64>",
  run(idl(acct("A", [{ name: "xs", type: { vec: "u32" } }])),
      idl(acct("A", [{ name: "xs", type: { vec: "u64" } }]))), "A", "BREAKING", 1);

// enum struct-style (named-field) variant gains a field → variant payload grows → BREAKING
const enumNamed = (closedFields: Array<{ name: string; type: string }>) =>
  ({ metadata: { name: "p" }, accounts: [{ name: "A", type: { kind: "struct", fields: [{ name: "s", type: { defined: "St" } }] } }], types: [{ name: "St", type: { kind: "enum", variants: [{ name: "Open" }, { name: "Closed", fields: closedFields }] } }] });
expect("enum named-variant gains a field",
  run(idl(enumNamed([{ name: "at", type: "u64" }])),
      idl(enumNamed([{ name: "at", type: "u64" }, { name: "by", type: "pubkey" }]))), "A", "BREAKING", 1);

// self-referential (cyclic) type: the cycle guard must let the diff terminate AND
// still catch a change to a non-cyclic field (here v: u64 -> u128). No hang, BREAKING.
const cyclic = (vType: string) =>
  ({ metadata: { name: "p" }, accounts: [{ name: "A", type: { kind: "struct", fields: [{ name: "next", type: { option: { defined: "A" } } }, { name: "v", type: vType }] } }], types: [{ name: "A", type: { kind: "struct", fields: [{ name: "next", type: { option: { defined: "A" } } }, { name: "v", type: vType }] } }] });
expect("cyclic type retyped -> BREAKING (no hang)", run(idl(cyclic("u64")), idl(cyclic("u128"))), "A", "BREAKING", 1);
expect("cyclic type unchanged -> SAFE (back-edge not over-flagged)", run(idl(cyclic("u64")), idl(cyclic("u64"))), "A", "SAFE", 0);

// codama thin account (struct in types[], discriminator present) + tail append
const codama = (fields: Array<{ name: string; type: string }>) =>
  ({ metadata: { name: "p" }, accounts: [{ name: "Vault", discriminator: [1, 2, 3, 4, 5, 6, 7, 8] }], types: [{ name: "Vault", type: { kind: "struct", fields } }] });
expect("codama format tail append -> NEEDS_MIGRATION",
  run(idl(codama([{ name: "owner", type: "pubkey" }])),
      idl(codama([{ name: "owner", type: "pubkey" }, { name: "paused", type: "bool" }]))), "Vault", "NEEDS_MIGRATION", 0);

// zero-field account on both sides is trivially SAFE (no false append/removal)
expect("empty-struct account -> SAFE", run(idl(acct("A", [])), idl(acct("A", []))), "A", "SAFE", 0);

// Anchor type alias ({kind:"type", alias}) is resolved, not treated as opaque: a
// change to the aliased type must shift bytes and read as BREAKING — NOT hide behind
// the alias name as a false REVIEW/SAFE. (Regression for the alias false-negative.)
const aliased = (len: number) =>
  ({ metadata: { name: "p" }, accounts: [{ name: "S", type: { kind: "struct", fields: [{ name: "h", type: { defined: "Buf" } }, { name: "o", type: "pubkey" }] } }], types: [{ name: "Buf", type: { kind: "type", alias: { array: ["u8", len] } } }] });
expect("type alias body widened [u8;32]->[u8;64] -> BREAKING",
  run(idl(aliased(32)), idl(aliased(64))), "S", "BREAKING", 1);
expect("type alias unchanged -> SAFE (resolved, not over-flagged)",
  run(idl(aliased(32)), idl(aliased(32))), "S", "SAFE", 0);
// alias -> alias chain: change at the end of the chain still propagates to BREAKING
const aliasChain = (len: number) =>
  ({ metadata: { name: "p" }, accounts: [{ name: "S", type: { kind: "struct", fields: [{ name: "h", type: { defined: "Buf" } }, { name: "o", type: "u8" }] } }], types: [{ name: "Buf", type: { kind: "type", alias: { defined: "Inner" } } }, { name: "Inner", type: { kind: "type", alias: { array: ["u8", len] } } }] });
expect("alias->alias chain change -> BREAKING", run(idl(aliasChain(16)), idl(aliasChain(24))), "S", "BREAKING", 1);

// malformed input → exit 2 (not misreported as BREAKING/exit 1)
check("malformed JSON exit 2", run(idl("{ not json"), idl(acct("A", [u("u64")]))).exit, 2);
check("accounts not an array exit 2", run(idl({ accounts: { foo: "bar" } }), idl({ accounts: { foo: "bar" } })).exit, 2);
check("unknown flag exit 2", run(idl(acct("A", [u("u64")])), idl(acct("A", [u("u64")])), "--bogus").exit, 2);

// SAME-TYPE INSERTION/REORDER MASKED AS RENAME — the critical false-SAFE class.
// Inserting a field of the SAME type as its neighbors (often + dropping a trailing
// field so the count stays equal) used to be misread as a chain of benign "renames"
// and pass as REVIEW/NEEDS_MIGRATION with exit 0. The bytes' WIDTH lines up so an old
// account still deserializes, but every field past the insert reads a DIFFERENT field's
// value (scrambled balances). It MUST be BREAKING. Guarded by the field-name-set test:
// a name was introduced and/or dropped, so it is not a permutation or an isolated rename.
expect("same-type mid-insert + trailing-drop (count equal) -> BREAKING (was false REVIEW)",
  run(idl(acct("A", [{ name: "a", type: "u64" }, { name: "b", type: "u64" }, { name: "c", type: "u64" }])),
      idl(acct("A", [{ name: "a", type: "u64" }, { name: "x", type: "u64" }, { name: "b", type: "u64" }]))),
  "A", "BREAKING", 1);
expect("realistic StakeAccount mid-insert of same-typed field -> BREAKING",
  run(idl(acct("StakeAccount", [{ name: "owner", type: "pubkey" }, { name: "stakedAmount", type: "u64" }, { name: "rewardDebt", type: "u64" }, { name: "lastClaimSlot", type: "u64" }])),
      idl(acct("StakeAccount", [{ name: "owner", type: "pubkey" }, { name: "poolId", type: "u64" }, { name: "stakedAmount", type: "u64" }, { name: "rewardDebt", type: "u64" }]))),
  "StakeAccount", "BREAKING", 1);
expect("same-type mid-insert with length increase -> BREAKING (was false NEEDS_MIGRATION)",
  run(idl(acct("A", [{ name: "a", type: "u64" }, { name: "b", type: "u64" }])),
      idl(acct("A", [{ name: "a", type: "u64" }, { name: "inserted", type: "u64" }, { name: "b", type: "u64" }]))),
  "A", "BREAKING", 1);
// Boundary guard: a GENUINE multi-field rename (disjoint name sets, identical positional
// types, equal count) is still byte-compatible → REVIEW, not over-flagged as BREAKING.
expect("double rename, same positional types -> REVIEW (byte-compatible, not over-flagged)",
  run(idl(acct("A", [{ name: "a", type: "u64" }, { name: "b", type: "u64" }])),
      idl(acct("A", [{ name: "x", type: "u64" }, { name: "y", type: "u64" }]))),
  "A", "REVIEW", 0);

// bare-tuple fixed-array shorthand ["u8",32] is byte-identical to {array:["u8",32]} —
// normalize it so a cross-representation diff doesn't raise a phantom BREAKING, while a
// genuine size change in either form still breaks.
expect("bare-tuple [u8,32] vs {array:[u8,32]} -> SAFE (representation normalized)",
  run(idl(acct("A", [{ name: "k", type: ["u8", 32] }, { name: "o", type: "u64" }])),
      idl(acct("A", [{ name: "k", type: { array: ["u8", 32] } }, { name: "o", type: "u64" }]))),
  "A", "SAFE", 0);
expect("bare-tuple genuine size change [u8,32]->[u8,64] -> BREAKING",
  run(idl(acct("A", [{ name: "k", type: ["u8", 32] }])),
      idl(acct("A", [{ name: "k", type: ["u8", 64] }]))),
  "A", "BREAKING", 1);

// ---- report ----------------------------------------------------------------

rmSync(DIR, { recursive: true, force: true });
if (failures.length) {
  console.error(`\n${failures.join("\n")}\n\n${pass} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`\n✓ all ${pass} assertions passed`);
process.exit(0);
