// Scenario matrix runner: each (cell, N) is one fresh run.mjs process into a new directory.
//   node matrix.mjs --out NEW_DIR --cells static,move-d8 --sizes 10,100,1000 [--frames 60] [--warmup 16] [--backend stub]
//        [--profile cpu] [--objects auto|0|1] [--rerun auto|0] [--frontline-game-root P --frontline-game-dist P]
// `--cells all` selects every cell; `frontline` is the game workload (N >= 1000, 600 frames by default).
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cells } from './workload.mjs';
import { markdown, summarize } from './matrix-summary.mjs';

const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => process.argv.slice(2 + i * 2, 4 + i * 2)));
assert(args['--out'], '--out NEW_DIRECTORY is required');
const output = resolve(args['--out']);
const selected = args['--cells'] === undefined || args['--cells'] === 'all' ? Object.keys(cells) : args['--cells'].split(',');
for (const id of selected) assert(cells[id] || id === 'frontline', `unknown cell ${id}; known: ${Object.keys(cells).join(', ')}, frontline`);
const sizes = (args['--sizes'] ?? '10,100,1000,10000').split(',').map(Number);
assert(sizes.every(n => Number.isSafeInteger(n) && n >= 8));
const frames = Number(args['--frames'] ?? 60), warmup = Number(args['--warmup'] ?? 16);
const objectsMode = args['--objects'] ?? 'auto', rerunMode = args['--rerun'] ?? 'auto';
const heapOptions = args['--max-old-space'] ?? '8192';
const backendOf = id => args['--backend'] ?? cells[id]?.backend ?? 'stub';
const uptime = () => execFileSync('uptime', { encoding: 'utf8' }).trim().replace(/^.*load averages?: /, '').split(/[ ,]+/)[0];

async function runOnce(id, count, dir) {
  const frontline = id === 'frontline';
  const wantObjects = objectsMode === '1' || (objectsMode === 'auto' && count <= 100000);
  const flags = frontline
    ? ['--workload', 'frontline', '--game-root', args['--frontline-game-root'], '--game-dist', args['--frontline-game-dist'], '--frames', String(args['--frames'] ?? 600)]
    : ['--cell', id, '--frames', String(frames)];
  const argv = [`--max-old-space-size=${heapOptions}`, resolve(import.meta.dirname, 'run.mjs'), '--out', dir, '--count', String(count), '--warmup', String(warmup),
    '--backend', backendOf(id), ...flags, ...(wantObjects ? ['--objects', '1'] : []), ...(args['--profile'] ? ['--profile', args['--profile']] : []),
    ...(args['--settle-ms'] ? ['--settle-ms', args['--settle-ms']] : [])];
  const load = uptime();
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.stdout.resume();
    child.on('error', reject);
    child.on('close', (code, signal) => done({ code, signal, stderr: stderr.slice(-2000) }));
  });
  let report;
  try { report = JSON.parse(await readFile(resolve(dir, 'report.json'), 'utf8')); }
  catch { report = { status: 'failed', config: { cell: id, count }, failure: { message: `process exit code=${result.code} signal=${result.signal}: ${result.stderr.split('\n').slice(-3).join(' ')}` } }; }
  return { report, load, result };
}

await mkdir(output, { recursive: false });
const rows = [];
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
for (const id of selected) for (const count of sizes) {
  if (id === 'frontline' && count < 1000) continue;
  const base = resolve(output, id, String(count));
  console.log(`begin ${id} N=${count}`);
  await mkdir(resolve(output, id), { recursive: true });
  let { report, load } = await runOnce(id, count, base);
  let row = summarize(report, { cell: id, uptime: load, outDir: base });
  // One rerun for a noisy cell: p95 well above p50 (host contention), keep the lower-p50 run and flag it.
  if (rerunMode === 'auto' && row.status === 'complete' && row.total.p95 > 2.5 * row.total.p50 && row.total.p50 > 0.2) {
    const again = await runOnce(id, count, `${base}-rerun`);
    const second = summarize(again.report, { cell: id, uptime: again.load, rerun: true, outDir: `${base}-rerun` });
    if (second.status === 'complete' && second.total.p50 <= row.total.p50) row = second;
    else row = { ...row, rerun: true };
  }
  rows.push(row);
  console.log(JSON.stringify({ cell: id, N: count, status: row.status, rnd: row.render?.p50, src: row.source?.p50, load }));
  await writeFile(resolve(output, 'matrix.json'), JSON.stringify({ sourceHead, frames, warmup, backend: args['--backend'] ?? 'stub (recovery: dawn)', qualification: 'diagnostic; shared host under load', rows }, null, 2));
}
await writeFile(resolve(output, 'matrix.md'), markdown(rows, { title: `Scenario matrix ${output}`, notes: [`head ${sourceHead}, backend ${args['--backend'] ?? 'stub (recovery: dawn)'}, ${frames} frames, diagnostic only (shared host; load column is uptime at run start).`] }));
console.log(resolve(output, 'matrix.md'));
