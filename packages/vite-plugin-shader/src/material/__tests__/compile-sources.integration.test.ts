import { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { compileMaterialSources } from '../../engine-inputs/compile-material-sources.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(['1', '2'])('compiles source inside the maintained pool: workers=%s', async (workers) => {
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', workers);
  const post = vi.spyOn(Worker.prototype, 'postMessage');
  const result = await compileMaterialSources(
    [0, 1, 2, 3].map((index) => ({
      defines: undefined,
      file: {
        id: `bounded-worker-${index}`,
        source: `@compute @workgroup_size(1) fn work_${index}() {}`,
      },
      options: { id: `bounded-worker-${index}` },
    })),
    {},
  );
  expect(post.mock.calls.filter(([job]) => job !== null)).toHaveLength(workers === '2' ? 4 : 0);
  for (const [index, compiled] of result.entries()) {
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw compiled.error;
    expect(compiled.value.wgsl).toContain(`work_${index}`);
  }
}, 30_000);

it('closes the real pool normally after a source producer throws and can start another pool', async () => {
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '2');
  const stop = vi.spyOn(Worker.prototype, 'terminate');
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
  const job = (source: string) => ({
    defines: undefined,
    file: { id: 'pool-source', source },
    options: { id: 'pool-source' },
  });
  await expect(
    compileMaterialSources(
      [
        job('#pragma material_slot surface\n@compute @workgroup_size(1) fn invalid() {}'),
        job('@compute @workgroup_size(1) fn control() {}'),
      ],
      {},
    ),
  ).rejects.toThrow('Standard Surface entry has no module identity');
  expect(exits).toEqual([0, 0]);
  expect(stop).not.toHaveBeenCalled();
  const repaired = await compileMaterialSources(
    [
      job('@compute @workgroup_size(1) fn repaired_0() {}'),
      job('@compute @workgroup_size(1) fn repaired_1() {}'),
    ],
    {},
  );
  expect(repaired.every((result) => result.ok)).toBe(true);
  expect(exits).toEqual([0, 0, 0, 0]);
  expect(stop).not.toHaveBeenCalled();
}, 30_000);
