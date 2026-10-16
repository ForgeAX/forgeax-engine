#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function commitRows(base) {
  const log = git(['log', '--format=%H%x09%s', `${base}..HEAD`]);
  if (log.length === 0) return [];
  return log.split('\n').map((line) => {
    const [sha, ...subjectParts] = line.split('\t');
    const subject = subjectParts.join('\t');
    const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha])
      .split('\n')
      .filter(Boolean);
    const task = subject.match(/\[(m\d+_t\d+)\]/)?.[1];
    return { sha, subject, task, files };
  });
}

const siblingOwners = new Map([
  ['packages/import/src/scriptable-pack-file-snapshot.ts', 'import package owner'],
  ['packages/app/src/assets-runtime-assembly.ts', 'app assembly owner'],
  ['packages/devkit/src/shared-inputs.ts', 'devkit owner'],
  ['docs/vite-plugin-pack.md', 'vite-plugin-pack documentation owner'],
]);

function ownerForPath(path, subject) {
  const exact = siblingOwners.get(path);
  if (exact !== undefined) return exact;
  if (subject.startsWith('feat(app):')) return 'app assembly owner';
  if (subject.startsWith('feat(import):')) return 'import package owner';
  if (subject.startsWith('feat(vite-plugin-pack):')) return 'vite-plugin-pack/devkit owner';
  if (subject.startsWith('docs(vite-plugin-pack):')) return 'vite-plugin-pack documentation owner';
  if (subject.includes('mechanical CI fix')) return 'milestone mechanical-fix owner';
  return undefined;
}

const repoRoot = git(['rev-parse', '--show-toplevel']);
const base = git(['merge-base', 'HEAD', 'origin/main']);
const rows = commitRows(base).map((row) => ({
  ...row,
  scope: row.task !== undefined ? 'feature-task' : 'unattributed-history',
  files: row.files.map((path) => ({
    path,
    owner:
      row.task !== undefined
        ? 'feature envelope'
        : (ownerForPath(path, row.subject) ?? 'unclassified'),
    inFeatureEnvelope: row.task !== undefined,
  })),
}));
const unclassified = rows.flatMap((row) =>
  row.files
    .filter((file) => file.owner === 'unclassified')
    .map((file) => `${row.sha}:${file.path}`),
);
const unattributed = rows.filter((row) => row.task === undefined);
const report = {
  status: unclassified.length === 0 ? 'audited-with-owner-notes' : 'insufficient-evidence',
  repository: repoRoot,
  head: git(['rev-parse', 'HEAD']),
  mergeBase: base,
  comparison: `${base}...HEAD`,
  commits: rows,
  unattributedCommits: unattributed.map(({ sha, subject }) => ({ sha, subject })),
  unclassifiedFiles: unclassified,
  notes: [
    'This is a three-point merge-base audit; it does not rewrite or delete history.',
    'A task tag proves feature-envelope attribution, not ownership of unrelated files.',
    'Unattributed sibling files remain visible with their package owner note and are not reported as feature work.',
  ],
};

const reportPath = resolve(
  process.cwd(),
  process.env.FORGEAX_SCOPE_AUDIT_REPORT ?? 'artifacts/renderer-device-loss/scope-audit.json',
);
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`base=${base}`);
console.log(`head=${report.head}`);
for (const row of rows) {
  const task = row.task ?? 'unattributed';
  const files = row.files.map((file) => `${file.path} (${file.owner})`).join(', ');
  console.log(`commit=${row.sha} task=${task} scope=${row.scope} files=${files}`);
}
console.log(`report=${reportPath}`);
console.log(`status=${report.status}`);
if (unclassified.length > 0) process.exitCode = 1;
