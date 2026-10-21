import { vec3 } from '@forgeax/engine-math';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
} from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import {
  collectGpuDrivenMaterialArtifacts,
  GpuDrivenMaterialExecutionRetention,
  GpuDrivenMaterialProgramProjection,
} from '../gpu-driven/material-artifacts';
import { prepareGpuDrivenDraw } from '../gpu-driven/prepared-draw';
import { MaterialResource } from '../material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { MaterialDispatch, MaterialFrame } from '../scene/material-dispatch';
import { SceneSlots } from '../scene/scene-slots';

function fixture(count = 1) {
  const receipt = createStandardPbrArtifactReceipt();
  const artifact = {
    material: 'game::surface',
    pass: 'forward',
    program: createMaterialShaderProgram('fixture'),
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: [],
    vertexInputs: receipt.vertexInputs.map((input) => ({ ...input })),
    receipt,
  };
  const snapshot: MaterialSnapshot = {
    materialHandle: 1,
    materialShaderId: 'game::surface',
    baseColor: vec3.create(1, 1, 1),
    roughness: 0.5,
    metallic: 0,
    passes: [
      {
        name: 'forward',
        program: { module: 'game::surface', fragmentEntry: 'forward_fragment' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
      {
        name: 'shadow',
        program: { module: 'game::shadow', fragmentEntry: 'shadow_fragment' },
        renderState: { tags: { LightMode: 'ShadowCaster' } },
      },
    ],
    materialProgramKeys: { forward: 'game::surface', shadow: 'game::shadow' },
    materialSceneIndexProgramKeys: {
      forward: { pass: 'forward', specializationKey: 'game::surface-scene' },
      shadow: { pass: 'shadow', specializationKey: 'game::shadow-scene' },
    },
  };
  const material = new MaterialResource(snapshot);
  const draw = {
    kind: 'indexed' as const,
    first: 0,
    count: 36,
    baseVertex: 0,
    topology: 'triangle-list' as const,
  };
  const prepared = prepareGpuDrivenDraw({
    material: snapshot,
    deformation: 'rigid',
    artifact,
    geometry: {
      identity: 'box',
      vertexInputs: receipt.vertexInputs.map((input) => ({ ...input })),
      topology: draw.topology,
      indexed: true,
    },
    generation: receipt.generation,
    draw,
  });
  if (!prepared.ok) throw prepared.error;
  const rows = Array.from({ length: count }, (_, index) => {
    const source: RenderableSnapshot = {
      entityKey: index,
      worldId: 0,
      assetHandle: 1,
      transform: { world: new Float32Array(16) },
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      material,
      materials: [material],
      materialBindingSources: ['renderer-override'],
      gpuDrivenDraws: [
        {
          ...draw,
          materialSlot: 0,
          pipelineClass: 'fixture',
          materialResourceClass: 'shared',
          prepared: prepared.value,
          geometry: {
            receipt: {
              identity: 'box',
              vertexInputs: receipt.vertexInputs.map((input) => ({ ...input })),
              topology: draw.topology,
              indexed: true,
            },
            draw,
            deformation: 'rigid',
          },
        },
      ],
    };
    return { source, renderableIndex: index };
  });
  const owner = new MaterialDispatch();
  rows.forEach((row, index) => {
    owner.bind(index, row.source);
  });
  const slotOwner = new SceneSlots();
  rows.forEach((row, index) => {
    slotOwner.set(index, {
      slot: index,
      generation: 1,
      worldId: 0,
      entityKey: index,
      snapshot: row.source,
    });
  });
  const dispatch = owner.query(slotOwner.capture());
  const guarded = new Proxy(dispatch, {
    get(target, key, receiver) {
      if (key === Symbol.iterator) throw new Error('Program selection expanded entity dispatch');
      return Reflect.get(target, key, receiver);
    },
  });
  const projection = new GpuDrivenMaterialProgramProjection();
  const programs = projection.project(guarded, owner.materials());
  const resolve = vi.fn((id: string) => ({ ...artifact, material: id }));
  const topology = new BatchTopology();
  topology.rebuild(
    rows.map((row, index) => ({
      slot: index,
      generation: 1,
      worldId: 0,
      entityKey: index,
      snapshot: row.source,
    })),
  );
  const input = {
    batches: topology.query(topology.sourcePlan(), undefined).batches,
    probeBlend: false,
    programs,
    resolve,
    clustered: false,
    reflectionFallback: false,
    shadowViews: true,
  };
  return {
    input,
    owner,
    material,
    snapshot,
    programs,
    projection,
    guarded,
    artifact,
    topology,
    rows,
  };
}

it('selects shared Forward and Shadow programs without expanding dispatch', () => {
  const f = fixture(512);
  const result = collectGpuDrivenMaterialArtifacts(f.input);
  expect(f.input.resolve.mock.calls.map(([id]) => id)).toEqual([
    'game::surface-scene',
    'game::shadow-scene',
  ]);
  expect([...result.materialArtifacts.values()][0]?.fragmentEntry).toBe('forward_fragment');
  expect([...result.shadowMaterialArtifacts.values()][0]?.fragmentEntry).toBe('shadow_fragment');
});

it('prepares an authored medium color Pass for its renderer-owned nearest and color work', () => {
  const f = fixture(512);
  f.material.adopt({
    ...f.snapshot,
    surfaceModel: 'single-layer-medium',
    passes: [{ name: 'color', program: { module: 'game::surface' } }],
    materialProgramKeys: { color: 'game::surface' },
    materialSceneIndexProgramKeys: {
      color: { pass: 'forward', specializationKey: 'game::surface-scene' },
    },
  });
  f.owner.adopt(f.material);
  const result = collectGpuDrivenMaterialArtifacts({
    ...f.input,
    programs: f.projection.project(f.guarded, f.owner.materials()),
  });
  expect(result.batchExecutions.values().next().value?.forward.route).toBe('gpu');
  expect(result.materialArtifacts.size).toBe(1);
  expect(result.shadowMaterialArtifacts.size).toBe(0);
  expect(f.input.resolve.mock.calls.map(([id]) => id)).toEqual(['game::surface-scene']);
});

it('keeps multiple ShadowCaster passes in the direct lane without consulting entity claims', () => {
  const f = fixture(10_000);
  const shadow = f.snapshot.passes?.[1];
  if (shadow === undefined) throw new Error('Missing fixture shadow pass');
  f.material.adopt({
    ...f.snapshot,
    passes: [...(f.snapshot.passes ?? []), { ...shadow, name: 'second-shadow' }],
    materialProgramKeys: { ...f.snapshot.materialProgramKeys, 'second-shadow': 'game::shadow' },
  });
  f.owner.adopt(f.material);
  const result = collectGpuDrivenMaterialArtifacts({
    ...f.input,
    programs: f.projection.project(f.guarded, f.owner.materials()),
  });
  expect(result.batchExecutions.values().next().value?.forward.route).toBe('gpu');
  expect(result.batchExecutions.values().next().value?.shadow.route).toBe('direct');
  expect(result.shadowMaterialArtifacts.size).toBe(0);
});

it('keeps every authored Forward Pass when one shared material gains a second Pass', () => {
  const f = fixture(10_000);
  const forward = f.snapshot.passes?.[0];
  if (forward === undefined) throw new Error('Missing fixture Forward pass');
  f.material.adopt({
    ...f.snapshot,
    passes: [...(f.snapshot.passes ?? []), { ...forward, name: 'second-forward' }],
    materialProgramKeys: { ...f.snapshot.materialProgramKeys, 'second-forward': 'game::surface' },
  });
  f.owner.adopt(f.material);
  const result = collectGpuDrivenMaterialArtifacts({
    ...f.input,
    programs: f.projection.project(f.guarded, f.owner.materials()),
  });
  expect(result.batchExecutions.values().next().value?.forward.route).toBe('direct');
  expect(result.batchExecutions.values().next().value?.shadow.route).toBe('gpu');
  expect(result.materialArtifacts.size).toBe(0);
  expect(
    collectGpuDrivenMaterialArtifacts(f.input).batchExecutions.values().next().value?.forward.route,
  ).toBe('gpu');
});

it('keeps old frame programs fixed after material adoption', () => {
  const f = fixture();
  f.material.adopt({
    ...f.snapshot,
    materialSceneIndexProgramKeys: {
      ...f.snapshot.materialSceneIndexProgramKeys,
      shadow: { pass: 'shadow', specializationKey: 'game::replacement-shadow' },
    },
  });
  f.owner.adopt(f.material);
  collectGpuDrivenMaterialArtifacts(f.input);
  expect(f.input.resolve.mock.calls.map(([id]) => id)).toEqual([
    'game::surface-scene',
    'game::shadow-scene',
  ]);
  f.input.resolve.mockClear();
  collectGpuDrivenMaterialArtifacts({
    ...f.input,
    programs: f.projection.project(f.guarded, f.owner.materials()),
  });
  expect(f.input.resolve.mock.calls.map(([id]) => id)).toEqual([
    'game::surface-scene',
    'game::replacement-shadow',
  ]);
});

it.each([
  'point-list',
  'line-list',
  'line-strip',
] as const)('does not route %s to direct shadows for multiple Passes or absent scene programs', (topology) => {
  const f = fixture();
  const shadow = f.snapshot.passes?.[1];
  if (shadow === undefined) throw new Error('Missing fixture shadow pass');
  const batches = f.input.batches.map((batch) => {
    if (batch.binding === undefined) throw new Error('Missing fixture binding');
    const geometry = batch.binding.geometry;
    return {
      ...batch,
      binding: {
        ...batch.binding,
        geometry: {
          ...geometry,
          receipt: { ...geometry.receipt, topology },
          draw: { ...geometry.draw, topology },
        },
      },
    };
  });
  for (const multiple of [false, true]) {
    f.material.adopt({
      ...f.snapshot,
      passes: multiple
        ? [...(f.snapshot.passes ?? []), { ...shadow, name: 'second' }]
        : f.snapshot.passes,
      materialProgramKeys: { ...f.snapshot.materialProgramKeys, second: 'game::shadow' },
      materialSceneIndexProgramKeys: {
        forward: { pass: 'forward', specializationKey: 'game::surface-scene' },
      },
    });
    f.owner.adopt(f.material);
    const result = collectGpuDrivenMaterialArtifacts({
      ...f.input,
      batches,
      programs: f.projection.project(f.guarded, f.owner.materials()),
    });
    expect(result.batchExecutions.values().next().value?.shadow.route).toBe('none');
    expect(result.shadowMaterialArtifacts.size).toBe(0);
  }
});

it('resolves availability on each collection and only requests demanded shadow programs', () => {
  const f = fixture();
  const missing = () => undefined;
  expect(() => collectGpuDrivenMaterialArtifacts({ ...f.input, resolve: missing })).toThrow(
    'missing-material-receipt',
  );
  expect(
    collectGpuDrivenMaterialArtifacts({ ...f.input, shadowViews: false }).materialArtifacts.size,
  ).toBe(1);
  expect(f.input.resolve.mock.calls.map(([id]) => id)).toEqual(['game::surface-scene']);
  f.input.resolve.mockClear();
  expect(collectGpuDrivenMaterialArtifacts(f.input).shadowMaterialArtifacts.size).toBe(1);
  expect(f.input.resolve).toHaveBeenCalledTimes(2);
});

it('rejects missing fixed material state instead of rebuilding a per-entity program index', () => {
  const f = fixture();
  expect(() => collectGpuDrivenMaterialArtifacts({ ...f.input, programs: undefined })).toThrow(
    'missing-material-receipt',
  );
});

it('keeps selection independent of entity count and never reads candidates', () => {
  const f = fixture(50_000);
  expect(f.input.batches).toHaveLength(1);
  const batches = f.input.batches.map((batch) => ({
    ...batch,
    candidates: new Proxy(batch.candidates, {
      get() {
        throw new Error('Program selection inspected candidates');
      },
    }),
  }));
  const result = collectGpuDrivenMaterialArtifacts({ ...f.input, batches });
  expect(result.materialArtifacts.size).toBe(1);
  expect(result.shadowMaterialArtifacts.size).toBe(1);
  expect(f.input.resolve).toHaveBeenCalledTimes(2);
  f.material.adopt({ ...f.snapshot, roughness: 0.8 });
  f.owner.adopt(f.material);
  const changed = collectGpuDrivenMaterialArtifacts({
    ...f.input,
    batches,
    programs: f.projection.project(f.guarded, f.owner.materials()),
  });
  expect(changed.batchExecutions.values().next().value?.forward).toMatchObject({
    route: 'gpu',
    material: { roughness: 0.8 },
  });
  expect(result.batchExecutions.values().next().value?.forward).toMatchObject({
    route: 'gpu',
    material: { roughness: 0.5 },
  });
});

it('preserves the declared CPU recovery for incompatible shared geometry', () => {
  const f = fixture();
  const batch = f.input.batches.at(0);
  if (batch?.binding === undefined) throw new Error('Missing batch binding');
  const geometry = batch.binding.geometry;
  const invalid = {
    ...batch,
    binding: {
      ...batch.binding,
      geometry: {
        ...geometry,
        receipt: { ...geometry.receipt, vertexInputs: [] },
      },
    },
  };
  const result = collectGpuDrivenMaterialArtifacts({ ...f.input, batches: [invalid] });
  expect(result.batchExecutions.values().next().value?.forward).toMatchObject({
    route: 'direct',
    reason: { code: 'vertex-input-mismatch' },
  });
  expect(result.materialArtifacts.size).toBe(0);
});

it('distinguishes skin and color ABI variants under one material identity', () => {
  const f = fixture();
  const rigid = createStandardPbrArtifactReceipt(false, false);
  const skinned = createStandardPbrArtifactReceipt(true, true);
  const batch = f.input.batches.at(0);
  if (batch?.binding === undefined) throw new Error('Missing batch binding');
  const binding = batch.binding;
  const geometry = binding.geometry;
  const batches = [rigid, skinned].map((receipt, index) => ({
    ...batch,
    batchId: index,
    binding: {
      ...binding,
      geometry: {
        ...geometry,
        deformation: index === 0 ? ('rigid' as const) : ('skin' as const),
        receipt: { ...geometry.receipt, vertexInputs: receipt.vertexInputs },
      },
    },
  }));
  const resolve = vi.fn(
    (
      id: string,
      request?:
        | boolean
        | { readonly deformation?: 'rigid' | 'skin'; readonly vertexColorAvailable?: boolean },
    ) => {
      if (typeof request !== 'object')
        throw new Error('Expected concrete material preparation request');
      const receipt = request.deformation === 'skin' ? skinned : rigid;
      return {
        ...f.artifact,
        material: id,
        receipt,
        layoutIdentity: receipt.reflection.layoutIdentity,
      };
    },
  );
  const result = collectGpuDrivenMaterialArtifacts({ ...f.input, batches, resolve });
  expect(result.materialArtifacts.size).toBe(2);
  expect(result.shadowMaterialArtifacts.size).toBe(2);
  expect(
    resolve.mock.calls.map(([, request]) => {
      if (typeof request !== 'object')
        throw new Error('Expected concrete material preparation request');
      return [request.deformation, request.vertexColorAvailable];
    }),
  ).toEqual([
    ['rigid', false],
    ['rigid', false],
    ['skin', true],
    ['skin', true],
  ]);
});

it('keeps geometry membership while Forward switches between transparent and opaque', () => {
  const f = fixture(128);
  const before = f.topology.query(f.topology.sourcePlan(), undefined);
  const transparent = {
    ...f.snapshot,
    passes: f.snapshot.passes?.map((pass) =>
      pass.name !== 'forward'
        ? pass
        : {
            ...pass,
            renderState: {
              ...pass.renderState,
              blend: {
                color: {
                  srcFactor: 'one' as const,
                  dstFactor: 'one-minus-src-alpha' as const,
                  operation: 'add' as const,
                },
                alpha: {
                  srcFactor: 'one' as const,
                  dstFactor: 'one-minus-src-alpha' as const,
                  operation: 'add' as const,
                },
              },
            },
          },
    ),
  };
  f.material.adopt(transparent);
  f.owner.adopt(f.material);
  const result = collectGpuDrivenMaterialArtifacts({
    ...f.input,
    programs: f.projection.project(f.guarded, f.owner.materials()),
  });
  expect(result.batchExecutions.values().next().value?.forward.route).toBe('direct');
  expect(result.batchExecutions.values().next().value?.shadow.route).toBe('gpu');
  expect(f.topology.query(f.topology.sourcePlan(), undefined)).toBe(before);
  const fresh = new BatchTopology();
  fresh.rebuild(
    f.rows.map((row, index) => ({
      slot: index,
      generation: 1,
      worldId: 0,
      entityKey: index,
      snapshot: row.source,
    })),
  );
  expect(fresh.query(fresh.sourcePlan(), undefined).candidateCount).toBe(128);
  f.material.adopt(f.snapshot);
  f.owner.adopt(f.material);
  const opaque = collectGpuDrivenMaterialArtifacts({
    ...f.input,
    programs: f.projection.project(f.guarded, f.owner.materials()),
  });
  expect(opaque.batchExecutions.values().next().value?.forward.route).toBe('gpu');
  expect(f.topology.query(f.topology.sourcePlan(), undefined)).toBe(before);
});

it('observes replacement program bytes without changing the fixed material root', () => {
  const f = fixture();
  const first = collectGpuDrivenMaterialArtifacts(f.input);
  const nextProgram = createMaterialShaderProgram('replacement bytes');
  const next = collectGpuDrivenMaterialArtifacts({
    ...f.input,
    resolve: (id) => ({ ...f.artifact, material: id, program: nextProgram }),
  });
  expect([...first.materialArtifacts.values()][0]?.program).toBe(f.artifact.program);
  expect([...next.materialArtifacts.values()][0]?.program).toBe(nextProgram);
});

it('deduplicates only identical shader, Pass, deformation and color requests', () => {
  const f = fixture();
  const batch = f.input.batches.at(0);
  if (batch?.binding === undefined) throw new Error('Missing batch binding');
  const binding = batch.binding;
  const shaders = ['game::shared/rigid/false', 'game::shared/skin/true'];
  const materials = shaders.map(
    (shader, index) =>
      new MaterialResource({
        ...f.snapshot,
        materialHandle: index + 1,
        materialSceneIndexProgramKeys: {
          forward: { pass: 'forward', specializationKey: shader },
          shadow: { pass: 'shadow', specializationKey: shader },
        },
      }),
  );
  let frame = new MaterialFrame(undefined);
  for (const material of materials) frame = frame.with(material);
  const batches = materials.flatMap((material) =>
    [false, true].flatMap((skin) =>
      [false, true].flatMap((color) => {
        const receipt = createStandardPbrArtifactReceipt(skin, color);
        const selected = {
          ...batch,
          binding: {
            ...binding,
            material,
            geometry: {
              ...binding.geometry,
              deformation: skin ? ('skin' as const) : ('rigid' as const),
              receipt: { ...binding.geometry.receipt, vertexInputs: receipt.vertexInputs },
            },
          },
        };
        return [selected, { ...selected }];
      }),
    ),
  );
  const resolve = vi.fn<
    NonNullable<Parameters<typeof collectGpuDrivenMaterialArtifacts>[0]['resolve']>
  >((id, request) => {
    if (typeof request !== 'object') throw new Error('Expected concrete artifact request');
    const receipt = createStandardPbrArtifactReceipt(
      request.deformation === 'skin',
      request.vertexColorAvailable,
    );
    return {
      ...f.artifact,
      material: id,
      receipt,
      layoutIdentity: receipt.reflection.layoutIdentity,
    };
  });
  const result = collectGpuDrivenMaterialArtifacts({
    ...f.input,
    batches,
    programs: f.projection.project(f.guarded, frame),
    resolve,
    clustered: true,
    probeBlend: true,
    reflectionFallback: true,
  });
  expect(resolve).toHaveBeenCalledTimes(16);
  const requests = resolve.mock.calls.map(([id, request]) => {
    if (typeof request !== 'object') throw new Error('Expected concrete artifact request');
    expect(request.address).toBe('scene-index');
    for (const field of ['clustered', 'probeBlend', 'reflectionFallback'] as const) {
      expect(request[field]).toBe(request.pass === 'forward' ? true : undefined);
      expect(Object.hasOwn(request, field)).toBe(request.pass === 'forward');
    }
    return `${id}:${request.pass}:${request.deformation}:${request.vertexColorAvailable}`;
  });
  expect(new Set(requests).size).toBe(16);
  for (const [selected, execution] of result.batchExecutions) {
    const shader = shaders[materials.indexOf(selected.material)];
    for (const kind of ['forward', 'shadow'] as const) {
      const pass = execution[kind];
      expect(pass.route).toBe('gpu');
      if (pass.route === 'gpu') expect(pass.artifact.specializationKey).toBe(shader);
    }
  }
});

it('deduplicates unavailable artifacts locally and retries with current collection flags', () => {
  const f = fixture();
  const { materialSceneIndexProgramKeys: _programs, ...snapshot } = f.snapshot;
  f.material.adopt(snapshot);
  f.owner.adopt(f.material);
  const programs = f.projection.project(f.guarded, f.owner.materials());
  const resolve = vi.fn<
    NonNullable<Parameters<typeof collectGpuDrivenMaterialArtifacts>[0]['resolve']>
  >(() => undefined);
  const batch = f.input.batches.at(0);
  if (batch === undefined) throw new Error('Missing batch');
  const batches = Array.from({ length: 8 }, () => batch);
  for (const enabled of [false, true]) {
    const firstCall = resolve.mock.calls.length;
    const result = collectGpuDrivenMaterialArtifacts({
      ...f.input,
      batches,
      programs,
      resolve,
      clustered: enabled,
      probeBlend: enabled,
      reflectionFallback: enabled,
    });
    expect(resolve.mock.calls.length - firstCall).toBe(2);
    expect(result.batchExecutions.values().next().value?.forward.route).toBe('direct');
    const request = resolve.mock.calls[firstCall]?.[1];
    if (typeof request !== 'object') throw new Error('Expected concrete artifact request');
    expect(request).toMatchObject({
      pass: 'forward',
      clustered: enabled,
      probeBlend: enabled,
      reflectionFallback: enabled,
    });
  }
});

it('keeps a direct ShadowCaster on its declared route when no scene program pair is published', () => {
  const f = fixture();
  f.material.adopt({
    ...f.snapshot,
    materialSceneIndexProgramKeys: {
      forward: { pass: 'forward', specializationKey: 'game::surface-scene' },
    },
  });
  f.owner.adopt(f.material);
  const result = collectGpuDrivenMaterialArtifacts({
    ...f.input,
    programs: f.projection.project(f.guarded, f.owner.materials()),
  });
  expect(result.batchExecutions.values().next().value?.shadow.route).toBe('direct');
  expect(result.shadowMaterialArtifacts.size).toBe(0);
  expect(f.input.resolve.mock.calls.map(([id]) => id)).toEqual(['game::surface-scene']);
});

it('retains executions across frames while programs, geometry and artifacts are unchanged', () => {
  const f = fixture(4);
  const artifacts = new Map<string, typeof f.artifact>();
  let generation = 0;
  const resolve = vi.fn((id: string) => {
    const key = `${generation}/${id}`;
    let artifact = artifacts.get(key);
    if (artifact === undefined) {
      artifact = { ...f.artifact, material: id };
      artifacts.set(key, artifact);
    }
    return artifact;
  });
  const retention = new GpuDrivenMaterialExecutionRetention();
  const collect = () => collectGpuDrivenMaterialArtifacts({ ...f.input, resolve, retention });
  const first = collect();
  const binding = first.batchExecutions.keys().next().value;
  if (binding === undefined) throw new Error('Expected one shared binding');
  const prepared = retention.prepared;
  expect(prepared).toBeGreaterThan(0);
  const pose = collect();
  expect(retention.prepared).toBe(prepared);
  expect(pose.batchExecutions.get(binding)).toEqual(first.batchExecutions.get(binding));
  expect(pose.batchExecutions.get(binding)?.forward).toBe(
    first.batchExecutions.get(binding)?.forward,
  );
  expect(pose.batchExecutions.get(binding)?.shadow).toBe(
    first.batchExecutions.get(binding)?.shadow,
  );
  expect([...pose.materialArtifacts.values()]).toEqual([...first.materialArtifacts.values()]);

  // Scene projections re-wrap accepted materials each frame; equal facts still reuse.
  const programs = f.input.programs;
  const rewrapped = collectGpuDrivenMaterialArtifacts({
    ...f.input,
    resolve,
    retention,
    programs: {
      dispatch: programs.dispatch,
      materials: programs.materials,
      get overlays() {
        return programs.overlays;
      },
      get(material) {
        const selected = programs.get(material);
        return (
          selected && { ...selected, forward: [...selected.forward], shadow: [...selected.shadow] }
        );
      },
    },
  });
  expect(retention.prepared).toBe(prepared);
  expect(rewrapped.batchExecutions.get(binding)?.forward).toBe(
    first.batchExecutions.get(binding)?.forward,
  );

  // A recompiled artifact is a new resolver result; the dependent join is rebuilt.
  generation = 1;
  const recompiled = collect();
  expect(retention.prepared).toBe(prepared * 2);
  const forward = recompiled.batchExecutions.get(binding)?.forward;
  expect(forward).not.toBe(first.batchExecutions.get(binding)?.forward);
  expect(forward?.route === 'gpu' && forward.artifact.specializationKey).toBe(
    'game::surface-scene',
  );

  // A new accepted material version selects new programs and is never served stale.
  f.material.adopt({ ...f.snapshot, roughness: 0.25 });
  f.owner.adopt(f.material);
  const adopted = collectGpuDrivenMaterialArtifacts({
    ...f.input,
    resolve,
    retention,
    programs: f.projection.project(f.guarded, f.owner.materials()),
  });
  const execution = adopted.batchExecutions.values().next().value?.forward;
  expect(retention.prepared).toBe(prepared * 3);
  expect(execution?.route !== 'none' && execution?.material.roughness).toBe(0.25);
});

it('keeps the collected frame identity when every retained execution is unchanged', () => {
  const f = fixture(4);
  const artifacts = new Map<string, typeof f.artifact>();
  const resolve = vi.fn((id: string) => {
    let artifact = artifacts.get(id);
    if (artifact === undefined) {
      artifact = { ...f.artifact, material: id };
      artifacts.set(id, artifact);
    }
    return artifact;
  });
  const retention = new GpuDrivenMaterialExecutionRetention();
  f.input = { ...f.input, resolve };
  const first = collectGpuDrivenMaterialArtifacts({ ...f.input, retention });
  expect(collectGpuDrivenMaterialArtifacts({ ...f.input, retention })).toBe(first);
  const noShadow = collectGpuDrivenMaterialArtifacts({ ...f.input, retention, shadowViews: false });
  expect(noShadow).not.toBe(first);
  expect(noShadow.shadowMaterialArtifacts.size).toBe(0);
});
