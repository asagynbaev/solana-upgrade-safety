#!/usr/bin/env node
/**
 * Integration tests for layout-diff — the real thing, end to end:
 *
 *   1. Drive the actual CLI against full-size, realistic Anchor 0.30+ IDL fixtures
 *      (a multi-account lending program with a nested struct, an enum, and a vec),
 *      and assert the complete --json report + exit code.
 *   2. Run the real install.sh into a temp project and execute the differ from the
 *      *installed* location against the *installed* fixtures — proving the published
 *      artifact path works and that node_modules / scratch files are not dragged in.
 *
 * No test framework. Run with `npm run test:integration` (tsx integration.test.ts).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REPO = join(HERE, "..");
const DIFF = join(HERE, "layout-diff.ts");
const FIX = join(REPO, "tests", "fixtures");
const WIN = process.platform === "win32";
const tsxBin = join(HERE, "node_modules", ".bin", WIN ? "tsx.cmd" : "tsx");

let pass = 0;
const failures: string[] = [];
function check(label: string, got: unknown, want: unknown) {
  if (got === want) { pass++; return; }
  failures.push(`✗ ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

interface Diff { exit: number; summary: Record<string, number>; verdicts: Record<string, string>; raw: string; }
function runDiff(bin: string, diffPath: string, a: string, b: string, ...flags: string[]): Diff {
  const r = spawnSync(bin, [diffPath, a, b, "--json", ...flags], { encoding: "utf8", shell: WIN });
  const out: Diff = { exit: r.status ?? -1, summary: {}, verdicts: {}, raw: (r.stdout ?? "") + (r.stderr ?? "") };
  try {
    const p = JSON.parse(r.stdout);
    out.summary = p.summary ?? {};
    for (const f of p.findings ?? []) out.verdicts[f.account] = f.verdict;
  } catch { /* non-JSON (bad input) */ }
  return out;
}

// ── 1. Realistic full-program diff ──────────────────────────────────────────
// v1 -> v2 deliberately exercises every verdict on real-shaped accounts:
//   Market      BREAKING        (nested RateModel struct gains reserveFactorBps)
//   Obligation  NEEDS_MIGRATION (emode appended at the tail)
//   Reserve     REVIEW          (liquidity -> availableLiquidity, same type)
//   PriceFeed   UNKNOWN         (account struct not in types[] — external oracle)
//   RewardVault SAFE            (brand-new account type in v2)
const d = runDiff(tsxBin, DIFF, join(FIX, "lending.v1.idl.json"), join(FIX, "lending.v2.idl.json"));
check("lending: Market verdict", d.verdicts.Market, "BREAKING");
check("lending: Obligation verdict", d.verdicts.Obligation, "NEEDS_MIGRATION");
check("lending: Reserve verdict", d.verdicts.Reserve, "REVIEW");
check("lending: PriceFeed verdict", d.verdicts.PriceFeed, "UNKNOWN");
check("lending: RewardVault verdict", d.verdicts.RewardVault, "SAFE");
check("lending: summary.breaking", d.summary.breaking, 1);
check("lending: summary.needs_migration", d.summary.needs_migration, 1);
check("lending: summary.review", d.summary.review, 1);
check("lending: summary.unknown", d.summary.unknown, 1);
check("lending: summary.safe", d.summary.safe, 1);
check("lending: exit code (breaking present)", d.exit, 1);

// reverse direction: the nested change is still BREAKING, and the tail-removed
// emode flips Obligation to REVIEW (trailing removal, byte-safe)
const rev = runDiff(tsxBin, DIFF, join(FIX, "lending.v2.idl.json"), join(FIX, "lending.v1.idl.json"));
check("lending reverse: Market still BREAKING", rev.verdicts.Market, "BREAKING");
check("lending reverse: Obligation REVIEW (trailing removal)", rev.verdicts.Obligation, "REVIEW");
check("lending reverse: RewardVault BREAKING (account removed)", rev.verdicts.RewardVault, "BREAKING");

// identical real IDL must be clean
const same = runDiff(tsxBin, DIFF, join(FIX, "lending.v1.idl.json"), join(FIX, "lending.v1.idl.json"));
check("lending identical: exit 0", same.exit, 0);
check("lending identical: Market SAFE", same.verdicts.Market, "SAFE");

// ── 2. End-to-end install flow ──────────────────────────────────────────────
const installSh = join(REPO, "install.sh");
const hasBash = spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;
if (!hasBash || !existsSync(installSh)) {
  console.warn("! skipping install.sh end-to-end test (needs bash + install.sh; still runs in CI)");
} else {
  const target = mkdtempSync(join(tmpdir(), "sus-install-"));
  try {
    const inst = spawnSync("bash", [installSh, target], { encoding: "utf8" });
    check("install.sh exit 0", inst.status, 0);

    const skillDir = join(target, ".claude", "skills", "solana-upgrade-safety");
    const instDiff = join(skillDir, "scripts", "layout-diff.ts");
    check("installed: layout-diff.ts present", existsSync(instDiff), true);
    check("installed: test.ts present", existsSync(join(skillDir, "scripts", "test.ts")), true);
    check("installed: SKILL.md present", existsSync(join(skillDir, "SKILL.md")), true);
    check("installed: example fixtures present", existsSync(join(skillDir, "examples", "vault.v1.idl.json")), true);
    check("installed: command present", existsSync(join(target, ".claude", "commands", "check-upgrade.md")), true);

    // installer must NOT drag in node_modules / lockfile / scratch
    const scriptsDir = join(skillDir, "scripts");
    const copied = existsSync(scriptsDir) ? readdirSync(scriptsDir) : [];
    check("installed: no node_modules copied", copied.includes("node_modules"), false);
    check("installed: no package-lock copied", copied.includes("package-lock.json"), false);
    check("installed: no scratch json copied", copied.some((f) => f.startsWith("def_") || f.startsWith("tmp-")), false);

    // run the differ FROM the installed copy against the installed example fixtures
    if (existsSync(instDiff)) {
      const exV1 = join(skillDir, "examples", "vault.v1.idl.json");
      const exV2 = join(skillDir, "examples", "vault.v2.idl.json");
      const exV3 = join(skillDir, "examples", "vault.v3.idl.json");
      check("installed run: v1->v2 BREAKING exit 1", runDiff(tsxBin, instDiff, exV1, exV2).exit, 1);
      check("installed run: v1->v3 NEEDS_MIGRATION exit 0", runDiff(tsxBin, instDiff, exV1, exV3).exit, 0);
      check("installed run: v1->v3 --strict exit 1", runDiff(tsxBin, instDiff, exV1, exV3, "--strict").exit, 1);
      check("installed run: v1->v1 SAFE exit 0", runDiff(tsxBin, instDiff, exV1, exV1).exit, 0);
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n${failures.join("\n")}\n\n${pass} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`\n✓ all ${pass} integration assertions passed`);
process.exit(0);
