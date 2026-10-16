#!/usr/bin/env node
// render-sticky.mjs (M5 w22) - sticky comment composer for the CI metrics
// report tree produced by scripts/metrics/run-all.mjs (M5 w19).
//
// Layout (plan-strategy K-10 + AC-15):
//   - Title literal '### forgeax-engine metrics report' on the first line.
//   - Summary table (only rows where status !== 'ok' + an overview line
//     'total: N/M packages x kinds passed') capped at 30 lines.
//   - <details><summary>complete metrics details (<count> entries)</summary>
//     full matrix listing every (package, kind, value, threshold, status)
//     row, followed by the producer's per-entry evidence. No metric rows are dropped.
//   - The body is markdown only (no images, no emoji, no colour codes) so
//     the same text is consumable by AI users, pipes, and humans alike
//     (charter proposition 3 machine-readable union > prose).
//
// Usage:
//   node scripts/metrics/render-sticky.mjs [--report-dir <dir>] [--out <path>] [--stdout]
//   --report-dir default = <repo-root>/report
//   --out        default = <report-dir>/sticky-comment.md (mkdir -p as needed)
//   --stdout     also echo the rendered markdown to process.stdout
//   --ci-context prepend FORGEAX_CI_NEEDS gate outcomes to the existing report;
//                missing failed/skipped producer bodies remain explicit evidence.
//
// Reference:
//   - requirements §AC-07 / §AC-15
//   - plan-strategy §K-10 / §7.4 / §7.5

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(here, '..', '..');

const argv = process.argv.slice(2);
const args = { stdout: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--report-dir' && argv[i + 1]) {
    args.reportDir = argv[++i];
  } else if (a === '--out' && argv[i + 1]) {
    args.out = argv[++i];
  } else if (a === '--stdout') {
    args.stdout = true;
  } else if (a === '--ci-context') {
    args.ciContext = true;
  }
}

const reportDir = resolve(args.reportDir ?? `${defaultRepoRoot}/report`);
const outPath = resolve(args.out ?? `${reportDir}/sticky-comment.md`);

const KIND_ORDER = JSON.parse(
  readFileSync(resolve(defaultRepoRoot, 'schemas/forgeax-metrics.schema.json'), 'utf8'),
).required;
const SUMMARY_CAP = 30;

function listEntries(rootDir) {
  if (!existsSync(rootDir)) return [];
  const entries = [];
  for (const pkg of readdirSync(rootDir).sort()) {
    const pkgDir = `${rootDir}/${pkg}`;
    if (!statSync(pkgDir).isDirectory()) continue;
    for (const file of readdirSync(pkgDir).sort()) {
      const kind = file.replace(/\.json$/, '');
      if (file !== `${kind}.json` || !KIND_ORDER.includes(kind)) continue;
      try {
        const entry = JSON.parse(readFileSync(`${pkgDir}/${file}`, 'utf8'));
        if (entry?.package !== pkg || entry.kind !== kind || typeof entry.status !== 'string') {
          throw new Error('invalid metric identity or status');
        }
        entries.push(entry);
      } catch (error) {
        entries.push({
          package: pkg,
          kind: file.replace(/\.json$/, ''),
          status: 'unavailable',
          value: null,
          threshold: null,
          details: { message: 'invalid metric report', cause: error.message },
        });
      }
    }
  }
  entries.sort((a, b) => {
    const pa = a.package ?? '';
    const pb = b.package ?? '';
    if (pa !== pb) return pa.localeCompare(pb);
    return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  });
  return entries;
}

// pixelDiff bench detection: feat-20260512 M3 T-015 introduces a second
// flavour of MetricKind 'bench' whose dispatcher returns details.unit
// === 'pixels' (Layer B aggregate cap). This helper centralises the
// branch so both formatValue + formatThreshold stay aligned (Schema as
// Contract: details.unit is the discriminator anchor).
function isPixelDiffBench(entry) {
  return entry.kind === 'bench' && entry.details?.unit === 'pixels';
}

function benchMeasurement(entry) {
  if (entry.details?.reportSchema === 'gpu-frame-samples') {
    return { scale: 100, unit: '% GPU median improvement', comparison: '>=' };
  }
  if (entry.details?.reportSchema === 'vfx-batch-b') {
    return { scale: 1, unit: ' ms p95', comparison: '<=' };
  }
  return { scale: 1, unit: ' ns/op', comparison: '<=' };
}

function formatValue(entry) {
  if (entry.value === null || entry.value === undefined) return 'n/a';
  const v = entry.value;
  if (entry.kind === 'bundle-size') {
    const kb = (v / 1024).toFixed(2);
    return `${v} bytes (${kb} KB)`;
  }
  if (isPixelDiffBench(entry)) {
    const pp = entry.details?.perPixelThreshold;
    const ppFragment = typeof pp === 'number' ? `, perPixel=${pp}` : '';
    return `pixelDiff: ${v} pixels${ppFragment}`;
  }
  if (entry.kind === 'bench') {
    const measurement = benchMeasurement(entry);
    return `${typeof v === 'number' ? (v * measurement.scale).toFixed(2) : v}${measurement.unit}`;
  }
  if (entry.kind === 'fps') {
    return `${typeof v === 'number' ? v.toFixed(2) : v} fps`;
  }
  return String(v);
}

function formatThreshold(entry) {
  if (entry.threshold === null || entry.threshold === undefined) return 'n/a';
  if (entry.kind === 'bundle-size') {
    const kb = (entry.threshold / 1024).toFixed(2);
    return `<= ${entry.threshold} bytes (${kb} KB)`;
  }
  if (isPixelDiffBench(entry)) return `<= ${entry.threshold} pixels`;
  if (entry.kind === 'bench') {
    const measurement = benchMeasurement(entry);
    const threshold = entry.threshold * measurement.scale;
    const value = measurement.scale === 1 ? String(threshold) : threshold.toFixed(2);
    return `${measurement.comparison} ${value}${measurement.unit}`;
  }
  if (entry.kind === 'fps') return `>= ${entry.threshold} fps`;
  return String(entry.threshold);
}

function tableHeader() {
  return ['| package | kind | value | target | status |', '| --- | --- | --- | --- | --- |'];
}

function tableRow(entry) {
  return `| ${entry.package} | ${entry.kind} | ${formatValue(entry)} | ${formatThreshold(entry)} | ${entry.status} |`;
}

function trimToCap(lines, cap, more) {
  if (lines.length <= cap) return lines;
  const kept = lines.slice(0, cap - 1);
  kept.push(`| ... | ... | ... | ... | (${more - kept.length} more, see <details>) |`);
  return kept;
}

function workflowIdentity() {
  const lines = [];
  const productHead = process.env.EXPECTED_PRODUCT_SHA || process.env.GITHUB_SHA;
  if (productHead) {
    lines.push(`Head: \`${productHead}\``);
    if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== productHead) {
      lines.push(`Workflow event SHA: \`${process.env.GITHUB_SHA}\``);
    }
    if (process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY) {
      const url = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
      lines.push(
        `Workflow: [${process.env.GITHUB_RUN_ID}](${url}); attempt ${process.env.GITHUB_RUN_ATTEMPT ?? 'unknown'}.`,
      );
    }
    lines.push('');
  }
  return lines;
}

function render(entries) {
  const okEntries = entries.filter((e) => e.status === 'ok');
  const failed = entries.filter((e) => e.status !== 'ok');
  const total = entries.length;
  const passed = okEntries.length;

  const lines = ['### forgeax-engine metrics report', '', ...workflowIdentity()];
  lines.push(
    'Metric status is separate from overall CI acceptance. `n/a` target means no threshold was declared; an `ok` row does not establish an undeclared performance budget.',
  );
  lines.push('');
  if (total === 0) {
    lines.push('_no metrics report files found under report/. Did `pnpm metrics:run` run?_');
    lines.push('');
  } else if (failed.length === 0) {
    lines.push(`total: ${passed}/${total} (package x kind) entries passed (all status=ok)`);
    lines.push('');
  } else {
    lines.push(...tableHeader());
    const failedRows = failed.map(tableRow);
    const summaryHeaderLines = 5;
    const overviewLine = `total: ${passed}/${total} (package x kind) entries passed`;
    const trimmed = trimToCap(failedRows, SUMMARY_CAP - summaryHeaderLines - 1, failed.length);
    lines.push(...trimmed);
    lines.push(overviewLine);
    lines.push('');
  }

  lines.push('| kind | reported | ok | non-ok |', '|:--|--:|--:|--:|');
  for (const kind of KIND_ORDER) {
    const rows = entries.filter((entry) => entry.kind === kind);
    const ok = rows.filter((entry) => entry.status === 'ok').length;
    lines.push(`| ${kind} | ${rows.length} | ${ok} | ${rows.length - ok} |`);
  }
  lines.push('');

  const detailsLines = [];
  detailsLines.push('<details>');
  detailsLines.push(`<summary>complete metrics details (${total} entries)</summary>`);
  detailsLines.push('');
  detailsLines.push(...tableHeader());
  detailsLines.push(...entries.map(tableRow));
  detailsLines.push('');
  detailsLines.push('</details>');
  lines.push(...detailsLines);
  lines.push('');

  lines.push('<details>', '<summary>Producer evidence and failure details</summary>', '');
  for (const entry of entries) {
    lines.push(`#### ${entry.package} / ${entry.kind}`, '');
    lines.push(`Report file: \`${entry.package}/${entry.kind}.json\``, '');
    lines.push(
      '```json',
      JSON.stringify(entry.details ?? {}, null, 2).replaceAll('`', '\\u0060'),
      '```',
      '',
    );
  }
  lines.push('</details>', '');

  return lines.join('\n');
}

function renderCiContext() {
  const needs = JSON.parse(process.env.FORGEAX_CI_NEEDS ?? 'null');
  if (!needs || Array.isArray(needs) || typeof needs !== 'object') {
    throw new Error('FORGEAX_CI_NEEDS must contain the workflow needs object');
  }
  const jobs = Object.entries(needs).sort(([a], [b]) => a.localeCompare(b));
  if (jobs.length === 0 || jobs.some(([, job]) => typeof job?.result !== 'string')) {
    throw new Error('FORGEAX_CI_NEEDS must contain producer-owned gate results');
  }
  const bodyPath = resolve(reportDir, 'sticky-comment.md');
  const body = existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8') : '';
  const lines = ['### forgeax-engine CI report', '', ...workflowIdentity()];
  lines.push(
    'Aggregate CI gate results below come from the workflow `needs` projection. Inspect the linked workflow for the full job/shard roster and failure logs. Metric status remains separate from complete CI acceptance.',
    '',
    '| gate | result |',
    '|:--|:--|',
    ...jobs.map(([name, job]) => `| ${name} | ${job.result} |`),
    '',
    '<details>',
    '<summary>Gate producer outputs</summary>',
    '',
    '```json',
    JSON.stringify(
      Object.fromEntries(jobs.map(([name, job]) => [name, job.outputs ?? {}])),
      null,
      2,
    ).replaceAll('`', '\\u0060'),
    '```',
    '',
    '</details>',
    '',
  );
  if (body.trim()) {
    lines.push(body);
  } else {
    lines.push(
      '> [!WARNING] Metric report unavailable; the producer supplied no report body.',
      '',
      `Metric producer result: \`${needs['metrics-validate']?.result ?? 'not-provided'}\`. Read the gate outcomes and workflow logs above.`,
      '',
    );
    if (needs['metrics-validate']?.result === 'success') {
      process.stderr.write('successful metrics producer has no report body\n');
      process.exitCode = 1;
    }
  }
  return lines.join('\n');
}

const markdown = args.ciContext ? renderCiContext() : render(listEntries(reportDir));

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
if (args.stdout) {
  process.stdout.write(markdown.endsWith('\n') ? markdown : `${markdown}\n`);
}
