import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { assert, beforeAll, expect, it, vi } from 'vitest';
import {
  cookStaticShadow,
  OPAQUE_SWITCHES,
} from '../../../../shader-compiler/src/material/__tests__/standard-static-shadow.fixture';
import { updateShadowView } from '../../__tests__/helpers/gpu-input-read-domain';
import {
  shadowSourceFixture,
  shadowSourceSnapshot,
} from '../../__tests__/shadow-source-content.fixture';
import { MeshChanges, ShadowMeshReads } from '../../device/mesh-changes';
import { MaterialResource } from '../../material-resource';
import {
  installPublicationPrograms,
  rebindPublicationMaterialSchemas,
} from '../../publication/programs';
import { worldRenderResources } from '../../publication/resource-scope';
import { prepareDirectionalShadowCache } from '../../record/directional-shadow-cache';
import { collectGpuShadowMaterials } from '../../record/frame-gpu-driven';
import type { RenderFrameState } from '../../record/frame-snapshot';
import type { RenderSystemInternals } from '../../record/render-context';
import { defaultMaterialSnapshot, type MaterialSnapshot } from '../../render-system-extract';
import type { ViewLights } from '../../world/render-lights';
import { MaterialFrame } from '../material-dispatch';
import {
  ShadowMaterialContent,
  sameShadowMaterial,
  sameShadowMaterialFrames,
} from '../material-shadow-content';
import { MeshFrame } from '../mesh-frame';
import { type PersistentShadowCasterProjection, RenderScene } from '../render-scene';

let opaque: MaterialSnapshot, alpha: MaterialSnapshot, displaced: MaterialSnapshot;
function snapshot(cooked: Awaited<ReturnType<typeof cookStaticShadow>>): MaterialSnapshot {
  const pass = cooked.shadow;
  assert(pass.abi.entryPoints !== undefined);
  return {
    ...defaultMaterialSnapshot(),
    immutableValues: true,
    passes: [
      {
        name: 'shadow',
        program: { module: pass.module },
        renderState: { tags: { LightMode: 'ShadowCaster' } },
      },
    ],
    materialProgramKeys: { shadow: pass.sourceClosureDigest },
    materialProgramInputs: { shadow: { entryPoints: pass.abi.entryPoints } },
    materialParamSchema: pass.paramSchema,
    paramSnapshot: { roughness: 0.5, alphaCutoff: 0.5, displacementScale: 1, displacementBias: 0 },
  };
}
beforeAll(async () => {
  opaque = snapshot(await cookStaticShadow());
  alpha = snapshot(
    await cookStaticShadow({ staticSwitches: { ...OPAQUE_SWITCHES, alphaClipping: true } }),
  );
  displaced = snapshot(
    await cookStaticShadow({ staticSwitches: { ...OPAQUE_SWITCHES, displacement: true } }),
  );
});
const change = (source: MaterialSnapshot, name: string, value: number): MaterialSnapshot => ({
  ...source,
  paramSnapshot: { ...source.paramSnapshot, [name]: value },
});

it('uses the real cooked entry read sets, including old and new shared material frames', () => {
  expect(sameShadowMaterial(opaque, change(opaque, 'roughness', 0.9))).toBe(true);
  expect(sameShadowMaterial(opaque, change(opaque, 'alphaCutoff', 0.9))).toBe(true);
  expect(sameShadowMaterial(alpha, change(alpha, 'alphaCutoff', 0.9))).toBe(false);
  expect(sameShadowMaterial(displaced, change(displaced, 'displacementScale', 2))).toBe(false);
  expect(sameShadowMaterial(displaced, change(displaced, 'displacementBias', 1))).toBe(false);
  const material = new MaterialResource(opaque);
  const before = new MaterialFrame(undefined).with(material, 10_000);
  material.adopt(change(opaque, 'roughness', 0.9));
  const after = before.with(material);
  expect(sameShadowMaterialFrames(before, after)).toBe(true);
  expect(before.get(material)?.snapshot).toBe(opaque);
  expect(after.get(material)?.snapshot).toBe(material.snapshot);
});

it('witnesses fixed numeric materials without losing scope or selected-snapshot changes', () => {
  const first = new World(),
    second = new World();
  const resource = new MaterialResource(opaque);
  const frame = new MaterialFrame(undefined).with(resource);
  const capture = (
    materials: MaterialFrame,
    scope = worldRenderResources(first),
    selected = resource.snapshot,
  ) => {
    const content = new ShadowMaterialContent(materials);
    content.add(resource, selected, scope);
    return content;
  };
  const before = capture(frame);
  expect(capture(frame).same(before)).toBe(true);
  expect(capture(frame, worldRenderResources(second)).same(before)).toBe(false);
  expect(capture(frame, worldRenderResources(first), alpha).same(before)).toBe(false);
  resource.adopt(change(opaque, 'roughness', 0.9));
  const unread = capture(frame.with(resource));
  expect(unread.same(before)).toBe(true);
  resource.adopt(alpha);
  const masked = capture(frame.with(resource));
  expect(masked.same(before)).toBe(false);
  resource.adopt(change(alpha, 'alphaCutoff', 0.9));
  expect(capture(frame.with(resource)).same(masked)).toBe(false);
});

it('ignores shadow-read edits of frame materials no member uses', () => {
  const scope = worldRenderResources(new World());
  const member = new MaterialResource(opaque),
    other = new MaterialResource(alpha);
  const frame = new MaterialFrame(undefined).with(member).with(other);
  const capture = (materials: MaterialFrame) => {
    const content = new ShadowMaterialContent(materials);
    content.add(member, member.snapshot, scope);
    return content;
  };
  const before = capture(frame);
  other.adopt(change(alpha, 'alphaCutoff', 0.9));
  const otherEdited = frame.with(other);
  expect(sameShadowMaterialFrames(frame, otherEdited)).toBe(false);
  expect(capture(otherEdited).same(before)).toBe(true);
  member.adopt(alpha);
  expect(capture(otherEdited.with(member)).same(before)).toBe(false);
});

it('keeps views that batch different caster subsets, but not across a subset edit', () => {
  const scope = worldRenderResources(new World());
  const shared = new MaterialResource(opaque),
    subset = new MaterialResource(opaque);
  const frame = new MaterialFrame(undefined).with(shared).with(subset);
  const capture = (materials: MaterialFrame, members: readonly MaterialResource[]) => {
    const content = new ShadowMaterialContent(materials);
    for (const member of members) content.add(member, member.snapshot, scope);
    return content;
  };
  const main = capture(frame, [shared, subset]);
  expect(capture(frame, [shared]).same(main)).toBe(true);
  subset.adopt(alpha);
  expect(capture(frame.with(subset), [shared]).same(main)).toBe(false);
});

it.each([
  false,
  true,
])('captures shader-read texture versions with a fixed frame (%s)', async (withFrame) => {
  const assets = new AssetRegistry(),
    world = new World({ assets });
  const texture = () =>
    assets
      .create({
        kind: 'texture',
        format: 'rgba8unorm',
        colorSpace: 'linear',
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
        mips: { kind: 'none' },
        data: new Uint8Array(16),
      })
      .unwrap();
  const baseColor = texture(),
    unrelated = texture();
  const material = new MaterialResource({
    ...alpha,
    textureHandles: new Map([
      ['baseColorTexture', baseColor],
      ['displacementTexture', unrelated],
    ]),
  });
  const capture = () => {
    const content = new ShadowMaterialContent(
      withFrame ? new MaterialFrame(undefined).with(material) : undefined,
    );
    content.add(material, material.snapshot, worldRenderResources(world));
    return content;
  };
  const edit = (handle: typeof baseColor) =>
    assets
      .writeRange(handle, {
        origin: { x: 0, y: 0 },
        size: { width: 1, height: 1 },
        data: new Uint8Array(4).fill(255),
      })
      .unwrap();
  const fixture = await staticShadowFixture();
  const input = fixture.input();
  try {
    const old = capture();
    updateShadowView(fixture.pool, { ...input, shadowMaterials: old }).unwrap();
    fixture.pool._commitResourceReplacement();
    edit(unrelated);
    const unrelatedEdit = capture();
    expect(unrelatedEdit.same(old)).toBe(true);
    expect(
      updateShadowView(fixture.pool, { ...input, shadowMaterials: unrelatedEdit }).unwrap().cache,
    ).toBe('hit');
    edit(baseColor);
    const readEdit = capture();
    expect(readEdit.same(old)).toBe(false);
    expect(
      updateShadowView(fixture.pool, { ...input, shadowMaterials: readEdit }).unwrap().cache,
    ).toBe('invalidated');
    expect(fixture.pool.dirtyRects(fixture.identity)).toBeUndefined();
    expect(old.same(old)).toBe(true);
  } finally {
    fixture.dispose();
    assets.dispose();
  }
});

it('checks actual shadow material content before accepting an unchanged World proof', () => {
  const world = new World(),
    lease = createRenderReadLease(world);
  const internals = { assets: { catalogEpoch: 1 } } as unknown as RenderSystemInternals;
  const state = {
    compiledFrameGraph: { topologyKey: 'stable' },
    installedPipelineHandle: 1,
    directionalShadowCache: null,
  } as unknown as RenderFrameState;
  const lights = {
    cascades: {
      cascadeCount: 1,
      lightViewProj: [new Float32Array(16)],
      directionalShadowQuality: { kind: 'pcf', kernel: 3 },
    },
  } as unknown as ViewLights;
  const material = new MaterialResource(alpha),
    owner = {};
  const changes = new MeshChanges();
  const reads = new ShadowMeshReads(changes);
  reads.add(changes.create());
  let materials = new MaterialFrame(undefined).with(material, 10_000);
  const projection = (): PersistentShadowCasterProjection => ({
    meshDraws: new RenderScene(),
    content: {
      owner,
      materials,
      meshes: new MeshFrame(),
      sceneRevision: 0,
      dispatchRevision: 0,
      subsurface: { source: 0, authorVisible: 0, admitted: 0 },
    },
    renderables: [],
    dispatch: [],
    worldBoundsOf: () => false,
  });
  const decide = () =>
    prepareDirectionalShadowCache(
      internals,
      state,
      worldRenderResources(world),
      lease,
      lights,
      1024,
      { reads, epoch: changes.epoch, change: 'quiet' },
      projection(),
    );
  try {
    state.directionalShadowCache = decide().next;
    expect(decide().miss).toBeUndefined();
    material.adopt(change(alpha, 'alphaCutoff', 0.9));
    materials = materials.with(material);
    expect(decide().miss).toBe('content-changed');
  } finally {
    reads.release();
    changes.reset();
    lease.dispose();
  }
});

it('rebinds Worker-cloned shader reads to the receiving immutable program owner', () => {
  const assets = new AssetRegistry();
  try {
    const reads = opaque.materialProgramInputs?.shadow?.entryPoints;
    const key = opaque.materialProgramKeys?.shadow;
    assert(reads !== undefined && key !== undefined && opaque.materialParamSchema !== undefined);
    const programs = structuredClone([
      {
        key,
        shader: {
          source: 'struct P { baseColor: vec4<f32> } @group(1) @binding(0) var<uniform> p: P;',
          paramSchema: opaque.materialParamSchema,
          entryPoints: reads,
        },
      },
    ]);
    installPublicationPrograms(assets, programs);
    const registered = assets.shaderRegistry.findMaterialArtifact(key).unwrap().program.entryPoints;
    expect(registered).toEqual(reads);
    const copied = { ...structuredClone(opaque), materialProgramInputs: {} };
    const candidate = rebindPublicationMaterialSchemas(assets.shaderRegistry, {
      frame: { renderables: [] },
      materialUpdates: [new MaterialResource(copied)],
      operations: [],
    } as never);
    expect(candidate.materialUpdates[0]?.snapshot.materialProgramInputs?.shadow?.entryPoints).toBe(
      registered,
    );
    const malformed = structuredClone(programs);
    assert(malformed[0] !== undefined);
    malformed[0].shader.entryPoints = [];
    expect(() => installPublicationPrograms(assets, malformed)).toThrow(
      /conflicting immutable shader/,
    );
  } finally {
    assets.dispose();
  }
});

async function staticShadowFixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  return shadowSourceFixture(device, { createShaderModule: () => ok(shader) });
}

it('fully redraws retained static depth for material-only changes without geometric dirty boxes', async () => {
  const fixture = await staticShadowFixture();
  const resource = new MaterialResource(alpha);
  const before = new MaterialFrame(undefined).with(resource);
  const input = { ...fixture.input(), directMaterials: before };
  try {
    updateShadowView(fixture.pool, input).unwrap();
    fixture.pool._commitResourceReplacement();
    resource.adopt(change(alpha, 'specular', 0.9));
    const unread = before.with(resource);
    expect(sameShadowMaterialFrames(before, unread)).toBe(true);
    const unchanged = updateShadowView(fixture.pool, {
      ...input,
      directMaterials: unread,
    }).unwrap();
    expect({
      cache: unchanged.cache,
      reason: fixture.pool.invalidationReason(fixture.identity),
    }).toEqual({ cache: 'hit', reason: undefined });
    resource.adopt(change(alpha, 'alphaCutoff', 0.9));
    const after = unread.with(resource);
    expect(
      updateShadowView(fixture.pool, { ...input, directMaterials: after }).unwrap().cache,
    ).toBe('invalidated');
    expect(fixture.pool.inspect()[0]?.preparation).toMatchObject({
      materialContentMisses: 1,
      sceneBoundsMisses: 0,
    });
    expect(fixture.pool.dirtyRects(fixture.identity)).toBeUndefined();
    fixture.pool._commitResourceReplacement();
    expect(updateShadowView(fixture.pool, input).unwrap().cache).toBe('invalidated');
    expect(fixture.pool.dirtyRects(fixture.identity)).toBeUndefined();
  } finally {
    fixture.dispose();
  }
});

it.each([
  0, 1,
])('checks only the actual static row-material selection, including member %s', async (selectedSlot) => {
  const fixture = await staticShadowFixture();
  const world = new World();
  const scope = worldRenderResources(world);
  const resources = [new MaterialResource(alpha), new MaterialResource(alpha)];
  for (const [slot, resource] of resources.entries()) {
    const row = shadowSourceSnapshot(slot + 1, slot === 0 ? -10 : 10);
    fixture.update({ ...row, material: resource, materials: [resource], mobility: 'static' });
  }
  const selected = resources[selectedSlot];
  const unrelated = resources[1 - selectedSlot];
  assert(selected && unrelated);
  const base = fixture.input();
  expect(base.sourcePlan.batches.some((batch) => batch.key.rowMaterial === true)).toBe(true);
  const frame = () =>
    resources.reduce((frame, resource) => frame.with(resource), new MaterialFrame(undefined));
  const capture = () => {
    const materials = frame();
    const shadowMaterials = new ShadowMaterialContent(materials);
    const executions = new Map();
    for (const batch of base.sourcePlan.batches) {
      const binding = batch.binding;
      assert(binding);
      executions.set(binding, { shadow: { route: 'gpu', material: binding.material.snapshot } });
    }
    collectGpuShadowMaterials(
      {} as RenderSystemInternals,
      scope,
      executions,
      new Map(),
      shadowMaterials,
      undefined,
    );
    return {
      ...base,
      candidatePrimitiveIndices: [selectedSlot],
      materialSource: { slotAt: fixture.projection.slotAt },
      directMaterials: materials,
      shadowMaterials,
    };
  };
  try {
    const before = capture();
    updateShadowView(fixture.pool, before, before.sourcePlan).unwrap();
    fixture.pool._commitResourceReplacement();
    unrelated.adopt(change(alpha, 'alphaCutoff', 0.9));
    const dynamicOnly = capture();
    expect(updateShadowView(fixture.pool, dynamicOnly, dynamicOnly.sourcePlan).unwrap().cache).toBe(
      'hit',
    );
    selected.adopt(change(alpha, 'alphaCutoff', 0.7));
    const staticEdit = capture();
    expect(updateShadowView(fixture.pool, staticEdit, staticEdit.sourcePlan).unwrap().cache).toBe(
      'invalidated',
    );
    expect(fixture.pool.dirtyRects(fixture.identity)).toBeUndefined();
    expect(before.directMaterials.get(selected)?.snapshot).toBe(alpha);
    fixture.pool._commitResourceReplacement();
    expect(updateShadowView(fixture.pool, staticEdit, staticEdit.sourcePlan).unwrap().cache).toBe(
      'hit',
    );
  } finally {
    fixture.dispose();
  }
});

it.each([
  false,
  true,
])('requires each independent Renderer World to capture its selected shared row material (numeric: %s)', async (numeric) => {
  const fixtures = [await staticShadowFixture(), await staticShadowFixture()];
  const worlds = [new World(), new World()];
  const shared = new MaterialResource(numeric ? opaque : alpha);
  const unrelated = new MaterialResource(alpha);
  const before = new MaterialFrame(undefined).with(shared).with(unrelated);
  for (const fixture of fixtures) {
    for (const entityKey of [1, 2]) {
      fixture.update({
        ...shadowSourceSnapshot(entityKey, entityKey === 1 ? -10 : 10),
        material: shared,
        materials: [shared],
        mobility: 'static',
      });
    }
  }
  const capture = (materials: MaterialFrame, world: World, complete: boolean) => {
    const content = new ShadowMaterialContent(materials);
    if (complete) content.add(shared, shared.snapshot, worldRenderResources(world), undefined, 0);
    return content;
  };
  try {
    unrelated.adopt(change(alpha, 'alphaCutoff', 0.9));
    const after = before.with(unrelated);
    const selected: ShadowMaterialContent[] = [];
    for (const [index, fixture] of fixtures.entries()) {
      const world = worlds[index];
      assert(world);
      const plan = fixture.input().sourcePlan;
      expect(plan.batches.length).toBeGreaterThan(0);
      expect(plan.batches.every((batch) => batch.key.rowMaterial === true)).toBe(true);
      const partial = capture(before, world, false);
      expect(partial.select(plan, fixture.projection)).toBe(partial);
      const complete = capture(before, world, true);
      const admitted = complete.select(plan, fixture.projection);
      expect(admitted).not.toBe(complete);
      selected.push(admitted);
      expect(capture(after, world, false).select(plan, fixture.projection).same(partial)).toBe(
        false,
      );
      expect(capture(after, world, true).select(plan, fixture.projection).same(admitted)).toBe(
        true,
      );
    }
    expect(selected[0]?.same(selected[1])).toBe(false);
  } finally {
    for (const fixture of fixtures) fixture.dispose();
  }
});

it('does not let an unknown World capture certify a selected World sharing the resource', async () => {
  const fixture = await staticShadowFixture();
  const worlds = [new World(), new World()];
  const shared = new MaterialResource(alpha);
  const materials = new MaterialFrame(undefined).with(shared);
  for (const entityKey of [1, 2]) {
    fixture.update({
      ...shadowSourceSnapshot(entityKey, entityKey === 1 ? -10 : 10),
      material: shared,
      materials: [shared],
      mobility: 'static',
    });
  }
  const source = fixture.input().sourcePlan;
  const plan = source;
  expect(plan.batches.length).toBeGreaterThan(0);
  const other = worlds[0];
  assert(other);
  const scope = worldRenderResources(other);
  const content = new ShadowMaterialContent(materials);
  content.add(shared, shared.snapshot, scope);
  try {
    expect(content.select(plan, fixture.projection)).toBe(content);
    const unknown = new ShadowMaterialContent(materials);
    unknown.add(shared, shared.snapshot, scope, undefined, 1);
    expect(unknown.select(plan, fixture.projection)).toBe(unknown);
  } finally {
    fixture.dispose();
  }
});

it('captures each fixed snapshot once per shadow preparation while preserving scope membership', () => {
  const world = new World();
  const resource = new MaterialResource(opaque);
  const frame = new MaterialFrame(undefined).with(resource);
  const content = new ShadowMaterialContent(frame);
  const get = vi.spyOn(frame, 'get');
  try {
    for (let i = 0; i < 100; i++) content.add(resource, opaque, worldRenderResources(world));
    const second = new World();
    for (let i = 0; i < 100; i++) content.add(resource, opaque, worldRenderResources(second));
    expect(get).toHaveBeenCalledTimes(1);
    const next = new ShadowMaterialContent(frame);
    next.add(resource, opaque, worldRenderResources(world));
    expect(next.same(content)).toBe(false);
    next.add(resource, opaque, worldRenderResources(second));
    expect(next.same(content)).toBe(true);
    const selected = new ShadowMaterialContent(frame);
    selected.add(resource, opaque, worldRenderResources(world));
    selected.add(resource, alpha, worldRenderResources(second));
    expect(selected.same(content)).toBe(false);
  } finally {
    get.mockRestore();
  }
});
