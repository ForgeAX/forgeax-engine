// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=6):
//   - packages/gltf/src/__tests__/bridge-name-instances.test.ts
//   - packages/gltf/src/__tests__/bridge-recursive.test.ts
//   - packages/gltf/src/__tests__/bridge-register-integration.test.ts
//   - packages/gltf/src/__tests__/bridge-snapshot.test.ts
//   - packages/gltf/src/__tests__/bridge-multi-prim.test.ts
//   - packages/gltf/src/__tests__/bridge-recurse-and-transform.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { gltfDocToSceneAsset, toMaterialAsset } from '../bridge.js';
import type { GltfDoc, GltfMaterialIr, GltfMeshIr } from '../parse-gltf.js';
import { unwrapMeshAsset as meshIrToMeshAsset } from './bridge-test-helpers.js';

function fakeMeshHandle(id: number): Handle<'MeshAsset', 'shared'> {
  return id as unknown as Handle<'MeshAsset', 'shared'>;
}

{
  describe('KHR_lights_punctual bridge contract', () => {
    it('projects imported light facts to existing light kinds without a peer component', () => {
      const doc = {
        meshes: [],
        materials: [],
        nodes: [],
        scenes: [{ nodes: [] }],
        textures: undefined,
        images: undefined,
        samplers: undefined,
        skeletons: [],
        animationClips: [],
        defaultSceneIndex: 0,
        diagnostics: {
          nodeNames: [],
          unsupportedExtensions: [],
          matrixTrsCoexistNodes: [],
        },
        extensions: {
          KHR_lights_punctual: {
            lights: [
              { type: 'directional', intensity: 2 },
              { type: 'point', intensity: 3, range: 4 },
              {
                type: 'spot',
                intensity: 5,
                range: 6,
                spot: { innerConeAngle: 0.2, outerConeAngle: 0.6 },
              },
            ],
          },
        },
      } as unknown as GltfDoc;

      const scene = gltfDocToSceneAsset(doc, {
        meshHandles: new Map(),
        materialHandles: new Map(),
      });
      const lights = (scene as unknown as { lights?: readonly Record<string, unknown>[] }).lights;
      expect(lights?.map((light) => light.kind)).toEqual(['directional', 'point', 'spot']);
      expect(lights?.map((light) => light.intensity)).toEqual([2, 3, 5]);
      expect(lights?.[1]?.range).toBe(4);
    });
  });
}

function fakeMaterialHandle(id: number): Handle<'MaterialAsset', 'shared'> {
  return id as unknown as Handle<'MaterialAsset', 'shared'>;
}

const FAKE_TEXTURE_HANDLE = 1 as unknown as Handle<'TextureAsset', 'shared'>;
const FAKE_SAMPLER_HANDLE = 2 as unknown as Handle<'SamplerAsset', 'shared'>;

const STANDARD_MATERIAL: GltfMaterialIr = {
  name: 'TestMat',
  baseColorFactor: [0.8, 0.2, 0.1, 1.0],
  metallicFactor: 0.5,
  roughnessFactor: 0.7,
  baseColorTexture: { texture: 0 },
};

{
  // ─── from bridge-name-instances.test.ts ───

  const baseDoc = (): GltfDoc => ({
    meshes: [
      {
        name: 'MeshFoo',
        positions: new Float32Array([0, 0, 0]),
        indices: new Uint16Array([0]),
        materialIndex: 0,
        meshIndex: 0,
      },
    ],
    materials: [
      {
        name: 'MatFoo',
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 1.0,
        roughnessFactor: 1.0,
      },
    ],
    nodes: [
      {
        name: 'InstancedBox',
        transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        meshIndex: 0,
        skinIndex: null,
        camera: null,
        children: [],
        instancing: { count: 4, transforms: new Float32Array(4 * 16) },
      },
    ],
    scenes: [{ name: 'SceneFoo', nodes: [0] }],
    textures: undefined,
    images: undefined,
    samplers: undefined,
    skeletons: [],
    animationClips: [],
    defaultSceneIndex: 0,
    diagnostics: {
      nodeNames: ['InstancedBox'],
      unsupportedExtensions: [],
      matrixTrsCoexistNodes: [],
    },
  });

  const ctx = {
    meshHandles: new Map([[0, fakeMeshHandle(1)]]),
    materialHandles: new Map([[0, fakeMaterialHandle(7)]]),
  };

  describe('bridge-name-instances.test.ts', () => {
    describe('bridge.ts Name attachment (M4 w11/w12)', () => {
      it('AC-06 attaches Name component when node.name is non-empty', () => {
        const scene = gltfDocToSceneAsset(baseDoc(), ctx);
        const node = scene.entities['node-0'];
        expect(node?.components.Name).toEqual({ value: 'InstancedBox' });
      });

      it('AC-07 omits Name when node.name is undefined', () => {
        const doc: GltfDoc = {
          ...baseDoc(),
          nodes: [{ ...baseDoc().nodes[0], name: undefined } as never],
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        const node = scene.entities['node-0'];
        expect(node?.components.Name).toBeUndefined();
      });

      it('AC-07 omits Name when node.name is empty string', () => {
        const doc: GltfDoc = {
          ...baseDoc(),
          nodes: [{ ...baseDoc().nodes[0], name: '' } as never],
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        const node = scene.entities['node-0'];
        expect(node?.components.Name).toBeUndefined();
      });

      it('AC-08 mesh / material / scene names do NOT route into Name on the node', () => {
        const scene = gltfDocToSceneAsset(baseDoc(), ctx);
        for (const node of Object.values(scene.entities)) {
          const name = node.components.Name;
          if (name !== undefined) {
            expect(name.value).not.toBe('MeshFoo');
            expect(name.value).not.toBe('MatFoo');
            expect(name.value).not.toBe('SceneFoo');
          }
        }
      });
    });

    describe('bridge.ts Instances attachment (M4 w11/w12)', () => {
      it('AC-10 attaches Instances with transforms.length === N*16', () => {
        const scene = gltfDocToSceneAsset(baseDoc(), ctx);
        const node = scene.entities['node-0'];
        expect(node?.components.Instances).toBeDefined();
        const inst = node?.components.Instances;
        if (inst !== undefined) {
          const transforms = inst.transforms as Float32Array;
          expect(transforms.length).toBe(4 * 16);
        }
      });

      it('AC-10 transforms identity is byte-equal to importer composed buffer', () => {
        const seed = new Float32Array(4 * 16);
        for (let i = 0; i < seed.length; i++) seed[i] = i;
        const doc: GltfDoc = {
          ...baseDoc(),
          nodes: [
            {
              ...baseDoc().nodes[0],
              instancing: { count: 4, transforms: seed },
            } as never,
          ],
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        expect(scene.entities['node-0']?.components.Instances).toEqual({ transforms: seed });
      });

      it('AC-11 1 entity carries MeshFilter+MeshRenderer+Instances (no flatten)', () => {
        const scene = gltfDocToSceneAsset(baseDoc(), ctx);
        const candidates = Object.values(scene.entities).filter(
          (n) =>
            n.components.MeshFilter !== undefined &&
            n.components.MeshRenderer !== undefined &&
            n.components.Instances !== undefined,
        );
        expect(candidates.length).toBe(1);
      });

      it('omits Instances when node has no instancing IR', () => {
        const doc: GltfDoc = {
          ...baseDoc(),
          nodes: [{ ...baseDoc().nodes[0], instancing: undefined } as never],
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        expect(scene.entities['node-0']?.components.Instances).toBeUndefined();
      });

      it('preserves authored instancing without a Renderer', () => {
        const scene = gltfDocToSceneAsset(baseDoc(), {
          meshHandles: ctx.meshHandles,
          materialHandles: ctx.materialHandles,
        });
        expect(scene.entities['node-0']?.components.Instances).toEqual({
          transforms: baseDoc().nodes[0]?.instancing?.transforms,
        });
      });
    });
  });
}

{
  // ─── from bridge-recursive.test.ts ───

  function node(
    overrides: Partial<{
      meshIndex: number | null;
      children: number[];
      name: string;
    }> = {},
  ): GltfDoc['nodes'][number] {
    return {
      transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      meshIndex: overrides.meshIndex ?? null,
      skinIndex: null,
      camera: null,
      children: overrides.children ?? [],
      ...(overrides.name !== undefined ? { name: overrides.name } : {}),
    };
  }

  const twoLevelDoc: GltfDoc = {
    meshes: [
      {
        name: 'M0',
        positions: new Float32Array([0, 0, 0]),
        indices: new Uint16Array([0]),
        materialIndex: 0,
        meshIndex: 0,
      },
      {
        name: 'M1',
        positions: new Float32Array([1, 1, 1]),
        indices: new Uint16Array([0]),
        materialIndex: 0,
        meshIndex: 1,
      },
    ],
    materials: [{ baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 }],
    nodes: [
      node({ meshIndex: 0, children: [1], name: 'root' }),
      node({ meshIndex: 1, children: [], name: 'child' }),
    ],
    scenes: [{ name: 'S', nodes: [0] }],
    textures: undefined,
    images: undefined,
    samplers: undefined,
    skeletons: [],
    animationClips: [],
    defaultSceneIndex: 0,
    diagnostics: {
      nodeNames: ['root', 'child'],
      unsupportedExtensions: [],
      matrixTrsCoexistNodes: [],
    },
  };

  const threeLevelDoc: GltfDoc = {
    meshes: [
      {
        name: 'M0',
        positions: new Float32Array([0, 0, 0]),
        indices: new Uint16Array([0]),
        materialIndex: 0,
        meshIndex: 0,
      },
      {
        name: 'M1',
        positions: new Float32Array([1, 1, 1]),
        indices: new Uint16Array([0]),
        materialIndex: 0,
        meshIndex: 1,
      },
      {
        name: 'M2',
        positions: new Float32Array([2, 2, 2]),
        indices: new Uint16Array([0]),
        materialIndex: 0,
        meshIndex: 2,
      },
    ],
    materials: [{ baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 }],
    nodes: [
      node({ meshIndex: 0, children: [1], name: 'root' }),
      node({ meshIndex: 1, children: [2], name: 'middle' }),
      node({ meshIndex: 2, children: [], name: 'grandchild' }),
    ],
    scenes: [{ name: 'S', nodes: [0] }],
    textures: undefined,
    images: undefined,
    samplers: undefined,
    skeletons: [],
    animationClips: [],
    defaultSceneIndex: 0,
    diagnostics: {
      nodeNames: ['root', 'middle', 'grandchild'],
      unsupportedExtensions: [],
      matrixTrsCoexistNodes: [],
    },
  };

  describe('bridge-recursive.test.ts', () => {
    describe('gltfDocToSceneAsset DFS recursion (w24)', () => {
      it('visits child nodes (two-level hierarchy)', () => {
        const ctx = {
          meshHandles: new Map([
            [0, fakeMeshHandle(10)],
            [1, fakeMeshHandle(11)],
          ]),
          materialHandles: new Map([[0, fakeMaterialHandle(20)]]),
        };
        const scene: SceneAsset = gltfDocToSceneAsset(twoLevelDoc, ctx);
        expect(Object.keys(scene.entities).length).toBe(2);
        expect(scene.entities['node-0']?.components.MeshFilter?.assetHandle).toBe(10);
        expect(scene.entities['node-1']?.components.MeshFilter?.assetHandle).toBe(11);
        expect(scene.entities['node-0']).toBeDefined();
        expect(scene.entities['node-1']).toBeDefined();
      });

      it('visits full three-level hierarchy in DFS order', () => {
        const ctx = {
          meshHandles: new Map([
            [0, fakeMeshHandle(10)],
            [1, fakeMeshHandle(11)],
            [2, fakeMeshHandle(12)],
          ]),
          materialHandles: new Map([[0, fakeMaterialHandle(20)]]),
        };
        const scene: SceneAsset = gltfDocToSceneAsset(threeLevelDoc, ctx);
        expect(Object.keys(scene.entities).length).toBe(3);
        expect(scene.entities['node-0']).toBeDefined();
        expect(scene.entities['node-1']).toBeDefined();
        expect(scene.entities['node-2']).toBeDefined();
      });

      it('includes child entities with Name components from node.name', () => {
        const ctx = {
          meshHandles: new Map([
            [0, fakeMeshHandle(10)],
            [1, fakeMeshHandle(11)],
          ]),
          materialHandles: new Map([[0, fakeMaterialHandle(20)]]),
        };
        const scene: SceneAsset = gltfDocToSceneAsset(twoLevelDoc, ctx);
        expect(scene.entities['node-0']?.components.Name?.value).toBe('root');
        expect(scene.entities['node-1']?.components.Name?.value).toBe('child');
      });
    });
  });
}

{
  // ─── from bridge-register-integration.test.ts ───

  describe('bridge-register-integration.test.ts', () => {
    describe('toMaterialAsset -> registerMaterialAsset integration (pass-based)', () => {
      it('PBR material with full ctx produces pass-based MaterialAsset', () => {
        const textureHandles = new Map([[0, FAKE_TEXTURE_HANDLE]]);
        const samplerHandles = new Map([[0, FAKE_SAMPLER_HANDLE]]);

        const asset = toMaterialAsset(STANDARD_MATERIAL, {
          textureHandles,
          samplerHandles,
        });

        expect(asset.kind).toBe('material');
        expect(asset.passes).toBeDefined();
        expect(asset.passes?.[0]?.program.module).toBe('forgeax::default-standard-pbr');
        expect(asset.passes?.[0]?.name).toBe('Forward');
        expect(asset.values?.baseColorTexture).toMatchObject({ texture: FAKE_TEXTURE_HANDLE });
        expect(asset.values?.metallic).toBe(0.5);
        expect(asset.values?.roughness).toBe(0.7);
      });

      it('maps glTF emissiveFactor and emissiveTexture', () => {
        const mat: GltfMaterialIr = {
          name: 'EmissiveMat',
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 0.5,
          emissiveFactor: [0.8, 0.4, 0.1],
          emissiveTexture: { texture: 1 },
        };
        const asset = toMaterialAsset(mat, {
          textureHandles: new Map([[1, FAKE_TEXTURE_HANDLE]]),
        });

        expect(asset.values?.emissive).toEqual([0.8, 0.4, 0.1]);
        expect(asset.values?.emissiveIntensity).toBe(1);
        expect(asset.values?.emissiveTexture).toMatchObject({ texture: FAKE_TEXTURE_HANDLE });
      });

      it('standard material without textures omits texture values', () => {
        const { baseColorTexture: _, ...rest } = STANDARD_MATERIAL;
        const mat: GltfMaterialIr = rest;
        const samplerHandles = new Map([[0, FAKE_SAMPLER_HANDLE]]);

        const asset = toMaterialAsset(mat, {
          textureHandles: new Map(),
          samplerHandles,
        });

        expect(asset.values?.baseColorTexture).toBeUndefined();
        expect(asset.values?.sampler).toBeUndefined();
      });

      it('PBR material exposes a standard-root program and values', () => {
        const asset = toMaterialAsset(STANDARD_MATERIAL, {
          textureHandles: new Map(),
          samplerHandles: new Map([[0, FAKE_SAMPLER_HANDLE]]),
        });
        expect(asset.passes?.[0]?.program.module).toBe('forgeax::default-standard-pbr');
        expect(asset.values?.baseColor).toEqual([0.8, 0.2, 0.1, 1]);
      });

      it('PBR material preserves RGBA baseColor, including blend opacity', () => {
        const samplerHandles = new Map([[0, FAKE_SAMPLER_HANDLE]]);
        const asset = toMaterialAsset(STANDARD_MATERIAL, {
          textureHandles: new Map(),
          samplerHandles,
        });

        const baseColor = asset.values?.baseColor as number[];
        expect(baseColor).toHaveLength(4);
        expect(baseColor).toEqual([0.8, 0.2, 0.1, 1]);
      });

      it('BLEND material preserves baseColor alpha for the standard-PBR UBO overlay', () => {
        const mat: GltfMaterialIr = {
          ...STANDARD_MATERIAL,
          baseColorFactor: [0.041667, 0.041667, 0.041667, 0.5],
          alphaMode: 'BLEND',
        };
        const asset = toMaterialAsset(mat, {
          textureHandles: new Map(),
          samplerHandles: new Map(),
        });

        expect(asset.values?.baseColor).toEqual([0.041667, 0.041667, 0.041667, 0.5]);
      });

      it('omits coordinates when texCoord is absent', () => {
        const asset = toMaterialAsset(STANDARD_MATERIAL, {
          textureHandles: new Map(),
          samplerHandles: new Map(),
        });
        expect(asset.values?.baseColorTexture).toBeUndefined();
      });

      it('keeps texCoord on the individual texture slot', () => {
        const mat: GltfMaterialIr = {
          ...STANDARD_MATERIAL,
          baseColorTexture: { texture: 0, texCoord: 0 },
        };
        const asset = toMaterialAsset(mat, {
          textureHandles: new Map([[0, FAKE_TEXTURE_HANDLE]]),
          samplerHandles: new Map(),
        });
        expect(asset.values?.baseColorTexture).toMatchObject({ coordinates: { set: 0 } });
      });

      it('keeps a nonzero texCoord on the individual texture slot', () => {
        const mat: GltfMaterialIr = {
          ...STANDARD_MATERIAL,
          baseColorTexture: { texture: 0, texCoord: 1 },
        };
        const asset = toMaterialAsset(mat, {
          textureHandles: new Map([[0, FAKE_TEXTURE_HANDLE]]),
          samplerHandles: new Map(),
        });
        expect(asset.values?.baseColorTexture).toMatchObject({ coordinates: { set: 1 } });
      });

      it('OPAQUE material has no renderState.blend', () => {
        const asset = toMaterialAsset(STANDARD_MATERIAL, {
          textureHandles: new Map(),
          samplerHandles: new Map(),
        });
        const pass = asset.passes?.[0];
        expect(pass?.renderState?.blend).toBeUndefined();
      });

      it('BLEND material sets renderState.blend and depthWriteEnabled=false', () => {
        const mat: GltfMaterialIr = { ...STANDARD_MATERIAL, alphaMode: 'BLEND' };
        const asset = toMaterialAsset(mat, {
          textureHandles: new Map(),
          samplerHandles: new Map(),
        });
        const pass = asset.passes?.[0];
        expect(pass?.renderState?.blend).toBeDefined();
        expect(pass?.renderState?.depthWriteEnabled).toBe(false);
      });

      it('double-sided material disables face culling without changing its queue', () => {
        const mat: GltfMaterialIr = { ...STANDARD_MATERIAL, doubleSided: true };
        const asset = toMaterialAsset(mat, {
          textureHandles: new Map(),
          samplerHandles: new Map(),
        });
        const pass = asset.passes?.[0];
        expect(pass?.renderState?.queue).toBe(2000);
        expect(pass?.renderState?.cullMode).toBe('none');
        expect(pass?.renderState?.blend).toBeUndefined();
      });

      it('double-sided BLEND material keeps both blend and no-cull state', () => {
        const mat: GltfMaterialIr = {
          ...STANDARD_MATERIAL,
          alphaMode: 'BLEND',
          doubleSided: true,
        };
        const asset = toMaterialAsset(mat, {
          textureHandles: new Map(),
          samplerHandles: new Map(),
        });
        const pass = asset.passes?.[0];
        expect(pass?.renderState?.blend).toBeDefined();
        expect(pass?.renderState?.depthWriteEnabled).toBe(false);
        expect(pass?.renderState?.cullMode).toBe('none');
      });
    });
  });
}

{
  // ─── from bridge-snapshot.test.ts ───

  const helloGltfDoc: GltfDoc = {
    meshes: [
      {
        name: 'Box',
        positions: new Float32Array([0, 0, 0]),
        indices: new Uint16Array([0]),
        materialIndex: 0,
        meshIndex: 0,
      },
    ],
    materials: [
      {
        name: 'BoxMaterial',
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 1.0,
        roughnessFactor: 1.0,
      },
    ],
    nodes: [
      {
        name: 'BoxNode',
        transform: {
          translation: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        meshIndex: 0,
        skinIndex: null,
        camera: null,
        children: [],
      },
      {
        name: 'CameraNode',
        transform: {
          translation: [0, 0, 3],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        meshIndex: null,
        skinIndex: null,
        camera: {
          projection: 0,
          autoAspect: false,
          fov: Math.PI / 4,
          aspect: 16 / 9,
          near: 0.1,
          far: 100,
        },
        children: [],
      },
    ],
    scenes: [{ name: 'Scene', nodes: [0, 1] }],
    textures: undefined,
    images: undefined,
    samplers: undefined,
    skeletons: [],
    animationClips: [],
    defaultSceneIndex: 0,
    diagnostics: {
      nodeNames: ['BoxNode', 'CameraNode'],
      unsupportedExtensions: [],
      matrixTrsCoexistNodes: [],
    },
  };

  describe('bridge-snapshot.test.ts', () => {
    describe('gltfDocToSceneAsset (M3 w8/w9)', () => {
      it('matches the legacy hello-gltf inline-impl POD output', () => {
        const ctx = {
          meshHandles: new Map([[0, fakeMeshHandle(1)]]),
          materialHandles: new Map([[0, fakeMaterialHandle(7)]]),
        };
        const scene: SceneAsset = gltfDocToSceneAsset(helloGltfDoc, ctx);
        expect(scene.kind).toBe('scene');
        expect(Object.keys(scene.entities).length).toBeGreaterThanOrEqual(1);
        const meshNode = scene.entities['node-0'];
        expect(meshNode?.components.MeshFilter?.assetHandle).toBe(1);
        const renderer = meshNode?.components.MeshRenderer;
        expect(renderer).toBeDefined();
        if (renderer !== undefined) {
          const materials = renderer.materials as unknown[];
          expect(Array.isArray(materials)).toBe(true);
          expect(materials).toEqual([]);
        }
        expect(meshNode?.components.Transform).toBeDefined();
      });

      it('attaches Camera component when a node references a camera (via GltfNodeIr.camera)', () => {
        const ctx = {
          meshHandles: new Map([[0, fakeMeshHandle(1)]]),
          materialHandles: new Map([[0, fakeMaterialHandle(7)]]),
        };
        const scene = gltfDocToSceneAsset(helloGltfDoc, ctx);
        const cameraNode = Object.values(scene.entities).find(
          (n) => n.components.Camera !== undefined,
        );
        expect(cameraNode).toBeDefined();
      });
    });
  });
}

{
  // ─── from bridge-multi-prim.test.ts ───

  describe('bridge-multi-prim.test.ts', () => {
    describe('bridge.ts B1 multi-primitive merge (M3 w14)', () => {
      it('2-prim glTF mesh produces 1 entity (meshHandles keyed by glTF mesh index)', () => {
        const mesh0Prim0: GltfMeshIr = {
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          indices: new Uint16Array([0, 1, 2]),
          materialIndex: 0,
          meshIndex: 0,
        };
        const mesh0Prim1: GltfMeshIr = {
          positions: new Float32Array([0, 0, 0, -1, 0, 0, 0, -1, 0]),
          indices: new Uint16Array([0, 1, 2]),
          materialIndex: 1,
          meshIndex: 0,
        };
        const doc: GltfDoc = {
          meshes: [mesh0Prim0, mesh0Prim1],
          materials: [
            { baseColorFactor: [1, 0, 0, 1], metallicFactor: 1, roughnessFactor: 1 },
            { baseColorFactor: [0, 0, 1, 1], metallicFactor: 1, roughnessFactor: 1 },
          ],
          nodes: [
            {
              name: 'MeshNode',
              transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [],
            },
          ],
          scenes: [{ name: 'Scene', nodes: [0] }],
          textures: undefined,
          images: undefined,
          samplers: undefined,
          skeletons: [],
          animationClips: [],
          defaultSceneIndex: 0,
          diagnostics: {
            nodeNames: ['MeshNode'],
            unsupportedExtensions: [],
            matrixTrsCoexistNodes: [],
          },
        };
        const ctx = {
          meshHandles: new Map([[0, fakeMeshHandle(10)]]),
          materialHandles: new Map([
            [0, fakeMaterialHandle(20)],
            [1, fakeMaterialHandle(21)],
          ]),
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        expect(Object.keys(scene.entities).length).toBe(1);

        const entityNode = scene.entities['node-0'];
        expect(entityNode).toBeDefined();
        expect(entityNode?.components.MeshFilter?.assetHandle).toBe(10);
        expect(entityNode?.components.MeshRenderer).toBeDefined();
      });

      it('single-prim glTF produces 1 entity with 1 material (backward compatible)', () => {
        const doc: GltfDoc = {
          meshes: [
            {
              name: 'Box',
              positions: new Float32Array([0, 0, 0]),
              indices: new Uint16Array([0]),
              materialIndex: 0,
              meshIndex: 0,
            },
          ],
          materials: [{ baseColorFactor: [1, 0, 0, 1], metallicFactor: 1, roughnessFactor: 1 }],
          nodes: [
            {
              name: 'BoxNode',
              transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [],
            },
          ],
          scenes: [{ name: 'Scene', nodes: [0] }],
          textures: undefined,
          images: undefined,
          samplers: undefined,
          skeletons: [],
          animationClips: [],
          defaultSceneIndex: 0,
          diagnostics: {
            nodeNames: ['BoxNode'],
            unsupportedExtensions: [],
            matrixTrsCoexistNodes: [],
          },
        };
        const ctx = {
          meshHandles: new Map([[0, fakeMeshHandle(1)]]),
          materialHandles: new Map([[0, fakeMaterialHandle(7)]]),
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        expect(Object.keys(scene.entities).length).toBe(1);
        const node = scene.entities['node-0'];
        expect(node?.components.MeshFilter?.assetHandle).toBe(1);
        expect(node?.components.MeshRenderer).toBeDefined();
      });

      it('transform-only node (no mesh, no camera) produces entity with Transform only', () => {
        const doc: GltfDoc = {
          meshes: [
            {
              positions: new Float32Array([0, 0, 0]),
              indices: new Uint16Array([0]),
              materialIndex: 0,
              meshIndex: 0,
            },
          ],
          materials: [{ baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 }],
          nodes: [
            {
              name: 'TransformNode',
              transform: { translation: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [2, 2, 2] },
              meshIndex: null,
              skinIndex: null,
              camera: null,
              children: [],
            },
          ],
          scenes: [{ name: 'Scene', nodes: [0] }],
          textures: undefined,
          images: undefined,
          samplers: undefined,
          skeletons: [],
          animationClips: [],
          defaultSceneIndex: 0,
          diagnostics: {
            nodeNames: ['TransformNode'],
            unsupportedExtensions: [],
            matrixTrsCoexistNodes: [],
          },
        };
        const ctx = {
          meshHandles: new Map(),
          materialHandles: new Map(),
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        expect(Object.keys(scene.entities).length).toBe(1);
        const node = scene.entities['node-0'];
        expect(node?.components.Transform).toBeDefined();
        expect(node?.components.MeshFilter).toBeUndefined();
        expect(node?.components.MeshRenderer).toBeUndefined();
      });

      it('multi glTF-mesh document: each node materials filtered by node.meshIndex (verify-r1 charter-defect fix)', () => {
        const m0p0: GltfMeshIr = {
          positions: new Float32Array([0, 0, 0]),
          indices: new Uint16Array([0]),
          materialIndex: 0,
          meshIndex: 0,
        };
        const m0p1: GltfMeshIr = {
          positions: new Float32Array([0, 0, 0]),
          indices: new Uint16Array([0]),
          materialIndex: 1,
          meshIndex: 0,
        };
        const m1p0: GltfMeshIr = {
          positions: new Float32Array([0, 0, 0]),
          indices: new Uint16Array([0]),
          materialIndex: 2,
          meshIndex: 1,
        };
        const doc: GltfDoc = {
          meshes: [m0p0, m0p1, m1p0],
          materials: [
            { baseColorFactor: [1, 0, 0, 1], metallicFactor: 1, roughnessFactor: 1 },
            { baseColorFactor: [0, 1, 0, 1], metallicFactor: 1, roughnessFactor: 1 },
            { baseColorFactor: [0, 0, 1, 1], metallicFactor: 1, roughnessFactor: 1 },
          ],
          nodes: [
            {
              name: 'NodeA',
              transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [],
            },
            {
              name: 'NodeB',
              transform: { translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 1,
              skinIndex: null,
              camera: null,
              children: [],
            },
          ],
          scenes: [{ name: 'Scene', nodes: [0, 1] }],
          textures: undefined,
          images: undefined,
          samplers: undefined,
          skeletons: [],
          animationClips: [],
          defaultSceneIndex: 0,
          diagnostics: {
            nodeNames: ['NodeA', 'NodeB'],
            unsupportedExtensions: [],
            matrixTrsCoexistNodes: [],
          },
        };
        const ctx = {
          meshHandles: new Map([
            [0, fakeMeshHandle(10)],
            [1, fakeMeshHandle(11)],
          ]),
          materialHandles: new Map([
            [0, fakeMaterialHandle(20)],
            [1, fakeMaterialHandle(21)],
            [2, fakeMaterialHandle(22)],
          ]),
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        expect(Object.keys(scene.entities).length).toBe(2);
        const nodeA = Object.values(scene.entities).find(
          (n) => n.components.Name?.value === 'NodeA',
        );
        const nodeB = Object.values(scene.entities).find(
          (n) => n.components.Name?.value === 'NodeB',
        );
        expect(nodeA?.components.MeshRenderer?.materials).toEqual([]);
        expect(nodeB?.components.MeshRenderer?.materials).toEqual([]);
      });
    });
  });
}

{
  // ─── from bridge-recurse-and-transform.test.ts ───

  describe('bridge-recurse-and-transform.test.ts', () => {
    describe('bridge.ts B2 child recursion (M3 w14)', () => {
      it('3-level hierarchy (root->child->grandchild) produces 3 entities with ChildOf links', () => {
        const doc: GltfDoc = {
          meshes: [
            {
              positions: new Float32Array([0, 0, 0]),
              indices: new Uint16Array([0]),
              materialIndex: 0,
              meshIndex: 0,
            },
          ],
          materials: [{ baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 }],
          nodes: [
            {
              name: 'Root',
              transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [1],
            },
            {
              name: 'Child',
              transform: { translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: null,
              skinIndex: null,
              camera: null,
              children: [2],
            },
            {
              name: 'Grandchild',
              transform: { translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [],
            },
          ],
          scenes: [{ name: 'Scene', nodes: [0] }],
          textures: undefined,
          images: undefined,
          samplers: undefined,
          skeletons: [],
          animationClips: [],
          defaultSceneIndex: 0,
          diagnostics: {
            nodeNames: ['Root', 'Child', 'Grandchild'],
            unsupportedExtensions: [],
            matrixTrsCoexistNodes: [],
          },
        };
        const ctx = {
          meshHandles: new Map([[0, fakeMeshHandle(1)]]),
          materialHandles: new Map([[0, fakeMaterialHandle(7)]]),
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        expect(Object.keys(scene.entities).length).toBe(3);

        const rootNode = Object.values(scene.entities).find(
          (n) => n.components.Name?.value === 'Root',
        );
        const childNode = Object.values(scene.entities).find(
          (n) => n.components.Name?.value === 'Child',
        );
        const grandchildNode = Object.values(scene.entities).find(
          (n) => n.components.Name?.value === 'Grandchild',
        );
        expect(rootNode).toBeDefined();
        expect(childNode).toBeDefined();
        expect(grandchildNode).toBeDefined();

        expect(rootNode?.components.MeshFilter).toBeDefined();
        expect(childNode?.components.MeshFilter).toBeUndefined();
        expect(grandchildNode?.components.MeshFilter).toBeDefined();

        expect(childNode?.components.ChildOf?.parent).toBe('node-0');
        expect(grandchildNode?.components.ChildOf?.parent).toBe('node-1');
      });
    });

    describe('bridge.ts B3 transform accumulation (M3 w14)', () => {
      // bug-20260613: bridge writes LOCAL TRS into Transform; ChildOf is also
      // emitted, so propagateTransforms is the single accumulation path.
      // Writing world TRS here would double-bake every child node.
      it('child Transform mirrors local TRS (propagateTransforms accumulates world)', () => {
        const doc: GltfDoc = {
          meshes: [
            {
              positions: new Float32Array([0, 0, 0]),
              indices: new Uint16Array([0]),
              materialIndex: 0,
              meshIndex: 0,
            },
          ],
          materials: [{ baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 }],
          nodes: [
            {
              name: 'Parent',
              transform: { translation: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [1],
            },
            {
              name: 'Child',
              transform: { translation: [2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [],
            },
          ],
          scenes: [{ name: 'Scene', nodes: [0] }],
          textures: undefined,
          images: undefined,
          samplers: undefined,
          skeletons: [],
          animationClips: [],
          defaultSceneIndex: 0,
          diagnostics: {
            nodeNames: ['Parent', 'Child'],
            unsupportedExtensions: [],
            matrixTrsCoexistNodes: [],
          },
        };
        const ctx = {
          meshHandles: new Map([[0, fakeMeshHandle(1)]]),
          materialHandles: new Map([[0, fakeMaterialHandle(7)]]),
        };
        const scene = gltfDocToSceneAsset(doc, ctx);
        expect(Object.keys(scene.entities).length).toBe(2);

        const childNode = Object.values(scene.entities).find(
          (n) => n.components.Name?.value === 'Child',
        );
        expect(childNode?.components.Transform).toBeDefined();
        const t = childNode?.components.Transform;
        // Local TRS: child node carries its own [2, 0, 0]; parent's [5, 0, 0]
        // is encoded via ChildOf -> parent's Transform, accumulated by
        // propagateTransforms downstream.
        expect(t?.pos).toEqual([2, 0, 0]);
        expect(childNode?.components.ChildOf?.parent).toBeDefined();
      });
    });

    describe('bridge.ts B6 camera detection (M3 w14)', () => {
      it('glTF node with camera index produces entity with Camera component', () => {
        const doc = {
          meshes: [
            {
              positions: new Float32Array([0, 0, 0]),
              indices: new Uint16Array([0]),
              materialIndex: 0,
              meshIndex: 0,
            },
          ],
          materials: [{ baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 }],
          nodes: [
            {
              name: 'BoxNode',
              transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: 0,
              skinIndex: null,
              camera: null,
              children: [],
            },
            {
              name: 'CameraNode',
              transform: { translation: [0, 0, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              meshIndex: null,
              skinIndex: null,
              children: [],
              camera: {
                projection: 0,
                autoAspect: false,
                fov: Math.PI / 4,
                aspect: 16 / 9,
                near: 0.1,
                far: 100,
              },
            },
          ],
          scenes: [{ name: 'Scene', nodes: [0, 1] }],
          textures: undefined,
          images: undefined,
          samplers: undefined,
          skeletons: [],
          animationClips: [],
          defaultSceneIndex: 0,
          diagnostics: {
            nodeNames: ['BoxNode', 'CameraNode'],
            unsupportedExtensions: [],
            matrixTrsCoexistNodes: [],
          },
        };
        const ctx = {
          meshHandles: new Map([[0, fakeMeshHandle(1)]]),
          materialHandles: new Map([[0, fakeMaterialHandle(7)]]),
        };
        const scene = gltfDocToSceneAsset(doc as unknown as GltfDoc, ctx);

        const cameraNode = Object.values(scene.entities).find(
          (n) => n.components.Name?.value === 'CameraNode',
        );
        expect(cameraNode).toBeDefined();
        expect(cameraNode?.components.Camera).toBeDefined();
        expect(cameraNode?.components.Camera?.fov).toBe(0.7853981633974483);

        const boxNode = Object.values(scene.entities).find(
          (n) => n.components.Name?.value === 'BoxNode',
        );
        expect(boxNode?.components.Camera).toBeUndefined();
      });
    });
  });
}

{
  // ─── from bridge-mesh-aabb.test.ts (RED) ───
  //
  // TDD fail-first for bug-20260706-import-path-meshasset-aabb-undefined-blocks-pick M3.
  // M4 (gltf producer emit aabb) will turn these assertions green.
  //
  // Assertions assume M4 will compute aabb via box3.fromPositions on the
  // concatenated positionsCat, which merges all primitives' positions in
  // vertex-buffer order.

  describe('bridge-mesh-aabb.test.ts (RED)', () => {
    describe('meshIrToMeshAsset aabb (TDD fail-first, M4 turns green)', () => {
      it('single primitive: aabb equals position component min/max', () => {
        const prim: GltfMeshIr = {
          positions: new Float32Array([1, 2, 3, 4, 5, 6, -1, -2, -3]),
          indices: new Uint16Array([0, 1, 2]),
          materialIndex: 0,
          meshIndex: 0,
        };
        const asset = meshIrToMeshAsset([prim]);
        expect(asset.aabb).toBeInstanceOf(Float32Array);
        expect(asset.aabb).toHaveLength(6);
        // min=(-1,-2,-3)  max=(4,5,6)
        expect(asset.aabb?.[0]).toBe(-1);
        expect(asset.aabb?.[1]).toBe(-2);
        expect(asset.aabb?.[2]).toBe(-3);
        expect(asset.aabb?.[3]).toBe(4);
        expect(asset.aabb?.[4]).toBe(5);
        expect(asset.aabb?.[5]).toBe(6);
      });

      it('multi-primitive: merged AABB with offset prims so merged != any single box', () => {
        // Prim 0: box near origin, min=(0,0,-2), max=(3,3,0)
        const prim0: GltfMeshIr = {
          positions: new Float32Array([0, 0, -2, 3, 0, -2, 0, 3, 0]),
          indices: new Uint16Array([0, 1, 2]),
          materialIndex: 0,
          meshIndex: 0,
        };
        // Prim 1: box offset far away, min=(10,-1,10), max=(12,2,15)
        const prim1: GltfMeshIr = {
          positions: new Float32Array([10, -1, 10, 12, -1, 10, 10, 2, 15]),
          indices: new Uint16Array([0, 1, 2]),
          materialIndex: 1,
          meshIndex: 0,
        };
        const asset = meshIrToMeshAsset([prim0, prim1]);
        expect(asset.aabb).toBeInstanceOf(Float32Array);
        expect(asset.aabb).toHaveLength(6);
        // Merged: min=(0,-1,-2), max=(12,3,15)
        // Neither prim alone covers x=0..12 or y=-1..3 or z=-2..15.
        expect(asset.aabb?.[0]).toBe(0);
        expect(asset.aabb?.[1]).toBe(-1);
        expect(asset.aabb?.[2]).toBe(-2);
        expect(asset.aabb?.[3]).toBe(12);
        expect(asset.aabb?.[4]).toBe(3);
        expect(asset.aabb?.[5]).toBe(15);
      });

      it('skinned input (18-float stride): aabb computed from position attribute only', () => {
        const prim: GltfMeshIr = {
          positions: new Float32Array([5, 1, 8, 2, 9, 4, 7, 3, 0]),
          indices: new Uint16Array([0, 1, 2]),
          joints0: new Uint16Array([0, 1, 2, 3, 0, 0, 0, 0, 1, 0, 0, 0]),
          weights0: new Float32Array([1, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 1, 0, 0]),
          materialIndex: 0,
          meshIndex: 0,
        };
        const asset = meshIrToMeshAsset([prim]);
        expect(asset.aabb).toBeInstanceOf(Float32Array);
        expect(asset.aabb).toHaveLength(6);
        // min=(2,1,0)  max=(7,9,8) — from positions, ignoring skin/joint data
        expect(asset.aabb?.[0]).toBe(2);
        expect(asset.aabb?.[1]).toBe(1);
        expect(asset.aabb?.[2]).toBe(0);
        expect(asset.aabb?.[3]).toBe(7);
        expect(asset.aabb?.[4]).toBe(9);
        expect(asset.aabb?.[5]).toBe(8);
      });

      it('empty input (0 vertices): inverted-empty box', () => {
        const prim: GltfMeshIr = {
          positions: new Float32Array(0),
          materialIndex: 0,
          meshIndex: 0,
        };
        const asset = meshIrToMeshAsset([prim]);
        expect(asset.aabb).toBeInstanceOf(Float32Array);
        expect(asset.aabb).toHaveLength(6);
        // Inverted-empty: min=(+Inf,+Inf,+Inf), max=(-Inf,-Inf,-Inf)
        expect(asset.aabb?.[0]).toBe(Number.POSITIVE_INFINITY);
        expect(asset.aabb?.[1]).toBe(Number.POSITIVE_INFINITY);
        expect(asset.aabb?.[2]).toBe(Number.POSITIVE_INFINITY);
        expect(asset.aabb?.[3]).toBe(Number.NEGATIVE_INFINITY);
        expect(asset.aabb?.[4]).toBe(Number.NEGATIVE_INFINITY);
        expect(asset.aabb?.[5]).toBe(Number.NEGATIVE_INFINITY);
      });
    });
  });
}

describe('meshIrToMeshAsset material slots', () => {
  it('deduplicates source materials into stable A/default/A slots', () => {
    const primitive = (materialIndex: number | null): GltfMeshIr => ({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint16Array([0, 1, 2]),
      materialIndex,
      meshIndex: 0,
    });
    const guid = '019d0000-0000-7000-8000-000000000004';
    const asset = meshIrToMeshAsset([primitive(0), primitive(null), primitive(0)], {
      guidByIndex: new Map([[0, guid]]),
      nameByIndex: new Map([[0, 'Paint']]),
    });

    expect(asset.submeshes.map((submesh) => submesh.materialSlot)).toEqual([0, 1, 0]);
    expect(asset.materialSlots.map((slot) => slot.slotName)).toEqual(['Paint', 'Default']);
    expect(asset.materialSlots.map((slot) => slot.sourceKey)).toEqual([
      'gltf:material:0',
      'gltf:default',
    ]);
    expect(asset.materialSlots[0]?.defaultMaterial).toBeInstanceOf(Uint8Array);
    expect(asset.materialSlots[1]?.defaultMaterial).toBeUndefined();
  });

  it('projects importer COLOR_0 into the canonical color attribute', () => {
    const primitive = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint16Array([0, 1, 2]),
      colors0: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]),
      materialIndex: 0,
      meshIndex: 0,
    } as GltfMeshIr & { readonly colors0: Float32Array };
    const asset = meshIrToMeshAsset([primitive]);
    expect(asset.attributes.color).toEqual(primitive.colors0);
  });
});
