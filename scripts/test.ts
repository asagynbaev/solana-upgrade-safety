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

// malformed input → exit 2 (not misreported as BREAKING/exit 1)
check("malformed JSON exit 2", run(idl("{ not json"), idl(acct("A", [u("u64")]))).exit, 2);
check("accounts not an array exit 2", run(idl({ accounts: { foo: "bar" } }), idl({ accounts: { foo: "bar" } })).exit, 2);
check("unknown flag exit 2", run(idl(acct("A", [u("u64")])), idl(acct("A", [u("u64")])), "--bogus").exit, 2);

// ---- report ----------------------------------------------------------------

rmSync(DIR, { recursive: true, force: true });
if (failures.length) {
  console.error(`\n${failures.join("\n")}\n\n${pass} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`\n✓ all ${pass} assertions passed`);
process.exit(0);
