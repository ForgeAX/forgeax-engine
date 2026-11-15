import { describe, expect, it, vi } from 'vitest';
import {
  cloneOwnedRenderFeaturePlanSignatureSnapshot,
  cloneRenderFeaturePlanSignatureSnapshot,
  type RenderFeatureBindingValue,
  type RenderFeatureWorkPlan,
  renderFeaturePlanSignature,
  renderFeaturePlanSignatureSnapshotEquals,
  validateRenderFeaturePlan,
} from '../features/plan';
import { ownRenderFeatureProgramData } from '../features/prepared-gpu-work';

function bindingValuePlan(value: RenderFeatureBindingValue): RenderFeatureWorkPlan {
  return {
    resources: [
      { kind: 'graphics-bindings', name: 'state', program: 'program', values: { probe: value } },
    ],
    passes: [],
  };
}

function bindingValueNode(
  snapshot: ReturnType<typeof cloneRenderFeaturePlanSignatureSnapshot>,
): Extract<NonNullable<(typeof snapshot.resources)[number]>, { kind: 'primitive' }> {
  const resource = snapshot.resources[0];
  if (resource?.kind !== 'object') throw new Error('Missing binding resource snapshot');
  const values = resource.values[resource.keys.indexOf('values')];
  if (values?.kind !== 'object') throw new Error('Missing binding values object');
  const value = values.values[values.keys.indexOf('probe')];
  if (value?.kind !== 'primitive') throw new Error('Missing primitive binding value');
  return value;
}

it('keeps native numeric hints canonical across signed zero and non-finite numbers', () => {
  const plan = (size: number): RenderFeatureWorkPlan => ({
    resources: [{ kind: 'buffer', name: 'range', size, usage: ['storage'] }],
    passes: [],
  });
  const negativeZero = cloneOwnedRenderFeaturePlanSignatureSnapshot(plan(-0));
  const negativeZeroNode = negativeZero.resources[0];
  if (negativeZeroNode?.kind !== 'object') throw new Error('Missing buffer snapshot');
  const zero = negativeZeroNode.values[negativeZeroNode.keys.indexOf('size')];
  expect(zero).toMatchObject({ kind: 'primitive', token: '0', numberValue: -0 });
  expect(renderFeaturePlanSignatureSnapshotEquals(plan(+0), negativeZero)).toBe(true);

  const notANumber = cloneOwnedRenderFeaturePlanSignatureSnapshot(plan(Number.NaN));
  const nanNode = notANumber.resources[0];
  if (nanNode?.kind !== 'object') throw new Error('Missing non-finite buffer snapshot');
  const special = nanNode.values[nanNode.keys.indexOf('size')];
  expect(special).toMatchObject({ kind: 'primitive', token: 'null', numberValue: Number.NaN });
  expect(renderFeaturePlanSignatureSnapshotEquals(plan(Number.POSITIVE_INFINITY), notANumber)).toBe(
    true,
  );
  expect(renderFeaturePlanSignatureSnapshotEquals(plan(Number.NEGATIVE_INFINITY), notANumber)).toBe(
    true,
  );
});

it.each([
  true,
  false,
  null,
  undefined,
])('uses native primitive literals after one formatter property read for %s', (value) => {
  const snapshot = cloneOwnedRenderFeaturePlanSignatureSnapshot(bindingValuePlan(value));
  const node = bindingValueNode(snapshot);
  expect(node.token).toBe(JSON.stringify(value) ?? 'undefined');

  const original = Object.getOwnPropertyDescriptor(JSON, 'stringify');
  if (typeof original?.value !== 'function') throw new Error('Missing native stringify');
  let reads = 0;
  Object.defineProperty(JSON, 'stringify', {
    configurable: true,
    enumerable: original.enumerable ?? false,
    get() {
      reads += 1;
      return original.value;
    },
  });
  try {
    expect(renderFeaturePlanSignatureSnapshotEquals(bindingValuePlan(value), snapshot)).toBe(true);
    expect(reads).toBe(1);
  } finally {
    Object.defineProperty(JSON, 'stringify', original);
  }
});

it('uses the formatter selected after a borrowed getter changes it mid-comparison', () => {
  const original = Object.getOwnPropertyDescriptor(JSON, 'stringify');
  if (typeof original?.value !== 'function') throw new Error('Missing native stringify');
  const failure = new Error('borrowed formatter failure');
  let receiver: unknown;
  const plan = (size: number): RenderFeatureWorkPlan => ({
    resources: [
      {
        kind: 'buffer',
        get name() {
          Object.defineProperty(JSON, 'stringify', {
            ...original,
            value: function (this: unknown) {
              receiver = this;
              throw failure;
            },
          });
          return 'range';
        },
        size,
        usage: ['storage'],
      } as RenderFeatureWorkPlan['resources'][number],
    ],
    passes: [],
  });
  const snapshot = cloneRenderFeaturePlanSignatureSnapshot({
    resources: [{ kind: 'buffer', name: 'range', size: 4, usage: ['storage'] }],
    passes: [],
  });
  try {
    expect(() => renderFeaturePlanSignatureSnapshotEquals(plan(4), snapshot)).toThrow(failure);
    expect(receiver).toBe(JSON);
  } finally {
    Object.defineProperty(JSON, 'stringify', original);
  }
});

it('does not reuse a boolean literal when the selected formatter is custom', () => {
  const original = Object.getOwnPropertyDescriptor(JSON, 'stringify');
  if (typeof original?.value !== 'function') throw new Error('Missing native stringify');
  const failure = new Error('custom boolean formatter failure');
  const snapshot = cloneOwnedRenderFeaturePlanSignatureSnapshot(bindingValuePlan(true));
  let receiver: unknown;
  Object.defineProperty(JSON, 'stringify', {
    ...original,
    value: function (this: unknown, value: unknown) {
      receiver = this;
      if (typeof value === 'boolean') throw failure;
      return original.value.call(this, value);
    },
  });
  try {
    expect(() =>
      renderFeaturePlanSignatureSnapshotEquals(bindingValuePlan(true), snapshot),
    ).toThrow(failure);
    expect(receiver).toBe(JSON);
  } finally {
    Object.defineProperty(JSON, 'stringify', original);
  }
});

it('creates number hints only from native tokens while the formatter switches custom and back', () => {
  const original = Object.getOwnPropertyDescriptor(JSON, 'stringify');
  if (typeof original?.value !== 'function') throw new Error('Missing native stringify');
  const plan = (size: number): RenderFeatureWorkPlan => ({
    resources: [{ kind: 'buffer', name: 'range', size, usage: ['storage'] }],
    passes: [],
  });
  let customCalls = 0;
  Object.defineProperty(JSON, 'stringify', {
    ...original,
    value: function (this: unknown, value: unknown) {
      customCalls += 1;
      if (this !== JSON) throw new Error('Custom formatter receiver changed');
      return typeof value === 'number' ? `custom:${value}` : original.value.call(this, value);
    },
  });
  try {
    const custom = cloneOwnedRenderFeaturePlanSignatureSnapshot(plan(8));
    const customResource = custom.resources[0];
    if (customResource?.kind !== 'object') throw new Error('Missing custom buffer snapshot');
    expect(customResource.values[customResource.keys.indexOf('size')]).toMatchObject({
      kind: 'primitive',
      token: 'custom:8',
    });
    expect(customResource.values[customResource.keys.indexOf('size')]).not.toHaveProperty(
      'numberValue',
    );
    expect(customCalls).toBeGreaterThan(0);

    Object.defineProperty(JSON, 'stringify', original);
    expect(renderFeaturePlanSignatureSnapshotEquals(plan(8), custom)).toBe(false);
    const renewedNative = cloneOwnedRenderFeaturePlanSignatureSnapshot(plan(8), custom);
    const renewedResource = renewedNative.resources[0];
    if (renewedResource?.kind !== 'object') throw new Error('Missing renewed native snapshot');
    expect(renewedResource.values[renewedResource.keys.indexOf('size')]).toMatchObject({
      kind: 'primitive',
      token: '8',
      numberValue: 8,
    });

    const failure = new Error('formatter switched back to custom');
    Object.defineProperty(JSON, 'stringify', {
      ...original,
      value: (_value: unknown) => {
        throw failure;
      },
    });
    expect(() => renderFeaturePlanSignatureSnapshotEquals(plan(8), renewedNative)).toThrow(failure);
  } finally {
    Object.defineProperty(JSON, 'stringify', original);
  }
});

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
  expect(validateRenderFeaturePlan('owned', plan).ok).toBe(true);
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
  expect(validateRenderFeaturePlan('invalid', invalid).ok).toBe(false);
  const bytes = new Uint32Array([1]);
  const uploaded = { ...buffer, data: bytes };
  const uploadPlan: RenderFeatureWorkPlan = { resources: [uploaded], passes: [] };
  const uploadSnapshot = cloneRenderFeaturePlanSignatureSnapshot(uploadPlan);
  bytes[0] = 2;
  expect(renderFeaturePlanSignatureSnapshotEquals(uploadPlan, uploadSnapshot)).toBe(true);
  expect(validateRenderFeaturePlan('upload', uploadPlan).ok).toBe(true);
});

it('uses initialization version and byte length as buffer topology while ignoring its copy closure', () => {
  const copyInto = vi.fn((target: Uint8Array) => {
    target.fill(1);
    return true;
  });
  const initialization = { version: 'sdf-fields-v1', byteLength: 16, copyInto };
  const buffer = {
    kind: 'buffer' as const,
    name: 'sdf-fields',
    allocationKey: initialization.version,
    size: 16,
    usage: ['storage'] as const,
    initialization,
  };
  const plan: RenderFeatureWorkPlan = { resources: [buffer], passes: [] };
  const snapshot = cloneOwnedRenderFeaturePlanSignatureSnapshot(plan);
  const signature = renderFeaturePlanSignature(plan);

  const replacementCopy = vi.fn((target: Uint8Array) => {
    target.fill(2);
    return true;
  });
  const sameMetadata: RenderFeatureWorkPlan = {
    resources: [{ ...buffer, initialization: { ...initialization, copyInto: replacementCopy } }],
    passes: [],
  };
  expect(renderFeaturePlanSignatureSnapshotEquals(sameMetadata, snapshot)).toBe(true);
  expect(cloneOwnedRenderFeaturePlanSignatureSnapshot(sameMetadata, snapshot)).toBe(snapshot);
  expect(renderFeaturePlanSignature(sameMetadata)).toBe(signature);
  expect(copyInto).not.toHaveBeenCalled();
  expect(replacementCopy).not.toHaveBeenCalled();

  const changedVersion: RenderFeatureWorkPlan = {
    resources: [
      {
        ...buffer,
        allocationKey: 'sdf-fields-v2',
        initialization: { ...initialization, version: 'sdf-fields-v2' },
      },
    ],
    passes: [],
  };
  expect(renderFeaturePlanSignatureSnapshotEquals(changedVersion, snapshot)).toBe(false);
  expect(renderFeaturePlanSignature(changedVersion)).not.toBe(signature);

  const changedByteLength: RenderFeatureWorkPlan = {
    resources: [{ ...buffer, initialization: { ...initialization, byteLength: 12 } }],
    passes: [],
  };
  expect(renderFeaturePlanSignatureSnapshotEquals(changedByteLength, snapshot)).toBe(false);
  expect(renderFeaturePlanSignature(changedByteLength)).not.toBe(signature);
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
  expect(validateRenderFeaturePlan('arena', initial).ok).toBe(true);
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
