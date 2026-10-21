import { vec3 } from '@forgeax/engine-math';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { assert, describe, expect, it, vi } from 'vitest';
import { MaterialResource } from '../material-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { PerSubmeshMaterialBgDeps } from '../record/main-pass-material';
import {
  MaterialUniformRecording,
  materialUniformResources,
  materialUniformSlot,
  prepareMaterialUniform,
  prepareMaterialUniformFrame,
  recordMaterialUniforms,
} from '../record/material-uniforms';
import { MATERIAL_PER_ENTITY_STRIDE } from '../record/render-context';
import { MaterialFrame } from '../scene/material-dispatch';

function material(value = 1) {
  return new MaterialResource({
    passes: [],
    baseColor: vec3.create(value, 0, 0),
    metallic: 0,
    roughness: 0.5,
    materialParamSchema: [{ name: 'baseColor', type: 'vec4' }],
    immutableValues: true,
  });
}
function fixture() {
  const writeBuffer = vi.fn().mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  const deps = {
    runtime: { device: { queue }, errorRegistry: { fire: vi.fn() } },
    pipelineState: {
      materialUniformBuffer: {
        buffer: {} as Buffer,
        sizeInBytes: 4096 * MATERIAL_PER_ENTITY_STRIDE,
      },
    },
    frameState: { warnedMissingBaseColorTextureHandles: new Set<number>() },
  } as unknown as PerSubmeshMaterialBgDeps;
  return { deps, writeBuffer, world: {} as RenderResourceScope };
}

describe('draw-owned shared material storage', () => {
  it('packs one edited root independently of 10,000 draw uses and 1,000 unrelated roots', () => {
    const { deps, world, writeBuffer } = fixture();
    const roots = Array.from({ length: 1001 }, () => material());
    let frame = new MaterialFrame(undefined);
    for (const root of roots) frame = frame.with(root);
    prepareMaterialUniformFrame(deps.runtime, frame);
    const resources = materialUniformResources([]);
    for (const root of roots) prepareMaterialUniform(deps, root.snapshot, world, resources);
    const before = deps.frameState.materialUboCounters?.packMisses;
    writeBuffer.mockClear();
    const changed = roots[0];
    assert(changed);
    changed.adopt({ ...changed.snapshot, baseColor: vec3.create(0, 1, 0) });
    frame = frame.with(changed);
    prepareMaterialUniformFrame(deps.runtime, frame);
    expect(writeBuffer).not.toHaveBeenCalled();
    for (let index = 0; index < 10_000; index++)
      prepareMaterialUniform(deps, changed.snapshot, world, resources);
    for (const root of roots) prepareMaterialUniform(deps, root.snapshot, world, resources);
    expect(deps.frameState.materialUboCounters?.packMisses).toBe((before ?? 0) + 1);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
  });

  it('native resource tuples invalidate only the actually changed root', () => {
    const { deps, world, writeBuffer } = fixture();
    const roots = Array.from({ length: 1000 }, () => material());
    const textures = roots.map(() => ({}));
    const sampler = {};
    const identities = textures.map((texture) => materialUniformResources([sampler, texture]));
    roots.forEach((root, index) => {
      const identity = identities[index];
      assert(identity);
      prepareMaterialUniform(deps, root.snapshot, world, identity);
    });
    const packed = deps.frameState.materialUboCounters?.packMisses ?? 0;
    writeBuffer.mockClear();
    identities[617] = materialUniformResources([sampler, {}]);
    roots.forEach((root, index) => {
      const identity = identities[index];
      assert(identity);
      prepareMaterialUniform(deps, root.snapshot, world, identity);
    });
    expect(deps.frameState.materialUboCounters?.packMisses).toBe(packed + 1);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    const retainedTexture = textures[4];
    assert(retainedTexture);
    expect(materialUniformResources([sampler, retainedTexture])).toBe(identities[4]);
  });

  it('restores a fixed earlier version in the same root address after a newer view', () => {
    const { deps, world, writeBuffer } = fixture();
    const root = material();
    const old = root.snapshot;
    const resources = materialUniformResources([]);
    const firstSlot = prepareMaterialUniform(deps, old, world, resources);
    root.adopt({ ...old, baseColor: vec3.create(0, 1, 0) });
    expect(prepareMaterialUniform(deps, root.snapshot, world, resources)).toBe(firstSlot);
    expect(prepareMaterialUniform(deps, old, world, resources)).toBe(firstSlot);
    const bytes = writeBuffer.mock.calls.at(-1)?.[2] as Uint8Array;
    expect(Array.from(new Float32Array(bytes.buffer).slice(0, 3))).toEqual([1, 0, 0]);
    expect(deps.frameState.materialUboCounters?.packMisses).toBe(2);
  });

  it('retries all overlapping physical pages after a partial failure and admits new pages', () => {
    const { deps, world, writeBuffer } = fixture();
    const root = material();
    const pages = {
      byteStride: MATERIAL_PER_ENTITY_STRIDE / 2,
      byteSize: MATERIAL_PER_ENTITY_STRIDE,
      buffers: [{} as Buffer, {} as Buffer],
    };
    Object.assign(deps.pipelineState.materialUniformBuffer, { buffer: null, pages });
    const resources = materialUniformResources([]);
    const failure = new Error('second page failed');
    writeBuffer.mockReturnValueOnce(ok(undefined)).mockReturnValueOnce(err(failure));
    expect(() => prepareMaterialUniform(deps, root.snapshot, world, resources)).toThrow(failure);
    prepareMaterialUniform(deps, root.snapshot, world, resources);
    expect(writeBuffer.mock.calls.map((call) => call[0])).toEqual([
      pages.buffers[0],
      pages.buffers[1],
      pages.buffers[0],
      pages.buffers[1],
    ]);
    writeBuffer.mockClear();
    prepareMaterialUniform(deps, root.snapshot, world, resources);
    expect(writeBuffer).not.toHaveBeenCalled();
  });

  it('frees removed root addresses through MaterialFrame deltas and restores skipped versions', () => {
    const { deps } = fixture();
    const a = material(),
      b = material();
    const first = new MaterialFrame(undefined).with(a).with(b);
    expect(prepareMaterialUniformFrame(deps.runtime, first)).toBe(2);
    const aSlot = materialUniformSlot(deps.runtime, a.snapshot);
    const bSlot = materialUniformSlot(deps.runtime, b.snapshot);
    expect(
      prepareMaterialUniformFrame(deps.runtime, new MaterialFrame(undefined).with(b)),
    ).toBeLessThanOrEqual(2);
    const c = material();
    expect(
      prepareMaterialUniformFrame(deps.runtime, new MaterialFrame(undefined).with(b).with(c)),
    ).toBe(2);
    expect(materialUniformSlot(deps.runtime, c.snapshot)).toBe(aSlot);
    expect(materialUniformSlot(deps.runtime, b.snapshot)).toBe(bSlot);
    expect(prepareMaterialUniformFrame(deps.runtime, first)).toBe(2);
    expect(materialUniformSlot(deps.runtime, a.snapshot)).toBe(aSlot);
  });
});

it('forks only unsubmitted versions and reuses a single slot across ordinary submitted frames', () => {
  const { deps, world } = fixture();
  const root = material();
  const resources = materialUniformResources([]);
  let original = -1;
  for (let frame = 0; frame < 60; frame++) {
    root.adopt({ ...root.snapshot, roughness: frame / 60 });
    recordMaterialUniforms(() => {
      const slot = prepareMaterialUniform(deps, root.snapshot, world, resources);
      if (frame === 0) original = slot;
      expect(slot).toBe(original);
    });
  }
  const old = root.snapshot;
  let latest = -1;
  recordMaterialUniforms(() => {
    const first = prepareMaterialUniform(deps, old, world, resources);
    root.adopt({ ...old, roughness: 0.25 });
    latest = prepareMaterialUniform(deps, root.snapshot, world, resources);
    expect(latest).not.toBe(first);
    expect(prepareMaterialUniform(deps, old, world, resources)).toBe(first);
  });
  recordMaterialUniforms(() =>
    expect(prepareMaterialUniform(deps, root.snapshot, world, resources)).toBe(latest),
  );
  const failure = new Error('record rejected');
  expect(() =>
    recordMaterialUniforms(() => {
      prepareMaterialUniform(deps, root.snapshot, world, resources);
      root.adopt({ ...root.snapshot, roughness: 0.75 });
      prepareMaterialUniform(deps, root.snapshot, world, resources);
      throw failure;
    }),
  ).toThrow(failure);
  root.adopt({ ...root.snapshot, roughness: 1 });
  expect(prepareMaterialUniformFrame(deps.runtime, new MaterialFrame(undefined).with(root))).toBe(
    1,
  );
});

it('shares uniform allocation between capture and display runtimes using the same physical storage', () => {
  const { deps, world, writeBuffer } = fixture();
  Object.assign(deps.runtime, { meshSsboState: {} });
  const capture = { ...deps, runtime: Object.create(deps.runtime) };
  const red = material(1);
  const green = material(0);
  green.adopt({ ...green.snapshot, baseColor: vec3.create(0, 1, 0) });
  const resources = materialUniformResources([]);
  prepareMaterialUniformFrame(deps.runtime, new MaterialFrame(undefined).with(red).with(green));
  recordMaterialUniforms(() => {
    const captured = prepareMaterialUniform(capture, green.snapshot, world, resources);
    const display = prepareMaterialUniform(deps, red.snapshot, world, resources);
    expect(display).not.toBe(captured);
    expect(materialUniformSlot(capture.runtime, green.snapshot)).toBe(captured);
    expect(prepareMaterialUniform(deps, green.snapshot, world, resources)).toBe(captured);
    const writes = new Map<number, Uint8Array>();
    for (const [, offset, bytes] of writeBuffer.mock.calls) writes.set(offset, bytes);
    const values = (slot: number) => {
      const bytes = writes.get(slot * MATERIAL_PER_ENTITY_STRIDE);
      assert(bytes);
      return Array.from(new Float32Array(bytes.buffer).slice(0, 3));
    };
    expect(values(captured)).toEqual([0, 1, 0]);
    expect(values(display)).toEqual([1, 0, 0]);
  });
});

it('pins earlier versions across suspended preparation without leaking into another recording', () => {
  const { deps, world } = fixture();
  const root = material();
  const resources = materialUniformResources([]);
  const original = root.snapshot;
  const suspended = new MaterialUniformRecording();
  const first = suspended.run(() => prepareMaterialUniform(deps, original, world, resources));
  root.adopt({ ...original, roughness: 0.25 });
  let second = -1;
  recordMaterialUniforms(() => {
    second = prepareMaterialUniform(deps, root.snapshot, world, resources);
    expect(second).not.toBe(first);
  });
  suspended.run(() => {
    expect(prepareMaterialUniform(deps, original, world, resources)).toBe(first);
    expect(prepareMaterialUniform(deps, root.snapshot, world, resources)).toBe(second);
  });
  root.adopt({ ...root.snapshot, roughness: 0.75 });
  const third = prepareMaterialUniform(deps, root.snapshot, world, resources);
  expect(third).not.toBe(first);
  expect(third).not.toBe(second);
  suspended.complete();
  suspended.complete();
  root.adopt({ ...root.snapshot, roughness: 1 });
  expect(prepareMaterialUniformFrame(deps.runtime, new MaterialFrame(undefined).with(root))).toBe(
    1,
  );
});
