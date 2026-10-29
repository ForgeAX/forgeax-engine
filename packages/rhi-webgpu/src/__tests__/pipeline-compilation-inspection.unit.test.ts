import { expect, it, vi } from 'vitest';
import { WebGpuPipelineLibrary } from '../pipeline-library';
import { createMockGpu } from './__mocks__/gpu-device';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected pipeline inspection fixture value');
  return value;
}

async function fixture() {
  const adapter = await createMockGpu().requestAdapter();
  const raw = (await adapter?.requestDevice()) as unknown as GPUDevice;
  const finishes: (() => void)[] = [];
  const render = vi.fn(
    () =>
      new Promise<GPURenderPipeline>((resolve) => {
        finishes.push(() => resolve({} as GPURenderPipeline));
      }),
  );
  const compute = vi.fn(
    () =>
      new Promise<GPUComputePipeline>((resolve) => {
        finishes.push(() => resolve({} as GPUComputePipeline));
      }),
  );
  Object.assign(raw, { createRenderPipelineAsync: render, createComputePipelineAsync: compute });
  const library = new WebGpuPipelineLibrary(raw);
  const descriptor = (
    source = 'terrain source',
    label = 'terrain',
  ): GPURenderPipelineDescriptor => {
    const module = library.createShaderModule({ code: source, label: `${label}-shader` });
    const group = library.createBindGroupLayout({ label: `${label}-group`, entries: [] });
    return {
      label,
      layout: library.createPipelineLayout({ bindGroupLayouts: [group] }),
      vertex: { module, entryPoint: 'vs', buffers: [] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
      multisample: { count: 1 },
    };
  };
  return { library, descriptor, finishes, render, compute };
}

it('lists every current compilation with detached complete state and no shader source payload', async () => {
  const f = await fixture(),
    descriptor = f.descriptor();
  const first = f.library.createRenderPipelineAsync(descriptor);
  const duplicate = f.library.createRenderPipelineAsync({
    ...descriptor,
    label: 'same semantic recipe',
  });
  const second = f.library.createComputePipelineAsync({
    label: 'cull',
    layout: 'auto',
    compute: {
      module: f.library.createShaderModule({ code: 'cull source', label: 'cull-shader' }),
      entryPoint: 'main',
      constants: { size: 64 },
    },
  });
  expect(f.library.inspect().pending?.pipelines.map((row) => row.stage)).toEqual([
    'queued',
    'queued',
  ]);
  await Promise.resolve();
  const inspection = f.library.inspect(),
    rows = required(inspection.pending).pipelines;
  expect(inspection).toMatchObject({ compilationPending: 2, pending: { unidentified: 0 } });
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    kind: 'render',
    origin: 'runtime',
    stage: 'compiling',
    identity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    elapsedMs: expect.any(Number),
    recipe: {
      label: 'terrain',
      vertex: { entryPoint: 'vs', buffers: [] },
      fragment: { entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      multisample: { count: 1 },
    },
    shaders: [
      { label: 'terrain-shader', sourceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
    ],
    bindGroupLayouts: [{ label: 'terrain-group', entries: [] }],
  });
  expect(rows[1]).toMatchObject({
    kind: 'compute',
    recipe: { label: 'cull', compute: { entryPoint: 'main', constants: { size: 64 } } },
  });
  expect(JSON.stringify(rows)).not.toContain('terrain source');
  (required(rows[0]).recipe as { label?: string }).label = 'mutated snapshot';
  expect(f.library.inspect().pending?.pipelines[0]?.recipe.label).toBe('terrain');
  required(f.finishes[0])();
  await Promise.all([first, duplicate]);
  expect(f.render).toHaveBeenCalledTimes(1);
  expect(f.library.inspect().pending?.pipelines.map((row) => row.kind)).toEqual(['compute']);
  required(f.finishes[1])();
  await second;
  expect(f.library.inspect().pending).toEqual({ unidentified: 0, pipelines: [] });
});

it('identifies recipes across module numbering and labels, while separating actual state variants', async () => {
  const a = await fixture(),
    b = await fixture();
  b.library.createShaderModule({ code: 'unrelated module' });
  const aRequest = a.library.createRenderPipelineAsync(a.descriptor());
  const descriptor = b.descriptor('terrain source', 'renamed');
  const bRequest = b.library.createRenderPipelineAsync(descriptor);
  const variant = b.library.createRenderPipelineAsync({ ...descriptor, multisample: { count: 4 } });
  const aRow = required(required(a.library.inspect().pending).pipelines[0]);
  const bRows = required(b.library.inspect().pending).pipelines;
  expect(aRow.identity).toBe(required(bRows[0]).identity);
  expect(aRow.identity).not.toBe(required(bRows[1]).identity);
  expect(aRow.recipe).not.toEqual(required(bRows[0]).recipe);
  await Promise.resolve();
  required(a.finishes[0])();
  for (const finish of b.finishes) finish();
  await Promise.all([aRequest, bRequest, variant]);
});

it.each([
  false,
  true,
])('marks imported compilation origins and cleans failures (background=%s)', async (background) => {
  const source = await fixture();
  source.library.createRenderPipeline(source.descriptor());
  const manifest = source.library.export().unwrap();
  const target = await fixture();
  const preparing = target.library.prepare(manifest, { background });
  await vi.waitFor(() => expect(target.finishes).toHaveLength(1));
  expect(target.library.inspect().pending?.pipelines[0]?.origin).toBe(
    background ? 'background-warmup' : 'startup-warmup',
  );
  required(target.finishes[0])();
  expect((await preparing).ok).toBe(true);
  target.render.mockRejectedValueOnce(new Error('native compile refused') as never);
  await expect(
    target.library.createRenderPipelineAsync(target.descriptor('invalid source')),
  ).rejects.toThrow('native compile refused');
  expect(target.library.inspect()).toMatchObject({
    compilationPending: 0,
    failures: 1,
    pending: { unidentified: 0, pipelines: [] },
  });
});

it('reports opaque native dependencies as unidentified until their request settles', async () => {
  const f = await fixture();
  const pending = f.library.createComputePipelineAsync({
    layout: 'auto',
    compute: { module: {} as GPUShaderModule, entryPoint: 'external' },
  });
  expect(f.library.inspect().pending).toEqual({ unidentified: 1, pipelines: [] });
  await Promise.resolve();
  required(f.finishes[0])();
  await pending;
  expect(f.library.inspect().pending).toEqual({ unidentified: 0, pipelines: [] });
});

it('indexes the complete preload roster before issuing native requests', async () => {
  const source = await fixture();
  const base = source.descriptor();
  source.library.createRenderPipeline(base);
  source.library.createRenderPipeline({ ...base, multisample: { count: 4 } });
  const target = await fixture();
  const warming = target.library.prepare(source.library.export().unwrap(), { concurrency: 1 });
  await vi.waitFor(() => expect(target.finishes).toHaveLength(1));
  const descriptor = target.descriptor();
  // The second warmup entry has not been issued yet. A runtime request for it
  // is covered even though the request origin is runtime.
  const covered = target.library.createRenderPipelineAsync({
    ...descriptor,
    multisample: { count: 4 },
  });
  const absent = target.library.createRenderPipelineAsync({
    ...descriptor,
    primitive: { topology: 'triangle-list', cullMode: 'front' },
  });
  expect(target.library.inspect().pending?.pipelines.map((row) => row.preload)).toEqual([
    'startup',
    'startup',
    'absent',
  ]);
  await Promise.resolve();
  for (const finish of target.finishes) finish();
  await Promise.all([warming, covered, absent]);
  expect(target.render).toHaveBeenCalledTimes(3);
});

it('keeps coverage unresolved until background indexing finishes and reports shared membership', async () => {
  const source = await fixture();
  source.library.createRenderPipeline(source.descriptor());
  const manifest = source.library.export().unwrap();
  const target = await fixture();
  const background = target.library.prepare(manifest, { background: true });
  const runtime = target.library.createRenderPipelineAsync(target.descriptor());
  expect(target.library.inspect().pending?.pipelines[0]?.preload).toBe('indexing');
  expect(target.library.export().ok).toBe(false);
  await vi.waitFor(() =>
    expect(target.library.inspect().pending?.pipelines[0]?.preload).toBe('background'),
  );
  const startup = target.library.prepare(manifest);
  await vi.waitFor(() =>
    expect(target.library.inspect().pending?.pipelines[0]?.preload).toBe('both'),
  );
  for (const finish of target.finishes) finish();
  await Promise.all([background, startup, runtime]);
  expect(target.render).toHaveBeenCalledTimes(1);
  expect(target.library.export().ok).toBe(true);
});
