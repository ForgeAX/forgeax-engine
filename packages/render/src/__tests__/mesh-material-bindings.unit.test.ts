import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  type MeshMaterialBindingResidency,
  projectMeshMaterialBindingObservation,
  resolveMeshMaterialBindings,
} from '../mesh-material-bindings';

function guid(value: string) {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw new Error(`invalid fixture guid: ${value}`);
  return parsed.value;
}

const DEFAULT_A = guid('019d0000-0000-7000-8000-000000000001');
const DEFAULT_B = guid('019d0000-0000-7000-8000-000000000002');

function mesh(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(0),
    attributes: {},
    submeshes: [
      { indexOffset: 0, indexCount: 0, vertexCount: 0, topology: 'triangle-list', materialSlot: 0 },
      { indexOffset: 0, indexCount: 0, vertexCount: 0, topology: 'triangle-list', materialSlot: 1 },
      { indexOffset: 0, indexCount: 0, vertexCount: 0, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [
      { slotName: 'Body', defaultMaterial: DEFAULT_A },
      { slotName: 'Trim', defaultMaterial: DEFAULT_B },
    ],
  };
}

describe('resolveMeshMaterialBindings', () => {
  it('fails closed instead of throwing when a runtime producer omits materialSlots', () => {
    const result = resolveMeshMaterialBindings(
      { ...mesh(), materialSlots: undefined } as unknown as MeshAsset,
      [],
      deps,
    );
    expect(result).toEqual({ ok: false, code: 'mesh-material-slots-missing' });
  });
  const deps = {
    isValidOverride: (handle: number) => handle === 11,
    resolveMeshDefault: (guid: typeof DEFAULT_A | AssetHandle<'material'>) =>
      typeof guid === 'number'
        ? guid
        : AssetGuid.format(guid) === AssetGuid.format(DEFAULT_A)
          ? 21
          : 22,
  };

  it('inherits every mesh default for an empty override vector', () => {
    expect(resolveMeshMaterialBindings(mesh(), [], deps)).toEqual({
      ok: true,
      bindings: [
        { handle: 21, source: 'mesh-default' },
        { handle: 22, source: 'mesh-default' },
      ],
      diagnostics: [],
    });
  });

  it('supports partial overrides and treats zero as inherit', () => {
    expect(resolveMeshMaterialBindings(mesh(), [11, 0], deps)).toMatchObject({
      ok: true,
      bindings: [
        { handle: 11, source: 'renderer-override' },
        { handle: 22, source: 'mesh-default' },
      ],
    });
  });

  it('falls back from an invalid override and reports overflow without changing slot count', () => {
    expect(resolveMeshMaterialBindings(mesh(), [99, 0, 11], deps)).toEqual({
      ok: true,
      bindings: [
        { handle: 21, source: 'mesh-default' },
        { handle: 22, source: 'mesh-default' },
      ],
      diagnostics: [
        { code: 'mesh-renderer-material-override-overflow', slotIndex: 2 },
        { code: 'mesh-renderer-material-override-invalid', slotIndex: 0, handle: 99 },
      ],
    });
  });

  it('fails closed when a declared mesh default is unavailable', () => {
    const result = resolveMeshMaterialBindings(mesh(), [], {
      isValidOverride: () => false,
      resolveMeshDefault: () => undefined,
    });
    expect(result).toMatchObject({ ok: false, slotIndex: 0 });
  });
});

it('captures the binding producer table before its arrays change', () => {
  const resolved = resolveMeshMaterialBindings(mesh(), [11, 99, 11], {
    isValidOverride: (handle) => handle === 11,
    resolveMeshDefault: () => 21,
  });
  if (!resolved.ok) throw Error('Expected resolved fixture material bindings');
  const binding = resolved.bindings[0];
  const diagnostic = resolved.diagnostics[0];
  const observation = projectMeshMaterialBindingObservation({
    worldId: 0,
    entityKey: 1,
    bindings: resolved.bindings,
    diagnostics: resolved.diagnostics,
  });
  Reflect.set(resolved.bindings, 0, { handle: 0, source: 'engine-default' });
  Reflect.set(resolved.diagnostics, 0, {
    code: 'mesh-renderer-material-override-invalid',
    slotIndex: 1,
  });
  expect(observation.bindings[0]).toBe(binding);
  expect(observation.diagnostics[0]).toBe(diagnostic);
  expect(Object.isFrozen(observation.bindings)).toBe(true);
  expect(Object.isFrozen(observation.diagnostics)).toBe(true);
});

function observation(residency: MeshMaterialBindingResidency) {
  return projectMeshMaterialBindingObservation({
    worldId: 0,
    entityKey: 1,
    bindings: [{ handle: 0, source: 'engine-default' }],
    diagnostics: [],
    residency: [residency],
  });
}

it.each([
  'readiness',
  'sampler',
  'texture',
  'failure',
  'detail',
] as const)('captures a frozen %s accessor without retaining its live source', (field) => {
  let changed = false;
  const reads: string[] = [];
  const sampler = { handle: 18, resident: true };
  const texture = { handle: 17, mipLevelCount: 3 };
  const detail = { slot: 1 };
  const failure = { code: 'invalid', expected: 'texture', hint: 'repair', detail };
  const residency: MeshMaterialBindingResidency = {
    readiness: 'ready',
    samplers: [sampler],
    textures: [texture],
    preparationFailure: failure,
  };
  const targets = {
    readiness: { object: residency, key: 'readiness', next: 'failed' },
    sampler: { object: sampler, key: 'resident', next: false },
    texture: { object: texture, key: 'mipLevelCount', next: 0 },
    failure: { object: failure, key: 'expected', next: 'changed' },
    detail: { object: detail, key: 'slot', next: 2 },
  };
  const target = targets[field];
  const original = Reflect.get(target.object, target.key);
  Object.defineProperty(target.object, target.key, {
    get: () => {
      reads.push(field);
      return changed ? target.next : original;
    },
  });
  for (const value of [
    sampler,
    texture,
    detail,
    failure,
    residency.samplers,
    residency.textures,
    residency,
  ])
    Object.freeze(value);
  const projected = observation(residency).residency[0];
  expect(reads).toEqual([field]);
  expect(projected === residency).toBe(false);
  changed = true;
  expect(projected).toMatchObject({
    readiness: 'ready',
    samplers: [{ handle: 18, resident: true }],
    textures: [{ handle: 17, mipLevelCount: 3 }],
    preparationFailure: { expected: 'texture', detail: { slot: 1 } },
  });
  expect(reads).toEqual([field]);
});

it.each([
  'own',
  'prototype',
] as const)('does not call a borrowed array %s every override', (kind) => {
  let calls = 0;
  const sampler = { handle: 18, resident: true };
  const samplers = [sampler];
  const every = () => {
    calls += 1;
    return true;
  };
  if (kind === 'own') Object.defineProperty(samplers, 'every', { value: every });
  else Object.setPrototypeOf(samplers, Object.assign(Object.create(Array.prototype), { every }));
  Object.freeze(samplers);
  const source = Object.freeze({
    readiness: 'ready' as const,
    samplers,
    textures: Object.freeze([]),
  });
  const projected = observation(source);
  expect(calls).toBe(0);
  sampler.resident = false;
  expect(projected.residency[0]?.samplers[0]?.resident).toBe(true);
});

it.each([
  'bindings',
  'diagnostics',
] as const)('detaches a frozen %s array index accessor', (field) => {
  const first = Object.freeze({
    handle: 1,
    source: 'engine-default' as const,
    code: 'mesh-renderer-material-override-invalid' as const,
    slotIndex: 0,
  });
  const second = Object.freeze({ ...first, handle: 2 });
  let current: typeof first | typeof second = first;
  let reads = 0;
  const rows = [first];
  Object.defineProperty(rows, 0, {
    get: () => {
      reads += 1;
      return current;
    },
  });
  Object.freeze(rows);
  const projected = projectMeshMaterialBindingObservation({
    worldId: 0,
    entityKey: 1,
    bindings: [],
    diagnostics: [],
    [field]: rows,
  });
  expect(reads).toBe(field === 'bindings' ? 2 : 1);
  current = second;
  expect(projected[field][0]).toBe(first);
  expect(projected[field]).not.toBe(rows);
});

it('preserves borrowed binding iteration failures', () => {
  const failure = Error('borrowed iteration failed');
  const bindings = [Object.freeze({ handle: 0, source: 'engine-default' as const })];
  Object.defineProperty(bindings, Symbol.iterator, {
    value: () => {
      throw failure;
    },
  });
  Object.freeze(bindings);
  expect(() =>
    projectMeshMaterialBindingObservation({
      worldId: 0,
      entityKey: 1,
      bindings,
      diagnostics: [],
    }),
  ).toThrow(failure);
});
