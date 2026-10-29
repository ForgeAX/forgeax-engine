import { selectMaterialPassProgram } from '@forgeax/engine-assets-runtime';
import type { MaterialAsset, MaterialProgramAbi, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  particleMaterialPass,
  particleMaterialSceneDepthBinding,
  particleMaterialUsesBindings,
  particleMeshVertices,
  particleMeshVerticesCached,
  particleRendererRenderState,
  prepareParticleMaterialInputs,
} from '../feature/particle-resources.js';

describe('particle mesh resources', () => {
  it('does not infer a vertex layout from an untyped packed buffer', () => {
    const vertices = new Float32Array([
      0, 1, 0, 0, 1, 0, 0.5, 1, 1, 0, 0, 1, 0, -1, 0, 0, -1, 0, 0.5, 0, 1, 0, 0, 1,
    ]);
    const mesh = {
      vertices,
      indices: new Uint16Array([0, 1, 0]),
      attributes: {},
      submeshes: [],
    } as unknown as MeshAsset;

    expect(particleMeshVertices(mesh)).toHaveLength(0);
  });

  it('reuses derived vertices only for frozen asset publications', () => {
    const mesh = Object.freeze({
      kind: 'mesh' as const,
      vertices: new Float32Array(),
      attributes: { position: new Float32Array([0, 1, 2]) },
      indices: new Uint16Array([0]),
      submeshes: [],
      materialSlots: [],
    }) as unknown as MeshAsset;
    const first = particleMeshVerticesCached(mesh);
    const second = particleMeshVerticesCached(mesh);
    expect(second).toBe(first);
    expect(Array.from(second)).toEqual([0, 1, 2, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 1, 1]);
  });

  it('does not hide mutations on unfrozen authoring meshes', () => {
    const mesh = {
      kind: 'mesh' as const,
      vertices: new Float32Array(),
      attributes: { position: new Float32Array([0, 1, 2]) },
      indices: new Uint16Array([0]),
      submeshes: [],
      materialSlots: [],
    } as unknown as MeshAsset;
    const first = particleMeshVerticesCached(mesh);
    (mesh.attributes.position as Float32Array)[0] = 7;
    const second = particleMeshVerticesCached(mesh);
    expect(second).not.toBe(first);
    expect(second[0]).toBe(7);
  });
});

describe('particle material pass', () => {
  it.each([
    'billboard',
    'mesh',
    'ribbon',
    'trail',
    'beam',
  ] as const)('selects the published intrinsic color input for %s particles', (kind) => {
    const context = {
      backend: 'webgpu',
      capability: 'storage-buffer-atmosphere',
      pipeline: 'forward',
      geometry: 'mesh',
      pass: 'forward',
      profile: 'forgeax-material-wgsl-v1',
      toolchain: 'naga-oil',
      instrumentation: 'none',
    } as const;
    const abi = {
      directEntry: 'vs_main',
      materialRow: { byteLength: 16, fields: [] },
      resourceSlots: [],
      uvSets: [],
      vertexInputs: [{ semantic: 'color', location: 2, format: 'float32x4' }],
      alphaMask: { cutoff: 'alphaCutoff', source: 'baseColor.a' },
      reflection: { layoutIdentity: 'particle-layout', resourceSlots: [], vertexInputs: [] },
      receiptIdentity: 'particle-layout',
      generation: 1,
    } satisfies MaterialProgramAbi;
    const passName = `particle-${kind}`;
    const projection = {
      materialGuid: 'particle-material',
      publicationGeneration: 1,
      specializationKey: 'publication',
      artifactHash: 'publication-hash',
      runtimeValues: {},
      staticSelection: [],
      passes: [
        {
          name: passName,
          module: 'game::particle',
          renderState: { cullMode: 'none' as const },
          programs: [
            {
              context,
              address: 'direct' as const,
              entry: 'vs_main',
              abi,
              specializationKey: 'cooked/particle-color',
              artifactHash: 'particle-color',
            },
          ],
        },
      ],
    };

    expect(() => selectMaterialPassProgram(projection, passName, context)).toThrow(
      expect.objectContaining({ code: 'material-specialization-not-cooked' }),
    );
    expect(particleMaterialPass(kind, undefined, false, { projection, context })).toEqual({
      shader: 'cooked/particle-color',
      renderState: { cullMode: 'none' },
    });
  });

  it('selects a published program by pass and device context without aliasing its module', () => {
    const context = {
      backend: 'webgpu',
      capability: 'storage-buffer',
      pipeline: 'forward',
      geometry: 'mesh',
      pass: 'forward',
      profile: 'forgeax-material-wgsl-v1',
      toolchain: 'naga-oil',
      instrumentation: 'none',
    } as const;
    const material: MaterialAsset = {
      kind: 'material',
      passes: [{ name: 'particle-mesh', program: { module: 'game::particle' } }],
    };
    const projection = {
      materialGuid: 'material',
      publicationGeneration: 1,
      specializationKey: 'publication',
      artifactHash: 'publication-hash',
      runtimeValues: {},
      staticSelection: [],
      passes: [
        {
          name: 'particle-mesh',
          module: 'game::particle',
          renderState: { cullMode: 'none' as const },
          programs: [
            { context, specializationKey: 'cooked/native', artifactHash: 'native' },
            {
              context: { ...context, instrumentation: 'validation' as const },
              specializationKey: 'cooked/validation',
              artifactHash: 'validation',
            },
          ],
        },
      ],
    };
    expect(particleMaterialPass('mesh', material, true, { projection, context })).toEqual({
      shader: 'cooked/native',
      renderState: { cullMode: 'none' },
    });
    expect(
      particleMaterialPass('mesh', material, true, {
        projection,
        context: { ...context, instrumentation: 'validation' },
      }).shader,
    ).toBe('cooked/validation');
    expect(() =>
      particleMaterialPass('mesh', material, true, {
        projection,
        context: { ...context, backend: 'wgpu-native' },
      }),
    ).toThrow(expect.objectContaining({ code: 'material-specialization-not-cooked' }));
    expect(
      particleMaterialPass('mesh', material, true, {
        projection: {
          ...projection,
          publicationGeneration: 2,
          passes: [
            {
              ...projection.passes[0],
              name: 'particle-mesh',
              module: 'game::particle',
              programs: [{ context, specializationKey: 'cooked/rebuilt', artifactHash: 'rebuilt' }],
            },
          ],
        },
        context,
      }).shader,
    ).toBe('cooked/rebuilt');
  });

  it('requests material bindings only when the selected shader declares group 1', () => {
    for (const contract of [
      undefined,
      'group-0',
      'group-0-resource',
      'view-only',
      'view-and-scene-depth',
    ] as const)
      expect(particleMaterialUsesBindings(contract)).toBe(false);
    for (const contract of [
      'render-material',
      'render-material-with-scene-depth',
      'render-material-and-scene-depth',
    ] as const)
      expect(particleMaterialUsesBindings(contract)).toBe(true);
  });

  it('uses the renderer-specific authored shader and render state', () => {
    const material: MaterialAsset = {
      kind: 'material',
      passes: [
        { name: 'Forward', program: { module: 'game::standard' } },
        {
          name: 'particle-billboard',
          program: { module: 'game::hex-sigil' },
          renderState: { depthWriteEnabled: false, cullMode: 'none' },
        },
      ],
    };

    expect(particleMaterialPass('billboard', material)).toEqual({
      shader: 'game::hex-sigil',
      renderState: { depthWriteEnabled: false, cullMode: 'none' },
    });
  });

  it('maps renderer shader contracts to their scene-depth binding slots', () => {
    expect(particleMaterialSceneDepthBinding('group-0-resource')).toBe(0);
    expect(particleMaterialSceneDepthBinding('view-and-scene-depth')).toBe(1);
    expect(particleMaterialSceneDepthBinding('group-0')).toBeUndefined();
    expect(particleMaterialSceneDepthBinding('view-only')).toBeUndefined();
    expect(particleMaterialSceneDepthBinding('render-material')).toBeUndefined();
  });

  it('does not mistake an ordinary Forward pass for a particle shader', () => {
    const material: MaterialAsset = {
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'game::standard' } }],
    };

    expect(particleMaterialPass('mesh', material)).toEqual({
      shader: 'forgeax::vfx-render.particles.mesh',
    });
  });

  it('returns a structured missing-input error instead of dereferencing an absent declaration', () => {
    expect(
      prepareParticleMaterialInputs(
        {
          kind: 'billboard',
          material: '019e9c00-0000-7000-8000-000000000003',
          materialInputs: ['heat'],
        },
        { kind: 'material', particleInputs: [] },
        [],
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'vfx-material-input-missing', detail: { name: 'heat' } },
    });
  });
});

describe('VFX Mesh world-space projection', () => {
  it('adapts Standard geometry without discarding the ordinary material render state', () => {
    const renderState = {
      depthCompare: 'less-equal',
      depthWriteEnabled: true,
      queue: 2000,
    } as const;
    const material = {
      kind: 'material',
      passes: [
        {
          name: 'forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState,
        },
      ],
    } as MaterialAsset;
    expect(particleMaterialPass('mesh', material)).toEqual({
      shader: 'forgeax::vfx-render.particles.mesh',
      renderState,
    });
  });
});

describe('authored unlit mesh fallback', () => {
  const renderState = { depthWriteEnabled: false, queue: 3000 };
  const material = {
    kind: 'material',
    passes: [{ name: 'forward', program: { module: 'game::unlit' }, renderState }],
  } as MaterialAsset;

  it.each([false, true])('specializes only an unlit stock mesh fallback, inputs=%s', (inputs) => {
    expect(particleMaterialPass('mesh', material, inputs, undefined, true)).toEqual({
      shader: `forgeax::vfx-render.particles.${inputs ? 'mesh-inputs-unlit' : 'mesh-unlit'}`,
      renderState,
    });
    expect(particleMaterialPass('mesh', material, inputs, undefined, false)).toEqual({
      shader: `forgeax::vfx-render.particles.${inputs ? 'mesh-inputs' : 'mesh'}`,
      renderState,
    });
  });

  it('preserves an explicit particle mesh program and its state', () => {
    const custom = {
      kind: 'material',
      passes: [
        { name: 'particle-mesh', program: { module: 'game::authored-particle' }, renderState },
      ],
    } as MaterialAsset;
    expect(particleMaterialPass('mesh', custom, false, undefined, true)).toEqual({
      shader: 'game::authored-particle',
      renderState,
    });
    expect(particleMaterialPass('billboard', material, false, undefined, true)).toEqual({
      shader: 'forgeax::vfx-render.particles.billboard',
    });
  });
});

describe('particle renderer blend defaults', () => {
  it('maps additive billboard output to premultiplied RGB plus additive color blending', () => {
    expect(particleRendererRenderState('billboard', 'additive', undefined)).toEqual({
      cullMode: 'none',
      depthCompare: 'less-equal',
      depthWriteEnabled: false,
      blend: {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
    });
  });

  it('defaults billboard and topology renderers to premultiplied alpha', () => {
    expect(particleRendererRenderState('billboard', undefined, undefined)?.blend).toEqual({
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    });
    expect(particleRendererRenderState('trail', undefined, undefined)?.blend).toEqual({
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    });
  });

  it('keeps opaque-cutout unblended and preserves an authored particle pass state', () => {
    expect(particleRendererRenderState('billboard', 'opaque-cutout', undefined)).toEqual({
      cullMode: 'none',
      depthCompare: 'less-equal',
      depthWriteEnabled: true,
    });
    const authored = { cullMode: 'front' as const, depthWriteEnabled: false };
    const state = particleRendererRenderState('billboard', 'additive', authored);
    expect(state).toStrictEqual(authored);
    // A Worker-cloned copy of the same authored content keeps one state object.
    expect(particleRendererRenderState('billboard', 'additive', structuredClone(authored))).toBe(
      state,
    );
  });
});
