// Bounded service comparison. Output is diagnostic, not whole-game acceptance.
// node --expose-gc memory-services.mjs <index.mjs> fresh|arena|churn [iterations]
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { measureAllocations } from '../../../skills/forgeax-engine-performance/scripts/allocation_probe.mjs';
const [entry, mode = 'arena', count = '2000', profileOutput] = process.argv.slice(2);
assert.ok(entry && ['fresh', 'arena', 'churn'].includes(mode));
const iterations = Number(count);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0 && iterations <= 100000);
const { World, Update } = await import(pathToFileURL(entry));
const world = new World();
let checksum = 0;
let backingBytes = 0;
let maximumId = 0;
const warmup = mode === 'churn' ? 0 : 200;
// This is the owning package's internal diagnostic, not a public slot API.
const pool = world[Symbol.for('forgeax.ecs.worldInternal')].getBufferPool();
if (mode !== 'churn') world.addSystem(Update, {
  name: 'memory-service-bench', commands: 'none', queries: [],
  fn: (world) => {
    const alloc = (ctor, length) => {
      if (mode === 'arena') return world.frameArena.alloc(ctor, length).unwrap();
      const result = new ctor(length); backingBytes += result.byteLength; return result;
    };
    const ids = alloc(Uint32Array, 10000); ids.fill(1);
    const keys = alloc(Float64Array, 10000); keys.fill(2);
    const order = alloc(Uint32Array, 10000); order.fill(3);
    const matrices = alloc(Float32Array, 4096); matrices.fill(4);
    checksum += ids[9999] + keys[9999] + order[9999] + matrices[4095];
  },
}).unwrap();
const run = () => {
  if (mode !== 'churn') { world.update().unwrap(); return; }
  const result = pool.alloc(262145).unwrap();
  result.view[0] = 17; checksum += result.view[0];
  maximumId = Math.max(maximumId, result.id);
  pool.release(result.id).unwrap();
};
for (let n = 0; n < warmup; n++) run();
const beforeArena = world.memoryStats?.().arena;
backingBytes = 0;
let sampling = null;
let wallMs = null;
let cpu;
const samplingWarmup = profileOutput ? 256 : 0;
if (profileOutput) {
  const { profile, ...allocation } = await measureAllocations(run, {
    calls: iterations, warmup: 0, samplingWarmup, samplingInterval: 128,
    includeProfile: true, targetFrame: { url: import.meta.url, functionName: 'run' },
  });
  writeFileSync(profileOutput, JSON.stringify(profile));
  assert.ok(allocation.probeFrames > 0, 'Require attributable allocation frames');
  sampling = allocation;
} else {
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  for (let n = 0; n < iterations; n++) run();
  wallMs = performance.now() - started;
  cpu = process.cpuUsage(cpuBefore);
}
const after = world.memoryStats?.();
const metadataBytes = Object.values(pool).reduce((sum, value) => sum + (ArrayBuffer.isView(value) ? value.byteLength : 0), 0);
assert.equal(checksum, (iterations + warmup + samplingWarmup) * (mode === 'churn' ? 17 : 10));
if (mode === 'arena') assert.equal(after.arena.backingAllocations - beforeArena.backingAllocations, 0);
if (globalThis.gc) for (let n = 0; n < 3; n++) globalThis.gc();
const memory = process.memoryUsage();
console.log(JSON.stringify({ sampling, instrumented: Boolean(profileOutput), mode, iterations, warmup, checksum, wallMs,
  cpuMs: cpu ? (cpu.user + cpu.system) / 1000 : null,
  cpuUsPerIteration: cpu ? (cpu.user + cpu.system) / iterations : null,
  measuredBackingTrafficBytes: mode === 'fresh' ? backingBytes : mode === 'arena' ? 0 : iterations * 262145,
  maximumId, slotMetadataBytes: metadataBytes,
  retained: { heapUsed: memory.heapUsed, arrayBuffers: memory.arrayBuffers },
  allocator: after ?? null,
  boundary: 'Service workload and owner counters only. CPU is host-contended; not a game FPS, natural GC or pixel/GPU acceptance result.' }));
