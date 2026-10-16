import { Worker } from 'node:worker_threads';
import * as naga from '@forgeax/engine-naga';
import { compileShader } from '@forgeax/engine-shader-compiler';
import { afterEach, expect, it, vi } from 'vitest';
import {
  compileMaterialSources,
  type MaterialCompileJob,
} from '../engine-inputs/compile-material-sources.js';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries.js';
import { lowerEngineSurfaceEntry } from '../engine-inputs/prepare-engine-shader-source.js';

const previousWorkers = process.env.FORGEAX_SHADER_COMPILE_WORKERS;
afterEach(() => {
  if (previousWorkers === undefined) delete process.env.FORGEAX_SHADER_COMPILE_WORKERS;
  else process.env.FORGEAX_SHADER_COMPILE_WORKERS = previousWorkers;
  vi.restoreAllMocks();
});

it('prepares Standard Surface inside real workers without changing compiled bytes or metadata', async () => {
  const engine = await loadEngineShaderEntries();
  const jobs: MaterialCompileJob[] = Array.from({ length: 32 }, (_, index) => index % 2 === 1).map(
    (vertexColor, index) => ({
      defines: { VERTEX_COLOR_AVAILABLE: vertexColor },
      file: engine.defaultStandardPbr,
      options: {
        id: `worker-standard-${index}`,
        imports: engine.imports,
        defines: {
          STORAGE_BUFFER_AVAILABLE: true,
          PER_INSTANCE_REGION: false,
          SKINNING_DISABLED: true,
          VERTEX_COLOR_AVAILABLE: vertexColor,
        },
      },
    }),
  );
  const expected = await Promise.all(
    jobs.map(async (job) => {
      const prepared = lowerEngineSurfaceEntry(
        job.file,
        engine.imports,
        engine.imports,
        job.options.defines,
      );
      return compileShader(prepared.source, { ...job.options, imports: prepared.imports });
    }),
  );
  for (const result of expected) expect(result.ok).toBe(true);
  const compose = vi.spyOn(naga, 'composeShader');
  const exits: number[] = [];
  const observed = new WeakSet<Worker>();
  const postMessage = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker['postMessage']>
  ) {
    if (!observed.has(this)) {
      observed.add(this);
      this.once('exit', (code) => exits.push(code));
    }
    return postMessage.apply(this, args);
  });
  for (const workers of ['1', '2', '16']) {
    compose.mockClear();
    exits.length = 0;
    process.env.FORGEAX_SHADER_COMPILE_WORKERS = workers;
    expect(await compileMaterialSources(jobs, engine.imports)).toEqual(expected);
    if (workers === '1') expect(compose).toHaveBeenCalledTimes(2);
    expect(exits).toEqual(Array.from({ length: workers === '1' ? 0 : Number(workers) }, () => 0));
  }
}, 60_000);

it('preserves preparation errors and recovers for later worker invocations', async () => {
  process.env.FORGEAX_SHADER_COMPILE_WORKERS = '2';
  const invalid = { id: 'broken', source: '#pragma material_slot surface' };
  await expect(
    compileMaterialSources(
      [
        { defines: undefined, file: invalid, options: { id: invalid.id } },
        { defines: undefined, file: invalid, options: { id: invalid.id } },
      ],
      {},
    ),
  ).rejects.toThrow('Standard Surface entry has no module identity: broken');
  const source = '@compute @workgroup_size(1) fn cs() {}';
  const jobs = [0, 1].map((index) => ({
    defines: undefined,
    file: { id: `valid-${index}`, source },
    options: { id: `valid-${index}` },
  }));
  const results = await compileMaterialSources(jobs, {});
  expect(results.every((result) => result.ok)).toBe(true);
});
