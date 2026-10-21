import { createBoxGeometry } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import {
  createMaterialProgramArtifactReceipt,
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
  type ParamSchemaEntry,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import type { MaterialProgramAbi, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { resolveRendererMaterialShaderArtifact } from '../assembly/material/pipeline-helpers';
import {
  buildGpuDrivenDraws,
  gpuDrivenMaterialArtifactKey,
  prepareGpuDrivenDraw,
} from '../extract/gpu-driven';
import { MaterialResource } from '../material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';

const textureNames = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'specularColorTexture',
  'emissiveTexture',
  'occlusionTexture',
  'transmissionTexture',
  'thicknessTexture',
] as const;

function material(): MaterialSnapshot {
  return {
    passes: [],
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 0.5,
    materialShaderId: 'forgeax::default-standard-pbr',
    textureHandles: new Map(textureNames.map((name, index) => [name, index + 1])) as never,
    samplerHandles: new Map(textureNames.map((name, index) => [name, index + 101])) as never,
  };
}

function snapshot(
  materialSnapshot: MaterialSnapshot = material(),
  draws?: readonly NonNullable<RenderableSnapshot['gpuDrivenDraws']>[number][],
): RenderableSnapshot {
  const draw = {
    kind: 'indexed' as const,
    first: 0,
    count: 36,
    baseVertex: 0,
    materialSlot: 0,
    topology: 'triangle-list' as const,
    pipelineClass: 'standard-pbr',
    materialResourceClass: 'standard-pbr-resources',
    geometry: {
      receipt: geometry({ receipt: createStandardPbrArtifactReceipt() }),
      draw: {
        kind: 'indexed' as const,
        first: 0,
        count: 36,
        baseVertex: 0,
        topology: 'triangle-list' as const,
      },
      deformation: 'rigid' as const,
    },
  };
  const resource = new MaterialResource(materialSnapshot);
  return {
    assetHandle: 1,
    transform: { world: new Float32Array(16) },
    material: resource,
    materials: [resource],
    materialBindingSources: [],
    worldId: 0,
    entityKey: 1,
    gpuDrivenDraws: draws ?? [draw],
  };
}

function geometry(source: { readonly receipt: Pick<MaterialProgramAbi, 'vertexInputs'> }) {
  return {
    identity: 'canonical-pbr-geometry',
    vertexInputs: source.receipt.vertexInputs,
    topology: 'triangle-list' as const,
    indexed: true,
  };
}

function artifact(vertexColorAvailable = false) {
  const receipt = createStandardPbrArtifactReceipt(false, vertexColorAvailable);
  return {
    material: 'forgeax::default-standard-pbr',
    pass: 'forward',
    program: createMaterialShaderProgram('producer-composed-standard-pbr'),
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: ['forgeax_material::standard'],
    vertexInputs: receipt.vertexInputs.map((input) => ({ ...input })),
    receipt,
  };
}

function customArtifact() {
  const schema = [
    { name: 'tint', type: 'color' },
    { name: 'roughnessBias', type: 'f32' },
  ] as const satisfies readonly ParamSchemaEntry[];
  const receipt = createMaterialProgramArtifactReceipt({
    schema,
    directEntry: 'vs_main',
    sceneIndexEntry: 'vs_scene_index',
    vertexInputs: [
      { semantic: 'position', location: 0, format: 'float32x3' },
      { semantic: 'normal', location: 1, format: 'float32x3' },
      { semantic: 'uv', location: 2, format: 'float32x2' },
      { semantic: 'tangent', location: 3, format: 'float32x4' },
    ],
  });
  return {
    material: 'game::custom-surface',
    pass: 'forward',
    program: createMaterialShaderProgram('producer-composed-custom-surface'),
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: ['game::custom-surface'],
    vertexInputs: receipt.vertexInputs.map((input) => ({ ...input })),
    receipt,
  };
}

describe('prepared Standard PBR producer-to-record integration', () => {
  it.each([
    'forgeax::default-standard-pbr',
    'physical-material::standard-clearcoat-factor-r',
  ])('distinguishes canonical roots from legacy direct-only aliases: %s', (materialShaderId) => {
    const source = { ...material(), materialShaderId };
    const draws = buildGpuDrivenDraws({
      mesh: createBoxGeometry(1, 1, 1).unwrap(),
      materials: [source],
      fallbackMaterial: source,
      deformation: 'rigid',
      getMaterialShaderArtifact: () => undefined,
    });
    expect(draws).toHaveLength(1);
    expect(draws[0]?.preparationError?.code).toBe(
      materialShaderId.startsWith('forgeax::') ? 'missing-material-receipt' : undefined,
    );
  });

  it('retains a published direct-only material on the ordinary lane without a preparation error', () => {
    const program = artifact();
    const { sceneIndexEntry: _entry, ...receipt } = program.receipt;
    const direct: MaterialSnapshot = { ...material(), materialShaderId: 'game::direct-only' };
    const draws = buildGpuDrivenDraws({
      mesh: createBoxGeometry(1, 1, 1).unwrap(),
      materials: [direct],
      fallbackMaterial: direct,
      deformation: 'rigid',
      getMaterialShaderArtifact: () => ({ ...program, receipt }),
    });
    expect(draws).toHaveLength(1);
    expect(draws[0]?.prepared).toBeUndefined();
    expect(draws[0]?.preparationError).toBeUndefined();
  });

  it('requires the published scene-index artifact for a custom surface', () => {
    const source: MaterialSnapshot = {
      ...material(),
      materialShaderId: 'game::custom-surface-direct',
      materialProgramKeys: { forward: 'game::custom-surface-direct' },
      materialSceneIndexProgramKeys: {
        forward: { specializationKey: 'game::custom-surface-scene', pass: 'forward' },
      },
    };
    const requested: string[] = [];
    const draws = buildGpuDrivenDraws({
      mesh: createBoxGeometry(1, 1, 1).unwrap(),
      materials: [source],
      fallbackMaterial: source,
      deformation: 'rigid',
      getMaterialShaderArtifact: (key) => {
        requested.push(key);
        return undefined;
      },
    });
    expect(requested).toEqual(['game::custom-surface-scene']);
    expect(draws).toHaveLength(1);
    expect(draws[0]?.preparationError?.code).toBe('missing-material-receipt');
  });

  it('prepares a COLOR_0 geometry with the matching published receipt', () => {
    const source = artifact(true);
    const result = prepareGpuDrivenDraw({
      material: material(),
      deformation: 'rigid',
      artifact: source,
      geometry: geometry(source),
      generation: source.receipt.generation,
      draw: snapshot().gpuDrivenDraws?.[0] as NonNullable<
        RenderableSnapshot['gpuDrivenDraws']
      >[number],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receiptIdentity).toBe(source.receipt.receiptIdentity);
    expect(result.value.vertexInputs).toContainEqual({
      semantic: 'color',
      location: 13,
      format: 'float32x4',
    });
  });

  it('admits geometry attributes that the selected material does not consume', () => {
    const source = artifact();
    const result = prepareGpuDrivenDraw({
      material: material(),
      deformation: 'rigid',
      artifact: source,
      geometry: {
        ...geometry(source),
        vertexInputs: [
          ...source.receipt.vertexInputs,
          { semantic: 'uv1', location: 6, format: 'float32x2' },
        ],
      },
      generation: source.receipt.generation,
      draw: snapshot().gpuDrivenDraws?.[0] as NonNullable<
        RenderableSnapshot['gpuDrivenDraws']
      >[number],
    });

    expect(result.ok).toBe(true);
  });

  it('selects the colored receipt while extracting a real colored mesh draw', () => {
    const coloredSource = artifact(true);
    const coloredMesh: MeshAsset = {
      kind: 'mesh',
      vertices: new Float32Array(36),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {
        position: new Float32Array(9),
        normal: new Float32Array(9),
        uv: new Float32Array(6),
        tangent: new Float32Array(12),
        color: new Float32Array(12),
      },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          materialSlot: 0,
          topology: 'triangle-list',
        },
      ],
      materialSlots: [{ slotName: 'default' }],
    };
    const selectedColorFacts: boolean[] = [];
    const draws = buildGpuDrivenDraws({
      mesh: coloredMesh,
      materials: [material()],
      fallbackMaterial: material(),
      deformation: 'rigid',
      getMaterialShaderArtifact: (_materialShaderId, request) => {
        selectedColorFacts.push(request?.vertexColorAvailable === true);
        return coloredSource;
      },
    });

    expect(selectedColorFacts).toEqual([true]);
    expect(draws).toHaveLength(1);
    expect(draws[0]?.prepared?.vertexInputs).toContainEqual({
      semantic: 'color',
      location: 13,
      format: 'float32x4',
    });
    expect(draws[0]?.preparationError).toBeUndefined();
  });

  it.each([
    'resident-uv',
    'missing-uv',
    'missing-normal',
    'wrong-uv-format',
  ] as const)('admits only resident geometry UV aliases: %s', (scenario) => {
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const attributes = { ...mesh.attributes };
    if (scenario === 'missing-uv') delete attributes.uv;
    if (scenario === 'missing-normal') delete attributes.normal;
    const receipt = createMaterialProgramArtifactReceipt({
      schema: [],
      directEntry: 'vs_main',
      sceneIndexEntry: 'vs_scene_index',
      vertexInputs: [
        ...artifact().receipt.vertexInputs,
        ...Array.from({ length: 7 }, (_, index) => ({
          semantic: `uv${index + 1}`,
          location: index + 6,
          format: scenario === 'wrong-uv-format' && index === 6 ? 'float32x4' : 'float32x2',
        })),
      ],
    });
    const source = {
      ...artifact(),
      receipt,
      layoutIdentity: receipt.reflection.layoutIdentity,
      uvSetCount: 8,
    };
    const draws = buildGpuDrivenDraws({
      mesh: { ...mesh, attributes },
      materials: [material()],
      fallbackMaterial: material(),
      deformation: 'rigid',
      getMaterialShaderArtifact: () => source,
    });
    expect(draws).toHaveLength(1);
    expect(draws[0]?.preparationError?.code).toBe(
      scenario === 'resident-uv' ? undefined : 'vertex-input-mismatch',
    );
    expect(draws[0]?.prepared !== undefined).toBe(scenario === 'resident-uv');
  });

  it('prepares colored geometry with an exact published program that does not consume COLOR_0', () => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const directKey = 'sha256:published-plain-direct';
    const sceneKey = 'sha256:published-plain-scene';
    const program = artifact();
    registry.installMaterialArtifact(sceneKey, {
      source: program.program.source,
      paramSchema: [],
      receipt: program.receipt,
    });
    const plain: MaterialSnapshot = {
      ...material(),
      materialShaderId: directKey,
      materialProgramKeys: { forward: directKey },
      materialSceneIndexProgramKeys: {
        forward: { specializationKey: sceneKey, pass: 'forward' },
      },
    };
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const coloredMesh: MeshAsset = {
      ...mesh,
      attributes: { ...mesh.attributes, color: new Float32Array(96) },
    };
    const draws = buildGpuDrivenDraws({
      mesh: coloredMesh,
      materials: [plain],
      fallbackMaterial: plain,
      deformation: 'rigid',
      getMaterialShaderArtifact: (key, request) =>
        resolveRendererMaterialShaderArtifact(key, registry, undefined, request),
    });
    expect(draws).toHaveLength(1);
    expect(draws[0]?.preparationError).toBeUndefined();
    expect(draws[0]?.prepared).toBeDefined();
    expect(draws[0]?.prepared?.vertexInputs.some((input) => input.semantic === 'color')).toBe(
      false,
    );
    expect(draws[0]?.prepared?.receiptIdentity).toBe(program.receipt.receiptIdentity);
  });

  it('shares geometry input tables by immutable layout while observing authored layout changes', () => {
    const base = createBoxGeometry(1, 1, 1).unwrap();
    const attributes = { ...base.attributes };
    const mesh = { ...base, attributes };
    const project = (source: MeshAsset) =>
      buildGpuDrivenDraws({
        mesh: source,
        materials: [],
        fallbackMaterial: material(),
        deformation: 'rigid',
      })[0]?.geometry.receipt.vertexInputs;
    const first = project(mesh);
    expect(first).toBeDefined();
    expect(project(createBoxGeometry(2, 2, 2).unwrap())).toBe(first);
    // Raw author maps may change in place; their identity never owns this cache.
    Object.assign(attributes, { color: new Float32Array(96) });
    const changed = project(mesh);
    expect(changed).not.toBe(first);
    expect(first?.some((input) => input.semantic === 'color')).toBe(false);
    expect(changed?.some((input) => input.semantic === 'color')).toBe(true);
    expect(project(mesh)).toBe(changed);
  });

  it('keeps colored and colorless receipts on distinct production identities', () => {
    const plain = artifact(false);
    const colored = artifact(true);
    const plainKey = gpuDrivenMaterialArtifactKey({
      material: plain.material,
      deformation: 'rigid',
      receiptIdentity: plain.receipt.receiptIdentity,
      receiptGeneration: plain.receipt.generation,
    });
    const coloredKey = gpuDrivenMaterialArtifactKey({
      material: colored.material,
      deformation: 'rigid',
      receiptIdentity: colored.receipt.receiptIdentity,
      receiptGeneration: colored.receipt.generation,
    });

    expect(plain.receipt.vertexInputs).not.toContainEqual(
      expect.objectContaining({ semantic: 'color', location: 13 }),
    );
    expect(colored.receipt.vertexInputs).toContainEqual({
      semantic: 'color',
      location: 13,
      format: 'float32x4',
    });
    expect(plain.receipt.receiptIdentity).not.toBe(colored.receipt.receiptIdentity);
    expect(plainKey).not.toBe(coloredKey);
  });

  it('carries one producer receipt to direct and scene-index preparation', () => {
    const source = artifact();
    const result = prepareGpuDrivenDraw({
      material: material(),
      deformation: 'rigid',
      artifact: source,
      geometry: geometry(source),
      generation: source.receipt.generation,
      draw: snapshot().gpuDrivenDraws?.[0] as NonNullable<
        RenderableSnapshot['gpuDrivenDraws']
      >[number],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.directEntry).toBe('vs_main');
    expect(result.value.sceneIndexEntry).toBe('vs_scene_index');
    expect(result.value.resourceSlots).toBe(source.receipt.resourceSlots);
    expect(result.value.identity.deformation).toBe('rigid');
  });

  it.each([
    ['stale generation', (source: ReturnType<typeof artifact>) => source.receipt.generation + 1],
    ['missing resources', (source: ReturnType<typeof artifact>) => source.receipt.generation],
  ])('fails before recording for %s', (_label, generation) => {
    const source = artifact();
    const baseSnapshot = snapshot();
    const drawMaterial =
      _label === 'missing resources'
        ? {
            ...baseSnapshot.material.snapshot,
            textureHandles: undefined,
            authoredTextureFields: new Set(['baseColorTexture']),
          }
        : baseSnapshot.material.snapshot;
    const result = prepareGpuDrivenDraw({
      material: drawMaterial,
      deformation: 'rigid',
      artifact: source,
      geometry: geometry(source),
      generation: generation(source),
      draw: baseSnapshot.gpuDrivenDraws?.[0] as NonNullable<
        RenderableSnapshot['gpuDrivenDraws']
      >[number],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(
      _label === 'stale generation' ? 'stale-generation' : 'resource-not-ready',
    );
    expect(result.error.detail.reason).toBe(
      _label === 'stale generation' ? 'generation-stale' : 'material-resource-missing',
    );
  });

  it('prepares every extracted submesh draw from its own range and material receipt', () => {
    const source = artifact();
    const box = createBoxGeometry(1, 1, 1).unwrap();
    if (box.indices === undefined) throw new Error('Expected indexed box');
    const draws = buildGpuDrivenDraws({
      mesh: {
        ...box,
        indices: new Uint16Array([...box.indices, ...box.indices.slice(0, 12)]),
        submeshes: [
          {
            vertexCount: 24,
            indexCount: 36,
            indexOffset: 0,
            materialSlot: 0,
            topology: 'triangle-list',
          },
          {
            vertexCount: 24,
            indexCount: 12,
            indexOffset: 36,
            materialSlot: 0,
            topology: 'triangle-list',
          },
        ],
      },
      deformation: 'rigid',
      materials: [material()],
      fallbackMaterial: material(),
      getMaterialShaderArtifact: () => source,
    });

    expect(draws).toHaveLength(2);
    expect(draws.map((draw) => draw.prepared?.first)).toEqual([0, 36]);
    expect(draws.map((draw) => draw.prepared?.count)).toEqual([36, 12]);
    expect(draws.every((draw) => draw.prepared?.topology === draw.topology)).toBe(true);
    expect(
      draws.every(
        (draw) => draw.prepared?.identity.geometry === draws[0]?.geometry?.receipt.identity,
      ),
    ).toBe(true);
  });

  it('returns a structured receipt error without adding a duplicate CPU draw', () => {
    const source = artifact();
    const base = snapshot();
    const draw = base.gpuDrivenDraws?.[0] as NonNullable<
      RenderableSnapshot['gpuDrivenDraws']
    >[number];
    const result = prepareGpuDrivenDraw({
      material: base.material.snapshot,
      deformation: 'rigid',
      artifact: (() => {
        const { receipt: _receipt, ...withoutReceipt } = source;
        return withoutReceipt;
      })(),
      geometry: geometry(source),
      generation: source.receipt.generation,
      draw,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing-material-receipt');
    expect(base.gpuDrivenDraws).toHaveLength(1);
  });

  it('keeps a direct-only receipt out of GPU Scene admission', () => {
    const source = artifact();
    const base = snapshot();
    const { sceneIndexEntry: _entry, ...directReceipt } = source.receipt;
    const draw = base.gpuDrivenDraws?.[0];
    if (draw === undefined) throw new Error('missing fixture draw');
    const result = prepareGpuDrivenDraw({
      material: base.material.snapshot,
      deformation: 'rigid',
      artifact: { ...source, receipt: directReceipt },
      geometry: geometry(source),
      generation: directReceipt.generation,
      draw,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'missing-material-receipt' } });
  });

  it('admits numeric-only Standard PBR without optional texture resources', () => {
    const source = artifact();
    const numericMaterial: MaterialSnapshot = {
      ...material(),
      textureHandles: undefined,
      samplerHandles: undefined,
    };
    const baseSnapshot = snapshot(numericMaterial);
    const result = prepareGpuDrivenDraw({
      material: baseSnapshot.material.snapshot,
      deformation: 'rigid',
      artifact: source,
      geometry: geometry(source),
      generation: source.receipt.generation,
      draw: baseSnapshot.gpuDrivenDraws?.[0] as NonNullable<
        RenderableSnapshot['gpuDrivenDraws']
      >[number],
    });
    expect(result.ok).toBe(true);
  });

  it('keeps a video material on the CPU residual beside an eligible static PBR draw', () => {
    const source = artifact();
    const staticMaterial = material();
    const videoMaterial: MaterialSnapshot = {
      ...staticMaterial,
      videoTextureFields: new Map([['baseColorTexture', 7]]) as never,
    };
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const staticDraws = buildGpuDrivenDraws({
      mesh,
      materials: [staticMaterial],
      fallbackMaterial: staticMaterial,
      deformation: 'rigid',
      getMaterialShaderArtifact: () => source,
    });
    const videoDraws = buildGpuDrivenDraws({
      mesh,
      materials: [videoMaterial],
      fallbackMaterial: videoMaterial,
      deformation: 'rigid',
      getMaterialShaderArtifact: () => source,
    });

    expect(staticDraws[0]?.prepared).toBeDefined();
    expect(videoDraws[0]?.prepared).toBeUndefined();
    expect(videoDraws[0]?.preparationError).toBeUndefined();
  });

  it('admits a producer-backed custom material without a Standard shader name', () => {
    const source = customArtifact();
    const customMaterial: MaterialSnapshot = {
      ...material(),
      materialShaderId: source.material,
      materialParamSchema: [
        { name: 'tint', type: 'color' },
        { name: 'roughnessBias', type: 'f32' },
      ],
      paramSnapshot: { tint: [0.8, 0.25, 0.1, 1], roughnessBias: 0.12 },
      textureHandles: undefined,
      samplerHandles: undefined,
    };
    const baseSnapshot = snapshot(customMaterial);
    const result = prepareGpuDrivenDraw({
      material: baseSnapshot.material.snapshot,
      deformation: 'rigid',
      artifact: source,
      geometry: geometry(source),
      generation: source.receipt.generation,
      draw: baseSnapshot.gpuDrivenDraws?.[0] as NonNullable<
        RenderableSnapshot['gpuDrivenDraws']
      >[number],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.identity.material).toBe('game::custom-surface');
    expect(result.value.materialRow.byteLength).toBe(32);
    expect(result.value.materialRow.fields).toEqual(['tint', 'roughnessBias']);
    expect(result.value.sceneIndexEntry).toBe('vs_scene_index');
  });
});
