import { expect, it, vi } from 'vitest';
import {
  captureMaterialSnapshot,
  MaterialResource,
  ownedMaterialValues,
} from '../material-resource';
import { rebindPublicationMaterialSchemas } from '../publication/programs';
import type { RenderResourceScope } from '../publication/resource-scope';
import {
  type DispatchEntry,
  defaultMaterialSnapshot,
  type MaterialSnapshot,
  type RenderableSnapshot,
} from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import type { DispatchList } from '../scene/material-dispatch';
import type { StandardSceneSurfaceAdmission } from '../temporal/scene-data';
import {
  createStandardSceneSurfaceAdmission,
  ProducedStandardSceneDataAdmissionInput,
  standardSceneDataContributorForDispatch,
  standardSceneSurfaceContributorBaseline,
} from '../temporal/standard-scene-data-admission';

function source() {
  return {
    ...defaultMaterialSnapshot(31),
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax_material::standard' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
    materialProgramKeys: { forward: 'cooked:forward' },
    materialPublication: undefined,
    materialProgramInputs: {
      forward: { entryPoints: [{ name: 'fs_ao_input', stage: 'fragment' as const, bindings: [] }] },
    },
    materialContext: { geometry: 'mesh' as 'mesh' | 'skinned', vertexColor: false },
  };
}

function requiredFirst<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('fixture requires a first value');
  return value;
}

function contributor(material: MaterialResource, entity = 1, deformation?: 'skin' | 'morph') {
  const row = {
    material,
    materials: [material],
    entityKey: entity,
    ...(deformation === 'skin' ? { skinBinding: { skeleton: 1, joints: [1] } } : {}),
    ...(deformation === 'morph'
      ? { morph: { weights: new Float32Array([1]), targetCount: 1 } }
      : {}),
  } as unknown as RenderableSnapshot;
  const value = standardSceneDataContributorForDispatch(
    row,
    {
      materialHandle: 31,
      materialShaderId: 'cooked:forward',
      tags: { LightMode: 'Forward' },
      passIndex: 0,
    },
    'forward',
  );
  if (value === undefined) throw new Error('fixture requires a surface contributor');
  return value;
}

function input(contributors: ReturnType<typeof contributor>[]) {
  const produced = new ProducedStandardSceneDataAdmissionInput();
  produced.capture({
    viewIdentity: 'view/main',
    generation: 2,
    deviceGeneration: 4,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered' as const,
    renderPath: 'forward' as const,
  });
  produced.contributors.push(...contributors);
  return produced;
}

function projectionInput(
  materials: readonly MaterialResource[],
  entities = materials.map((_material, index) => index + 1),
  scopes: readonly object[] = [{}],
  lane: 'forward' | 'deferred' = 'forward',
) {
  const renderables = materials.map(
    (material, index) =>
      ({
        worldId: 0,
        entityKey: entities[index] ?? index + 1,
        material,
        materials: [material],
        transform: { world: new Float32Array(16) },
      }) as unknown as RenderableSnapshot,
  );
  const dispatch = materials.map((material, index) => ({
    entityIndex: index + 1,
    materialHandle: material.snapshot.materialHandle ?? 0,
    renderableIndex: index,
    passIndex: 0,
    queue: 2000,
    layer: 0,
    tags: { LightMode: 'Forward' },
    renderState: undefined,
    defines: undefined,
    vertexEntry: undefined,
    fragmentEntry: 'fs_main',
    materialShaderId: 'cooked:forward',
  })) as DispatchEntry[];
  return {
    viewIdentity: 'view/main',
    generation: 2,
    deviceGeneration: 4,
    standardPipeline: true,
    cameraAvailable: true,
    lane: 'clustered' as const,
    renderPath: lane,
    contributorProjection: {
      renderables: renderables as FrameList<RenderableSnapshot>,
      dispatch: dispatch as DispatchList,
      scopes: scopes as readonly RenderResourceScope[],
      lane,
    },
  };
}

function projectionAdmissionInput(
  candidate: ReturnType<typeof projectionInput>,
  previous?: StandardSceneSurfaceAdmission,
) {
  const { contributorProjection, ...metadata } = candidate;
  const produced = new ProducedStandardSceneDataAdmissionInput();
  produced.capture(metadata);
  const prior = standardSceneSurfaceContributorBaseline(previous);
  contributorProjection.dispatch.forEach((dispatch: DispatchEntry, index) => {
    const row = contributorProjection.renderables.at(dispatch.renderableIndex);
    const value = standardSceneDataContributorForDispatch(
      row,
      dispatch,
      contributorProjection.lane,
      prior?.[index],
    );
    if (value !== undefined) produced.contributors.push(value);
  });
  return produced;
}

function directProjectionAdmission(candidate: ReturnType<typeof projectionInput>) {
  return createStandardSceneSurfaceAdmission(projectionAdmissionInput(candidate));
}

/** Retain the prior result the view producer supplies to the pure admission owner. */
class SceneDataAdmissionFixture {
  private previous: StandardSceneSurfaceAdmission | undefined;

  update(candidate: Parameters<typeof createStandardSceneSurfaceAdmission>[0]) {
    this.previous = createStandardSceneSurfaceAdmission(candidate, this.previous);
    return this.previous;
  }

  updateProjection(candidate: ReturnType<typeof projectionInput>) {
    return this.update(projectionAdmissionInput(candidate, this.previous));
  }
}

function programIdentity(material: MaterialResource) {
  return material.programObservation(requiredFirst(material.snapshot.passes)).identity;
}

it('captures program subtrees and shares exact program facts across draw members and holders', () => {
  const authored = source();
  const captured = captureMaterialSnapshot(authored);
  const material = new MaterialResource(captured);
  const held = new MaterialResource(captured);
  const first = contributor(material);
  const firstProgramIdentity = programIdentity(material);
  requiredFirst(authored.passes).program.module = 'custom';
  authored.materialProgramKeys.forward = 'changed';
  requiredFirst(authored.materialProgramInputs.forward.entryPoints).name = 'changed';
  authored.materialContext.geometry = 'skinned';
  const second = contributor(material, 2);
  expect(second.facts?.selectedProgramFacts).toBe(first.facts?.selectedProgramFacts);
  expect(second.facts?.programCandidates).toBe(first.facts?.programCandidates);
  expect(programIdentity(held)).toBe(firstProgramIdentity);
  expect(second.entryPoint).toBe('fs_ao_input');
  expect(second.geometry).toBe('mesh');
  expect(Object.isFrozen(captured.passes[0]?.program)).toBe(true);
  expect(authored.passes[0]?.program.module).toBe('custom');
});

it('keeps borrowed and proxy program reads live even with immutable value claims and frozen roots', () => {
  const authored = source();
  const borrowed = Object.freeze({ ...authored, immutableValues: true as const });
  const material = new MaterialResource(borrowed);
  const owner = new SceneDataAdmissionFixture();
  const first = owner.update(input([contributor(material)]));
  requiredFirst(authored.materialProgramInputs.forward.entryPoints).name = 'fs_changed';
  const second = owner.update(input([contributor(material)]));
  expect(first.status).toBe('available');
  expect(second.status).toBe('unavailable');
  expect(second).not.toBe(first);
  const reads = vi.fn(() => authored.passes);
  const proxy = new Proxy(
    { ...authored },
    {
      get: (target, key, receiver) =>
        key === 'passes' ? reads() : Reflect.get(target, key, receiver),
    },
  );
  const proxyMaterial = new MaterialResource(proxy);
  contributor(proxyMaterial);
  const count = reads.mock.calls.length;
  contributor(proxyMaterial);
  expect(reads.mock.calls.length).toBeGreaterThan(count);
  expect(programIdentity(proxyMaterial)).toBeUndefined();
});

it('retains complete admission only for unchanged captured contributors and view facts', () => {
  const material = new MaterialResource(captureMaterialSnapshot(source()));
  const owner = new SceneDataAdmissionFixture();
  const first = owner.update(input([contributor(material)]));
  expect(owner.update(input([contributor(material)]))).toBe(first);
  const changedEntity = owner.update(input([contributor(material, 2)]));
  expect(changedEntity.identity).not.toBe(first.identity);
  const morph = owner.update(input([contributor(material, 2, 'morph')]));
  expect(morph.status).toBe('available');
  expect(morph).toEqual(
    createStandardSceneSurfaceAdmission(input([contributor(material, 2, 'morph')])),
  );
  const skin = owner.update(input([contributor(material, 2, 'skin')]));
  expect(skin.status).toBe('unavailable');
  expect(skin).toEqual(
    createStandardSceneSurfaceAdmission(input([contributor(material, 2, 'skin')])),
  );
  expect(skin.identity).not.toBe(morph.identity);
  for (const patch of [
    { generation: 3 },
    { deviceGeneration: 5 },
    { viewIdentity: 'view/other' },
    { lane: 'direct' as const },
    { renderPath: 'deferred' as const },
    { cameraAvailable: false },
    { standardPipeline: false },
  ]) {
    const candidate = { ...input([contributor(material)]), ...patch };
    expect(owner.update(candidate)).toEqual(createStandardSceneSurfaceAdmission(candidate));
  }
  const pair = input([contributor(material), contributor(material, 2)]);
  const ordered = owner.update(pair);
  const reversed = owner.update({ ...pair, contributors: [...pair.contributors].reverse() });
  expect(reversed.identity).toBe(ordered.identity);
  expect(owner.update(input([])).status).toBe('available');
  expect(first.status).toBe('available');
});

it('reuses captured contributor facts across new pose rows and dispatch lists', () => {
  const material = new MaterialResource(captureMaterialSnapshot(source()));
  const owner = new SceneDataAdmissionFixture();
  const scopes = [{}];
  const firstInput = projectionInput([material], [1], scopes);
  const first = owner.updateProjection(firstInput);
  const secondInput = projectionInput([material], [1], scopes);
  const nextRow = {
    ...secondInput.contributorProjection.renderables.at(0),
    transform: { world: new Float32Array(16).fill(1) },
  } as unknown as RenderableSnapshot;
  const poseChanged = {
    ...secondInput,
    contributorProjection: {
      ...secondInput.contributorProjection,
      renderables: [nextRow],
    },
  };
  const stringify = vi.spyOn(JSON, 'stringify');
  const beforeHit = stringify.mock.calls.length;
  try {
    expect(owner.updateProjection(poseChanged)).toBe(first);
    expect(stringify).toHaveBeenCalledTimes(beforeHit);
    directProjectionAdmission(poseChanged);
    expect(stringify.mock.calls.length).toBeGreaterThan(beforeHit);
  } finally {
    stringify.mockRestore();
  }
  expect(owner.updateProjection(poseChanged)).toEqual(directProjectionAdmission(poseChanged));
});

it('rechecks borrowed parameter selection, program changes, scope changes, and reordered rows', () => {
  const snapshot = captureMaterialSnapshot({
    ...source(),
    surfaceModel: 'standard',
    paramSnapshot: { transmission: 0 },
  } as MaterialSnapshot);
  const material = new MaterialResource(snapshot);
  const owner = new SceneDataAdmissionFixture();
  const scopes = [{}];
  const firstInput = projectionInput([material], [1], scopes);
  const first = owner.updateProjection(firstInput);
  expect(first.status).toBe('available');

  const transmitting = material.withParameters({ transmission: 1 });
  const transmittingInput = projectionInput([transmitting], [1], scopes);
  const transmittingAdmission = owner.updateProjection(transmittingInput);
  expect(transmittingAdmission).toEqual(directProjectionAdmission(transmittingInput));
  expect(transmittingAdmission).not.toBe(first);

  const restoredInput = projectionInput([material], [1], scopes);
  const restored = owner.updateProjection(restoredInput);
  expect(restored).toEqual(directProjectionAdmission(restoredInput));
  expect(restored.status).toBe('available');

  const mutableParameters = material.withParameters({ transmission: 0 });
  const mutableInput = projectionInput([mutableParameters], [1], scopes);
  const mutableStart = owner.updateProjection(mutableInput);
  const borrowedParameters = mutableParameters.snapshot.paramSnapshot as {
    transmission: number;
  };
  borrowedParameters.transmission = 1;
  const mutableTransmission = owner.updateProjection(mutableInput);
  expect(mutableTransmission).not.toBe(mutableStart);
  expect(mutableTransmission).toEqual(directProjectionAdmission(mutableInput));
  borrowedParameters.transmission = 0;
  expect(owner.updateProjection(mutableInput)).toEqual(directProjectionAdmission(mutableInput));

  const changedScopes = {
    ...projectionInput([material], [1], scopes),
    viewIdentity: 'view/replacement',
  };
  const scopeAdmission = owner.updateProjection(changedScopes);
  expect(scopeAdmission).not.toBe(restored);
  expect(scopeAdmission).toEqual(directProjectionAdmission(changedScopes));

  const secondMaterial = new MaterialResource(captureMaterialSnapshot(source()));
  const pair = projectionInput([material, secondMaterial], [1, 2], scopes);
  const ordered = owner.updateProjection(pair);
  const reversed = projectionInput([secondMaterial, material], [2, 1], scopes);
  expect(owner.updateProjection(reversed)).toEqual(directProjectionAdmission(reversed));
  expect(owner.updateProjection(reversed).identity).toBe(ordered.identity);

  const deleted = {
    ...reversed,
    contributorProjection: { ...reversed.contributorProjection, dispatch: [] },
  };
  expect(owner.updateProjection(deleted)).toEqual(directProjectionAdmission(deleted));

  const current = projectionInput([material], [1], scopes);
  const currentAdmission = owner.updateProjection(current);
  const currentRow = current.contributorProjection.renderables.at(0) as RenderableSnapshot;
  const deformed = {
    ...current,
    contributorProjection: {
      ...current.contributorProjection,
      renderables: [{ ...currentRow, morph: { weights: new Float32Array([1]), targetCount: 1 } }],
    },
  };
  expect(owner.updateProjection(deformed)).toEqual(directProjectionAdmission(deformed));
  expect(owner.updateProjection(deformed)).not.toBe(currentAdmission);
  const skinned = {
    ...current,
    contributorProjection: {
      ...current.contributorProjection,
      renderables: [{ ...currentRow, skinBinding: { skeleton: 1, joints: [1] } }],
    },
  };
  expect(owner.updateProjection(skinned)).toEqual(directProjectionAdmission(skinned));
  const passChanged = {
    ...current,
    contributorProjection: {
      ...current.contributorProjection,
      dispatch: [
        {
          ...(current.contributorProjection.dispatch.at(0) as DispatchEntry),
          passIndex: 1,
        },
      ],
    },
  };
  expect(owner.updateProjection(passChanged)).toEqual(directProjectionAdmission(passChanged));

  const changedInputs = {
    ...material.snapshot,
    materialProgramInputs: {
      forward: { entryPoints: [{ name: 'fs_changed', stage: 'fragment' as const, bindings: [] }] },
    },
  };
  material.adoptProgramSnapshot(changedInputs);
  const changedProgramInput = projectionInput([material], [1], scopes);
  expect(owner.updateProjection(changedProgramInput)).toEqual(
    directProjectionAdmission(changedProgramInput),
  );
  expect(owner.updateProjection(changedProgramInput).status).toBe('unavailable');
});

it('rechecks mutable dispatch selection tags before reusing captured program facts', () => {
  const material = new MaterialResource(captureMaterialSnapshot(source()));
  const owner = new SceneDataAdmissionFixture();
  const candidate = projectionInput([material]);
  const tags = candidate.contributorProjection.dispatch.at(0)?.tags;
  if (tags === undefined) throw new Error('fixture requires a dispatch tag row');
  const first = owner.updateProjection(candidate);
  expect(first.status).toBe('available');
  tags.LightMode = 'Deferred';
  const changed = owner.updateProjection(candidate);
  expect(changed).toEqual(directProjectionAdmission(candidate));
  expect(changed.identity).not.toBe(first.identity);
});

it('re-reads borrowed program entry inputs through the raw projection', () => {
  const authored = source();
  const borrowed = { ...authored, immutableValues: true as const };
  const material = new MaterialResource(borrowed);
  const owner = new SceneDataAdmissionFixture();
  const candidate = projectionInput([material]);
  const first = owner.updateProjection(candidate);
  expect(first.status).toBe('available');
  requiredFirst(authored.materialProgramInputs.forward.entryPoints).name = 'fs_changed';
  const second = owner.updateProjection(candidate);
  expect(second.status).toBe('unavailable');
  expect(second).toEqual(directProjectionAdmission(candidate));
});

it('replaces facts on accepted program changes and preserves held snapshots through rebinding', () => {
  const snapshot = captureMaterialSnapshot(source());
  const material = new MaterialResource(snapshot);
  const held = new MaterialResource(snapshot);
  contributor(material);
  const firstProgramIdentity = programIdentity(material);
  const schema = { ...snapshot, materialParamSchema: [] };
  material.adoptProgramSnapshot(schema);
  expect(programIdentity(material)).toBeDefined();
  const entries = {
    forward: { entryPoints: [{ name: 'fs_other', stage: 'fragment' as const, bindings: [] }] },
  };
  material.adoptProgramSnapshot({ ...material.snapshot, materialProgramInputs: entries });
  expect(programIdentity(material)).toBeUndefined();
  requiredFirst(entries.forward.entryPoints).name = 'fs_ao_input';
  expect(contributor(material).entryPoint).toBe('fs_ao_input');
  const replacement = source();
  requiredFirst(replacement.materialProgramInputs.forward.entryPoints).name = 'fs_new';
  material.adopt(captureMaterialSnapshot(replacement));
  expect(programIdentity(material)).not.toBe(firstProgramIdentity);
  expect(contributor(material).entryPoint).toBeUndefined();
  expect(programIdentity(held)).toBe(firstProgramIdentity);
  expect(contributor(held).entryPoint).toBe('fs_ao_input');
  const copied = new MaterialResource({ ...snapshot } as MaterialSnapshot);
  expect(programIdentity(copied)).toBeUndefined();
});

it('adopts actual registry entry changes without changing held program observations', () => {
  const material = new MaterialResource(captureMaterialSnapshot(source()));
  const held = new MaterialResource(material.snapshot);
  contributor(material);
  const firstContributionProgram = programIdentity(material);
  let entryPoints = Object.freeze([
    { name: 'fs_ao_input', stage: 'fragment' as const, bindings: [] },
  ]);
  const registry = {
    materialArtifact: () => ({ program: { entryPoints } }),
    materialParamSchemaProjection: () => undefined,
    isSourceBackedMaterialArtifact: () => false,
  };
  const rebind = () =>
    rebindPublicationMaterialSchemas(registry as never, { materialUpdates: [material] } as never);
  rebind();
  const accepted = contributor(material);
  const acceptedProgram = programIdentity(material);
  expect(accepted.entryPoint).toBe('fs_ao_input');
  expect(acceptedProgram).toBeDefined();
  expect(acceptedProgram).not.toBe(firstContributionProgram);
  const snapshot = material.snapshot;
  rebind();
  expect(material.snapshot).toBe(snapshot);
  expect(programIdentity(material)).toBe(acceptedProgram);
  entryPoints = Object.freeze([{ name: 'fs_changed', stage: 'fragment' as const, bindings: [] }]);
  rebind();
  expect(contributor(material).entryPoint).toBeUndefined();
  expect(programIdentity(material)).not.toBe(acceptedProgram);
  expect(programIdentity(held)).toBe(firstContributionProgram);
  expect(contributor(held).entryPoint).toBe('fs_ao_input');
});

it('derives fixed programs while preserving borrowed parameters and independent old holders', () => {
  const material = new MaterialResource(captureMaterialSnapshot(source()));
  const firstProgram = programIdentity(material);
  const parameters = { terrainLod: [0, 0, 2, 1] };
  const derived = material.withParameters(parameters);
  const held = new MaterialResource(derived.snapshot);
  expect(programIdentity(derived)).toBe(firstProgram);
  expect(programIdentity(held)).toBe(firstProgram);
  expect(derived.ownsValues(derived.snapshot)).toBe(false);
  expect(held.ownsValues(held.snapshot)).toBe(false);
  expect(ownedMaterialValues(derived.snapshot)).toBe(false);
  parameters.terrainLod[1] = 1;
  expect(derived.snapshot.paramSnapshot?.terrainLod).toBe(parameters.terrainLod);
  expect(held.snapshot.paramSnapshot?.terrainLod).toEqual([0, 1, 2, 1]);
  const next = material.withParameters({ terrainLod: [1, 1.5, 2, 1] });
  expect(programIdentity(next)).toBe(firstProgram);
  expect(held.snapshot.paramSnapshot?.terrainLod).toEqual([0, 1, 2, 1]);
  const schema = { ...derived.snapshot, materialParamSchema: [] };
  derived.adoptProgramSnapshot(schema);
  expect(programIdentity(derived)).toBeDefined();
  expect(derived.ownsValues(schema)).toBe(false);
  const changed = source();
  requiredFirst(changed.materialProgramInputs.forward.entryPoints).name = 'fs_other';
  material.adopt(captureMaterialSnapshot(changed));
  expect(programIdentity(material.withParameters({}))).not.toBe(firstProgram);
  expect(contributor(held).entryPoint).toBe('fs_ao_input');
  const otherWorld = new MaterialResource(captureMaterialSnapshot(source()));
  expect(otherWorld.snapshot.materialHandle).toBe(material.snapshot.materialHandle);
  expect(programIdentity(otherWorld.withParameters({}))).not.toBe(firstProgram);
  expect(programIdentity(new MaterialResource({ ...held.snapshot }))).toBeUndefined();
});

it('reads borrowed getters at derivation and keeps nested program arrays live', () => {
  const authored = source();
  const reads = vi.fn(() => authored.passes);
  const borrowed = new MaterialResource({
    ...authored,
    get passes() {
      return reads();
    },
  });
  const derived = borrowed.withParameters({ terrainNeighbors: [0, 0, 0, 0] });
  const before = reads.mock.calls.length;
  expect(programIdentity(derived)).toBeUndefined();
  requiredFirst(authored.materialProgramInputs.forward.entryPoints).name = 'fs_changed';
  expect(contributor(derived).entryPoint).toBeUndefined();
  expect(reads.mock.calls.length).toBe(before);
  expect(contributor(borrowed.withParameters({})).entryPoint).toBeUndefined();
  expect(reads.mock.calls.length).toBeGreaterThan(before);
});
