#!/usr/bin/env node
/**
 * layout-diff — detect account-layout breaking changes between two Anchor IDLs.
 *
 * On Solana an `upgrade` swaps the program bytecode instantly, but accounts that
 * already exist on-chain keep their OLD byte layout. Borsh is positional and has
 * no schema evolution, so reordering, inserting, resizing, or retyping a field
 * makes every existing account of that type deserialize into garbage. This tool
 * compares the account structs in two IDLs and classifies each change.
 *
 * It resolves `defined` (user-defined) types against each IDL's own `types[]`,
 * so a change *inside* a nested/embedded struct (e.g. a field typed
 * `{defined: Config}` whose Config grows or retypes a field) is caught too — that
 * shifts the embedded bytes exactly like a top-level change.
 *
 * Verdicts:
 *   SAFE             — new account type, or no layout-affecting change.
 *   REVIEW           — byte-compatible but worth a human look: a same-type field
 *                      rename (clients/IDL key on names), or a trailing field
 *                      removed (old accounts still deserialize; the removed data is
 *                      orphaned and the account stays over-allocated). Not fatal.
 *   NEEDS_MIGRATION  — fields appended at the tail only. Old accounts are shorter;
 *                      they will fail to deserialize until you realloc + backfill
 *                      (or use a versioned deserializer). Action required, not fatal.
 *   BREAKING         — reorder / insert-in-middle / non-trailing removal /
 *                      type-or-size change (incl. a changed nested struct) /
 *                      discriminator change. Existing accounts will be corrupted.
 *   UNKNOWN          — an account references a struct that isn't resolvable in the
 *                      IDL's types[] (external/missing type), so its layout cannot
 *                      be diffed. Verify by hand. Never reported as SAFE.
 *
 * Exit codes: 0 = no BREAKING (clean, or only REVIEW), 1 = BREAKING found, 2 = bad
 *             input (unreadable/malformed IDL). With --strict, NEEDS_MIGRATION and
 *             UNKNOWN also exit 1 (use this as a CI gate).
 *
 * Usage:
 *   npx tsx layout-diff.ts <old.idl.json> <new.idl.json> [--json] [--strict]
 *
 * Zero runtime dependencies (imports only node:fs). Node 18+. Handles both legacy
 * (fields inline on `accounts`) and Anchor 0.30+/Codama (accounts reference structs
 * in `types`, with discriminators), and normalizes representation differences
 * across those formats (`{defined:"Foo"}` vs `{defined:{name:"Foo"}}`, `publicKey`
 * vs `pubkey`) so a cross-toolchain-version diff doesn't raise phantom changes.
 */

import { readFileSync } from "node:fs";

type Verdict = "SAFE" | "REVIEW" | "NEEDS_MIGRATION" | "BREAKING" | "UNKNOWN";
interface Field { name: string; type: any; }
interface AccountLayout { name: string; fields: Field[]; discriminator?: number[]; resolved: boolean; }
interface Finding { account: string; verdict: Verdict; reasons: string[]; }

// ---- IDL parsing -----------------------------------------------------------

function loadIdl(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e: any) {
    fail(`cannot read IDL at ${path}: ${e.message}`);
  }
}

/** Pull ordered account layouts out of an IDL, both old and new formats. */
function extractAccounts(idl: any): Map<string, AccountLayout> {
  const out = new Map<string, AccountLayout>();
  const types: any[] = Array.isArray(idl.types) ? idl.types : [];

  if (idl.accounts !== undefined && !Array.isArray(idl.accounts)) {
    fail(`malformed IDL: "accounts" must be an array, got ${typeof idl.accounts}`);
  }
  const accounts: any[] = Array.isArray(idl.accounts) ? idl.accounts : [];

  const findStruct = (name: string) =>
    types.find((t) => t?.name === name && t?.type?.kind === "struct");

  for (const acc of accounts) {
    if (!acc || typeof acc.name !== "string") continue; // skip malformed entries
    if (out.has(acc.name)) {
      warn(`duplicate account "${acc.name}" in IDL — only the last definition is diffed`);
    }

    let fields: Field[] | undefined;

    // Legacy: struct inlined directly on the account entry.
    if (acc?.type?.kind === "struct" && Array.isArray(acc.type.fields)) {
      fields = acc.type.fields;
    } else {
      // 0.30+/Codama: account is a thin {name, discriminator}; struct lives in types[].
      const s = findStruct(acc.name);
      if (s) fields = s.type.fields;
    }

    if (!fields) {
      // Struct couldn't be resolved (external type, missing from types[], or a
      // non-struct kind). Mark it unresolved so the diff reports UNKNOWN rather
      // than fabricating an append/removal verdict from an empty field list.
      out.set(acc.name, { name: acc.name, fields: [], discriminator: acc.discriminator, resolved: false });
      continue;
    }
    out.set(acc.name, {
      name: acc.name,
      fields: fields.map((f) => ({ name: f.name, type: f.type })),
      discriminator: acc.discriminator,
      resolved: true,
    });
  }
  return out;
}

// ---- Type normalization ----------------------------------------------------

/** Normalize the IDL representation differences across Anchor versions, recursively. */
function canon(type: any): any {
  if (typeof type === "string") return type === "publicKey" ? "pubkey" : type;
  if (Array.isArray(type)) return type.map(canon);
  if (type && typeof type === "object") {
    // {defined:"Foo"} (legacy) and {defined:{name:"Foo"}} (0.30+) → one form.
    if (type.defined !== undefined) {
      const name = typeof type.defined === "string" ? type.defined : type.defined?.name;
      const generics =
        typeof type.defined === "object" && Array.isArray(type.defined?.generics)
          ? type.defined.generics.map(canon)
          : undefined;
      return generics ? { defined: name, generics } : { defined: name };
    }
    const out: Record<string, any> = {};
    for (const k of Object.keys(type).sort()) out[k] = canon(type[k]);
    return out;
  }
  return type;
}

/** Stable, format-insensitive key for DISPLAYing a type ("changed type X -> Y"). */
function typeKey(type: any): string {
  return JSON.stringify(canon(type));
}

/**
 * Byte-layout signature of a type for EQUALITY decisions. Unlike typeKey it
 * resolves `defined` structs/enums against `types[]` and inlines their structure
 * (field names within a nested struct don't affect bytes, so they're excluded;
 * enum variant order/structure does matter — the tag is positional). Two types
 * with the same signature serialize identically; a change anywhere inside a nested
 * type changes the signature. Cycle-guarded with a DFS path-set.
 */
function fieldTypeSig(type: any, types: any[], seen = new Set<string>()): string {
  const c = canon(type);
  if (typeof c === "string") return c;
  if (c && typeof c === "object") {
    if (c.defined !== undefined) {
      const name = c.defined;
      if (seen.has(name)) return `defined(${name})`; // cycle → fall back to nominal
      const def = types.find((t) => t?.name === name);
      if (!def || !def.type) return `defined(${name})`; // unresolvable → nominal
      const next = new Set(seen).add(name);
      if (def.type.kind === "struct") {
        const inner = (def.type.fields ?? []).map((f: any) => fieldTypeSig(f.type, types, next));
        return `struct(${inner.join(",")})`;
      }
      if (def.type.kind === "enum") {
        const vs = (def.type.variants ?? []).map((v: any) => {
          const vf = Array.isArray(v?.fields)
            ? v.fields.map((f: any) => fieldTypeSig(f?.type ?? f, types, next)).join(",")
            : "";
          return `${v?.name ?? ""}[${vf}]`;
        });
        return `enum(${vs.join("|")})`;
      }
      return `defined(${name})`;
    }
    if (c.option !== undefined) return `option(${fieldTypeSig(c.option, types, seen)})`;
    if (c.coption !== undefined) return `coption(${fieldTypeSig(c.coption, types, seen)})`;
    if (c.vec !== undefined) return `vec(${fieldTypeSig(c.vec, types, seen)})`;
    if (c.array !== undefined) {
      const [inner, len] = c.array;
      return `array(${fieldTypeSig(inner, types, seen)};${JSON.stringify(len)})`;
    }
    return JSON.stringify(c);
  }
  return JSON.stringify(c);
}

// ---- Borsh size model (best-effort, for byte-offset hints) -----------------

const FIXED: Record<string, number> = {
  bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4,
  u64: 8, i64: 8, f64: 8, u128: 16, i128: 16,
  pubkey: 32, publicKey: 32,
};

/** Returns byte size for fixed types, or null if the type is variable-length. */
function sizeOf(type: any, types: any[], seen = new Set<string>()): number | null {
  if (typeof type === "string") return FIXED[type] ?? null;
  if (type && typeof type === "object") {
    if (type.array) {
      const [inner, len] = type.array;
      const s = sizeOf(inner, types, seen);
      return s == null || typeof len !== "number" ? null : s * len;
    }
    if (type.option || type.coption || type.vec || type.string || type.bytes) return null; // length-prefixed / tagged
    if (type.defined) {
      const name = typeof type.defined === "string" ? type.defined : type.defined.name;
      if (seen.has(name)) return null;
      const def = types.find((t) => t?.name === name);
      if (!def) return null;
      if (def.type?.kind === "struct") {
        seen.add(name); // DFS path-set: track only the active branch...
        let total = 0;
        for (const f of def.type.fields) {
          const s = sizeOf(f.type, types, seen);
          if (s == null) { seen.delete(name); return null; }
          total += s;
        }
        seen.delete(name); // ...and release on exit so sibling fields can reuse the type
        return total;
      }
      return null; // enums are tag + variant → variable
    }
  }
  return null;
}

// ---- Diff ------------------------------------------------------------------

function diffAccount(
  name: string,
  oldL: AccountLayout | undefined,
  newL: AccountLayout | undefined,
  oldTypes: any[],
  newTypes: any[],
): Finding {
  if (oldL && !newL) {
    return { account: name, verdict: "BREAKING",
      reasons: ["account type removed — existing on-chain accounts of this type are orphaned"] };
  }
  if (!oldL && newL) {
    return { account: name, verdict: "SAFE",
      reasons: ["new account type — no pre-existing accounts (ensure its 8-byte discriminator is unique)"] };
  }
  if (!oldL || !newL) return { account: name, verdict: "SAFE", reasons: [] };

  // Could the struct(s) even be resolved? If not, we cannot diff the layout —
  // say so rather than fabricating an append/removal verdict from empty fields.
  if (!oldL.resolved || !newL.resolved) {
    const which = !oldL.resolved && !newL.resolved ? "both IDLs"
      : !oldL.resolved ? "the old IDL" : "the new IDL";
    return { account: name, verdict: "UNKNOWN", reasons: [
      `could not resolve the struct for "${name}" in ${which} (type missing from types[] or not a struct) — ` +
      `its layout cannot be diffed; verify by hand`,
    ] };
  }

  const reasons: string[] = [];
  let breaking = false;

  // Discriminator change (0.30+ exposes it). A renamed struct = new discriminator
  // = old accounts unrecognized by the new program even if the fields are identical.
  if (oldL.discriminator && newL.discriminator &&
      JSON.stringify(oldL.discriminator) !== JSON.stringify(newL.discriminator)) {
    reasons.push("discriminator changed — old accounts will not be recognized by the new program");
    breaking = true;
  }

  const o = oldL.fields, n = newL.fields;
  const common = Math.min(o.length, n.length);

  // Walk the shared prefix. A type/identity divergence shifts all following bytes;
  // a same-type rename does not, so we note it and keep scanning.
  let divergedAt = -1;
  const renameNotes: string[] = [];
  for (let i = 0; i < common; i++) {
    const sameName = o[i].name === n[i].name;
    const sameType = fieldTypeSig(o[i].type, oldTypes) === fieldTypeSig(n[i].type, newTypes);

    if (sameName && sameType) continue;

    if (sameName && !sameType) {
      const oSize = sizeOf(o[i].type, oldTypes);
      const nSize = sizeOf(n[i].type, newTypes);
      const sizeHint = oSize != null && nSize != null && oSize !== nSize
        ? ` (size ${oSize}B -> ${nSize}B, shifts every following field)`
        : ` (reinterprets existing bytes / shifts following fields)`;
      // typeKey is shallow: if it matches, the change is *inside* a nested defined type.
      if (typeKey(o[i].type) === typeKey(n[i].type)) {
        reasons.push(
          `field "${o[i].name}" (index ${i}) keeps type ${typeKey(o[i].type)} but that referenced ` +
          `type's own layout changed${sizeHint}`);
      } else {
        reasons.push(
          `field "${o[i].name}" (index ${i}) changed type ${typeKey(o[i].type)} -> ${typeKey(n[i].type)}${sizeHint}`);
      }
      divergedAt = i;
      break;
    }

    if (!sameName && sameType) {
      // Pure rename: identical bytes at the same offset. Non-fatal; keep scanning.
      renameNotes.push(
        `field at index ${i} renamed "${o[i].name}" -> "${n[i].name}" (same type, byte-compatible on the ` +
        `wire, but clients/IDL consumers key on field names — confirm intent)`);
      continue;
    }

    // Name AND type differ at this position: insertion / removal / reorder.
    reasons.push(
      `field at index ${i} changed identity "${o[i].name}" (${typeKey(o[i].type)}) -> ` +
      `"${n[i].name}" (${typeKey(n[i].type)}) — insertion/removal/reorder; everything from index ${i} reads wrong`);
    divergedAt = i;
    break;
  }

  if (divergedAt !== -1 || breaking) {
    return { account: name, verdict: "BREAKING", reasons: [...reasons, ...renameNotes] };
  }

  // Prefix is layout-identical (modulo renames). The length difference decides.
  if (n.length > o.length) {
    const added = n.slice(o.length).map((f) => `${f.name}: ${typeKey(f.type)}`);
    reasons.push(`appended ${n.length - o.length} field(s) at the tail: ${added.join(", ")}`);
    reasons.push("old accounts are shorter and will fail to deserialize until realloc + backfill " +
                 "(see migration-codegen.md) or a versioned deserializer is used");
    return { account: name, verdict: "NEEDS_MIGRATION", reasons: [...reasons, ...renameNotes] };
  }
  if (n.length < o.length) {
    const removed = o.slice(n.length).map((f) => `${f.name}: ${typeKey(f.type)}`);
    reasons.push(
      `removed ${o.length - n.length} trailing field(s): ${removed.join(", ")} — old accounts still ` +
      `deserialize (borsh ignores the now-extra trailing bytes; the surviving prefix is byte-identical), ` +
      `but the removed data is orphaned and accounts stay over-allocated/over-rented. Reclaim space via ` +
      `realloc/re-init if it matters.`);
    return { account: name, verdict: "REVIEW", reasons: [...reasons, ...renameNotes] };
  }

  if (renameNotes.length) {
    return { account: name, verdict: "REVIEW", reasons: renameNotes };
  }
  return { account: name, verdict: "SAFE", reasons: ["no layout-affecting change"] };
}

// ---- Reporting -------------------------------------------------------------

const C = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function badge(v: Verdict): string {
  if (v === "BREAKING") return C.red("● BREAKING");
  if (v === "UNKNOWN") return C.magenta("● UNKNOWN");
  if (v === "NEEDS_MIGRATION") return C.yellow("● NEEDS MIGRATION");
  if (v === "REVIEW") return C.cyan("● REVIEW");
  return C.green("● SAFE");
}

function warn(msg: string): void {
  console.error(C.yellow(`warning: ${msg}`));
}

function fail(msg: string): never {
  console.error(C.red(`error: ${msg}`));
  process.exit(2);
}

// ---- Main ------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const [oldPath, newPath] = args.filter((a) => !a.startsWith("--"));
  if (!oldPath || !newPath) {
    fail("usage: layout-diff <old.idl.json> <new.idl.json> [--json] [--strict]");
  }
  for (const f of flags) {
    if (f !== "--json" && f !== "--strict") fail(`unknown flag: ${f}`);
  }

  const oldIdl = loadIdl(oldPath);
  const newIdl = loadIdl(newPath);
  const oldAcc = extractAccounts(oldIdl);
  const newAcc = extractAccounts(newIdl);
  const oldTypes = Array.isArray(oldIdl.types) ? oldIdl.types : [];
  const newTypes = Array.isArray(newIdl.types) ? newIdl.types : [];

  const names = new Set<string>([...oldAcc.keys(), ...newAcc.keys()]);
  const findings: Finding[] = [];
  for (const name of names) {
    findings.push(diffAccount(name, oldAcc.get(name), newAcc.get(name), oldTypes, newTypes));
  }
  const rank: Record<Verdict, number> = { BREAKING: 0, UNKNOWN: 1, NEEDS_MIGRATION: 2, REVIEW: 3, SAFE: 4 };
  findings.sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.account.localeCompare(b.account));

  const count = (v: Verdict) => findings.filter((f) => f.verdict === v).length;
  const breaking = count("BREAKING");
  const unknown = count("UNKNOWN");
  const migration = count("NEEDS_MIGRATION");
  const review = count("REVIEW");
  const safe = count("SAFE");

  if (flags.has("--json")) {
    console.log(JSON.stringify({
      summary: { breaking, unknown, needs_migration: migration, review, safe },
      findings,
    }, null, 2));
  } else {
    const oldName = oldIdl.metadata?.name ?? oldIdl.name ?? oldPath;
    const newName = newIdl.metadata?.name ?? newIdl.name ?? newPath;
    console.log(C.bold(`\nAccount layout diff  ${C.dim(oldName + " → " + newName)}\n`));
    for (const f of findings) {
      console.log(`${badge(f.verdict)}  ${C.bold(f.account)}`);
      for (const r of f.reasons) console.log(`    ${C.dim("•")} ${r}`);
    }
    console.log("\n" + C.bold("Summary: ") +
      `${C.red(breaking + " breaking")}, ` +
      `${C.magenta(unknown + " unknown")}, ` +
      `${C.yellow(migration + " need migration")}, ` +
      `${C.cyan(review + " review")}, ` +
      `${C.green(safe + " safe")}`);
    if (breaking) {
      console.log(C.red("\n✗ Upgrade is UNSAFE for existing accounts. Do not ship without a migration plan.\n"));
    } else if (unknown) {
      console.log(C.magenta("\n? Could not analyze some account(s) (unresolved struct). Verify by hand before shipping.\n"));
    } else if (migration) {
      console.log(C.yellow("\n! Upgrade adds fields. Ship the realloc/backfill path before or alongside the upgrade.\n"));
    } else if (review) {
      console.log(C.cyan("\n~ No byte-breaking change, but some items need a human look (see REVIEW above).\n"));
    } else {
      console.log(C.green("\n✓ No account-layout breaking changes detected.\n"));
    }
  }

  if (breaking) process.exit(1);
  if (flags.has("--strict") && (migration || unknown)) process.exit(1);
  process.exit(0);
}

main();
