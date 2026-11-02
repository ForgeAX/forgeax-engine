import type { AssetHandle } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  GpuDrivenMaterialProgramProjection,
  gpuShadowProgramsCompatible,
} from '../gpu-driven/material-artifacts';
import { MaterialResource } from '../material-resource';
import { defaultMaterialSnapshot } from '../render-system-extract';
import { MaterialFrame } from '../scene/material-dispatch';

const resource = (handle: number, shader = 'forgeax::default-standard-pbr') =>
  new MaterialResource({
    ...defaultMaterialSnapshot(handle),
    materialShaderId: shader,
    immutableValues: true,
  });
const project = (frame: MaterialFrame) =>
  new GpuDrivenMaterialProgramProjection().project([], frame);

it('retains GPU shadow coverage across binding counts and unrelated numeric material edits', () => {
  const skin = resource(1, 'forgeax::pbr-skin');
  const rigid = resource(2);
  const before = new MaterialFrame(undefined).with(skin).with(rigid);
  const after = before.with(skin, 10_000).with(rigid, 128, {
    ...rigid.snapshot,
    roughness: 0.25,
  });
  expect(gpuShadowProgramsCompatible(project(before), project(after))).toBe(true);
});

it('compares captured versions without rereading a mutable material owner', () => {
  const material = resource(1);
  const before = new MaterialFrame(undefined).with(material);
  const after = before.with(material, 2);
  const left = project(before);
  const right = project(after);
  const read = vi.spyOn(material, 'snapshot', 'get').mockImplementation(() => {
    throw new Error('live material read outside its preparation fence');
  });
  try {
    expect(gpuShadowProgramsCompatible(left, right)).toBe(true);
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

it.each([
  16, 4096,
])('visits only changed material versions among %i retained resources', (count) => {
  const materials = Array.from({ length: count }, (_, index) => resource(index + 1));
  let before = new MaterialFrame(undefined);
  for (const material of materials) before = before.with(material);
  const changed = materials[0];
  if (changed === undefined) throw new Error('missing selected material');
  const after = before.with(changed, 1, { ...changed.snapshot, roughness: 0.25 });
  let visited = 0;
  const changes = after.changesSince.bind(after);
  const observe = vi.spyOn(after, 'changesSince').mockImplementation((previous, visit) =>
    changes(previous, (left, right) => {
      visited++;
      visit(left, right);
    }),
  );
  try {
    expect(gpuShadowProgramsCompatible(project(before), project(after))).toBe(true);
    expect(visited).toBe(1);
  } finally {
    observe.mockRestore();
  }
});

it('requires a staged shadow route and a current accepted program table', () => {
  const index = project(new MaterialFrame(undefined));
  expect(gpuShadowProgramsCompatible(index, index)).toBe(true);
  expect(gpuShadowProgramsCompatible(undefined, index)).toBe(false);
  expect(gpuShadowProgramsCompatible(index, undefined)).toBe(false);
});

it.each([
  'add',
  'remove',
] as const)('does not borrow coverage after material membership %s', (kind) => {
  const first = resource(1);
  const before = new MaterialFrame(undefined).with(first);
  const after = kind === 'add' ? before.with(resource(2)) : before.without(first);
  expect(gpuShadowProgramsCompatible(project(before), project(after))).toBe(false);
});

it.each([
  { textureHandles: new Map([['baseColorTexture', 7 as AssetHandle<'texture'>]]) },
  { materialShaderId: 'game::new-program' },
  { paramSnapshot: { alphaCutoff: 0.5 } },
  { renderState: { cullMode: 'none' as const } },
  { passes: [] },
])('invalidates changed shadow program, binding or route facts: %j', (edit) => {
  const material = resource(1);
  const before = new MaterialFrame(undefined).with(material);
  const after = before.with(material, 1, { ...material.snapshot, ...edit });
  expect(gpuShadowProgramsCompatible(project(before), project(after))).toBe(false);
});

it('keeps noncanonical programs conservative even for a numeric-only replacement', () => {
  const material = resource(1, 'game::custom');
  const before = new MaterialFrame(undefined).with(material);
  const after = before.with(material, 1, { ...material.snapshot, roughness: 0.25 });
  expect(gpuShadowProgramsCompatible(project(before), project(after))).toBe(false);
});

it('does not widen a raw material table proof when only another material changes', () => {
  const raw = new MaterialResource(defaultMaterialSnapshot(1));
  const owned = new MaterialResource({ ...defaultMaterialSnapshot(2), immutableValues: true });
  const before = new MaterialFrame(undefined).with(raw).with(owned);
  const after = before.with(owned, 2);
  expect(gpuShadowProgramsCompatible(project(before), project(after))).toBe(false);
  expect(gpuShadowProgramsCompatible(project(before), project(before))).toBe(false);
});

it('does not invoke an ownership getter while admitting borrowed material values', () => {
  const ownership = vi.fn(() => {
    throw new Error('borrowed ownership getter');
  });
  const snapshot = { ...defaultMaterialSnapshot(1) };
  Object.defineProperty(snapshot, 'immutableValues', { get: ownership });
  const material = new MaterialResource(snapshot);
  const before = new MaterialFrame(undefined).with(material);
  expect(before.hasBorrowedValues).toBe(true);
  const after = before.with(material, 2);
  expect(gpuShadowProgramsCompatible(project(before), project(after))).toBe(false);
  expect(ownership).not.toHaveBeenCalled();
});

it('derives aggregate ownership from membership while preserving older material frames', () => {
  const owned = resource(1);
  const raw = new MaterialResource(defaultMaterialSnapshot(2));
  const first = new MaterialFrame(undefined).with(owned);
  const borrowed = first.with(raw, 0);
  const restored = borrowed.without(raw);
  expect(first.hasBorrowedValues).toBe(false);
  expect(borrowed.hasBorrowedValues).toBe(true);
  expect(restored.hasBorrowedValues).toBe(false);
});
