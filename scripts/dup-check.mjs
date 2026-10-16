#!/usr/bin/env node
// dup-check.mjs - feat-20260514-ci-jscpd-duplication-gate jscpd wrapper.
//
// 9-step grep-gate idiom (mirrors apps/hello/triangle/scripts/m4-escape-
// hatch-grep-gate.mjs / m6-resource-creation-grep-gate.mjs / ac-08-grep-
// gate.mjs - research F-3, plan-strategy section D-P2). The wrapper does
// NOT trust jscpd's exit code (research F-2 callout: jscpd defaults to
// exitCode:0 even on detected duplicates) - it reads
// report/jscpd-report.json directly and emits its own exit 0 / 1 (R-4
// mitigation, architecture principle #5 Fail Fast).
//
// Exit codes:
//   0 = PASS (no clones survived post-process)
//   1 = FAIL (>= 1 clone survived; AC-20 zero-tolerance, no escape hatch)
//   2 = wrapper internal error (file missing, JSON parse failure, jscpd
//       spawn failure)
//
// CLI:
//   --report-path <path>            override report/jscpd-report.json
//                                   location (default:
//                                   report/jscpd-report.json relative
//                                   to repo root)
//   --skip-jscpd                    skip the jscpd subprocess call (test
//                                   harness anchor: drives
//                                   parseJscpdReport directly against a
//                                   pre-staged fixture file). The wrapper
//                                   still emits the
//                                   'JSON report saved to <path>' stdout
//                                   line so AC-22 / D-P6 path b survives
//                                   in this code path too.
//   --allow-pair <a::b>             repeated; in-test injection of
//                                   filePairIgnore unordered pairs (T-009
//                                   surface; the config/jscpd.json#filePairIgnore
//                                   field still feeds the wrapper through
//                                   the loadAllowList() helper).
//
// Configuration SSOT: config/jscpd.json. The wrapper does
// not duplicate jscpd configuration; it only consumes the JSON report
// jscpd writes per config/jscpd.json#output + config/jscpd.json#reporters, and the
// custom config/jscpd.json#filePairIgnore field that wrapper post-process owns
// (D-P1 - jscpd 4.x ignore is glob-only, no native file-pair support).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// === module-level constants ====================================================

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// === named exports: data structures + parser =================================

/**
 * Unordered pair of file paths. Two pairs compare equal whenever they hold
 * the same set of strings (order-insensitive). Self-pair {a, a} is allowed.
 *
 * Used by the post-process allow-list match (D-P1 / F-2) and by violation
 * dedup. The internal canonical key is a NUL-joined sorted tuple, safe for
 * Set membership.
 */
export class UnorderedFilePair {
  constructor(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
      throw new TypeError(`UnorderedFilePair expects two strings, got ${typeof a} + ${typeof b}`);
    }
    const sorted = a <= b ? [a, b] : [b, a];
    this.a = sorted[0];
    this.b = sorted[1];
    this.key = `${sorted[0]}\x00${sorted[1]}`;
  }
  equals(other) {
    return other instanceof UnorderedFilePair && this.key === other.key;
  }
}

export function unorderedFilePair(a, b) {
  return new UnorderedFilePair(a, b);
}

/**
 * @typedef {Object} ParsedClone
 * @property {UnorderedFilePair} pair
 * @property {{ name: string, start: number, end: number }} firstFile
 * @property {{ name: string, start: number, end: number }} secondFile
 * @property {number} lines
 * @property {number} tokens
 * @property {string} format
 */

/**
 * @typedef {Object} WrapperError
 * @property {'wrapper-internal-error'} code
 * @property {string} detail
 */

/**
 * Parse jscpd JSON report, normalising the duplicates[] array into
 * ParsedClone shape. Returns Result<{ duplicates }, WrapperError> instead
 * of throwing - the Result-style return is consumed by main() and turned
 * into exit 2 on the failure branch (Fail Fast).
 *
 * @param {string} jsonPath absolute path to jscpd-report.json
 * @returns {{ ok: true, value: { duplicates: ParsedClone[] } } | { ok: false, error: WrapperError }}
 */
export function parseJscpdReport(jsonPath) {
  if (!existsSync(jsonPath)) {
    return {
      ok: false,
      error: {
        code: 'wrapper-internal-error',
        detail: `jscpd JSON report not found at ${jsonPath} (does not exist)`,
      },
    };
  }
  let raw;
  try {
    raw = readFileSync(jsonPath, 'utf8');
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'wrapper-internal-error',
        detail: `cannot read ${jsonPath}: ${e.message}`,
      },
    };
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'wrapper-internal-error',
        detail: `cannot parse ${jsonPath} as JSON: ${e.message}`,
      },
    };
  }
  const dupes = Array.isArray(report?.duplicates) ? report.duplicates : [];
  const parsed = dupes.map((d) => normaliseClone(d));
  return { ok: true, value: { duplicates: parsed } };
}

function normaliseClone(d) {
  const fa = d.firstFile ?? {};
  const fb = d.secondFile ?? {};
  return {
    pair: unorderedFilePair(fa.name, fb.name),
    firstFile: { name: fa.name, start: fa.start, end: fa.end },
    secondFile: { name: fb.name, start: fb.start, end: fb.end },
    lines: d.lines,
    tokens: d.tokens,
    format: d.format,
  };
}

// === named exports: post-process placeholders (T-009 / T-010 fill in) ========

/**
 * Filter clones against an unordered file-pair allow-list. Each entry of
 * allowList is a [pathA, pathB] tuple; matching is set-semantic so
 * (Y, X) drops a clone reported as (X, Y) and {a, a} self-pairs are
 * supported. Allow-list entries take effect by canonical-key lookup
 * against UnorderedFilePair#key, so the loop is O(N) and order-stable.
 *
 * @param {ParsedClone[]} clones
 * @param {[string, string][]} allowList
 * @returns {{ kept: ParsedClone[], dropped: ParsedClone[] }}
 */
export function filterByAllowList(clones, allowList) {
  const allowKeys = new Set();
  for (const entry of allowList) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [a, b] = entry;
    if (typeof a !== 'string' || typeof b !== 'string') continue;
    allowKeys.add(unorderedFilePair(a, b).key);
  }
  const kept = [];
  const dropped = [];
  for (const c of clones) {
    if (allowKeys.has(c.pair.key)) dropped.push(c);
    else kept.push(c);
  }
  return { kept, dropped };
}

/**
 * Load the wrapper-owned config/jscpd.json#filePairIgnore custom field. Two
 * entry shapes are accepted (both yield the same [pathA, pathB] tuple
 * downstream):
 *
 *   - tuple form    : ["pathA", "pathB"]
 *   - object form   : {"files": ["pathA", "pathB"], "rationale": "..."}
 *
 * The object form carries an inline rationale string per pair (V-1
 * verify-round-1 feat-20260515-learn-render-getting-started: each new
 * file-pair must justify why it stays whitelisted instead of being
 * collapsed via shared helper). The rationale field is parser metadata
 * only - the post-process drop logic never reads it; it lives in the
 * config so AI users can grep-locate justification next to the pair.
 *
 * jscpd 4.1.1 ignores unknown top-level fields, so this stays SSOT-clean
 * (architecture principle #1) without a separate config file. Missing
 * field / non-array values collapse to []; malformed entries are silently
 * dropped (the schema is AI-user-authored, not third-party).
 *
 * @param {string} configPath absolute path to config/jscpd.json
 * @returns {[string, string][]}
 */
export function loadFilePairIgnore(configPath) {
  if (!existsSync(configPath)) return [];
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return [];
  }
  const raw = cfg?.filePairIgnore;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (Array.isArray(entry) && entry.length === 2) {
      const [a, b] = entry;
      if (typeof a === 'string' && typeof b === 'string') out.push([a, b]);
      continue;
    }
    if (
      entry &&
      typeof entry === 'object' &&
      Array.isArray(entry.files) &&
      entry.files.length === 2
    ) {
      const [a, b] = entry.files;
      if (typeof a === 'string' && typeof b === 'string') out.push([a, b]);
    }
  }
  return out;
}

/**
 * Format kept clones as one violation line per clone, grep-gate idiom
 * '<pathA>:<a1>-<a2> <-> <pathB>:<b1>-<b2> (lines=N, tokens=M, format=F)'.
 * Lines are joined with '\n' and the trailing newline is omitted - the
 * caller appends one when writing to stderr (so empty kept[] -> empty
 * string -> nothing written, AC-05 PASS-stderr-silence).
 *
 * Plan-strategy section 7.3 locks this exact wording: AI users grep
 * for '<->' to enumerate all violation pairs, and the (lines=N, tokens=M,
 * format=F) suffix is the structured channel. The ASCII '<->' arrow is
 * intentional (forgeax-english allows ASCII; this stays grep-stable
 * across terminals without unicode rendering).
 *
 * @param {ParsedClone[]} kept
 * @returns {string}
 */
export function formatViolation(kept) {
  if (kept.length === 0) return '';
  const lines = kept.map((c) => {
    const a = `${c.firstFile.name}:${c.firstFile.start}-${c.firstFile.end}`;
    const b = `${c.secondFile.name}:${c.secondFile.start}-${c.secondFile.end}`;
    return `${a} <-> ${b} (lines=${c.lines}, tokens=${c.tokens}, format=${c.format})`;
  });
  return lines.join('\n');
}

// === jscpd subprocess driver ==================================================

function spawnJscpd(configPaths) {
  const jscpdBin = join(REPO_ROOT, 'node_modules', '.bin', 'jscpd');
  return spawnSync(jscpdBin, ['--config', 'config/jscpd.json', ...configPaths], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: false,
  });
}

function loadConfigPaths() {
  const configPath = resolve(REPO_ROOT, 'config/jscpd.json');
  if (!existsSync(configPath)) return [];
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  return Array.isArray(cfg.path)
    ? cfg.path.map((path) => relative(REPO_ROOT, resolve(dirname(configPath), path)))
    : [];
}

// === main entry ===============================================================

function parseArgv(argv) {
  const args = {
    reportPath: 'report/jscpd-report.json',
    skipJscpd: false,
    allowPairs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--report-path' && argv[i + 1]) {
      args.reportPath = argv[++i];
    } else if (a === '--skip-jscpd') {
      args.skipJscpd = true;
    } else if (a === '--allow-pair' && argv[i + 1]) {
      const [x, y] = argv[++i].split('::');
      if (typeof x === 'string' && typeof y === 'string') {
        args.allowPairs.push([x, y]);
      }
    }
  }
  return args;
}

function emitInternalError(detail) {
  process.stderr.write(
    `[reason] dup-check: wrapper internal error - ${detail}\n` +
      `[rerun]  pnpm dup-check\n` +
      `[hint]   check report/jscpd-report.json file integrity\n`,
  );
}

/**
 * main(argv) - returns { exitCode } so callers (CLI guard or tests) can
 * decide how to surface it. Side effects: writes to stdout/stderr per the
 * grep-gate idiom contract.
 */
export async function main(argv) {
  const args = parseArgv(argv);
  const reportPath = resolve(REPO_ROOT, args.reportPath);

  // Step 3: spawn jscpd unless --skip-jscpd. The configuration SSOT is
  // config/jscpd.json (research F-1 / F-5 / F-6); jscpd 4.1.1 reads .path via
  // the wrapper's positional argv forwarding (research F-1 ingest gap).
  if (!args.skipJscpd) {
    let configPaths;
    try {
      configPaths = loadConfigPaths();
    } catch (e) {
      emitInternalError(`cannot parse config/jscpd.json: ${e.message}`);
      return { exitCode: 2 };
    }
    const spawn = spawnJscpd(configPaths);
    if (spawn.error) {
      emitInternalError(`jscpd spawn failed: ${spawn.error.message}`);
      return { exitCode: 2 };
    }
  }

  // Step 4: read report/jscpd-report.json (architecture principle #5
  // Fail Fast: trust the JSON, not the subprocess exit code per R-4).
  const parsed = parseJscpdReport(reportPath);
  if (!parsed.ok) {
    emitInternalError(parsed.error.detail);
    return { exitCode: 2 };
  }

  // Step 5: post-process clones[] - apply file-pair allow-list. Two
  // sources merged: config/jscpd.json#filePairIgnore (the SSOT for repo-level
  // RHI mirror exemptions) plus --allow-pair CLI args (in-test
  // injection). Both feed the same unordered-pair set semantics so the
  // wrapper does not branch on source.
  const configFilePairs = loadFilePairIgnore(resolve(REPO_ROOT, 'config/jscpd.json'));
  const allAllowPairs = configFilePairs.concat(args.allowPairs);
  const { kept } = filterByAllowList(parsed.value.duplicates, allAllowPairs);

  // Step 6 / 8: AC-22 / D-P6 path b - the wrapper surfaces the JSON
  // report path on stdout regardless of jscpd subprocess presence so AI
  // users have a single self-discovery channel for the structured
  // artefact (charter proposition 3 self-discovery contract). When jscpd
  // ran through stdio:inherit the line is jscpd's; in --skip-jscpd test
  // mode the wrapper emits the equivalent line itself.
  if (args.skipJscpd) {
    console.log(`JSON report saved to ${reportPath}`);
  }

  // Step 7: PASS / FAIL main line + violation dump (T-010 replaces).
  if (kept.length === 0) {
    console.log('=== Duplication check (jscpd 4.1.1) ===');
    console.log('');
    console.log('* (dup-check) PASS: 0 clones detected (threshold=0)');
    return { exitCode: 0 };
  }

  console.log('=== Duplication check (jscpd 4.1.1) ===');
  const violationDump = formatViolation(kept);
  if (violationDump.length > 0) process.stderr.write(`${violationDump}\n`);
  console.error(`* (dup-check) FAIL: ${kept.length} clone(s) survived`);
  // [reason] / [rerun] / [hint] 3-section footer (D-P7 / AC-21). The
  // hint surfaces the three-way fix path - AI users read it and pick
  // exactly one (architecture principle 4 explicit failure / charter
  // proposition 4). Wording locked by plan-strategy section 7.3 + D-P7;
  // grep contract: '\\[hint\\]' token AND each of the three keywords
  // (extract / filePairIgnore / minLines) appears literally.
  process.stderr.write(
    `\n[reason] dup-check: ${kept.length} clone(s) detected (lines>=30, tokens>=50)\n` +
      `[rerun]  pnpm dup-check\n` +
      `[hint]   extract shared helper at <suggested-path> ` +
      `OR add file-pair to config/jscpd.json#filePairIgnore with rationale ` +
      `OR raise minLines (PR description must justify per OOS-07/D-4)\n`,
  );
  return { exitCode: 1 };
}

// === CLI guard ================================================================

const invokedAsCli =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedAsCli) {
  const result = await main(process.argv.slice(2));
  process.exit(result.exitCode);
}
