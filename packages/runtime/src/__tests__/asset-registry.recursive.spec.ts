// asset-registry.recursive.spec — M1/SceneAsset recursive loadByGuid (TDD red
// phase for AC-01 / AC-06 / AC-07 / AC-08). The test file compiles and the
// "red" stage is intentional (type=test task).
//
// Coverage:
//   AC-01 — scene + N material + 1 mesh: recursive loadByGuid<SceneAsset>
//           registers all transitive sub-assets
//   AC-06 — idempotency: second loadByGuid(g) returns same handle, zero fetch
//   AC-07 — transitive failure: missing sub-asset → err with breadcrumb hint
//   AC-08 — in-flight dedup + cycle: concurrent Promise.all 3-way dedup;
//           cycle A→B→A no stack overflow

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type Component, defineComponent } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type {
  AssetError,
  LocalEntityId,
  MaterialAsset,
  SceneAsset,
  MeshAsset as TypesMeshAsset,
} from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

// ── test GUIDs ──────────────────────────────────────────────────────────────
const SCENE_GUID = 'a0000000-0000-4000-a000-000000000001';
const MATERIAL_A_GUID = 'a0000000-0000-4000-a000-000000000002';
const MATERIAL_B_GUID = 'a0000000-0000-4000-a000-000000000003';
const MESH_GUID = 'a0000000-0000-4000-a000-000000000004';
const MISSING_SUB_GUID = 'a0000000-0000-4000-a000-000000009999';
const CYCLE_A_GUID = 'b0000000-0000-4000-b000-000000000001';
const CYCLE_B_GUID = 'b0000000-0000-4000-b000-000000000002';
const WRONG_DEFAULT_KIND_GUID = 'a0000000-0000-4000-a000-000000000005';

// ECS component reflection is World/owner-local after the ECS architecture
// update. The recursive prod-path breadcrumb still needs the scene schema, so
// inject the test vocabulary into AssetRegistry explicitly.
const BreadcrumbTransform = defineComponent('Transform', { pos: 'array<f32, 3>' });
const BreadcrumbMeshFilter = defineComponent('MeshFilter', {
  assetHandle: 'shared<MeshAsset>',
});
const BreadcrumbMeshRenderer = defineComponent('MeshRenderer', {
  materials: 'array<shared<MaterialAsset>>',
});

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

function _localId(n: number): LocalEntityId {
  return n as LocalEntityId;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function makeMesh(): TypesMeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array([
      -0.5, 0, 0.5, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0.5, 0, 0.5, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0.5, 0, -0.5,
      0, 1, 0, 1, 1, 1, 0, 0, 1,
    ]),
    indices: new Uint16Array([0, 1, 2]),
    attributes: {},
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],

    materialSlots: [{ slotName: 'Default' }],
  };
}

function makeMaterialAsset(): MaterialAsset {
  return {
    kind: 'material',
    passes: [
      {
        name: 'forward',
        program: { module: 'test::dummy' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
    values: {},
  };
}

function makeTestSceneAsset(subRefs: { meshGuid: string; materialGuids: string[] }): SceneAsset {
  return {
    kind: 'scene',
    entities: {
      'entity-0': {
        components: {
          Transform: { pos: [0, 0, 0] },
          MeshFilter: { assetHandle: subRefs.meshGuid },
          MeshRenderer: { materials: subRefs.materialGuids },
        },
      },
    },
  };
}

// ── registry setup ──────────────────────────────────────────────────────────

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(
    makeMockShaderRegistry(),
    undefined,
    undefined,
    undefined,
    undefined,
    new Map<string, Component>([
      [BreadcrumbTransform.name, BreadcrumbTransform],
      [BreadcrumbMeshFilter.name, BreadcrumbMeshFilter],
      [BreadcrumbMeshRenderer.name, BreadcrumbMeshRenderer],
    ]),
  );
}

function preregisterMesh(reg: AssetRegistry): void {
  reg.catalog(parseGuid(MESH_GUID), makeMesh());
}

function preregisterMaterial(reg: AssetRegistry, guidStr: string): void {
  reg.catalog(parseGuid(guidStr), makeMaterialAsset());
}

// ── AC-01: scene + N material + 1 mesh recursive resolution ────────────────

describe('AC-01 — scene recursive loadByGuid', () => {
  it('loadByGuid<SceneAsset> in dev mode returns ok when sub-assets pre-registered', async () => {
    defineComponent('Transform', { pos: 'array<f32, 3>' });
    defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' });
    defineComponent('MeshRenderer', { materials: 'array<shared<MaterialAsset>>' });

    const reg = makeRegistry();
    preregisterMesh(reg);
    preregisterMaterial(reg, MATERIAL_A_GUID);
    preregisterMaterial(reg, MATERIAL_B_GUID);

    const scene = makeTestSceneAsset({
      meshGuid: MESH_GUID,
      materialGuids: [MATERIAL_A_GUID, MATERIAL_B_GUID],
    });
    reg.catalog(parseGuid(SCENE_GUID), scene);

    const result = await reg.loadByGuid<SceneAsset>(parseGuid(SCENE_GUID));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('scene');
    }
  });
});

// ── AC-06: idempotency ─────────────────────────────────────────────────────

describe('AC-06 — idempotency', () => {
  it('two sequential loadByGuid(g) return the same payload in dev mode', async () => {
    const reg = makeRegistry();
    const meshGuid = parseGuid(MESH_GUID);
    const mesh = makeMesh();
    const cat1 = reg.catalog(meshGuid, mesh);
    expect(cat1.ok).toBe(true);

    const r1 = await reg.loadByGuid<TypesMeshAsset>(meshGuid);
    expect(r1.ok).toBe(true);
    const r2 = await reg.loadByGuid<TypesMeshAsset>(meshGuid);
    expect(r2.ok).toBe(true);

    if (r1.ok && r2.ok && cat1.ok) {
      expect(r1.value).toBe(r2.value);
      expect(r1.value).toBe(cat1.value);
    }
  });

  it('loadByGuid returns the same payload for a pre-registered scene', async () => {
    defineComponent('Transform', { pos: 'array<f32, 3>' });
    defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' });
    defineComponent('MeshRenderer', { materials: 'array<shared<MaterialAsset>>' });

    const reg = makeRegistry();
    preregisterMesh(reg);
    preregisterMaterial(reg, MATERIAL_A_GUID);

    const scene = makeTestSceneAsset({
      meshGuid: MESH_GUID,
      materialGuids: [MATERIAL_A_GUID],
    });
    reg.catalog(parseGuid(SCENE_GUID), scene);

    const r1 = await reg.loadByGuid<SceneAsset>(parseGuid(SCENE_GUID));
    const r2 = await reg.loadByGuid<SceneAsset>(parseGuid(SCENE_GUID));

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value).toBe(r2.value);
    }
  });
});

// ── AC-07: transitive failure attribution ───────────────────────────────────

describe('AC-07 — transitive failure attribution', () => {
  it('dev-mode loadByGuid returns asset-not-found for missing GUID', async () => {
    const reg = makeRegistry();
    const rMissing = await reg.loadByGuid<TypesMeshAsset>(parseGuid(MISSING_SUB_GUID));
    expect(rMissing.ok).toBe(false);
    if (!rMissing.ok) {
      const err = rMissing.error as AssetError;
      expect(err.code).toBe('asset-not-found');
      expect(typeof err.hint).toBe('string');
    }
  });

  it('prod-path recursive error includes sub-asset GUID + parent scene GUID in hint', async () => {
    // Construct a catalog where the scene pack and mesh pack exist but the
    // material sub-ref GUID is missing. After M1 recursion is wired in ddcLoad,
    // loadByGuid<SceneAsset> should fail with a breadcrumb hint containing both
    // the missing GUID and the parent scene GUID.
    //
    // Pack fixture format matches the existing load-by-guid-prod fixtures
    // (pack-index is a flat array, pack file uses schemaVersion + assets[]).

    defineComponent('Transform', { pos: 'array<f32, 3>' });
    defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' });
    defineComponent('MeshRenderer', { materials: 'array<shared<MaterialAsset>>' });

    const reg = makeRegistry();

    // Pack-index: scene + mesh present, material missing.
    const packIndex = [
      { guid: SCENE_GUID, packageUrl: '/packs/scene.pack.json', kind: 'scene' },
      {
        guid: MESH_GUID,
        packageUrl: '/packs/mesh.pack.json',
        kind: 'mesh',
        materialSlots: [{ slotName: 'Default' }],
      },
      // MISSING_SUB_GUID intentionally absent
    ];

    // Scene pack payload references MESH_GUID + MISSING_SUB_GUID.
    // feat-20260622 M4 / w14: refs[] is now the recursion SSOT (D-5). Handle
    // fields carry refs[] indices (resolved by parseScenePayload), and the
    // scene envelope's refs[] (GUID-string projection) drives the unified
    // recursive for-loop. MESH_GUID -> refs[0], MISSING_SUB_GUID -> refs[1].
    const scenePack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: SCENE_GUID,
          kind: 'scene',
          payload: {
            entities: {
              'entity-0': {
                components: {
                  Transform: { pos: [0, 0, 0] },
                  MeshFilter: { assetHandle: 0 },
                  MeshRenderer: { materials: [1] },
                },
              },
            },
          },
          refs: [MESH_GUID, MISSING_SUB_GUID],
        },
      ],
    };

    const meshPack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: MESH_GUID,
          kind: 'mesh',
          payload: {
            vertices: [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1],
            indices: [0],
            attributes: {},
          },
          refs: [],
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 0,
              vertexCount: 0,
              topology: 'triangle-list',
              materialSlot: 0,
            },
          ],

          materialSlots: [{ slotName: 'Default' }],
        },
      ],
    };

    reg.configurePackIndex(`/pack-index.json`);

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === `/pack-index.json`) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/scene.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(scenePack) });
      }
      if (url === '/packs/mesh.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(meshPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const result = await reg.loadByGuid<SceneAsset>(parseGuid(SCENE_GUID));

      // After M1 impl, this should fail because MISSING_SUB_GUID is not in the
      // catalog. The error hint should contain the missing GUID and the parent
      // scene GUID as a breadcrumb.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const err = result.error as AssetError;
        expect(
          ['asset-not-found', 'asset-fetch-failed', 'asset-not-imported'].includes(err.code),
        ).toBe(true);
        expect(typeof err.hint).toBe('string');
        // Breadcrumb (D-7 / B-8): hint contains the missing sub-asset GUID,
        // the parent scene GUID, and the entity localId + component.field path
        // (4-segment chain: scene → entity → component.field → sub-asset).
        expect(err.hint).toContain(MISSING_SUB_GUID);
        expect(err.hint).toContain(SCENE_GUID);
        expect(err.hint).toContain('entity entity-0');
        expect(err.hint).toContain('MeshRenderer.materials');
        // feat-20260622 verify r1: the breadcrumb provenance is ALSO exposed in
        // structured form on `.detail` so an AI user locates the broken edge by
        // property access, not by parsing the hint (charter P3, requirements
        // error-self-recovery). Only asserted when the propagated error did not
        // carry a more-specific detail of its own.
        const detail = err.detail as
          | {
              referencedByGuid?: string;
              subAssetGuid?: string;
              sceneEntityKey?: string;
              sourceField?: { componentName?: string; fieldName?: string; arrayIndex?: number };
            }
          | undefined;
        // Unconditional (verify r2): the structured breadcrumb MUST be delivered
        // on this scene->missing-sub-asset prod path — a guarded assertion would
        // pass vacuously if the provenance silently regressed to hint-only.
        expect(detail?.referencedByGuid?.toLowerCase()).toBe(SCENE_GUID.toLowerCase());
        expect(detail?.subAssetGuid?.toLowerCase()).toBe(MISSING_SUB_GUID.toLowerCase());
        expect(detail?.sceneEntityKey).toBe('entity-0');
        expect(detail?.sourceField?.componentName).toBe('MeshRenderer');
        expect(detail?.sourceField?.fieldName).toBe('materials');
      }
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });
});

describe('mesh default material ready boundary', () => {
  it.each([
    ['empty refs', []],
    ['unrelated refs', [WRONG_DEFAULT_KIND_GUID]],
  ])('rejects a payload default omitted from %s before ready', async (_label, refs) => {
    const reg = makeRegistry();
    if (refs.length > 0) {
      reg.catalog(parseGuid(WRONG_DEFAULT_KIND_GUID), {
        kind: 'texture' as const,
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm' as const,
        data: new Uint8Array([255, 255, 255, 255]),
        colorSpace: 'srgb' as const,
        mips: { kind: 'none' as const },
      });
    }
    const omittedDefaultGuid = 'b0000000-0000-4000-b000-000000000099';
    reg.configurePackIndex('/pack-index.json');
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              { guid: MESH_GUID, packageUrl: '/packs/missing-edge.pack.json', kind: 'mesh' },
            ]),
        });
      }
      if (url === '/packs/missing-edge.pack.json') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [
                {
                  guid: MESH_GUID,
                  kind: 'mesh',
                  refs,
                  payload: {
                    vertices: [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1],
                    indices: [0, 0, 0],
                    attributes: {},
                    submeshes: [
                      {
                        indexOffset: 0,
                        indexCount: 3,
                        vertexCount: 1,
                        topology: 'triangle-list',
                        materialSlot: 0,
                      },
                    ],
                    materialSlots: [{ slotName: 'Body', defaultMaterial: omittedDefaultGuid }],
                  },
                },
              ],
            }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof globalThis.fetch;

    const result = await reg.loadByGuid<TypesMeshAsset>(parseGuid(MESH_GUID));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as AssetError).detail).toMatchObject({
        meshAssetGuid: MESH_GUID,
        defaultMaterialGuid: omittedDefaultGuid,
        actualKind: 'missing-ref-edge',
      });
    }
    expect(reg.inspect().assets.some((entry) => entry.guid === MESH_GUID)).toBe(false);
  });

  it('rejects a loaded non-material default before the Mesh becomes ready', async () => {
    const reg = makeRegistry();
    reg.catalog(parseGuid(WRONG_DEFAULT_KIND_GUID), {
      kind: 'texture' as const,
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm' as const,
      data: new Uint8Array([255, 255, 255, 255]),
      colorSpace: 'srgb' as const,
      mips: { kind: 'none' as const },
    });

    const packIndex = [
      { guid: MESH_GUID, packageUrl: '/packs/wrong-default.pack.json', kind: 'mesh' },
    ];
    const meshPack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: MESH_GUID,
          kind: 'mesh',
          payload: {
            vertices: [
              -0.5, 0, 0.5, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0.5, 0, 0.5, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0.5,
              0, -0.5, 0, 1, 0, 1, 1, 1, 0, 0, 1,
            ],
            indices: [0, 1, 2],
            attributes: {},
            submeshes: [
              {
                indexOffset: 0,
                indexCount: 3,
                vertexCount: 3,
                topology: 'triangle-list',
                materialSlot: 0,
              },
            ],
            materialSlots: [
              {
                slotName: 'Body',
                sourceKey: 'gltf:material:0',
                defaultMaterial: WRONG_DEFAULT_KIND_GUID,
              },
            ],
          },
          refs: [WRONG_DEFAULT_KIND_GUID],
        },
      ],
    };

    reg.configurePackIndex('/pack-index.json');
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/wrong-default.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(meshPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof globalThis.fetch;

    const result = await reg.loadByGuid<TypesMeshAsset>(parseGuid(MESH_GUID));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as AssetError;
      expect(error.code).toBe('asset-parse-failed');
      expect(error.detail).toEqual({
        meshAssetGuid: MESH_GUID,
        slotIndex: 0,
        slotName: 'Body',
        defaultMaterialGuid: WRONG_DEFAULT_KIND_GUID,
        actualKind: 'texture',
      });
    }
    expect(reg.inspect().assets.some((entry) => entry.guid === MESH_GUID)).toBe(false);
  });
});

// ── M2 GUIDs ───────────────────────────────────────────────────────────────
const TEXTURE_A_GUID = 'c0000000-0000-4000-c000-000000000001';
const TEXTURE_B_GUID = 'c0000000-0000-4000-c000-000000000002';
const TEXTURE_C_GUID = 'c0000000-0000-4000-c000-000000000003';
const MATERIAL_PARENT_GUID = 'c0000000-0000-4000-c000-000000000004';
const SKELETON_GUID = 'd0000000-0000-4000-d000-000000000001';
const SKIN_GUID = 'd0000000-0000-4000-d000-000000000002';
const SCENE_GLTF_GUID = 'e0000000-0000-4000-e000-000000000001';

// ── AC-08: in-flight dedup + cycle ─────────────────────────────────────────

describe('AC-08 — in-flight dedup + cycle', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('concurrent loadByGuid(g) 3-way shares in-flight promise — only 1 pack fetch', async () => {
    const reg = makeRegistry();

    const packIndex = [
      {
        guid: MESH_GUID,
        packageUrl: '/packs/mesh.pack.json',
        kind: 'mesh',
        materialSlots: [{ slotName: 'Default' }],
      },
    ];

    const meshPack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: MESH_GUID,
          kind: 'mesh',
          payload: {
            vertices: [
              -0.5, 0, 0.5, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0.5, 0, 0.5, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0.5,
              0, -0.5, 0, 1, 0, 1, 1, 1, 0, 0, 1,
            ],
            indices: [0, 1, 2],
            attributes: {},
          },
          refs: [],
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 3,
              vertexCount: 3,
              topology: 'triangle-list',
              materialSlot: 0,
            },
          ],

          materialSlots: [{ slotName: 'Default' }],
        },
      ],
    };

    reg.configurePackIndex(`/pack-index.json`);

    let packFetchCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === `/pack-index.json`) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/mesh.pack.json') {
        packFetchCount++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(meshPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const meshGuid = parseGuid(MESH_GUID);
      const [r1, r2, r3] = await Promise.all([
        reg.loadByGuid<TypesMeshAsset>(meshGuid),
        reg.loadByGuid<TypesMeshAsset>(meshGuid),
        reg.loadByGuid<TypesMeshAsset>(meshGuid),
      ]);

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(true);

      if (r1.ok && r2.ok && r3.ok) {
        expect(r1.value).toBe(r2.value);
        expect(r2.value).toBe(r3.value);

        // In-flight dedup: only 1 pack-index fetch + 1 pack fetch = 2 total
        // (pack-index might be fetched N times since fetchMock is per-call,
        // but packFetchCount should be 1 thanks to inFlight dedup)
        expect(packFetchCount).toBe(1);
      }
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('cycle A→B→A no stack overflow, both registered', async () => {
    defineComponent('Transform', { pos: 'array<f32, 3>' });
    defineComponent('SceneCycler', { refScene: 'shared<unknown>' });

    const reg = makeRegistry();

    // Two SceneAssets that reference each other via a refs[] edge.
    // feat-20260622 M4 / w14: the recursion source is envelope.refs (D-5).
    // A's envelope.refs = [CYCLE_B_GUID], B's = [CYCLE_A_GUID].
    // With register-before-recurse + inFlight dedup: A registers then recurses
    // into B; B registers then recurses into A; A is already catalogued
    // (fast-path hit) / inFlight Promise satisfies it → no stack overflow.

    const packIndex = [
      { guid: CYCLE_A_GUID, packageUrl: '/packs/a.pack.json', kind: 'scene' },
      { guid: CYCLE_B_GUID, packageUrl: '/packs/b.pack.json', kind: 'scene' },
    ];

    const sceneAPack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: CYCLE_A_GUID,
          kind: 'scene',
          payload: {
            entities: {
              'entity-0': {
                components: {
                  Transform: { pos: [0, 0, 0] },
                  SceneCycler: { refScene: 0 },
                },
              },
            },
          },
          refs: [CYCLE_B_GUID],
        },
      ],
    };

    const sceneBPack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: CYCLE_B_GUID,
          kind: 'scene',
          payload: {
            entities: {
              'entity-0': {
                components: {
                  Transform: { pos: [0, 0, 0] },
                  SceneCycler: { refScene: 0 },
                },
              },
            },
          },
          refs: [CYCLE_A_GUID],
        },
      ],
    };

    reg.configurePackIndex(`/pack-index.json`);

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === `/pack-index.json`) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/a.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sceneAPack) });
      }
      if (url === '/packs/b.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sceneBPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const result = await reg.loadByGuid<SceneAsset>(parseGuid(CYCLE_A_GUID));
      expect(result.ok).toBe(true);

      const resB = reg.lookup(parseGuid(CYCLE_B_GUID));
      expect(resB).not.toBe(undefined);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });
});

// ── AC-02: material recursive (D-8 — values string-only walker) ─────────

describe('AC-02 — material recursive loadByGuid', () => {
  it('loadByGuid<MaterialAsset> recurses into texture sub-assets pre-registered in dev mode', async () => {
    // Verify that the recursive loadByGuid<MaterialAsset> walk reaches
    // texture GUIDs from values. The textures are pre-registered in dev
    // mode (fast-path hit), simulating the typical dev workflow where leaf
    // assets are registered before the material. The material itself is
    // loaded via the prod path, and the recursive walk triggers loadByGuid
    // for each texture GUID — each hitting the fast-path cache.
    const reg = makeRegistry();

    // Pre-register textures in dev mode (fast-path compatible)
    reg.catalog(parseGuid(TEXTURE_A_GUID), {
      kind: 'texture' as const,
      shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
      format: 'rgba8unorm' as const,
      data: new Uint8Array(64),
      colorSpace: 'srgb' as const,
      mips: { kind: 'none' as const },
    });
    reg.catalog(parseGuid(TEXTURE_B_GUID), {
      kind: 'texture' as const,
      shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
      format: 'rgba8unorm' as const,
      data: new Uint8Array(64),
      colorSpace: 'srgb' as const,
      mips: { kind: 'none' as const },
    });

    const packIndex = [
      { guid: MATERIAL_PARENT_GUID, packageUrl: '/packs/material.pack.json', kind: 'material' },
    ];

    const materialPack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: MATERIAL_PARENT_GUID,
          kind: 'material',
          payload: {
            passes: [
              {
                name: 'forward',
                program: { module: 'test::dummy' },
                renderState: { tags: { LightMode: 'Forward' } },
              },
            ],
            values: {
              u_albedoMap: TEXTURE_A_GUID,
              u_normalMap: TEXTURE_B_GUID,
            },
          },
          refs: [],
        },
      ],
    };

    reg.configurePackIndex(`/pack-index.json`);

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === `/pack-index.json`) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/material.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(materialPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const result = await reg.loadByGuid<MaterialAsset>(parseGuid(MATERIAL_PARENT_GUID));

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Both texture GUIDs should be resolvable (fast-path hit from dev pre-registration)
        expect(reg.lookup(parseGuid(TEXTURE_A_GUID))).not.toBe(undefined);
        expect(reg.lookup(parseGuid(TEXTURE_B_GUID))).not.toBe(undefined);
      }
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });
});

// ── AC-04: skin recursive (D-10 — single skeletonGuid) ─────────────────────-

describe('AC-04 — skin recursive loadByGuid', () => {
  it('loadByGuid<SkinAsset> registers skeleton sub-asset via recursive walk', async () => {
    const reg = makeRegistry();

    // Pre-register skeleton in dev mode (fast-path compatible); the skeleton
    // loader requires Float32Array which does not survive JSON round-trip.
    reg.catalog(parseGuid(SKELETON_GUID), {
      kind: 'skeleton',
      inverseBindMatrices: new Float32Array(32),
      jointCount: 2,
    });

    const packIndex = [{ guid: SKIN_GUID, packageUrl: '/packs/skin.pack.json', kind: 'skin' }];

    const skinPack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: SKIN_GUID,
          kind: 'skin',
          payload: {
            jointPaths: ['Root', 'Root/Spine'],
            skeletonGuid: SKELETON_GUID,
          },
          refs: [],
        },
      ],
    };

    reg.configurePackIndex(`/pack-index.json`);

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === `/pack-index.json`) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/skin.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(skinPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const result = await reg.loadByGuid<import('@forgeax/engine-types').SkinAsset>(
        parseGuid(SKIN_GUID),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Skeleton GUID should be resolvable (fast-path hit from dev pre-registration)
        expect(reg.lookup(parseGuid(SKELETON_GUID))).not.toBe(undefined);
      }
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });
});

// ── AC-03: gltf-shaped scene composite (D-9 — via SceneAsset entry) ─────────

describe('AC-03 — gltf-shaped scene composite (via SceneAsset, D-9)', () => {
  it('loadByGuid<SceneAsset> registers mesh + material + texture-by-material chain', async () => {
    // D-9: runtime Asset union contains no GltfAsset POD; gltf importer
    // output (mesh + material + texture) is covered via SceneAsset recursion.
    // This fixture mirrors that output: a scene whose entities reference mesh
    // + material, and the material's values reference a texture GUID.
    // The recursive walk must reach all three kinds.
    //
    // Texture is pre-registered in dev mode (fast-path compatible); the
    // material envelope's refs[] carries the texture GUIDs from values,
    // and the recursive loadByGuid hits the dev fast-path.

    defineComponent('Transform', { pos: 'array<f32, 3>' });
    defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' });
    defineComponent('MeshRenderer', { materials: 'array<shared<MaterialAsset>>' });

    const reg = makeRegistry();

    // Pre-register texture in dev mode.
    reg.catalog(parseGuid(TEXTURE_C_GUID), {
      kind: 'texture' as const,
      shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
      format: 'rgba8unorm' as const,
      data: new Uint8Array(64),
      colorSpace: 'srgb' as const,
      mips: { kind: 'none' as const },
    });

    const packIndex = [
      { guid: SCENE_GLTF_GUID, packageUrl: '/packs/scene-gltf.pack.json', kind: 'scene' },
      {
        guid: MESH_GUID,
        packageUrl: '/packs/mesh.pack.json',
        kind: 'mesh',
        materialSlots: [{ slotName: 'Default' }],
      },
      {
        guid: MATERIAL_A_GUID,
        packageUrl: '/packs/mat.pack.json',
        kind: 'material',
      },
    ];

    const scenePack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: SCENE_GLTF_GUID,
          kind: 'scene',
          payload: {
            entities: {
              'entity-0': {
                components: {
                  Transform: { pos: [0, 0, 0] },
                  MeshFilter: { assetHandle: 0 },
                  MeshRenderer: { materials: [1] },
                },
              },
            },
          },
          // feat-20260622 M4 / w14: refs[] is the recursion SSOT (D-5).
          // MESH_GUID -> refs[0], MATERIAL_A_GUID -> refs[1].
          refs: [MESH_GUID, MATERIAL_A_GUID],
        },
      ],
    };

    const meshPack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: MESH_GUID,
          kind: 'mesh',
          payload: {
            vertices: [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1],
            indices: [0],
            attributes: {},
          },
          refs: [],
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 0,
              vertexCount: 0,
              topology: 'triangle-list',
              materialSlot: 0,
            },
          ],

          materialSlots: [{ slotName: 'Default' }],
        },
      ],
    };

    const materialPack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: MATERIAL_A_GUID,
          kind: 'material',
          payload: {
            passes: [
              {
                name: 'forward',
                program: { module: 'test::dummy' },
                renderState: { tags: { LightMode: 'Forward' } },
              },
            ],
            // feat-20260622 M4 / w14: texture handle fields carry refs[] indices
            // (resolved by materialLoader); the texture edge rides material
            // refs[] so the unified for-loop recurses into it.
            values: {
              u_baseColorMap: 0,
              u_normalMap: 0, // same texture via two params (diamond)
              u_metallic: 0.5, // non-GUID value → skipped
            },
          },
          refs: [TEXTURE_C_GUID],
        },
      ],
    };

    reg.configurePackIndex(`/pack-index.json`);

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === `/pack-index.json`) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/scene-gltf.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(scenePack) });
      }
      if (url === '/packs/mesh.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(meshPack) });
      }
      if (url === '/packs/mat.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(materialPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const result = await reg.loadByGuid<SceneAsset>(parseGuid(SCENE_GLTF_GUID));

      expect(result.ok).toBe(true);
      if (result.ok) {
        // All three kinds should be registered:
        // - mesh (via scene entity MeshFilter, prod path)
        // - material (via scene entity MeshRenderer, prod path)
        // - texture (via material values, dev fast-path hit)
        expect(reg.lookup(parseGuid(MESH_GUID))).not.toBe(undefined);
        expect(reg.lookup(parseGuid(MATERIAL_A_GUID))).not.toBe(undefined);
        expect(reg.lookup(parseGuid(TEXTURE_C_GUID))).not.toBe(undefined);
      }
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });
});

// ── M3: leaf coverage (AC-05) ──────────────────────────────────────────────
//
// The inline-payload leaf kinds in the closed Asset union carry no sub-asset
// edges; the importer fills envelope.refs = [] for them. The spec-enumerated
// leaves (mesh / texture / animation-clip / audio / font) plus extras
// (sampler / shader / skeleton / render-pipeline) -- tested together for union
// completeness. (equirect rides the Pack v2 artifact path, covered by
// asset-registry-hdr-equirect.test.ts, not the inline-payload roundtrip here.)
//
// AC-05 per-leaf assertions:
//   loadByGuid (fast-path) returns the catalogued payload
//   lookup after catalog returns the payload
//   inspect().assets count incremented by 1 from catalog (zero extra mutations)

const LEAF_TEST_GUIDS: Record<string, string> = {
  mesh: 'f0000000-0000-4000-f000-000000000001',
  texture: 'f0000000-0000-4000-f000-000000000002',
  sampler: 'f0000000-0000-4000-f000-000000000004',
  program: 'f0000000-0000-4000-f000-000000000005',
  skeleton: 'f0000000-0000-4000-f000-000000000006',
  'animation-clip': 'f0000000-0000-4000-f000-000000000007',
  audio: 'f0000000-0000-4000-f000-000000000008',
  font: 'f0000000-0000-4000-f000-000000000009',
  'render-pipeline': 'f0000000-0000-4000-f000-00000000000a',
};

interface LeafFixture {
  readonly label: string;
  readonly kind: string;
  readonly makeAsset: () => import('@forgeax/engine-types').Asset;
}

const LEAF_FIXTURES: readonly LeafFixture[] = [
  {
    label: 'mesh',
    kind: 'mesh',
    makeAsset: () => ({
      kind: 'mesh' as const,
      vertices: new Float32Array(12),
      indices: new Uint16Array([0]),
      attributes: {},
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: 0,
          topology: 'triangle-list' as const,
          materialSlot: 0,
        },
      ],
      materialSlots: [{ slotName: 'Default' }],
    }),
  },
  {
    label: 'texture',
    kind: 'texture',
    makeAsset: () => ({
      kind: 'texture' as const,
      shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
      format: 'rgba8unorm' as const,
      data: new Uint8Array(64),
      colorSpace: 'srgb' as const,
      mips: { kind: 'none' as const },
    }),
  },
  {
    label: 'sampler',
    kind: 'sampler',
    makeAsset: () => ({
      kind: 'sampler' as const,
      magFilter: 'linear' as const,
      minFilter: 'linear' as const,
    }),
  },
  {
    label: 'skeleton',
    kind: 'skeleton',
    makeAsset: () => ({
      kind: 'skeleton' as const,
      inverseBindMatrices: new Float32Array(16),
      jointCount: 1,
    }),
  },
  {
    label: 'animation-clip',
    kind: 'animation-clip',
    makeAsset: () => ({
      kind: 'animation-clip' as const,
      duration: 1.0,
      channels: [],
    }),
  },
  {
    label: 'audio',
    kind: 'audio',
    makeAsset: () => ({
      kind: 'audio' as const,
      sourceKey: 'fixture-audio',
      mediaType: 'audio/ogg' as const,
      bytes: new Uint8Array(),
    }),
  },
  {
    label: 'font',
    kind: 'font',
    makeAsset: () => ({
      kind: 'font' as const,
      // D-19: FontAsset.atlas/sampler are embedded AssetGuids (not handles).
      atlas: parseGuid('a0000000-0000-4000-a000-00000000f001'),
      sampler: parseGuid('a0000000-0000-4000-a000-00000000f002'),
      glyphs: {},
      common: {
        lineHeight: 0,
        base: 0,
        distanceRange: 0,
        pxRange: 0,
        atlasWidth: 0,
        atlasHeight: 0,
      },
    }),
  },
  {
    label: 'render-pipeline',
    kind: 'render-pipeline',
    makeAsset: () => ({
      kind: 'render-pipeline' as const,
      pipelineId: 'forgeax::standard' as const,
    }),
  },
];

describe('AC-05 -- leaf assets (no sub-asset edges)', () => {
  // Leaf kinds carry no recursion edges; the importer fills envelope.refs = []
  // and loadByGuid does not recurse for them. These tests confirm the registry
  // lifecycle (catalog -> fast-path loadByGuid -> lookup) per leaf kind.

  it.each(
    LEAF_FIXTURES.map((f) => [f.label, f]),
  )('loadByGuid<%s> returns ok and asset is catalogued via fast-path', async (_label, fixture) => {
    const reg = makeRegistry();
    const guidStr = LEAF_TEST_GUIDS[fixture.label];
    if (guidStr === undefined) throw new Error(`missing leaf test GUID for ${fixture.label}`);
    const guid = parseGuid(guidStr);
    const asset = fixture.makeAsset();

    // Record pre-catalogue state
    const assetsBefore = reg.inspect().assets.length;

    // Catalogue the leaf
    const cat = reg.catalog(guid, asset);
    expect(cat.ok).toBe(true);

    // Verify catalog added exactly one entry
    const assetsAfterCatalog = reg.inspect().assets.length;
    expect(assetsAfterCatalog).toBe(assetsBefore + 1);

    // loadByGuid fast-path (already catalogued) returns the payload
    const result = await reg.loadByGuid(guid);

    expect(result.ok).toBe(true);
    if (result.ok && cat.ok) {
      expect(result.value).toBe(cat.value);
    }

    // No extra registry mutations from loadByGuid
    const assetsAfterLoad = reg.inspect().assets.length;
    expect(assetsAfterLoad).toBe(assetsBefore + 1);

    // lookup confirms catalogue
    expect(reg.lookup(guid)).not.toBe(undefined);
  });
});

// ── feat-20260612 M2 fixup: SceneAsset.skinGuids browser-async-load chain ──
//
// REGRESSION COVERAGE: before the fix, browser-path `loadByGuid<SceneAsset>`
// recursively followed entity-component handle fields (mesh / material /
// texture / skeleton) but had no cross-edge to SkinAssets -- SkinAsset is a
// sibling identified by matching `skeletonGuid`, not by any handle field on a
// SceneEntity component. After loadByGuid<SceneAsset> resolved, instantiate()
// invoked `postSpawnResolveJoints` which silently `continue`d when
// `resolver.resolveSkinAsset` returned undefined. The result: `Skin.joints`
// stayed length=0, and the M2-introduced `JointCountMismatchError` fail-fast
// in render-system-extract triggered every frame on the browser path. dawn
// smoke missed it because dawn pre-registers every sub-asset before
// instantiate (sync register-handle path), bypassing the recursive walk.
//
// The fix:
//   1. SceneAsset POD now carries `skinGuids?: readonly string[]` (a list of
//      SkinAsset GUIDs the scene's skinned entities reference). gltfImporter
//      populates it; on-disk pack JSON stores it as either string GUIDs or
//      refs[] indices (parseScenePayload accepts both).
//   2. The scene envelope's `refs[]` includes each SkinAsset GUID so the
//      recursive `loadByGuid` walk pulls every SkinAsset.
//   3. `postSpawnResolveJoints` upgraded its silent `continue` on missing
//      SkinAsset to a fail-fast `skin-asset-unresolved` error, so a future
//      regression of the cross-edge wiring surfaces immediately rather than
//      hiding behind a frame-1 JointCountMismatchError.
const SKIN_FIXUP_SCENE_GUID = 'f0000000-0000-4000-f000-000000000001';
const SKIN_FIXUP_SKIN_GUID = 'f0000000-0000-4000-f000-000000000002';
const SKIN_FIXUP_SKELETON_GUID = 'f0000000-0000-4000-f000-000000000003';

describe('feat-20260612 M2 fixup — SceneAsset.skinGuids cross-edge', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('loadByGuid<SceneAsset> recursively loads SkinAsset via skinGuids cross-edge (browser pack-fetch path)', async () => {
    // Reproduces the browser-async-pack-fetch path: SkinAsset is NOT
    // pre-registered; loadByGuid<SceneAsset> must reach it through the
    // skinGuids cross-edge encoded in the scene pack body. Without the fix,
    // the SkinAsset is never loaded and no resolveGuid lookup succeeds.

    defineComponent('Transform', { pos: 'array<f32, 3>' });
    defineComponent('Skin', {
      skeleton: 'shared<SkeletonAsset>',
      joints: 'array<entity>',
    });

    const reg = makeRegistry();

    // Pre-register Skeleton in dev mode (Float32Array does not survive JSON
    // round-trip; the skeleton-loader's dual contract handles array form,
    // but this fixture keeps the focus on skin cross-edge wiring).
    reg.catalog(parseGuid(SKIN_FIXUP_SKELETON_GUID), {
      kind: 'skeleton',
      inverseBindMatrices: new Float32Array(64),
      jointCount: 1,
    });

    const packIndex = [
      { guid: SKIN_FIXUP_SCENE_GUID, packageUrl: '/packs/scene.pack.json', kind: 'scene' },
      { guid: SKIN_FIXUP_SKIN_GUID, packageUrl: '/packs/skin.pack.json', kind: 'skin' },
    ];

    const scenePack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: SKIN_FIXUP_SCENE_GUID,
          kind: 'scene',
          payload: {
            entities: {
              'entity-0': {
                components: {
                  Transform: { pos: [0, 0, 0] },
                  Skin: { skeleton: 0 },
                },
              },
            },
            // refs[]-index form (browser JSON-roundtrip shape)
            skinGuids: [1],
          },
          // refs ordering matches indices used by both the Skin.skeleton
          // handle field (resolved via HANDLE_FIELD_NAMES) and the
          // skinGuids[] integer form.
          refs: [SKIN_FIXUP_SKELETON_GUID, SKIN_FIXUP_SKIN_GUID],
        },
      ],
    };

    const skinPack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: SKIN_FIXUP_SKIN_GUID,
          kind: 'skin',
          payload: {
            jointPaths: ['Root'],
            skeletonGuid: SKIN_FIXUP_SKELETON_GUID,
          },
          refs: [SKIN_FIXUP_SKELETON_GUID],
        },
      ],
    };

    reg.configurePackIndex(`/pack-index.json`);

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === `/pack-index.json`) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/scene.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(scenePack) });
      }
      if (url === '/packs/skin.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(skinPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    // BEFORE fix: SkinAsset not catalogued -> lookup fails.
    // AFTER fix: the scene envelope's refs[] carries the SkinAsset GUID ->
    // loadByGuid recursion pulls it -> lookup succeeds.
    const result = await reg.loadByGuid<SceneAsset>(parseGuid(SKIN_FIXUP_SCENE_GUID));
    expect(result.ok).toBe(true);

    expect(reg.lookup(parseGuid(SKIN_FIXUP_SKIN_GUID))).not.toBe(undefined);
  });

  it('parseScenePayload accepts skinGuids as inline strings (in-memory form)', async () => {
    // dawn-smoke / direct register path stores skinGuids as raw GUID strings
    // (not refs[] indices). parseScenePayload's resolveSkinGuids must accept
    // both shapes for round-trip symmetry with the browser pack-fetch path.

    defineComponent('Transform', { pos: 'array<f32, 3>' });

    const reg = makeRegistry();
    reg.catalog(parseGuid(SKIN_FIXUP_SKELETON_GUID), {
      kind: 'skeleton',
      inverseBindMatrices: new Float32Array(64),
      jointCount: 1,
    });
    reg.catalog(parseGuid(SKIN_FIXUP_SKIN_GUID), {
      kind: 'skin',
      jointPaths: ['Root'],
      skeletonGuid: SKIN_FIXUP_SKELETON_GUID,
    });

    // Build a SceneAsset POD with inline skinGuids (no refs[] indices).
    const scene: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: { pos: [0, 0, 0] } } } },
      skinGuids: [SKIN_FIXUP_SKIN_GUID],
    };
    reg.catalog(parseGuid(SKIN_FIXUP_SCENE_GUID), scene);

    const result = await reg.loadByGuid<SceneAsset>(parseGuid(SKIN_FIXUP_SCENE_GUID));
    expect(result.ok).toBe(true);

    // Inline-string skinGuids form resolves through the recursive walk too.
    expect(reg.lookup(parseGuid(SKIN_FIXUP_SKIN_GUID))).not.toBe(undefined);
  });
});
