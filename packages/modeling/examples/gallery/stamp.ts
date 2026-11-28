// Merges the per-script parts into summary.json and writes provenance.txt. Run last (run.sh does). It fails when a
// registered PNG is missing or its sha256 differs from the file on disk, and refuses to call a dirty tree a stamp.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT } from './common.ts';

const PART_ORDER = [
  'before-merge',
  'rows-modes',
  'rows-iso',
  'rows-ssi',
  'rows-s2',
  'rows-extras',
  'rows-reruns',
];

interface Part {
  rows: Record<string, unknown>[];
  pngSha256: Record<string, string>;
}

const sha = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
const git = (...args: string[]): string =>
  execFileSync('git', args, {
    encoding: 'utf8',
    cwd: new URL('../../', import.meta.url).pathname,
  }).trim();

const partsDir = join(OUT, '.parts');
const present = readdirSync(partsDir).map((f) => f.replace(/\.json$/, ''));
const missing = PART_ORDER.filter((p) => !present.includes(p));
if (missing.length > 0) throw new Error(`missing parts: ${missing.join(', ')}`);

const rows: Record<string, unknown>[] = [];
const pngSha256: Record<string, string> = {};
const rowsPerPart: Record<string, number> = {};
for (const name of PART_ORDER) {
  const part = JSON.parse(readFileSync(join(partsDir, `${name}.json`), 'utf8')) as Part;
  rowsPerPart[name] = part.rows.length;
  for (const row of part.rows) rows.push({ part: name, ...row });
  for (const [rel, digest] of Object.entries(part.pngSha256)) {
    if (rel in pngSha256 && pngSha256[rel] !== digest)
      throw new Error(`png written twice with different bytes: ${rel}`);
    pngSha256[rel] = digest;
  }
}
for (const [rel, digest] of Object.entries(pngSha256)) {
  if (sha(readFileSync(join(OUT, rel))) !== digest)
    throw new Error(`png on disk differs from its registry: ${rel}`);
}
const sorted = Object.fromEntries(Object.entries(pngSha256).sort(([a], [b]) => a.localeCompare(b)));
const summaryPath = join(OUT, 'summary.json');
writeFileSync(
  summaryPath,
  `${JSON.stringify({ pngCount: Object.keys(sorted).length, rowsPerPart, rows, pngSha256: sorted }, null, 2)}\n`,
);
const summarySha = sha(readFileSync(summaryPath));

const head = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain')
  .split('\n')
  .filter((l) => l !== '');
const recheck = sha(readFileSync(summaryPath));
const lines = [
  'gallery-1 provenance',
  `head: ${head}`,
  `branch: ${git('rev-parse', '--abbrev-ref', 'HEAD')}`,
  `tree: ${dirty.length === 0 ? 'clean (git status --porcelain empty)' : `DIRTY (${dirty.length} entries)`}`,
  `utc: ${new Date().toISOString()}`,
  'command: examples/gallery/run.sh',
  `exit: ${process.env.GALLERY_EXIT ?? '0'}`,
  `png count: ${Object.keys(sorted).length}`,
  `summary.json sha256: ${summarySha}`,
  `summary.json sha256 re-check after last write: ${recheck === summarySha ? 'match' : `MISMATCH ${recheck}`}`,
];
writeFileSync(join(OUT, 'provenance.txt'), `${lines.join('\n')}\n`);
rmSync(partsDir, { recursive: true, force: true });
rmSync(join(OUT, '.raw'), { recursive: true, force: true });
// biome-ignore lint/suspicious/noConsole: example script output
console.log(lines.join('\n'));
if (dirty.length > 0 || recheck !== summarySha) process.exitCode = 1;
