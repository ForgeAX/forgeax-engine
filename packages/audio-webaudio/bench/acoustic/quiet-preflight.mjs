import { execFileSync } from 'node:child_process';
import { cpus, hostname, loadavg, platform } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inputIdentity } from './inputs.mjs';

// Read-only preflight; it never acquires or edits the physical-device lease.
// Apple sysctl returns the dispatch mask, not the internal VM-pressure enum:
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/event_private.h
if (platform() !== 'darwin' || !process.argv[2]) throw new Error('usage on the measurement Mac: node quiet-preflight.mjs <receipt.json>');
const root = fileURLToPath(new URL('../../../..', import.meta.url));
const inputs = await inputIdentity(root), samples = [];
const ticks = () => cpus().reduce((sum, cpu) => {
  sum.idle += cpu.times.idle;sum.total += Object.values(cpu.times).reduce((a, b) => a + b, 0);return sum;
}, { idle: 0, total: 0 });
const sysctl = key => execFileSync('sysctl', ['-n', key], { encoding: 'utf8' }).trim();
let previous = ticks();const started = performance.now();
for (let i = 0; i <= 12; i++) {
  if (i > 0) await new Promise(resolve => setTimeout(resolve, 5000));
  const now = ticks(), total = now.total - previous.total;
  const swapRaw = sysctl('vm.swapusage'), used = /used\s*=\s*([\d.]+)M/.exec(swapRaw);
  const pressureRaw = sysctl('kern.memorystatus_vm_pressure_level');
  samples.push({ at: new Date().toISOString(), elapsedMs: performance.now() - started,
    busyPercent: i === 0 ? null : total > 0 ? 100 * (1 - (now.idle - previous.idle) / total) : null,
    load1: loadavg()[0], pressureRaw, swapRaw, swapUsedMiB: used ? Number(used[1]) : null });
  previous = now;
}
const after = await inputIdentity(root);
const pass = inputs.dirty === '' && JSON.stringify(inputs) === JSON.stringify(after) && samples.at(-1).elapsedMs >= 60000 &&
  samples.every((s, i) => Number.isFinite(s.load1) && s.load1 <= 3 && s.pressureRaw === '1' && Number.isFinite(s.swapUsedMiB) &&
    (i === 0 || Number.isFinite(s.busyPercent) && s.busyPercent >= 0 && s.busyPercent <= 20 && s.swapUsedMiB <= samples[i - 1].swapUsedMiB));
const receipt = { status: pass ? 'pass' : 'fail', host: hostname(), inputs,
  endedAt: Date.now(), criteria: { durationMs: 60000, maximumCpuBusyPercent: 20, maximumLoad1: 3, memoryPressureDispatchMask: 1, swapGrowthMiB: 0 }, samples };
await writeFile(process.argv[2], `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ status: receipt.status, path: process.argv[2] }));
if (!pass) process.exitCode = 1;
