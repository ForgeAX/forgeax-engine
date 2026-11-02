// Borrowed-view CPU control over actual managed storage. No scene/GPU claim.
// node memory-pool-view.mjs <index.mjs> [calls=40000000]
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const [entry, count = '40000000'] = process.argv.slice(2);
const calls = Number(count);
assert.ok(entry && Number.isSafeInteger(calls) && calls > 0 && calls <= 200000000);
const { World } = await import(pathToFileURL(entry));
// Package-owned diagnostic; raw slot IDs are not a public capability.
const pool = new World()[Symbol.for('forgeax.ecs.worldInternal')].getBufferPool();
const ids = new Uint32Array(4096);
for (let i = 0; i < ids.length; i++) {
  const result = pool.alloc(16).unwrap();
  result.view[0] = i % 251;
  ids[i] = result.id;
}
let sum = 0;
for (let i = 0; i < 20000; i++) sum += pool.view(ids[i % 4096])[0];
sum = 0;
const before = process.cpuUsage();
const start = performance.now();
for (let i = 0; i < calls; i++) sum += pool.view(ids[i % 4096])[0];
const cpu = process.cpuUsage(before);
const wallMs = performance.now() - start;
let expected = 0;
for (let i = 0; i < calls; i++) expected += (i % 4096) % 251;
assert.equal(sum, expected);
console.log(JSON.stringify({ calls, sum, cpuMs: (cpu.user + cpu.system) / 1000, wallMs }));
