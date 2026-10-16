#!/usr/bin/env node
// check-workflow-ssot.mjs (M3 w13) - workflow SSOT lint.
// Enforces composite-action reuse for chrome-beta installation across the
// repo's GitHub workflow ymls (todo-059 split A: composite action). Two
// invariants:
//   (i) `uses: ./.github/actions/install-playwright-chrome-beta` appears
//       in >= 2 yml files (otherwise the composite action is dead weight).
//   (ii) no yml has an inline `playwright install --with-deps chrome-beta`
//       (chromium installs are unrelated and allowed).
// stderr is 3-section structured: [reason] / [rerun] / [hint] (matches the
// drift detector family pattern, plan-strategy §7.3).
// Family baseline: <= 80 LOC + 0 npm deps + structured stderr (architecture
// principle #5 Fail Fast).
// Usage: node scripts/check-workflow-ssot.mjs [--root <dir>]
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
let root = process.cwd();
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root' && argv[i + 1]) root = argv[++i];
}
root = resolve(root);

function fail(code, expected, hint) {
  process.stderr.write(
    `[reason] ${code}: ${expected}\n[rerun]  pnpm metrics:check\n[hint]   ${hint}\n`,
  );
  process.exit(1);
}

const wfDir = `${root}/.github/workflows`;
let entries;
try {
  entries = readdirSync(wfDir);
} catch (e) {
  fail(
    'workflow-ssot-no-workflows-dir',
    `${wfDir} is a readable workflows directory`,
    `re-run from repo root or pass --root <repo>; underlying: ${e.message}`,
  );
}
const ymls = entries
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => `${wfDir}/${f}`);

const COMPOSITE_TARGET = 'uses: ./.github/actions/install-playwright-chrome-beta';
let compositeUses = 0;
const inlineHits = [];
for (const fp of ymls) {
  const text = readFileSync(fp, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(COMPOSITE_TARGET)) compositeUses += 1;
    const noComment = line.replace(/#.*$/, '');
    if (/playwright\s+install\b/.test(noComment) && /chrome-beta/.test(noComment)) {
      inlineHits.push(`${fp}:${i + 1}: ${line.trim()}`);
    }
  }
}

if (inlineHits.length > 0) {
  fail(
    'workflow-ssot-inline-chrome-beta',
    'no yml installs chrome-beta inline; install-playwright-chrome-beta composite action is the SSOT',
    `inline drift hits:\n         ${inlineHits.join('\n         ')}\n         migrate to: uses: ./.github/actions/install-playwright-chrome-beta`,
  );
}
if (compositeUses < 2) {
  fail(
    'workflow-ssot-composite-undercount',
    'install-playwright-chrome-beta composite action is reused in >= 2 yml files',
    `found ${compositeUses} usage(s); add 'uses: ./.github/actions/install-playwright-chrome-beta' to the second yml or delete the composite action and revert callers to inline`,
  );
}
process.stdout.write(
  `[ok] install-playwright-chrome-beta composite action reused in ${compositeUses} yml file(s); no inline chrome-beta drift\n`,
);
