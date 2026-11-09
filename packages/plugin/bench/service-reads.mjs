// node --expose-gc service-reads.mjs CORDIS_ENTRY.mjs PRIVATE_OUTPUT.json
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { measureAllocations } from '../../../skills/forgeax-engine-performance/scripts/allocation_probe.mjs';
const [entry, output] = process.argv.slice(2);
assert(entry && output && globalThis.gc, 'Require package entry, private output and --expose-gc');
const { Context } = await import(entry),
  results = [];
let sink = 0;
for (const mode of ['plain', 'nested', 'accessor', 'intercepted', 'hook-pass', 'replacement']) {
  const ctx = new Context();
  let provider,
    reader,
    host = { width: 320 },
    frame = 0;
  function provide() {
    provider = ctx.plugin({
      name: 'owner-provider',
      apply(c) {
        c.provide('ownerService', host);
      },
    });
    return provider.await();
  }
  await provide();
  if (mode === 'accessor')
    ctx.accessor('ownerAccessor', {
      get(_receiver, error) {
        assert(error instanceof Error);
        return host;
      },
    });
  if (mode === 'intercepted')
    ctx.on('internal/get', (_c, name, error, next) => {
      assert(error instanceof Error);
      return next();
    });
  if (mode === 'hook-pass')
    ctx.on('internal/get', (_c, name, error, next) => next(), { global: false });
  const consumer = {
    name: 'owner-consumer',
    inject: ['ownerService'],
    apply(c) {
      reader = mode === 'accessor' ? () => c.ownerAccessor.width : () => c.ownerService.width;
    },
  };
  const fiber = ctx.plugin(consumer);
  await fiber.await();
  if (mode === 'nested') {
    const nested = fiber.ctx.plugin({ ...consumer, name: 'owner-nested' });
    await nested.await();
  }
  function serviceReadOwner() {
    frame++;
    sink += reader();
  }
  for (let i = 0; i < 10000; i++) serviceReadOwner();
  const cpu = [];
  for (let r = 0; r < 7; r++) {
    const before = process.threadCpuUsage(),
      start = performance.now();
    for (let i = 0; i < 20000; i++) serviceReadOwner();
    const used = process.threadCpuUsage(before);
    cpu.push({
      threadNs: ((used.user + used.system) * 1000) / 20000,
      wallNs: ((performance.now() - start) * 1e6) / 20000,
    });
  }
  const allocation = await measureAllocations(serviceReadOwner, {
    calls: 20000,
    warmup: 10000,
    samplingWarmup: 5000,
    samplingInterval: 256,
    targetFrame: { functionName: 'serviceReadOwner', url: import.meta.url },
  });
  if (mode === 'replacement') {
    await provider.dispose();
    host = { width: 640 };
    await provide();
    await fiber.await();
    assert.equal(reader(), 640);
  }
  results.push({ mode, cpu, allocation });
  await ctx.fiber.dispose();
}
const ring = [];
function positiveControl(index) {
  const value = { index };
  ring[index % 1024] = value;
  return value;
}
const positive = await measureAllocations(positiveControl, {
  calls: 20000,
  warmup: 10000,
  samplingWarmup: 5000,
  samplingInterval: 256,
  targetFrame: { functionName: 'positiveControl', url: import.meta.url },
});
writeFileSync(
  output,
  JSON.stringify(
    {
      entry,
      node: process.version,
      sha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
      results,
      sink,
      positive,
      qualification:
        'Real native Context/Fiber/inject/service read owner. Accessor/interceptor and nested controls; provider retirement/reinstall verified after measurement, its cold cost is not in rates. Separate ordinary thread CPU and collected-object allocation sampling; not game/Worker/retained acceptance.',
    },
    null,
    2,
  ) + '\n',
);
assert(positive.bytesPerCall > 16, 'Positive allocation control not observed');
const plain = results.find((row) => row.mode === 'plain').allocation.bytesPerCall;
assert(plain <= 400, `Native service read allocated ${plain.toFixed(2)} B/read; budget400`);
