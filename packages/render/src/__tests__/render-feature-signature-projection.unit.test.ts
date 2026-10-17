import { describe, expect, it, vi } from 'vitest';
import {
  cloneOwnedRenderFeaturePlanSignatureSnapshot,
  cloneRenderFeaturePlanSignatureSnapshot,
  freezeRenderFeaturePlan,
  type RenderFeatureWorkPlan,
  renderFeaturePlanSignature,
  renderFeaturePlanSignatureSnapshotEquals,
} from '../features/plan';
import { ownRenderFeatureProgramData } from '../features/prepared-gpu-work';

it('retains owned static buffer evidence without confusing normalized and nested JSON snapshots', () => {
  const buffer = ownRenderFeatureProgramData({
    kind: 'buffer' as const,
    name: 'particles',
    size: 64,
    usage: ['storage', 'copy-src', 'storage'] as const,
  });
  const plan: RenderFeatureWorkPlan = { resources: [buffer], passes: [] };
  const first = cloneRenderFeaturePlanSignatureSnapshot(plan);
  expect(cloneRenderFeaturePlanSignatureSnapshot(plan).resources[0]).toBe(first.resources[0]);
  expect(renderFeaturePlanSignatureSnapshotEquals(plan, first)).toBe(true);
  expect(freezeRenderFeaturePlan('owned', plan).unwrap().resources[0]).toBe(buffer);
  expect(renderFeaturePlanSignature(plan)).toBe(
    renderFeaturePlanSignature({
      ...plan,
      resources: [{ ...buffer, usage: ['storage', 'storage', 'copy-src'] }],
    }),
  );
  const nested: RenderFeatureWorkPlan = {
    resources: [
      { kind: 'graphics-bindings', name: 'binding', program: 'program', values: { buffer } },
    ],
    passes: [],
  };
  const nestedSnapshot = cloneRenderFeaturePlanSignatureSnapshot(nested);
  expect(renderFeaturePlanSignatureSnapshotEquals(nested, nestedSnapshot)).toBe(true);
  const binding = nestedSnapshot.resources[0];
  if (binding?.kind !== 'object') throw new Error('Missing binding snapshot');
  const values = binding.values[binding.keys.indexOf('values')];
  if (values?.kind !== 'object') throw new Error('Missing values snapshot');
  const nestedBuffer = values.values[values.keys.indexOf('buffer')];
  if (nestedBuffer?.kind !== 'object') throw new Error('Missing nested buffer snapshot');
  expect(nestedBuffer.keys).not.toContain('data');
  const invalid = { resources: [ownRenderFeatureProgramData({ ...buffer, name: '' })], passes: [] };
  expect(freezeRenderFeaturePlan('invalid', invalid).ok).toBe(false);
  const bytes = new Uint32Array([1]);
  const uploaded = { ...buffer, data: bytes };
  const uploadPlan: RenderFeatureWorkPlan = { resources: [uploaded], passes: [] };
  const uploadSnapshot = cloneRenderFeaturePlanSignatureSnapshot(uploadPlan);
  bytes[0] = 2;
  expect(renderFeaturePlanSignatureSnapshotEquals(uploadPlan, uploadSnapshot)).toBe(true);
  const captured = freezeRenderFeaturePlan('upload', uploadPlan).unwrap().resources[0];
  expect(captured).not.toBe(uploaded);
  expect(captured?.kind === 'buffer' && captured.data).toBe(bytes);
});

it.each([
  'raster',
  'shadow-caster',
] as const)('treats %s draw enablement as frame data without masking nested material values', (kind) => {
  const draw = {
    program: 'program',
    bindings: ['bindings'],
    vertexData: [],
    draw: { kind: 'draw-indirect' as const, resource: 'args', offset: 0 },
  };
  const plan = (enabled?: boolean): RenderFeatureWorkPlan => ({
    resources: [],
    passes: [{ kind, name: 'draw', colorAttachments: [], draws: [{ ...draw, enabled }, draw] }],
  });
  const first = plan();
  const signature = renderFeaturePlanSignature(first);
  const snapshot = cloneRenderFeaturePlanSignatureSnapshot(first);
  for (const enabled of [false, true, undefined]) {
    const current = plan(enabled);
    expect(renderFeaturePlanSignature(current)).toBe(signature);
    expect(renderFeaturePlanSignatureSnapshotEquals(current, snapshot)).toBe(true);
    expect(cloneRenderFeaturePlanSignatureSnapshot(current, snapshot)).toBe(snapshot);
    expect(cloneOwnedRenderFeaturePlanSignatureSnapshot(current, snapshot)).toBe(snapshot);
  }
  const held = plan(false);
  const pass = held.passes[0];
  if (pass?.kind !== 'raster' && pass?.kind !== 'shadow-caster')
    throw new Error('Missing draw pass');
  const changed: RenderFeatureWorkPlan = {
    ...held,
    passes: [{ ...pass, draws: [{ ...draw, draw: { ...draw.draw, offset: 4 } }, draw] }],
  };
  expect(renderFeaturePlanSignature(changed)).not.toBe(signature);
  expect(renderFeaturePlanSignatureSnapshotEquals(changed, snapshot)).toBe(false);
  const material = (enabled: boolean): RenderFeatureWorkPlan => ({
    resources: [
      { kind: 'graphics-bindings', name: 'material', program: 'program', values: { enabled } },
    ],
    passes: [],
  });
  expect(renderFeaturePlanSignature(material(false))).not.toBe(
    renderFeaturePlanSignature(material(true)),
  );
  expect(
    renderFeaturePlanSignatureSnapshotEquals(
      material(false),
      cloneRenderFeaturePlanSignatureSnapshot(material(true)),
    ),
  ).toBe(false);
});

it('keeps direct counts as frame data without masking dispatch identity or material values', () => {
  const plan = (workgroups: readonly [number, number?, number?]): RenderFeatureWorkPlan => ({
    resources: [],
    passes: [
      {
        kind: 'compute',
        name: 'counts',
        program: 'program',
        bindings: 'bindings',
        dispatches: [
          { kind: 'direct', entryPoint: 'main', workgroups },
          { kind: 'indirect', entryPoint: 'other', resource: 'args', offset: 0 },
        ],
      },
    ],
  });
  const first = plan([1]);
  const signature = renderFeaturePlanSignature(first);
  const snapshot = cloneRenderFeaturePlanSignatureSnapshot(first);
  for (const counts of [[0], [1], [2, 3, 4], [1, 0, 1], [1, 1, 0]] as const) {
    const current = plan(counts);
    expect(renderFeaturePlanSignature(current)).toBe(signature);
    expect(renderFeaturePlanSignatureSnapshotEquals(current, snapshot)).toBe(true);
    expect(cloneRenderFeaturePlanSignatureSnapshot(current, snapshot)).toBe(snapshot);
    expect(cloneOwnedRenderFeaturePlanSignatureSnapshot(current, snapshot)).toBe(snapshot);
  }
  const pass = first.passes[0];
  if (pass?.kind !== 'compute') throw new Error('Missing compute pass');
  for (const changed of [
    { ...pass, bindings: 'different' },
    { ...pass, dispatches: [...pass.dispatches].reverse() },
    {
      ...pass,
      dispatches: [
        { kind: 'direct' as const, entryPoint: 'different', workgroups: [1] as const },
        pass.dispatches[1],
      ],
    },
    {
      ...pass,
      dispatches: [
        pass.dispatches[0],
        { kind: 'indirect' as const, entryPoint: 'other', resource: 'args', offset: 12 },
      ],
    },
  ]) {
    const current = { ...first, passes: [changed] } as RenderFeatureWorkPlan;
    expect(renderFeaturePlanSignature(current)).not.toBe(signature);
    expect(renderFeaturePlanSignatureSnapshotEquals(current, snapshot)).toBe(false);
  }
  const material = (count: number): RenderFeatureWorkPlan => ({
    resources: [
      {
        kind: 'graphics-bindings',
        name: 'material',
        program: 'program',
        values: { kind: 'direct', workgroups: [count] },
      },
    ],
    passes: [],
  });
  expect(renderFeaturePlanSignature(material(0))).not.toBe(renderFeaturePlanSignature(material(1)));
  expect(
    renderFeaturePlanSignatureSnapshotEquals(
      material(0),
      cloneRenderFeaturePlanSignatureSnapshot(material(1)),
    ),
  ).toBe(false);
});

function wideBindingPlan(width: number, changed?: string): RenderFeatureWorkPlan {
  const params: Record<string, string> = {};
  for (let index = 0; index < width; index += 1) {
    params[`field-${index.toString().padStart(4, '0')}`] =
      index === width - 1 && changed !== undefined ? changed : 'retained';
  }
  return {
    resources: [
      { kind: 'graphics-bindings', name: 'bindings', program: 'program', values: { params } },
    ],
    passes: [],
  };
}

describe('feature signature detached projection work', () => {
  it.each([
    64, 512,
  ])('uses direct field ordinals after proving an unchanged %i-field key set', (width) => {
    const first = cloneRenderFeaturePlanSignatureSnapshot(wideBindingPlan(width));
    const lookup = vi.spyOn(Array.prototype, 'indexOf');
    let calls: number;
    let next: ReturnType<typeof cloneRenderFeaturePlanSignatureSnapshot>;
    try {
      next = cloneRenderFeaturePlanSignatureSnapshot(wideBindingPlan(width, 'changed'), first);
      calls = lookup.mock.calls.filter(
        ([key]) => typeof key === 'string' && key.startsWith('field-'),
      ).length;
    } finally {
      lookup.mockRestore();
    }
    expect(calls).toBe(0);
    expect(renderFeaturePlanSignatureSnapshotEquals(wideBindingPlan(width, 'changed'), next)).toBe(
      true,
    );
    expect(renderFeaturePlanSignatureSnapshotEquals(wideBindingPlan(width), first)).toBe(true);
    expect(renderFeaturePlanSignatureSnapshotEquals(wideBindingPlan(width), next)).toBe(false);
  });

  it('does not allocate discarded frozen containers for unchanged descendants of a changed array', () => {
    const first = wideBindingPlan(128);
    const snapshot = cloneRenderFeaturePlanSignatureSnapshot(first);
    const nested = Array.from({ length: 32 }, (_, index) => ({
      binding: index,
      resource: `buffer-${index}`,
    }));
    const pass = (name: string): RenderFeatureWorkPlan => ({
      resources: first.resources,
      passes: [
        {
          kind: 'compute',
          name,
          program: 'program',
          bindings: 'bindings',
          dispatches: nested.map((row) => ({
            kind: 'direct' as const,
            entryPoint: row.resource,
            workgroups: [row.binding + 1] as const,
          })),
        },
      ],
    });
    const previous = cloneRenderFeaturePlanSignatureSnapshot(pass('compute'), snapshot);
    const freeze = vi.spyOn(Object, 'freeze');
    let frozen: number;
    let next: ReturnType<typeof cloneRenderFeaturePlanSignatureSnapshot>;
    try {
      next = cloneRenderFeaturePlanSignatureSnapshot(pass('compute-next'), previous);
      frozen = freeze.mock.calls.length;
    } finally {
      freeze.mockRestore();
    }
    // Changed pass object/value column, its array, and the snapshot root.
    expect(frozen).toBe(5);
    expect(next.resources).toBe(previous.resources);
    expect(next.passes).not.toBe(previous.passes);
    expect(renderFeaturePlanSignatureSnapshotEquals(pass('compute-next'), next)).toBe(true);
    expect(renderFeaturePlanSignatureSnapshotEquals(pass('compute'), previous)).toBe(true);
  });
  it('keeps unvisited suffix holes when a pass getter shrinks its array during projection', () => {
    const pass = (name: string) => ({
      kind: 'compute' as const,
      name,
      program: 'program',
      bindings: 'bindings',
      dispatches: [{ kind: 'direct' as const, entryPoint: 'main', workgroups: [1] as const }],
    });
    const previous = cloneRenderFeaturePlanSignatureSnapshot({
      resources: [],
      passes: [pass('first'), pass('second'), pass('third')],
    });
    const passes = [pass('first'), pass('second'), pass('third')];
    let reads = 0;
    Object.defineProperty(passes, 0, {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        passes.length = 1;
        return pass('changed');
      },
    });
    const next = cloneRenderFeaturePlanSignatureSnapshot({ resources: [], passes }, previous);
    expect(reads).toBe(1);
    expect(passes).toHaveLength(1);
    if (next.passes.kind !== 'array' || previous.passes.kind !== 'array')
      throw new Error('Missing pass snapshots');
    expect(next.passes.values).toHaveLength(3);
    expect(Object.hasOwn(next.passes.values, 1)).toBe(false);
    expect(Object.hasOwn(next.passes.values, 2)).toBe(false);
    expect(previous.passes.values).toHaveLength(3);
    expect(Object.hasOwn(previous.passes.values, 1)).toBe(true);
  });
  it('reconciles added and removed fields without repeated searches of the old key list', () => {
    const first = wideBindingPlan(128);
    const previous = cloneRenderFeaturePlanSignatureSnapshot(first);
    const nextPlan = wideBindingPlan(128);
    const binding = nextPlan.resources[0];
    if (binding?.kind !== 'graphics-bindings') throw new Error('Missing binding');
    const params = binding.values.params as Record<string, string>;
    delete params['field-0000'];
    params['field-new'] = 'new';
    const lookup = vi.spyOn(Array.prototype, 'indexOf');
    let calls: number;
    let next: ReturnType<typeof cloneRenderFeaturePlanSignatureSnapshot>;
    try {
      next = cloneRenderFeaturePlanSignatureSnapshot(nextPlan, previous);
      calls = lookup.mock.calls.filter(
        ([key]) => typeof key === 'string' && key.startsWith('field-'),
      ).length;
    } finally {
      lookup.mockRestore();
    }
    expect(calls).toBe(0);
    expect(renderFeaturePlanSignatureSnapshotEquals(nextPlan, next)).toBe(true);
    expect(renderFeaturePlanSignatureSnapshotEquals(first, previous)).toBe(true);
    expect(renderFeaturePlanSignatureSnapshotEquals(first, next)).toBe(false);
  });
});

it('treats pass enablement as frame data while retaining exact structural admission', () => {
  const plan = (enabled: boolean): RenderFeatureWorkPlan => ({
    resources: [],
    passes: [
      {
        kind: 'compute',
        name: 'tick',
        program: 'program',
        bindings: 'bindings',
        enabled,
        dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [1] }],
      },
    ],
  });
  const active = plan(true),
    held = plan(false);
  const snapshot = cloneRenderFeaturePlanSignatureSnapshot(active);
  expect(renderFeaturePlanSignature(held)).toBe(renderFeaturePlanSignature(active));
  expect(renderFeaturePlanSignatureSnapshotEquals(held, snapshot)).toBe(true);
  expect(cloneRenderFeaturePlanSignatureSnapshot(held, snapshot)).toBe(snapshot);
  const pass = held.passes[0];
  if (pass === undefined) throw new Error('Missing feature pass');
  const changed: RenderFeatureWorkPlan = {
    ...held,
    passes: [{ ...pass, name: 'different' }],
  };
  expect(renderFeaturePlanSignatureSnapshotEquals(changed, snapshot)).toBe(false);
});

it('preserves declaration order and mutable program evidence when resource ordinals shift', () => {
  const program = (name: string, wgsl: string) => ({
    kind: 'compute-program' as const,
    name,
    program: { wgsl, entryPoints: ['main'] },
  });
  const wgslA = '// emitter a\n'.repeat(1000);
  const wgslB = '// emitter b\n'.repeat(1000);
  const first = { resources: [program('a', wgslA), program('b', wgslB)], passes: [] };
  const previous = cloneRenderFeaturePlanSignatureSnapshot(first);
  const reordered = { resources: [program('b', wgslB), program('a', wgslA)], passes: [] };
  const stringify = vi.spyOn(JSON, 'stringify');
  let next: ReturnType<typeof cloneRenderFeaturePlanSignatureSnapshot>;
  let serializedPrograms: number;
  try {
    next = cloneRenderFeaturePlanSignatureSnapshot(reordered, previous);
    serializedPrograms = stringify.mock.calls.filter(
      ([value]) => value === wgslA || value === wgslB,
    ).length;
  } finally {
    stringify.mockRestore();
  }
  expect(serializedPrograms).toBe(2);
  expect(next.resources[0]).not.toBe(previous.resources[1]);
  expect(next.resources[1]).not.toBe(previous.resources[0]);
  expect(renderFeaturePlanSignatureSnapshotEquals(reordered, next)).toBe(true);
  expect(renderFeaturePlanSignatureSnapshotEquals(first, next)).toBe(false);
  const changedProgram = reordered.resources[0];
  if (changedProgram === undefined) throw new Error('Missing program');
  changedProgram.program.entryPoints.push('changed');
  expect(renderFeaturePlanSignatureSnapshotEquals(reordered, next)).toBe(false);
  const changed = cloneRenderFeaturePlanSignatureSnapshot(reordered, next);
  expect(changed.resources[0]).not.toBe(next.resources[0]);
  expect(changed.resources[1]).toBe(next.resources[1]);
  expect(renderFeaturePlanSignatureSnapshotEquals(reordered, changed)).toBe(true);
  expect(renderFeaturePlanSignatureSnapshotEquals(first, previous)).toBe(true);
});

describe('generic signature comparison observes the top-level passes accessor', () => {
  const pass = {
    kind: 'compute' as const,
    name: 'tick',
    program: 'program',
    bindings: 'bindings',
    dispatches: [{ kind: 'direct' as const, entryPoint: 'main', workgroups: [1] as const }],
  };
  const passes = [pass];
  const snapshot = cloneRenderFeaturePlanSignatureSnapshot({ resources: [], passes });

  it('propagates a failure from the second passes read', () => {
    let reads = 0;
    const failure = new Error('passes became unavailable');
    const plan: RenderFeatureWorkPlan = {
      resources: [],
      get passes() {
        if (++reads === 2) throw failure;
        return passes;
      },
    };
    expect(() => renderFeaturePlanSignatureSnapshotEquals(plan, snapshot)).toThrow(failure);
    expect(reads).toBe(2);
  });

  it('compares the replacement array returned after the length check', () => {
    let reads = 0;
    const replacement = [{ ...pass, name: 'changed' }];
    const plan: RenderFeatureWorkPlan = {
      resources: [],
      get passes() {
        return ++reads === 1 ? passes : replacement;
      },
    };
    expect(renderFeaturePlanSignatureSnapshotEquals(plan, snapshot)).toBe(false);
    expect(reads).toBe(3);
  });
});

it('excludes range uploads from topology while retaining binding ranges and captured writes', () => {
  const data = new Uint32Array([1, 2]);
  const buffer = { kind: 'buffer' as const, name: 'arena', size: 512, usage: ['uniform'] as const };
  const plan = (
    uploads?: readonly { readonly offset: number; readonly data: ArrayBufferView }[],
  ): RenderFeatureWorkPlan => ({
    resources: [{ ...buffer, ...(uploads === undefined ? {} : { uploads }) }],
    passes: [],
  });
  const initial = plan([{ offset: 256, data }]);
  const snapshot = cloneRenderFeaturePlanSignatureSnapshot(initial);
  for (const current of [plan(), plan([]), plan([{ offset: 0, data: new Uint32Array([3]) }])]) {
    expect(renderFeaturePlanSignature(current)).toBe(renderFeaturePlanSignature(initial));
    expect(renderFeaturePlanSignatureSnapshotEquals(current, snapshot)).toBe(true);
  }
  const captured = freezeRenderFeaturePlan('arena', initial).unwrap().resources[0];
  expect(captured?.kind === 'buffer' && captured.uploads?.[0]?.offset).toBe(256);
  expect(captured?.kind === 'buffer' && captured.uploads?.[0]?.data).toBe(data);
  const binding = (offset: number): RenderFeatureWorkPlan => ({
    resources: [
      {
        kind: 'compute-bindings',
        name: 'bindings',
        program: 'program',
        entries: [{ binding: 0, resource: 'arena', offset, size: 64 }],
      },
    ],
    passes: [],
  });
  expect(renderFeaturePlanSignature(binding(0))).not.toBe(renderFeaturePlanSignature(binding(256)));
});
