import { expect, it, vi } from 'vitest';
import { resolveFeatureWorkResources } from '../features/frame-plan';
import { type RenderFeatureWork, renderFeaturePlanSignature } from '../features/plan';
import { RENDER_FEATURE_VERTEX_LAYOUTS } from '../features/prepared-graphics';

function works(ticks: number): RenderFeatureWork[] {
  return [
    {
      scope: 'frame',
      resources: [
        {
          kind: 'compute-program',
          name: 'program',
          program: { wgsl: 'synthetic', entryPoints: ['copy', 'simulate'] },
        },
        { kind: 'buffer', name: 'particles', size: 64, usage: ['storage'] },
        ...Array.from({ length: ticks }, (_, tick) => ({
          kind: 'buffer' as const,
          name: `tick-${tick}`,
          size: 16,
          usage: ['uniform' as const],
        })),
      ],
      passes: [],
    },
    {
      scope: { view: 'main' },
      resources: [
        { kind: 'buffer', name: 'output', size: 64, usage: ['storage'] },
        {
          kind: 'compute-bindings',
          name: 'copy',
          program: 'program',
          entries: [
            { binding: 0, resource: 'particles' },
            { binding: 1, resource: 'output' },
          ],
        },
      ],
      passes: [
        {
          kind: 'compute',
          name: 'copy',
          program: 'program',
          bindings: 'copy',
          dispatches: [{ kind: 'direct', entryPoint: 'copy', workgroups: [1] }],
        },
      ],
    },
  ];
}

it('keeps tick-local inputs out of view topology while retaining transitive shared dependencies', () => {
  const first = resolveFeatureWorkResources(works(1));
  const catchup = resolveFeatureWorkResources(works(8));
  expect(first[1]?.closure.resources.map((resource) => resource.name)).toEqual([
    'program',
    'particles',
    'output',
    'copy',
  ]);
  expect(catchup[1]?.closure.resources.map((resource) => resource.name)).toEqual([
    'program',
    'particles',
    'output',
    'copy',
  ]);
  const before = first[1],
    after = catchup[1];
  if (before === undefined || after === undefined) throw new Error('Missing view closure');
  expect(renderFeaturePlanSignature(before.closure)).toBe(
    renderFeaturePlanSignature(after.closure),
  );
  expect(first[0]?.closure.resources).toHaveLength(3);
  expect(catchup[0]?.closure.resources).toHaveLength(10);
});

it('retains shared graphics buffers referenced inside binding values and source order', () => {
  const rows = resolveFeatureWorkResources([
    {
      scope: 'frame',
      resources: [
        { kind: 'buffer', name: 'unused', size: 16, usage: ['uniform'] },
        { kind: 'buffer', name: 'instances', size: 64, usage: ['storage'] },
        { kind: 'buffer', name: 'runtime', size: 16, usage: ['uniform'] },
      ],
      passes: [],
    },
    {
      scope: { view: 'main' },
      resources: [
        {
          kind: 'graphics-program',
          name: 'local-program',
          program: {
            shader: 'synthetic',
            vertexLayout: RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInstance,
            colorFormats: [],
          },
        },
        {
          kind: 'graphics-bindings',
          name: 'bindings',
          program: 'local-program',
          values: { runtime: 'runtime', nested: ['instances', new Uint8Array([1, 2])] },
        },
      ],
      passes: [],
    },
  ]);
  expect(rows[1]?.closure.resources.map((resource) => resource.name)).toEqual([
    'instances',
    'runtime',
    'local-program',
    'bindings',
  ]);
});

it.each([
  1, 64,
])('encodes shared names once while retaining every view alias for %i ticks', (ticks) => {
  const input = works(ticks);
  const stringify = vi.spyOn(JSON, 'stringify');
  let calls = 0;
  let rows: ReturnType<typeof resolveFeatureWorkResources>;
  try {
    rows = resolveFeatureWorkResources(input);
    calls = stringify.mock.calls.length;
  } finally {
    stringify.mockRestore();
  }
  // The frame namespace is encoded once; views retain all shared aliases
  // for resolver callbacks without re-encoding tick-local names.
  expect(calls).toBe(ticks + 4);
  expect([...(rows[0]?.keys.keys() ?? [])]).toEqual([
    'program',
    'particles',
    ...Array.from({ length: ticks }, (_, i) => `tick-${i}`),
  ]);
  expect([...(rows[1]?.keys ?? [])]).toEqual([
    ['program', '["frame","program"]'],
    ['particles', '["frame","particles"]'],
    ...Array.from({ length: ticks }, (_, i) => [`tick-${i}`, `["frame","tick-${i}"]`]),
    ['output', '["view:main","output"]'],
    ['copy', '["view:main","copy"]'],
  ]);
  expect(rows[0]?.resources.map((r) => r.name)).toEqual([...(rows[0]?.keys.values() ?? [])]);
  expect(rows[1]?.resources).toEqual([
    { kind: 'buffer', name: '["view:main","output"]', size: 64, usage: ['storage'] },
    {
      kind: 'compute-bindings',
      name: '["view:main","copy"]',
      program: '["frame","program"]',
      entries: [
        { binding: 0, resource: '["frame","particles"]' },
        { binding: 1, resource: '["view:main","output"]' },
      ],
    },
  ]);
  expect(rows[1]?.closure.passes).toBe(input[1]?.passes);
});

it('retains scope order and independent same-named locals when frame follows a view', () => {
  const [frame, view] = works(1);
  if (frame === undefined || view === undefined) throw new Error('Missing scoped work');
  const input = [view, frame, { ...view, scope: { view: 'other' } }];
  const rows = resolveFeatureWorkResources(input);
  expect(rows.map((row) => row.work)).toEqual(input);
  expect(rows.map((row) => row.keys.get('particles'))).toEqual([
    '["frame","particles"]',
    '["frame","particles"]',
    '["frame","particles"]',
  ]);
  expect(rows.map((row) => row.keys.get('output'))).toEqual([
    '["view:main","output"]',
    undefined,
    '["view:other","output"]',
  ]);
  expect(rows[0]?.resources).toEqual(resolveFeatureWorkResources([frame, view])[1]?.resources);
});

it('observes shared name and payload edits between scopes and on the next resolution', () => {
  const payload = { bytes: new Uint8Array([1, 2, 3, 4]) };
  const buffer = {
    kind: 'buffer' as const,
    name: 'before',
    size: 16,
    usage: ['uniform' as const],
    data: payload.bytes,
  };
  let edited = false;
  const frame: RenderFeatureWork = { scope: 'frame', resources: [buffer], passes: [] };
  const view: RenderFeatureWork = {
    scope: { view: 'main' },
    get resources() {
      if (!edited) {
        edited = true;
        buffer.name = 'after';
        buffer.size = 32;
        buffer.usage = [];
        payload.bytes[0] = 9;
      }
      return [];
    },
    passes: [],
  };
  const first = resolveFeatureWorkResources([frame, view]);
  expect([...(first[0]?.keys ?? [])]).toEqual([['before', '["frame","before"]']]);
  expect([...(first[1]?.keys ?? [])]).toEqual([['after', '["frame","after"]']]);
  expect(first[0]?.resources[0]).toEqual({
    ...buffer,
    name: '["frame","before"]',
    size: 16,
    usage: ['uniform'],
  });
  const second = resolveFeatureWorkResources([frame, view]);
  expect(second[0]?.resources[0]).toEqual({ ...buffer, name: '["frame","after"]' });
  expect(second[0]?.closure.resources[0]).toBe(buffer);
  expect(second[0]?.resources[0]).toHaveProperty('data', new Uint8Array([9, 2, 3, 4]));
});

it.each([
  5, 7,
])('preserves a name getter changing during alias encoding at read %i', (changedRead) => {
  let reads = 0;
  const resource = {
    kind: 'buffer' as const,
    get name() {
      return ++reads === changedRead ? 'other' : 'shared';
    },
    size: 16,
    usage: ['uniform' as const],
  };
  const rows = resolveFeatureWorkResources([
    { scope: 'frame', resources: [resource], passes: [] },
    { scope: { view: 'main' }, resources: [], passes: [] },
  ]);
  expect([...(rows[0]?.keys ?? [])]).toEqual([
    ['shared', changedRead === 7 ? '["frame","other"]' : '["frame","shared"]'],
  ]);
  expect([...(rows[1]?.keys ?? [])]).toEqual([['shared', '["frame","shared"]']]);
});

it('still observes a shared getter failure in a later scope', () => {
  const failure = new Error('shared name became unavailable');
  let fail = false;
  const resource = {
    kind: 'buffer' as const,
    get name() {
      if (fail) throw failure;
      return 'shared';
    },
    size: 16,
    usage: ['uniform' as const],
  };
  const input: RenderFeatureWork[] = [
    { scope: 'frame', resources: [resource], passes: [] },
    {
      scope: { view: 'main' },
      get resources() {
        fail = true;
        return [];
      },
      passes: [],
    },
  ];
  expect(() => resolveFeatureWorkResources(input)).toThrow(failure);
  fail = false;
  expect(resolveFeatureWorkResources(input.slice(0, 1))[0]?.keys.get('shared')).toBe(
    '["frame","shared"]',
  );
});

it.each([
  {
    works: [
      { scope: 'frame' as const, resources: [], passes: [] },
      { scope: 'frame' as const, resources: [], passes: [] },
    ],
    error: 'duplicate RenderFeature work scope: frame',
  },
  {
    works: [
      {
        scope: 'frame' as const,
        resources: [{ kind: 'buffer' as const, name: 'same', size: 16, usage: [] }],
        passes: [],
      },
      {
        scope: { view: 'main' },
        resources: [{ kind: 'buffer' as const, name: 'same', size: 16, usage: [] }],
        passes: [],
      },
    ],
    error: 'ambiguous RenderFeature resource: view:main/same',
  },
  {
    works: [
      {
        scope: { view: 'left' },
        resources: [{ kind: 'buffer' as const, name: 'private', size: 16, usage: [] }],
        passes: [],
      },
      {
        scope: { view: 'right' },
        resources: [
          {
            kind: 'vertex-data' as const,
            name: 'vertices',
            buffer: 'private',
            layout: 'synthetic',
          },
        ],
        passes: [],
      },
    ],
    error: 'unresolved RenderFeature resource: view:right/private',
  },
])('preserves namespace validation: $error', ({ works, error }) => {
  expect(() => resolveFeatureWorkResources(works)).toThrow(error);
});

it('does not reuse a frame alias encoded under a temporarily changed work scope', () => {
  let reads = 0;
  const frame = {
    scope: 'frame' as RenderFeatureWork['scope'],
    resources: [] as RenderFeatureWork['resources'],
    passes: [],
  };
  frame.resources = [
    {
      kind: 'buffer',
      get name() {
        reads++;
        if (reads === 6) frame.scope = { view: 'transient' };
        if (reads === 7) frame.scope = 'frame';
        return 'shared';
      },
      size: 16,
      usage: ['uniform'],
    },
  ];
  const rows = resolveFeatureWorkResources([
    frame,
    { scope: { view: 'main' }, resources: [], passes: [] },
  ]);
  expect(rows[0]?.keys.get('shared')).toBe('["view:transient","shared"]');
  expect(rows[1]?.keys.get('shared')).toBe('["frame","shared"]');
});

it('keeps the original work scope getter observation boundary', () => {
  let reads = 0;
  const frame: RenderFeatureWork = {
    get scope() {
      if (++reads > 6) throw new Error('Scope read beyond admission and projection');
      return 'frame' as const;
    },
    resources: [{ kind: 'buffer', name: 'shared', size: 16, usage: ['uniform'] }],
    passes: [],
  };
  expect(resolveFeatureWorkResources([frame])[0]?.keys.get('shared')).toBe('["frame","shared"]');
  expect(reads).toBe(6);
});
