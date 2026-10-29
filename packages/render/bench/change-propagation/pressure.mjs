import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory, phase = 'mixed', sizes = '1000,10000,100000,1000000', ...options] = process.argv.slice(2);
assert(directory, 'pressure.mjs NEW_OUTPUT_DIRECTORY [PHASE] [COMMA_SEPARATED_COUNTS] [--workload frontline --game-root PATH --game-dist PATH]');
assert.equal(options.length % 2, 0, 'options require values');
const flags = Object.fromEntries(Array.from({ length: options.length / 2 }, (_, i) => options.slice(i * 2, i * 2 + 2)));
for (const key of Object.keys(flags)) assert(['--workload', '--game-root', '--game-dist', '--chunk-policy', '--frames', '--objects', '--backend'].includes(key), `unknown option ${key}`);
const frames = Number(flags['--frames'] ?? (flags['--workload'] === 'frontline' ? 600 : 60));
assert(Number.isSafeInteger(frames) && frames > 0);
const output = resolve(directory);
await mkdir(output, { recursive: false });
const counts = sizes.split(',').map(Number);
assert(counts.every(n => Number.isSafeInteger(n) && n >= 1000));
const results = [];
for (const count of counts) {
  const out = resolve(output, String(count));
  console.log(`begin N=${count}, ${flags['--workload'] ?? 'mixed'}, ${frames} frames`);
  const args = ['--max-old-space-size=8192', fileURLToPath(new URL('./run.mjs', import.meta.url)), '--out', out,
    '--count', String(count), '--dirty', '8', '--users', '128', '--warmup', '16', '--phase', phase,
    ...Object.entries({ '--objects': '1', ...flags, '--frames': String(frames) }).flat()];
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code, signal) => done({ count, code, signal, stdout, stderr, args }));
  });
  await writeFile(resolve(output, `${count}-process.json`), JSON.stringify(result, null, 2));
  results.push(result);
  console.log(result.stdout.trim() || result.stderr.slice(-1500));
  // A failed scale is evidence, not permission to silently reduce N or frames.
  if (result.code !== 0) { process.exitCode = 1; break; }
}
const reports = [];
for (const result of results) {
  const report = resolve(output, String(result.count), 'report.json');
  try { await readFile(report); }
  catch {
    await writeFile(report, JSON.stringify({ status: 'failed', config: { count: result.count, dirty: 8, users: 128, phase, frames, warmup: 16, workload: flags['--workload'] ?? 'mixed' },
      sourceHead: 'unavailable-before-native-abort', sourceDeltaSha256: 'unavailable', backend: flags['--backend'] ?? 'stub', raw: [],
      timingQualification: 'native failure; no completed performance window',
      failure: { message: `native process exited code=${result.code}, signal=${result.signal}; see ${result.count}-process.json` } }, null, 2), { flag: 'wx' });
  }
  reports.push(report);
}
if (reports.length) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./table.mjs', import.meta.url)), resolve(output, 'scaling.md'), ...reports], { stdio: 'inherit' });
  await new Promise((done, reject) => { child.on('error', reject); child.on('close', code => { if (code) process.exitCode = code; done(); }); });
}
