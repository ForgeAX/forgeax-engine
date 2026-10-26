import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const workerCounts = ['1', '2'];
const processTimeout = 30_000;

it('shares a warm material lane for uniform edits while cooking different contracts concurrently', {
  timeout: workerCounts.length * processTimeout,
}, async () => {
  const run = promisify(execFile);
  const entry = import.meta.resolve('@forgeax/engine-shader-compiler');
  const script = `
    import { createHash } from 'node:crypto';
    import { syncBuiltinESMExports } from 'node:module';
    import os from 'node:os';
    import { Worker } from 'node:worker_threads';
    // Pin this isolated placement fixture's capacity facts. Native Workers
    // and real cooker bytes remain exercised on constrained coverage hosts.
    os.availableParallelism = () => 2;
    os.freemem = () => 8 * 1024 ** 3;
    process.availableMemory = os.freemem;
    syncBuiltinESMExports();
    const { createMaterialPackCooker } = await import(${JSON.stringify(entry)});
    const active = new Map();
    let duplicate = false;
    let peak = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...args) {
      const job = args[0];
      if (job?.input?.source) {
        const key = JSON.stringify({ ...job.input.source, values: undefined });
        if ([...active.values()].includes(key)) duplicate = true;
        active.set(this, key);
        peak = Math.max(peak, active.size);
        this.prependOnceListener('message', () => { active.delete(this); });
      }
      return post.apply(this, args);
    };
    const cooker = createMaterialPackCooker([], { profile: 'webgpu-storage' });
    const inputs = [0, 1, 2, 3].map(index => ({
      guid: 'material-' + index,
      source: { kind: 'material', passes: [
        { name: 'Forward', program: { module: 'forgeax::default-unlit' },
          renderState: { cullMode: index < 2 ? 'back' : 'none' } },
      ], values: { baseColor: [index / 4, 0.4, 0.6, 1] } },
    }));
    const result = await Promise.all(inputs.map(input => cooker.cook(input)));
    const bytes = JSON.stringify(result, (_, value) => ArrayBuffer.isView(value)
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') : value);
    console.log(JSON.stringify({ duplicate, peak, digest: createHash('sha256').update(bytes).digest('hex') }));
  `;
  const outputs = [];
  for (const workers of workerCounts) {
    const result = await run(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, FORGEAX_SHADER_COMPILE_WORKERS: workers },
      timeout: processTimeout,
    });
    outputs.push(JSON.parse(result.stdout));
  }
  expect(outputs[1]?.digest).toBe(outputs[0]?.digest);
  expect(outputs[1]?.duplicate).toBe(false);
  expect(outputs[1]?.peak).toBe(2);
});
