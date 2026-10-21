// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=13):
//   - packages/types/src/__tests__/asset-error.test.ts
//   - packages/types/src/__tests__/asset.test.ts
//   - packages/types/src/__tests__/error-codes-material.test.ts
//   - packages/types/src/__tests__/font-asset-union.test.ts
//   - packages/types/src/__tests__/font-error-code.test.ts
//   - packages/types/src/__tests__/inspector-client.test.ts
//   - packages/types/src/__tests__/material-param-types.test.ts
//   - packages/types/src/__tests__/mesh-asset-indices-optional.test.ts
//   - packages/types/src/__tests__/pack-index-entry.test.ts
//   - packages/types/src/__tests__/shader-errors.test.ts
//   - packages/types/src/__tests__/skin-errors-code-consistency.test.ts
//   - packages/types/src/__tests__/submesh-error.test.ts
//   - packages/types/__tests__/physics-error-code.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
// Path adjustment for src/__tests__/ -> __tests__/: ../X -> ../src/X.

import { describe, expect, it, expectTypeOf } from 'vitest';
import type { TagOf } from '../src/handle';
import {
  ASSET_ERROR_HINTS,
  AssetError,
  FontError,
  RenderQueue,
  TextError,
} from '../src/index';
import type {
  Asset,
  AssetErrorCode,
  AssetErrorDetail,
  FontAsset,
  FontErrorCode,
  GlyphMetric,
  ImageMetadata,
  MaterialAsset,
  MeshAsset,
  MeshLodLevel,
  PackIndexEntry,
  PrimitiveTopology,
  SamplerAsset,
  Submesh,
  TextErrorCode,
  TextureAsset,
  VertexAttributeMap,
} from '../src/index';
import { MATERIAL_PARAM_TYPES } from '../src/index.js';
import type {
  PackErrorCode,
  PackErrorDetail,
  ParamSchemaEntry,
  ShaderCircularImportDetail,
  ShaderCompileFailedDetail,
  ShaderDefineConflictDetail,
  ShaderErrorCode,
  ShaderErrorDetail,
  ShaderImportNotFoundDetail,
  ShaderInitFailedDetail,
  ShaderManifestMalformedDetail,
} from '../src/index.js';
import { defaultConnect } from '../src/inspector-client';
import type {
  ConnectFn,
  InspectorClient,
  InspectorClientResult,
} from '../src/inspector-client';
import { PHYSICS_ERROR_HINTS, PhysicsError } from '@forgeax/engine-types';
import type {
  AnimationClip,
  PhysicsErrorCode,
  PhysicsErrorDetail,
  SkeletonAsset,
  SkinAsset,
} from '@forgeax/engine-types';


{
  // --- from asset-error.test.ts ---
// asset-error.test - runtime + type-level assertions for the 5-member closed
// `AssetErrorCode` union and the `AssetError` class (feat-20260511-asset-system-v1
// w3 / D-P1 + feat-20260518-pbr-direct-lighting-mvp M1 / w3 minor evolution
// 4 -> 5 add member 'asset-invalid-value').
//
// Assertions:
// - All 5 `AssetErrorCode` members instantiate as `AssetError` with the
//   four-field structured surface (.code / .expected / .hint / .message).
// - `switch (code)` exhaustive without `default:` compiles under tsc strict
//   (charter P3 explicit failure; noImplicitReturns).
// - Per-code `.hint` strings match the plan-strategy §7.3 locked literals
//   verbatim (ASSET_ERROR_HINTS is the producer-side SSOT).
// - `AssetError` shape is structurally parallel to RhiError / InspectorError
//   (charter P4 consistent abstraction).
//
// Anchors: requirements §G3 + AC-03 + AC-10 + AC-21 + §1 callout row 9;
//          plan-strategy §2 D-P1 + §7.3 (locked hint literals);
//          feat-20260518 plan-strategy §2 D-1 (5th member minor evolution);
//          feat-20260518 plan-decisions §2.1 L-1 (hint literal lock-in);
//          research Finding 8 (precedent: MetricErrorCode / InspectorErrorCode
//          independent closed unions).


const ASSET_ERROR_CODES_5: ReadonlySet<AssetErrorCode> = new Set([
  'asset-not-found',
  'asset-parse-failed',
  'asset-format-unsupported',
  'asset-fetch-failed',
  'asset-invalid-value',
]);

// feat-20260604-hdr-equirect-cube-importer-loader M2 / w3: the import-on-demand
// sentinel `texture-source-not-imported` (D-1). It is an AssetError (not the
// ImageError `image-decode-failed`) so it passes the loadByGuidProd
// `instanceof AssetError` transport-eligibility guard, while a genuinely
// corrupt `.bin` still fails fast as `image-decode-failed` and is never routed
// through the import transport.
const SENTINEL_TEXTURE_SOURCE_NOT_IMPORTED: AssetErrorCode = 'texture-source-not-imported';

describe('AssetErrorCode closed union - 5 members', () => {
  it('contains 5 members', () => {
    expect(ASSET_ERROR_CODES_5.size).toBe(5);
  });

  it('type-level: contains asset-not-found', () => {
    expectTypeOf<'asset-not-found'>().toMatchTypeOf<AssetErrorCode>();
  });

  it('type-level: contains asset-parse-failed', () => {
    expectTypeOf<'asset-parse-failed'>().toMatchTypeOf<AssetErrorCode>();
  });

  it('type-level: contains asset-format-unsupported', () => {
    expectTypeOf<'asset-format-unsupported'>().toMatchTypeOf<AssetErrorCode>();
  });

  it('type-level: contains asset-fetch-failed', () => {
    expectTypeOf<'asset-fetch-failed'>().toMatchTypeOf<AssetErrorCode>();
  });

  it('type-level: contains asset-invalid-value', () => {
    expectTypeOf<'asset-invalid-value'>().toMatchTypeOf<AssetErrorCode>();
  });

  it('type-level: union remains closed (rejects non-member literal)', () => {
    // @ts-expect-error closed union - 'not-a-real-code' is not a member.
    const _bogus: AssetErrorCode = 'not-a-real-code';
    void _bogus;
  });

  it('type-level: exhaustive switch with no default compiles for all 28 members', () => {
    function describe(code: AssetErrorCode): string {
      switch (code) {
        case 'asset-not-found':
          return 'not-found';
        case 'asset-parse-failed':
          return 'parse-failed';
        case 'asset-format-unsupported':
          return 'format-unsupported';
        case 'asset-fetch-failed':
          return 'fetch-failed';
        case 'catalog-source-unconfigured':
          return 'catalog-source-unconfigured';
        case 'asset-invalid-value':
          return 'invalid-value';
        case 'cubemap-handle-missing':
          return 'cubemap-handle-missing';
        case 'invalid-source-format':
          return 'invalid-source-format';
        case 'load-failed':
          return 'load-failed';
        case 'device-unsupported':
          return 'device-unsupported';
        case 'ibl-precompute-not-dispatched':
          return 'ibl-precompute-not-dispatched';
        case 'mesh-vertex-stride-mismatch':
          return 'mesh-vertex-stride-mismatch';
        // === 1 new code (feat-20260523-shader-template-instance-split M1-T02) ===
        case 'material-shader-ref-broken':
          return 'ref-broken';
        // === 1 new code (feat-20260526-material-asset-multipass-renderstate M1 / w6) ===
        case 'material-circular-inheritance':
          return 'circular-inheritance';
        // === 2 new codes (feat-20260603-asset-import-loader-injection M1 / w1) ===
        case 'loader-not-registered':
          return 'loader-not-registered';
        case 'asset-not-imported':
          return 'asset-not-imported';
        // === 1 new code (feat-20260604-hdr-equirect-cube-importer-loader M2 / w4) ===
        case 'texture-source-not-imported':
          return 'texture-source-not-imported';
        // === Mesh slot and renderer override diagnostics ===
        case 'mesh-renderer-material-override-invalid':
          return 'mesh-renderer-material-override-invalid';
        case 'mesh-renderer-material-override-overflow':
          return 'mesh-renderer-material-override-overflow';
        case 'mesh-asset-submeshes-empty':
          return 'mesh-asset-submeshes-empty';
        case 'mesh-asset-material-slot-index-out-of-range':
          return 'mesh-asset-material-slot-index-out-of-range';
        case 'mesh-submesh-index-range-out-of-bounds':
          return 'mesh-submesh-index-range-out-of-bounds';
        // === 1 new code (feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild) ===
        case 'tileset-region-index-out-of-range':
          return 'tileset-region-index-out-of-range';
        // === 1 new code (feat-20260608-tilemap-object-layer-rendering M1 schema extension) ===
        case 'tileset-tile-entry-malformed':
          return 'tileset-tile-entry-malformed';
        // === 1 new code (feat-20260621-asset-registry-robustness M2 / w4) ===
        case 'asset-invalidated':
          return 'asset-invalidated';
        // === 1 new code (feat-20260629-multi-uv-set-support M2 / m2-w5) ===
        case 'mesh-bin-contract-violation':
          return 'mesh-bin-contract-violation';
        // === 1 new code (perf-20260706 raw-container fail-fast, #620) ===
        case 'source-not-imported':
          return 'source-not-imported';
        // === 1 new code (feat-20260707-texture-block-compression M5 / w35) ===
        case 'mipgen-unsupported-compressed-format':
          return 'mipgen-unsupported-compressed-format';
      }
      // No default - TS guards union drift at compile time.
    }
    expectTypeOf(describe).returns.toEqualTypeOf<string>();
  });

  it('type-level: contains texture-source-not-imported (import-on-demand sentinel)', () => {
    expectTypeOf<'texture-source-not-imported'>().toMatchTypeOf<AssetErrorCode>();
  });

  it('texture-source-not-imported instantiates as AssetError with a non-empty hint', () => {
    const e = new AssetError({
      code: SENTINEL_TEXTURE_SOURCE_NOT_IMPORTED,
      expected: 'a build-time-imported RGBA .bin for this texture GUID',
      hint: ASSET_ERROR_HINTS['texture-source-not-imported'],
    });
    expect(e).toBeInstanceOf(AssetError);
    expect(e.code).toBe('texture-source-not-imported');
    expect(typeof ASSET_ERROR_HINTS['texture-source-not-imported']).toBe('string');
    expect(ASSET_ERROR_HINTS['texture-source-not-imported'].length).toBeGreaterThan(0);
  });
});

describe('AssetError class - 4-field structured surface', () => {
  it('all 5 members instantiate as AssetError with readonly code / expected / hint', () => {
    for (const code of ASSET_ERROR_CODES_5) {
      const e = new AssetError({
        code,
        expected: `expected for ${code}`,
        hint: `hint for ${code}`,
      });
      expect(e).toBeInstanceOf(AssetError);
      expect(e).toBeInstanceOf(Error);
      expect(e.code).toBe(code);
      expect(typeof e.expected).toBe('string');
      expect(typeof e.hint).toBe('string');
      expect(e.expected.length).toBeGreaterThan(0);
      expect(e.hint.length).toBeGreaterThan(0);
    }
  });

  it('.name === "AssetError" for cross-realm dispatch', () => {
    const e = new AssetError({
      code: 'asset-not-found',
      expected: 'handle in registry',
      hint: ASSET_ERROR_HINTS['asset-not-found'],
    });
    expect(e.name).toBe('AssetError');
  });

  it('.message composes from code + expected + hint', () => {
    const e = new AssetError({
      code: 'asset-fetch-failed',
      expected: 'fetch returns 2xx for url',
      hint: ASSET_ERROR_HINTS['asset-fetch-failed'],
    });
    expect(e.message).toContain('asset-fetch-failed');
    expect(e.message).toContain('fetch returns 2xx for url');
    expect(e.message).toContain(ASSET_ERROR_HINTS['asset-fetch-failed']);
  });

  it('AI users consume structured triple via property access (no .message parsing)', () => {
    const e = new AssetError({
      code: 'asset-parse-failed',
      expected: 'valid PNG / JPG',
      hint: 'check file integrity',
    });
    // Charter P3 red line: AI users do not depend on .message parsing.
    expect(e.code).toBe('asset-parse-failed');
    expect(e.expected).toBe('valid PNG / JPG');
    expect(e.hint).toBe('check file integrity');
  });
});

describe('ASSET_ERROR_HINTS - plan-strategy §7.3 locked literals', () => {
  it('asset-fetch-failed hint matches plan-strategy §7.3 verbatim', () => {
    expect(ASSET_ERROR_HINTS['asset-fetch-failed']).toBe(
      'check url path; verify dev server is running; in tests use data: URL fixture (data:image/png;base64,...)',
    );
  });

  it('asset-parse-failed hint matches plan-strategy §7.3 verbatim', () => {
    expect(ASSET_ERROR_HINTS['asset-parse-failed']).toBe(
      'check file bytes are not corrupted; for procedural geometry: verify all dimensions > 0 and segments >= 1',
    );
  });

  it('asset-format-unsupported hint matches plan-strategy §7.3 verbatim', () => {
    expect(ASSET_ERROR_HINTS['asset-format-unsupported']).toBe(
      'v1 supports png/jpg only; convert .bmp/.webp etc. via image tooling; gltf/glb supported via @forgeax/engine-gltf importer (forgeax asset import <gltf-or-glb> --root <project>)',
    );
  });

  it('asset-not-found hint matches plan-strategy §7.3 verbatim', () => {
    expect(ASSET_ERROR_HINTS['asset-not-found']).toBe(
      'handle id not in registry; verify register() was called before get(); inspect() returns all live handles',
    );
  });

  it('asset-invalid-value hint matches feat-20260518 plan-decisions L-1 verbatim', () => {
    expect(ASSET_ERROR_HINTS['asset-invalid-value']).toBe(
      'a register-time value failed validation; read err.hint for the case-specific fix (e.g. clamp a MaterialAsset param to [0,1], or give a strip-topology MeshAsset an index buffer) and err.detail for the offending field/value',
    );
  });

  it('ASSET_ERROR_HINTS covers all 5 AssetErrorCode members', () => {
    for (const code of ASSET_ERROR_CODES_5) {
      expect(ASSET_ERROR_HINTS[code]).toBeDefined();
      expect(typeof ASSET_ERROR_HINTS[code]).toBe('string');
      expect(ASSET_ERROR_HINTS[code].length).toBeGreaterThan(0);
    }
  });
});

}

{
  // --- from asset.test.ts ---
// asset.test - runtime-level shape assertions for the Asset discriminated union
// + VertexAttributeMap 6-key closed set (AC-09 / AC-15 / AC-21 + D-P1).
//
// Pairs with handle-brand.test-d.ts (type-level Handle<T> brand inequivalence).
// This file owns the runtime-visible surface of the union: `.kind` discriminator
// exhaustive switch compiles without `default:` (charter proposition 4 explicit
// failure), 4 variants carry structurally-required fields, and the
// VertexAttributeMap 6-key literal set is usable at consumption sites.
//
// Anchors: requirements §G7 + §2 row 8 + AC-09 / AC-15 / AC-21; plan-strategy
//          §2 D-P1 + §7.2 + §7.4; research Finding 4 (Three.js buffergeometry
//          lowercase key alignment).


describe('Asset discriminated union - .kind discriminator', () => {
  it("MeshAsset carries .kind === 'mesh' + vertices + indices + attributes", () => {
    const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const mesh: MeshAsset = {
      kind: 'mesh',
      vertices,
      indices,
      attributes: {
        position: vertices,
      },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: indices.length,
          vertexCount: vertices.length,
          topology: 'triangle-list',
        },
      ],
    };
    expect(mesh.kind).toBe('mesh');
    expect(mesh.vertices).toBe(vertices);
    expect(mesh.indices).toBe(indices);
    expect(mesh.attributes.position).toBe(vertices);
  });

  it("MeshAsset accepts an optional topology field (e.g. 'line-list')", () => {
    const vertices = new Float32Array([0, 0, 0, 1, 0, 0]);
    const mesh: MeshAsset = {
      kind: 'mesh',
      vertices,
      indices: new Uint16Array([0, 1]),
      attributes: { position: vertices },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 2,
          vertexCount: vertices.length,
          topology: 'line-list',
        },
      ],
    };
    expect(mesh.submeshes[0]?.topology).toBe('line-list');
  });

  it("TextureAsset carries .kind === 'texture' + POD shape aligned with @webgpu/types", () => {
    const texture: TextureAsset = {
      kind: 'texture',
      width: 4,
      height: 4,
      format: 'rgba8unorm',
      data: new Uint8Array(4 * 4 * 4),
      colorSpace: 'linear',
      mipmap: false,
    };
    expect(texture.kind).toBe('texture');
    expect(texture.width).toBe(4);
    expect(texture.height).toBe(4);
    expect(texture.format).toBe('rgba8unorm');
    expect(texture.colorSpace).toBe('linear');
    expect(texture.mipmap).toBe(false);
  });

  it("SamplerAsset carries .kind === 'sampler' + POD shape aligned with @webgpu/types", () => {
    const sampler: SamplerAsset = {
      kind: 'sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    };
    expect(sampler.kind).toBe('sampler');
    expect(sampler.magFilter).toBe('linear');
  });

  it("MaterialAsset carries .kind === 'material' + pass-based shape (pass-based, w7)", () => {
    const mat: MaterialAsset = {
      kind: 'material',
      passes: [
        { name: 'Forward', program: { module: 'forgeax_material::standard' }, renderState: { tags: { LightMode: 'Forward' }, queue: RenderQueue.Geometry } },
      ],
      values: { baseColor: [1, 0.5, 0.3, 1] },
    };
    expect(mat.kind).toBe('material');
    expect(mat.passes).toHaveLength(1);
    expect(mat.passes?.[0]?.name).toBe('Forward');
    expect(mat.passes?.[0]?.program.module).toBe('forgeax_material::standard');
    expect(mat.passes?.[0]?.renderState.tags).toEqual({ LightMode: 'Forward' });
  });

  it('Asset union resolves to 13 .kind variants; exhaustive switch compiles without default', () => {
    // The dummy function below is the smallest possible "real consumer site"
    // for the .kind discriminator. Removing any one case turns the `never`
    // assignment red (tsc strict + noFallthroughCasesInSwitch).
    function classify(asset: Asset): string {
      switch (asset.kind) {
        case 'mesh':
          return 'mesh';
        case 'texture':
          return 'texture';
        case 'equirect':
          return 'equirect';
        case 'sampler':
          return 'sampler';
        case 'material':
          return `material passes=${asset.passes?.length ?? 0}`;
        case 'scene':
          return 'scene';
        case 'skeleton':
          return `skeleton joints=${asset.jointCount}`;
        case 'skin':
          return `skin skeleton=${asset.skeletonGuid}`;
        case 'animation-clip':
          return `anim-clip duration=${asset.duration}`;
        case 'audio':
          return `audio source=${asset.sourceKey} bytes=${asset.bytes.byteLength}`;
        case 'shader':
          return `shader name=${asset.name}`;
        case 'font':
          return `font glyphs=${Object.keys(asset.glyphs).length}`;
        case 'render-pipeline':
          return `render-pipeline ${asset.pipelineId}`;
      }
    }
    const mesh: MeshAsset = {
      kind: 'mesh',
      vertices: new Float32Array([0, 0, 0]),
      indices: new Uint16Array([0]),
      attributes: {},
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 1,
          vertexCount: 3,
          topology: 'triangle-list',
        },
      ],
    };
    expect(classify(mesh)).toBe('mesh');
  });

  it('MaterialAsset is single-interface pass-based shape (no shadingModel)', () => {
    const mat: MaterialAsset = {
      kind: 'material',
      passes: [
        { name: 'Forward', program: { module: 'forgeax_material::unlit' }, renderState: { tags: { LightMode: 'Forward' }, queue: RenderQueue.Geometry } },
      ],
      values: { baseColor: [1, 1, 1, 1] },
    };
    expect(mat.kind).toBe('material');
    expect(mat.passes).toBeDefined();
    expect(mat.passes?.[0]?.program.module).toBe('forgeax_material::unlit');
  });
});

describe('VertexAttributeMap - 6 lowercase keys closed set (G7 / AC-15)', () => {
  it('accepts all 6 keys: position / normal / uv / tangent / skinIndex / skinWeight', () => {
    const buf = new Float32Array(3);
    const map: VertexAttributeMap = {
      position: buf,
      normal: buf,
      uv: buf,
      tangent: buf,
      skinIndex: buf,
      skinWeight: buf,
    };
    expect(Object.keys(map).sort()).toEqual(
      ['normal', 'position', 'skinIndex', 'skinWeight', 'tangent', 'uv'].sort(),
    );
  });

  it('all 6 keys are optional - empty object is valid', () => {
    const map: VertexAttributeMap = {};
    expect(Object.keys(map)).toHaveLength(0);
  });

  it('consumer `for (const [key] of Object.entries(attributes))` narrows key to the 6-member union', () => {
    // Real consumption site AC-15 evidence: the `for...of` iteration narrows
    // `key` to the 6-member literal union at TypeScript level. This block
    // executes at runtime to prove the narrowing plays well with the real
    // VertexAttributeMap shape (not just a *.test-d.ts assertion).
    const map: VertexAttributeMap = {
      position: new Float32Array([0, 0, 0]),
      normal: new Float32Array([0, 1, 0]),
    };
    const seen: string[] = [];
    for (const [key, buffer] of Object.entries(map)) {
      // `key` is narrowed to keyof VertexAttributeMap here (6-member union).
      seen.push(key);
      expect(buffer).toBeInstanceOf(Float32Array);
    }
    expect(seen.sort()).toEqual(['normal', 'position']);
  });

  it('values accept ArrayBuffer / Float32Array / Uint16Array', () => {
    const ab = new ArrayBuffer(12);
    const f32 = new Float32Array([0, 0, 0]);
    const u16 = new Uint16Array([0, 0, 0]);
    const map: VertexAttributeMap = {
      position: ab,
      normal: f32,
      skinIndex: u16,
    };
    expect(map.position).toBe(ab);
    expect(map.normal).toBe(f32);
    expect(map.skinIndex).toBe(u16);
  });
});

}

{
  // --- from error-codes-material.test.ts ---
// error-codes-material.test.ts - unit test for 7 new error code emit paths
// (M1-T04, feat-20260523-shader-template-instance-split).
//
// Covers:
//   - 5 new ShaderErrorCode members: material-schema-mismatch,
//     material-shader-not-found, material-param-type-mismatch,
//     material-param-unknown, material-param-missing-required
//   - 1 new AssetErrorCode member: material-shader-ref-broken
//   - 1 new PackErrorCode member: payload-schema-mismatch
//
// Each test verifies the error code literal is a member of the corresponding
// closed union and that the detail discriminated union narrows correctly.
//
// Anchors: requirements AC-12 (each new error code requires unit test);
//          plan-strategy D-NewErrorCodes-Anchor (5+1+1 in types SSOT);
//          plan-tasks.json M1-T04 acceptanceCheck.


// === ShaderErrorCode: 5 new material-* members ===

describe('ShaderErrorCode - 5 new material-* members (M1-T02)', () => {
  const newShaderCodes: ReadonlySet<ShaderErrorCode> = new Set([
    'material-schema-mismatch',
    'material-shader-not-found',
    'material-param-type-mismatch',
    'material-param-unknown',
    'material-param-missing-required',
  ]);

  it('all 5 new codes are members of ShaderErrorCode union', () => {
    for (const code of newShaderCodes) {
      expectTypeOf(code).toMatchTypeOf<ShaderErrorCode>();
    }
  });

  it('material-schema-mismatch is a valid ShaderErrorCode literal', () => {
    expectTypeOf<'material-schema-mismatch'>().toMatchTypeOf<ShaderErrorCode>();
  });

  it('material-shader-not-found is a valid ShaderErrorCode literal', () => {
    expectTypeOf<'material-shader-not-found'>().toMatchTypeOf<ShaderErrorCode>();
  });

  it('material-param-type-mismatch is a valid ShaderErrorCode literal', () => {
    expectTypeOf<'material-param-type-mismatch'>().toMatchTypeOf<ShaderErrorCode>();
  });

  it('material-param-unknown is a valid ShaderErrorCode literal', () => {
    expectTypeOf<'material-param-unknown'>().toMatchTypeOf<ShaderErrorCode>();
  });

  it('material-param-missing-required is a valid ShaderErrorCode literal', () => {
    expectTypeOf<'material-param-missing-required'>().toMatchTypeOf<ShaderErrorCode>();
  });

  it('exhaustive switch on ShaderErrorCode (now 12 members) compiles', () => {
    function describeCode(code: ShaderErrorCode): string {
      switch (code) {
        case 'shader-compile-failed':
          return 'compile';
        case 'compiler-init-failed':
          return 'init';
        case 'manifest-malformed':
          return 'manifest';
        case 'shader-not-found':
          return 'not-found';
        case 'shader-import-not-found':
          return 'import';
        case 'shader-circular-import':
          return 'cycle';
        case 'shader-define-conflict':
          return 'define';
        case 'material-schema-mismatch':
          return 'mismatch';
        case 'material-shader-not-found':
          return 'ms-not-found';
        case 'material-param-type-mismatch':
          return 'param-type';
        case 'material-param-unknown':
          return 'param-unknown';
        case 'material-param-missing-required':
          return 'param-missing';
      }
    }
    expect(describeCode('material-schema-mismatch')).toBe('mismatch');
    expect(describeCode('material-shader-not-found')).toBe('ms-not-found');
    expect(describeCode('material-param-type-mismatch')).toBe('param-type');
    expect(describeCode('material-param-unknown')).toBe('param-unknown');
    expect(describeCode('material-param-missing-required')).toBe('param-missing');
  });
});

// === ShaderErrorDetail: 5 new material-* detail variants ===

describe('ShaderErrorDetail - 5 new material-* detail variants (M1-T02)', () => {
  it('material-schema-mismatch detail carries mismatchKind union + materialShaderPath', () => {
    // Test the 4-element mismatchKind union: schema-extra | shader-extra |
    // type-mismatch | bg-overflow (plan-strategy F-6 round 2).
    const detailSchemaExtra: ShaderErrorDetail = {
      code: 'material-schema-mismatch',
      mismatchKind: 'schema-extra',
      expectedParam: 'metallic',
      materialShaderPath: 'my-material.wgsl',
    };
    expect(detailSchemaExtra.mismatchKind).toBe('schema-extra');

    const detailShaderExtra: ShaderErrorDetail = {
      code: 'material-schema-mismatch',
      mismatchKind: 'shader-extra',
      actualBinding: 3,
      materialShaderPath: 'my-material.wgsl',
    };
    expect(detailShaderExtra.mismatchKind).toBe('shader-extra');

    const detailTypeMismatch: ShaderErrorDetail = {
      code: 'material-schema-mismatch',
      mismatchKind: 'type-mismatch',
      expectedParam: 'baseColor',
      actualBinding: 0,
      materialShaderPath: 'my-material.wgsl',
    };
    expect(detailTypeMismatch.mismatchKind).toBe('type-mismatch');

    const detailBgOverflow: ShaderErrorDetail = {
      code: 'material-schema-mismatch',
      mismatchKind: 'bg-overflow',
      actualCount: 5,
      maxAllowed: 4,
      materialShaderPath: 'my-material.wgsl',
    };
    expect(detailBgOverflow.mismatchKind).toBe('bg-overflow');
    expect(detailBgOverflow.actualCount).toBe(5);
    expect(detailBgOverflow.maxAllowed).toBe(4);
  });

  it('material-shader-not-found detail carries identifier field', () => {
    const detail: ShaderErrorDetail = {
      code: 'material-shader-not-found',
      identifier: 'non_existent::shader',
    };
    expect(detail.identifier).toBe('non_existent::shader');
  });

  it('material-param-type-mismatch detail carries paramName + expectedType + actualValue', () => {
    const detail: ShaderErrorDetail = {
      code: 'material-param-type-mismatch',
      paramName: 'roughness',
      expectedType: 'f32',
      actualValue: 'smooth',
    };
    expect(detail.paramName).toBe('roughness');
    expect(detail.expectedType).toBe('f32');
    expect(detail.actualValue).toBe('smooth');
  });

  it('material-param-unknown detail carries paramName field', () => {
    const detail: ShaderErrorDetail = {
      code: 'material-param-unknown',
      paramName: 'extraField',
    };
    expect(detail.paramName).toBe('extraField');
  });

  it('material-param-missing-required detail carries paramName field', () => {
    const detail: ShaderErrorDetail = {
      code: 'material-param-missing-required',
      paramName: 'roughness',
    };
    expect(detail.paramName).toBe('roughness');
  });

  it('narrowing on detail.code surfaces per-variant payload (all 5 new variants)', () => {
    function inspect(detail: ShaderErrorDetail): string {
      switch (detail.code) {
        case 'shader-import-not-found':
          return `import:${detail.importPath}`;
        case 'shader-circular-import':
          return `cycle:${detail.cycle.length}`;
        case 'shader-define-conflict':
          return `define:${detail.defineName}`;
        case 'shader-compile-failed':
          return `compile:${detail.compilerMessages.length}`;
        case 'compiler-init-failed':
          return `init:${detail.reason ?? 'none'}`;
        case 'manifest-malformed':
          return `manifest:${detail.reason ?? 'none'}`;
        case 'material-schema-mismatch':
          return `mismatch:${detail.mismatchKind}:${detail.materialShaderPath}`;
        case 'material-shader-not-found':
          return `ms-not-found:${detail.identifier}`;
        case 'material-param-type-mismatch':
          return `param-type:${detail.paramName}:${detail.expectedType}`;
        case 'material-param-unknown':
          return `param-unknown:${detail.paramName}`;
        case 'material-param-missing-required':
          return `param-missing:${detail.paramName}`;
      }
    }
    expect(
      inspect({
        code: 'material-schema-mismatch',
        mismatchKind: 'type-mismatch',
        expectedParam: 'baseColor',
        actualBinding: 1,
        materialShaderPath: 'x.wgsl',
      }),
    ).toBe('mismatch:type-mismatch:x.wgsl');
    expect(
      inspect({
        code: 'material-shader-not-found',
        identifier: 'forgeax::foo',
      }),
    ).toBe('ms-not-found:forgeax::foo');
    expect(
      inspect({
        code: 'material-param-type-mismatch',
        paramName: 'roughness',
        expectedType: 'f32',
        actualValue: 'high',
      }),
    ).toBe('param-type:roughness:f32');
    expect(
      inspect({
        code: 'material-param-unknown',
        paramName: 'extra',
      }),
    ).toBe('param-unknown:extra');
    expect(
      inspect({
        code: 'material-param-missing-required',
        paramName: 'roughness',
      }),
    ).toBe('param-missing:roughness');
  });
});

// === AssetErrorCode: 1 new member ===

describe('AssetErrorCode - 1 new member (M1-T02)', () => {
  it('material-shader-ref-broken is a valid AssetErrorCode literal', () => {
    expectTypeOf<'material-shader-ref-broken'>().toMatchTypeOf<AssetErrorCode>();
  });

  it('exhaustive switch on AssetErrorCode (now 23 members) compiles', () => {
    function describe(code: AssetErrorCode): string {
      switch (code) {
        case 'asset-not-found':
          return 'not-found';
        case 'asset-parse-failed':
          return 'parse';
        case 'asset-format-unsupported':
          return 'format';
        case 'asset-fetch-failed':
          return 'fetch';
        case 'catalog-source-unconfigured':
          return 'catalog-source-unconfigured';
        case 'asset-invalid-value':
          return 'invalid';
        case 'cubemap-handle-missing':
          return 'cubemap';
        case 'invalid-source-format':
          return 'source-fmt';
        case 'load-failed':
          return 'load';
        case 'device-unsupported':
          return 'device';
        case 'ibl-precompute-not-dispatched':
          return 'ibl';
        case 'mesh-vertex-stride-mismatch':
          return 'mesh-stride';
        case 'material-shader-ref-broken':
          return 'ref-broken';
        // === 1 new code (feat-20260526-material-asset-multipass-renderstate M1 / w6) ===
        case 'material-circular-inheritance':
          return 'circular-inheritance';
        // === 2 new codes (feat-20260603-asset-import-loader-injection M1 / w1) ===
        case 'loader-not-registered':
          return 'loader-not-registered';
        case 'asset-not-imported':
          return 'asset-not-imported';
        // === 1 new code (feat-20260604-hdr-equirect-cube-importer-loader M2 / w4) ===
        case 'texture-source-not-imported':
          return 'texture-source-not-imported';
        // === Mesh slot and renderer override diagnostics ===
        case 'mesh-renderer-material-override-invalid':
          return 'mesh-renderer-material-override-invalid';
        case 'mesh-renderer-material-override-overflow':
          return 'mesh-renderer-material-override-overflow';
        case 'mesh-asset-submeshes-empty':
          return 'mesh-asset-submeshes-empty';
        case 'mesh-asset-material-slot-index-out-of-range':
          return 'mesh-asset-material-slot-index-out-of-range';
        case 'mesh-submesh-index-range-out-of-bounds':
          return 'mesh-submesh-index-range-out-of-bounds';
        // === 1 new code (feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild) ===
        case 'tileset-region-index-out-of-range':
          return 'tileset-region-index-out-of-range';
        // === 1 new code (feat-20260608-tilemap-object-layer-rendering M1 schema extension) ===
        case 'tileset-tile-entry-malformed':
          return 'tileset-tile-entry-malformed';
        // === 1 new code (feat-20260621-asset-registry-robustness M2 / w4) ===
        case 'asset-invalidated':
          return 'asset-invalidated';
        // === 1 new code (feat-20260629-multi-uv-set-support M2 / m2-w5) ===
        case 'mesh-bin-contract-violation':
          return 'mesh-bin-contract-violation';
        // === 1 new code (perf-20260706 raw-container fail-fast, #620) ===
        case 'source-not-imported':
          return 'source-not-imported';
        // === 1 new code (feat-20260707-texture-block-compression M5 / w35) ===
        case 'mipgen-unsupported-compressed-format':
          return 'mipgen-unsupported-compressed-format';
      }
    }
    expect(describe('material-shader-ref-broken')).toBe('ref-broken');
  });
});

// === AssetErrorDetail: 1 new variant ===

describe('AssetErrorDetail - 1 new material-shader-ref-broken variant (M1-T02)', () => {
  it('material-shader-ref-broken detail carries materialAssetGuid + missingShaderId', () => {
    const detail: AssetErrorDetail = {
      code: 'material-shader-ref-broken',
      materialAssetGuid: '550e8400-e29b-41d4-a716-446655440000',
      missingShaderId: 'forgeax::unknown',
    };
    expect(detail.materialAssetGuid).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(detail.missingShaderId).toBe('forgeax::unknown');
  });
});

// === PackErrorCode: 1 new member ===

describe('PackErrorCode - 1 new member (M1-T02)', () => {
  it('payload-schema-mismatch is a valid PackErrorCode literal', () => {
    expectTypeOf<'payload-schema-mismatch'>().toMatchTypeOf<PackErrorCode>();
  });

  it('exhaustive switch on PackErrorCode (now 9 members) compiles', () => {
    function describe(code: PackErrorCode): string {
      switch (code) {
        case 'pack-malformed-meta':
          return 'meta';
        case 'pack-malformed-pack':
          return 'pack';
        case 'pack-guid-malformed':
          return 'guid';
        case 'pack-orphan-meta':
          return 'orphan';
        case 'pack-meta-missing':
          return 'missing';
        case 'pack-guid-collision':
          return 'collision';
        case 'pack-cyclic-reference':
          return 'cycle';
        case 'pack-subasset-index-out-of-range':
          return 'oob';
        case 'payload-schema-mismatch':
          return 'payload';
      }
    }
    expect(describe('payload-schema-mismatch')).toBe('payload');
  });
});

// === PackErrorDetail: 1 new variant ===

describe('PackErrorDetail - 1 new payload-schema-mismatch variant (M1-T02)', () => {
  it('payload-schema-mismatch detail carries guid + errors (AjvError[])', () => {
    const detail: PackErrorDetail = {
      code: 'payload-schema-mismatch',
      guid: '550e8400-e29b-41d4-a716-446655440000',
      errors: [{ instancePath: '/paramSchema/0/type', message: 'must be equal to constant' }],
    };
    expect(detail.guid).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(detail.errors.length).toBe(1);
    expect(detail.errors[0]?.instancePath).toBe('/paramSchema/0/type');
  });
});

}

{
  // --- from font-asset-union.test.ts ---
// font-asset-union.test.ts — type-level assertions: Asset union = 12
// members, FontAsset exhaustive switch, Handle<FontAsset> narrow via TagOf
// (feat-20260531-world-space-msdf-text-rendering M2 / w8).
//
// Decision anchors:
//   - requirements AC-04 (Asset union 11->12, members = 12)
//   - requirements AC-17 (Handle<FontAsset> narrow via TagOf and asset.get)
//   - plan-strategy 5.3 key test points (AC-04/AC-17 type)
//   - charter P4 (consistent abstraction: new asset kind follows same switch
//     pattern as all others)


// --- Asset union member count = 12 ---

describe('Asset union member count = 12 (AC-04)', () => {
  it('FontAsset is assignable to Asset', () => {
    // If FontAsset were not in the Asset union, this would not compile.
    const fontAsset: Asset = null as unknown as FontAsset;
    expectTypeOf(fontAsset).not.toBeUndefined();
  });

  it('Asset.kind includes font (literal narrow)', () => {
    const fontAsset: FontAsset = {
      kind: 'font',
      atlas: 0 as unknown as FontAsset['atlas'],
      sampler: 0 as unknown as FontAsset['sampler'],
      glyphs: {},
      common: {
        lineHeight: 0,
        base: 0,
        distanceRange: 4,
        pxRange: 32,
        atlasWidth: 1024,
        atlasHeight: 1024,
      },
    };
    // Narrow from Asset to FontAsset via kind discriminator — no 'as' assertion
    const asset: Asset = fontAsset;
    if (asset.kind === 'font') {
      // TypeScript should narrow asset to FontAsset here
      const glyphCount = Object.keys(asset.glyphs).length;
      expectTypeOf(glyphCount).toEqualTypeOf<number>();
      // Verify specific FontAsset fields are narrowed (not just any Asset)
      const common = asset.common;
      expectTypeOf(common).toMatchTypeOf<{
        readonly lineHeight: number;
        readonly base: number;
        readonly distanceRange: number;
        readonly pxRange: number;
        readonly atlasWidth: number;
        readonly atlasHeight: number;
      }>();
    }
  });

  it('exhaustive switch on asset.kind has 13 arms (no default)', () => {
    // This function must compile without a default arm — TypeScript's
    // exhaustive switch checks that every member is covered. If the union
    // ever drifts, adding or removing a case without updating this function
    // causes a compile-time error (Type 'Xxx' is not assignable to 'never').
    function exhaustiveTag(asset: Asset): string {
      switch (asset.kind) {
        case 'mesh':
          return `mesh`;
        case 'texture':
          return `texture`;
        case 'equirect':
          return `equirect`;
        case 'sampler':
          return `sampler`;
        case 'material':
          return `material`;
        case 'scene':
          return `scene`;
        case 'skeleton':
          return `skeleton`;
        case 'skin':
          return `skin`;
        case 'animation-clip':
          return `animation-clip`;
        case 'audio':
          return `audio`;
        case 'shader':
          return `shader`;
        case 'font':
          return `font`;
        case 'render-pipeline':
          return `render-pipeline`;
      }
    }
    expectTypeOf(exhaustiveTag).returns.toEqualTypeOf<string>();
  });
});

// --- TagOf narrow: Handle<FontAsset> resolves correctly ---

describe('TagOf<FontAsset> narrows to FontAsset brand (AC-17)', () => {
  it('TagOf<FontAsset> = FontAsset', () => {
    expectTypeOf<TagOf<FontAsset>>().toEqualTypeOf<'FontAsset'>();
  });

  it('TagOf<Asset> distributes to include FontAsset', () => {
    // TagOf<Asset> is a distributive conditional — it resolves to the
    // union of all brand string literals. If FontAsset were missing
    // from AssetTagMap, this would resolve to 'FontAsset' being never.
    type AllBrands = TagOf<Asset>;
    // This assertion compiles only if FontAsset contributes 'FontAsset'
    // to the union.
    const _brand: AllBrands = 'FontAsset';
    expectTypeOf(_brand).toEqualTypeOf<'FontAsset'>();
  });
});

// --- GlyphMetric POD shape ---

describe('GlyphMetric POD shape', () => {
  it('GlyphMetric has required fields 1:1 BMFont char mapping', () => {
    const gm: GlyphMetric = {
      advance: 8,
      bearingX: 1,
      bearingY: 10,
      size: { w: 12, h: 14 },
      region: { x: 256, y: 512, w: 64, h: 72 },
    };
    expectTypeOf(gm.advance).toEqualTypeOf<number>();
    expectTypeOf(gm.bearingX).toEqualTypeOf<number>();
    expectTypeOf(gm.bearingY).toEqualTypeOf<number>();
    expectTypeOf(gm.size.w).toEqualTypeOf<number>();
    expectTypeOf(gm.size.h).toEqualTypeOf<number>();
    expectTypeOf(gm.region.x).toEqualTypeOf<number>();
    expectTypeOf(gm.region.y).toEqualTypeOf<number>();
    expectTypeOf(gm.region.w).toEqualTypeOf<number>();
    expectTypeOf(gm.region.h).toEqualTypeOf<number>();
  });

  // Negative: math-free constraint — GlyphMetric uses plain number,
  // no branded Vec2/Vec4 types.
  it('GlyphMetric fields are plain number (math-free)', () => {
    type AdvanceType = GlyphMetric['advance'];
    // If advance were a branded math type (e.g. Vec2), this would fail.
    // We assert it's plain 'number':
    expectTypeOf<AdvanceType>().toEqualTypeOf<number>();
  });
});

}

{
  // --- from font-error-code.test.ts ---
// font-error-code.test.ts — type-level assertions: FontErrorCode /
// TextErrorCode closed unions + structured FontError/TextError classes
// (feat-20260531-world-space-msdf-text-rendering M2 / w8).
//
// Decision anchors:
//   - requirements AC-15 (non-TTF -> FontErrorCode 'unsupported-font-format')
//   - requirements AC-16 (both closed unions in types/src/index.ts;
//     exhaustive switch(err.code) compiles without default;
//     .code/.hint/.expected/.detail fields)
//   - requirements AC-20 (font-concurrency > 8 -> TextErrorCode
//     'font-concurrency-exceeded')
//   - plan-strategy D-11 (FontErrorCode = build/load; TextErrorCode =
//     runtime layout; structured classes follow AssetError pattern)
//   - charter P3 (explicit failure: structured error accessible via
//     property access, never string parsing)
//
// The exhaustive switch tests double as negative regression: removing any
// case from the union member list produces a `Type '...' is not assignable
// to type 'never'` compile-time error because the switch would have an
// unreachable arm.


// --- FontErrorCode union membership ---

describe('FontErrorCode closed union (AC-16)', () => {
  it('has 4 members and exhaustive switch compiles without default', () => {
    // If any member is added/removed without updating this switch,
    // TypeScript raises "Type '...' is not assignable to type 'never'".
    function mapFontError(code: FontErrorCode): string {
      switch (code) {
        case 'unsupported-font-format':
          return 'not TTF';
        case 'font-atlas-missing':
          return 'no atlas';
        case 'font-atlas-corrupted':
          return 'bad sidecar';
        case 'bake-failed':
          return 'zappar error';
      }
    }
    expect(mapFontError('unsupported-font-format')).toBe('not TTF');
    expect(mapFontError('font-atlas-missing')).toBe('no atlas');
    expect(mapFontError('font-atlas-corrupted')).toBe('bad sidecar');
    expect(mapFontError('bake-failed')).toBe('zappar error');
  });
});

// --- TextErrorCode union membership ---

describe('TextErrorCode closed union (AC-16)', () => {
  it('has 3 members and exhaustive switch compiles without default', () => {
    function mapTextError(code: TextErrorCode): string {
      switch (code) {
        case 'font-concurrency-exceeded':
          return 'too many fonts';
        case 'font-atlas-missing':
          return 'atlas not loaded';
        case 'glyph-layout-failed':
          return 'layout broken';
      }
    }
    expect(mapTextError('font-concurrency-exceeded')).toBe('too many fonts');
    expect(mapTextError('font-atlas-missing')).toBe('atlas not loaded');
    expect(mapTextError('glyph-layout-failed')).toBe('layout broken');
  });
});

// --- FontError structured class ---

describe('FontError structured class (AC-16)', () => {
  it('has .code / .expected / .hint fields following AssetError pattern', () => {
    const err = new FontError({
      code: 'unsupported-font-format',
      expected: 'ttf',
      hint: 'supply a .ttf file instead',
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FontError');
    expect(err.code).toBe('unsupported-font-format');
    expect(err.expected).toBe('ttf');
    expect(err.hint).toBe('supply a .ttf file instead');
    expect(typeof err.message).toBe('string');
  });

  it('.code type narrows to FontErrorCode (no string widen)', () => {
    const err = new FontError({
      code: 'bake-failed',
      expected: 'successful bake',
      hint: 'check zappar wasm availability',
    });

    const code: FontErrorCode = err.code;
    // If FontError.code were typed as `string`, the exhaustiveness check
    // in mapFontError would not guard — this assertion confirms the code
    // type is the closed union, not a widened string.
    expectTypeOf(code).toEqualTypeOf<FontErrorCode>();
  });

  it('optional .detail carries structured payload', () => {
    const err = new FontError({
      code: 'bake-failed',
      expected: 'successful bake',
      hint: 'check zappar wasm availability',
      detail: { cause: 'WASM module failed to instantiate' },
    });

    expect(err.detail).toEqual({ cause: 'WASM module failed to instantiate' });
  });

  it('.detail is undefined when not provided', () => {
    const err = new FontError({
      code: 'font-atlas-corrupted',
      expected: 'valid JSON',
      hint: 're-bake the font',
    });

    expect(err.detail).toBeUndefined();
  });
});

// --- TextError structured class ---

describe('TextError structured class (AC-16)', () => {
  it('has .code / .expected / .hint fields', () => {
    const err = new TextError({
      code: 'font-concurrency-exceeded',
      expected: '<= 8',
      hint: 'reduce active font count or reuse existing fonts',
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TextError');
    expect(err.code).toBe('font-concurrency-exceeded');
    expect(err.expected).toBe('<= 8');
    expect(err.hint).toBe('reduce active font count or reuse existing fonts');
  });

  it('.code type narrows to TextErrorCode (no string widen)', () => {
    const err = new TextError({
      code: 'glyph-layout-failed',
      expected: 'valid FontAsset glyphs',
      hint: 'verify FontAsset common block fields',
    });

    const code: TextErrorCode = err.code;
    expectTypeOf(code).toEqualTypeOf<TextErrorCode>();
  });
});

// --- Error object property access (no string parsing) ---

describe('AI-user property access (P3 explicit failure)', () => {
  it('FontErrorCode members are accessible via switch exhaustiveness', () => {
    // Use a function parameter so TypeScript sees the full union type
    // and does not narrow to the specific literal.
    function mapAllCodes(code: FontErrorCode): string {
      switch (code) {
        case 'unsupported-font-format':
          return 'OTF/WOFF2 not supported';
        case 'font-atlas-missing':
          return 'atlas texture needs loading';
        case 'font-atlas-corrupted':
          return 'sidecar JSON invalid';
        case 'bake-failed':
          return 'zappar call threw';
      }
    }
    expect(mapAllCodes('font-atlas-missing')).toBe('atlas texture needs loading');
  });

  it('TextErrorCode members are accessible via switch exhaustiveness', () => {
    function mapAllCodes(code: TextErrorCode): string {
      switch (code) {
        case 'font-concurrency-exceeded':
          return '> 8 concurrent fonts';
        case 'font-atlas-missing':
          return 'atlas not ready';
        case 'glyph-layout-failed':
          return 'layout broken';
      }
    }
    expect(mapAllCodes('font-concurrency-exceeded')).toBe('> 8 concurrent fonts');
  });
});

}

{
  // --- from inspector-client.test.ts ---
// inspector-client.test - runtime assertions for the new
// `@forgeax/engine-types/inspector-client` module (feat-20260517 w4 / D-3
// F2-alpha). The module physically extracts `defaultConnect` from
// `@forgeax/engine-remote/src/cli.ts:367-451` so the WS-JSON-RPC 2.0
// client becomes a single SSOT shared by `@forgeax/engine-remote` (base
// CLI) and the inspection client.
//
// Three assertions (locked by plan-tasks w4):
//   (a) `defaultConnect(url)` resolves to an object with `execute(script)`
//       + `dispose()` shape (charter P5 consistent abstraction — single
//       method-injection surface for inspection scripts).
//   (b) `ConnectFn` type alias is exported and may be consumed by
//       downstream packages.
//   (c) On WS connect failure, returns
//       `Result.err(InspectorError 'console-not-running')` with the
//       four structured fields (charter P3 explicit failure).
//
// Anchors: plan-strategy §2 D-3 F2-alpha (defaultConnect extracted to
// types as wire-protocol client SSOT); §4 risk R7 (types package shape
// drift coverage); requirements AC-06 / AC-08 (inspection reuses the same
// client function literal as the base CLI).


describe('@forgeax/engine-types/inspector-client - defaultConnect (feat-20260517 D-3)', () => {
  it('exports ConnectFn type consumable by downstream packages', () => {
    expectTypeOf<ConnectFn>().toEqualTypeOf<(url: string) => Promise<InspectorClientResult>>();
  });

  it('returns Result.err with server-not-running on unreachable WS port (charter P3 explicit failure)', async () => {
    // Pick a port unlikely to be bound (in the ephemeral range above the
    // documented inspector default 5732 and monitor 5731). The connect
    // attempt should fail fast with the structured InspectorError shape;
    // tests run in node so the ws import resolves to the real lib and
    // we exercise the actual failure path rather than mocking it out.
    const result = await defaultConnect('ws://127.0.0.1:1/inspector');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok=false on unreachable port');
    expect(result.error.code).toBe('server-not-running');
    expect(typeof result.error.expected).toBe('string');
    expect(typeof result.error.hint).toBe('string');
    // Structural InspectorError: 4-field surface (.code, .expected, .hint,
    // and the inherited Error .message); plan-strategy D-3 freezes the
    // existing 6-member InspectorErrorCode union so 'console-not-running'
    // is the only value that surfaces on connect-time failure.
    expect(result.error.expected.length).toBeGreaterThan(0);
    expect(result.error.hint.length).toBeGreaterThan(0);
  });

  it('client object exposes execute(script) + dispose() on success (charter P5 consistent abstraction)', () => {
    // We only assert the structural shape here — actual successful
    // connection + RPC roundtrip is exercised by inspector-demo e2e in
    // M3 (AC-09). The type-level shape lock is sufficient for w4 because
    // the runtime body in w5 ships the same recipe as the legacy
    // console/cli.ts:402-417 (ws.send JSON.stringify envelope per call).
    expectTypeOf<InspectorClient['execute']>().toEqualTypeOf<
      (script: string) => Promise<unknown>
    >();
    expectTypeOf<InspectorClient['dispose']>().toEqualTypeOf<() => Promise<void>>();
  });
});

}

{
  // --- from material-param-types.test.ts ---
// material-param-types.test.ts - unit test for MATERIAL_PARAM_TYPES SSOT and
// ParamSchemaEntry type shape.
//
// Assertions (post feat-20260613 fix-issue-4 V1-Set deletion):
// - MATERIAL_PARAM_TYPES is a 17-member readonly tuple — the single SSOT
//   for paramSchema entry types (no V1/V2 dual-path).
// - Each member is a valid WGSL scalar/vector/sampler/texture type literal.
// - ParamSchemaEntry[] is usable as a type alias over the discriminated
//   union (Numeric / TextureBinding / StorageBinding families).
//
// Anchors: requirements section 3.4 (17 entries after texture_external);
//          plan-strategy D-7 paramSchema type set v2.


const EXPECTED_TYPES: ReadonlySet<string> = new Set([
  'f32',
  'i32',
  'u32',
  'vec2',
  'vec3',
  'vec4',
  'color',
  'texture2d',
  'texture_cube',
  'texture_depth_2d',
  'texture_cube_array',
  'sampler',
  'sampler_comparison',
  'storage_buffer',
  'texture_external',
]);

describe('MATERIAL_PARAM_TYPES - 17-tuple SSOT (post fix-issue-4)', () => {
  it('has exactly 17 members', () => {
    expect(MATERIAL_PARAM_TYPES.length).toBe(17);
  });

  it('contains all 15 expected WGSL-compatible type literals', () => {
    const set = new Set(MATERIAL_PARAM_TYPES);
    for (const t of EXPECTED_TYPES) {
      expect(set.has(t)).toBe(true);
    }
  });

  it('each member is a valid non-empty string', () => {
    for (const t of MATERIAL_PARAM_TYPES) {
      expect(typeof t).toBe('string');
      expect(t.length).toBeGreaterThan(0);
    }
  });
});

describe('ParamSchemaEntry - 3-field interface shape', () => {
  it('has exact 3 fields: name, type, default?', () => {
    const entry: ParamSchemaEntry = {
      name: 'baseColor',
      type: 'color',
      default: [1, 1, 1],
    };
    expect(entry.name).toBe('baseColor');
    expect(entry.type).toBe('color');
    expect(entry.default).toEqual([1, 1, 1]);
  });

  it('default is optional (undefined when absent)', () => {
    const entry: ParamSchemaEntry = {
      name: 'roughness',
      type: 'f32',
    };
    expect(entry.name).toBe('roughness');
    expect(entry.type).toBe('f32');
    expect(entry.default).toBeUndefined();
  });

  it('type-level: name is string', () => {
    expectTypeOf<ParamSchemaEntry['name']>().toEqualTypeOf<string>();
  });

  it('type-level: type is string', () => {
    expectTypeOf<ParamSchemaEntry['type']>().toEqualTypeOf<string>();
  });

  it('type-level: default is string | number | boolean | unknown[] | undefined', () => {
    // default is optional and can hold any literal default value.
    expectTypeOf<ParamSchemaEntry['default']>().toEqualTypeOf<unknown | undefined>();
  });

  it('ParamSchemaEntry[] is a usable array type alias', () => {
    const schema: ParamSchemaEntry[] = [
      { name: 'baseColor', type: 'color', default: [1, 1, 1] },
      { name: 'metallic', type: 'f32', default: 1.0 },
    ];
    expect(schema.length).toBe(2);
    expect(schema[0]?.name).toBe('baseColor');
    expect(schema[1]?.type).toBe('f32');
  });
});

}

{
  // --- from mesh-asset-indices-optional.test.ts ---
// mesh-asset-indices-optional.test - M2 / w3 (TDD).
//
// Asserts MeshAsset.indices is OPTIONAL: a vertex-only mesh value (no
// `indices` key) typechecks, while existing producers that pass `indices`
// explicitly stay valid byte-for-byte. Under exactOptionalPropertyTypes a
// vertex-only literal simply omits the key (no `indices: undefined`).
//
// Anchors: requirements AC-02 (zero-break) + AC-07 (vertex-only path);
//          plan-strategy D-A1 (indices -> optional); research Finding 9.


describe('w3 - MeshAsset.indices optional', () => {
  it('a vertex-only mesh value (no indices key) typechecks', () => {
    const vertices = new Float32Array([0, 0, 0, 1, 0, 0]);
    const topology: PrimitiveTopology = 'line-list';
    const mesh: MeshAsset = {
      kind: 'mesh',
      vertices,
      attributes: { position: vertices },
      submeshes: [{ indexOffset: 0, indexCount: 0, vertexCount: vertices.length, topology }],
    };
    expect(mesh.indices).toBeUndefined();
    expect(mesh.submeshes[0]?.topology).toBe('line-list');
  });

  it('an indexed mesh value (explicit indices) still typechecks unchanged', () => {
    const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const mesh: MeshAsset = {
      kind: 'mesh',
      vertices,
      indices,
      attributes: { position: vertices },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: indices.length,
          vertexCount: vertices.length,
          topology: 'triangle-list',
        },
      ],
    };
    expect(mesh.indices).toBe(indices);
  });

  it('indices, when present, accepts both Uint16Array and Uint32Array', () => {
    const vertices = new Float32Array(12);
    const u16: MeshAsset = {
      kind: 'mesh',
      vertices,
      indices: new Uint16Array([0]),
      attributes: {},
      submeshes: [
        { indexOffset: 0, indexCount: 1, vertexCount: vertices.length, topology: 'triangle-list' },
      ],
    };
    const u32: MeshAsset = {
      kind: 'mesh',
      vertices,
      indices: new Uint32Array([0]),
      attributes: {},
      submeshes: [
        { indexOffset: 0, indexCount: 1, vertexCount: vertices.length, topology: 'triangle-list' },
      ],
    };
    expect(u16.indices instanceof Uint16Array).toBe(true);
    expect(u32.indices instanceof Uint32Array).toBe(true);
  });
});

}

{
  // --- from pack-index-entry.test.ts ---
// pack-index-entry.test - structural assertions for PackIndexEntry +
// ImageMetadata POD shapes (feat-20260517 M1 w1).
//
// Covers:
//   - PackIndexEntry exposes 4 core fields + optional `metadata`
//   - ImageMetadata 6 fields (kind / width / height / format / colorSpace / mipmap)
//   - Legacy 4-field literals stay assignable (backward compat per D-2)
//   - Texture row carrying full metadata sub-structure type-checks
//   - colorSpace / mipmap narrow to literal unions / boolean
//
// Anchors: plan-strategy D-2 (5-field metadata sub-structure SSOT) + D-5
//          (sidecar mipmap string mapped at catalog builder; runtime sees
//          boolean) + AGENTS.md AI-user charter P4 (consistent abstraction:
//          metadata field names mirror TextureAsset POD field names).


describe('PackIndexEntry - 4 core fields + optional metadata', () => {
  it('legacy 4-field row (kind: pack) stays assignable without metadata', () => {
    const legacy: PackIndexEntry = {
      guid: '01890000-0000-7000-8000-000000000001',
      packageUrl: '/apps/demo/assets/cube.pack.json',
      kind: 'mesh',
      sourcePath: 'apps/demo/assets/cube.pack.json',
    };
    expect(legacy.guid).toBe('01890000-0000-7000-8000-000000000001');
    expect(legacy.metadata).toBeUndefined();
  });

  it('texture row carries metadata sub-structure with all 5 fields', () => {
    const row: PackIndexEntry = {
      guid: '0198abcd-0000-7000-8000-000000000002',
      packageUrl: '/apps/demo/assets/wood-container.jpg',
      kind: 'texture',
      sourcePath: 'apps/demo/assets/wood-container.jpg',
      metadata: {
        kind: 'texture',
        width: 256,
        height: 256,
        format: 'rgba8unorm-srgb',
        colorSpace: 'srgb',
        mipmap: true,
      },
    };
    const meta = row.metadata;
    if (meta === undefined || meta.kind !== 'texture') return;
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
    expect(meta.format).toBe('rgba8unorm-srgb');
    expect(meta.colorSpace).toBe('srgb');
    expect(meta.mipmap).toBe(true);
  });

  it('metadata may omit width / height (dev-mode pre-decode rows)', () => {
    const row: PackIndexEntry = {
      guid: '0198abcd-0000-7000-8000-000000000003',
      packageUrl: '/apps/demo/assets/banner.png',
      kind: 'texture',
      sourcePath: 'apps/demo/assets/banner.png',
      metadata: {
        kind: 'texture',
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mipmap: false,
      },
    };
    const meta2 = row.metadata;
    if (meta2 === undefined || meta2.kind !== 'texture') return;
    expect(meta2.width).toBeUndefined();
    expect(meta2.height).toBeUndefined();
    expect(meta2.format).toBe('rgba8unorm');
    expect(meta2.colorSpace).toBe('linear');
    expect(meta2.mipmap).toBe(false);
  });
});

describe('ImageMetadata - 6 fields (kind discriminator + 5 data fields) aligned with TextureAsset POD', () => {
  it('format accepts GPUTextureFormat values (rgba8unorm / rgba8unorm-srgb)', () => {
    const linear: ImageMetadata = {
      kind: 'texture',
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mipmap: false,
    };
    const srgb: ImageMetadata = {
      kind: 'texture',
      width: 1024,
      height: 1024,
      format: 'rgba8unorm-srgb',
      colorSpace: 'srgb',
      mipmap: true,
    };
    expect(linear.format).toBe('rgba8unorm');
    expect(srgb.format).toBe('rgba8unorm-srgb');
  });

  it('colorSpace narrows to "srgb" | "linear" literal union', () => {
    const a: ImageMetadata['colorSpace'] = 'srgb';
    const b: ImageMetadata['colorSpace'] = 'linear';
    expect(a).toBe('srgb');
    expect(b).toBe('linear');
  });

  it('mipmap narrows to boolean (D-5: sidecar string mapped at catalog builder)', () => {
    const enabled: ImageMetadata['mipmap'] = true;
    const disabled: ImageMetadata['mipmap'] = false;
    expect(enabled).toBe(true);
    expect(disabled).toBe(false);
  });
});

}

{
  // --- from shader-errors.test.ts ---
// shader-errors.test - type-level + runtime assertions for the 7-member closed
// `ShaderErrorCode` union and the discriminated `ShaderErrorDetail` union
// (feat-20260512-naga-oil-composition-hmr M3 T-08 red / T-09 green;
// feat-small-20260513-dx-docs-types-cleanup M1-T1 D-9 minor-add: 3 -> 6
// variants).
//
// Assertions:
// - `ShaderErrorCode` spans exactly 7 literal members. Exhaustive
//   `switch (code)` without `default:` compiles under tsc strict (charter
//   proposition 4 explicit failure).
// - `ShaderErrorDetail` discriminated union spans 6 typed variants keyed on
//   `code` (legacy 3: `shader-import-not-found` / `shader-circular-import` /
//   `shader-define-conflict`; D-9 add: `shader-compile-failed` /
//   `compiler-init-failed` / `manifest-malformed`). Narrowing on
//   `detail.code` surfaces the per-variant payload (importPath / cycle /
//   sites / compilerMessages / reason) without `as` casts.
//
// Anchors: plan-strategy §2 D-08 (7 members + 3 new typed variants,
// parallel to RhiErrorDetail); plan-strategy §2 D-PS-2 (4-file co-edit
// types -> naga -> shader-compiler -> rhi); requirements §AC-08
// (ShaderErrorCode 4 -> 7); architecture-principles #1 SSOT
// (packages/types/src/index.ts owns the 7 literals + 6 typed variants;
// no drift across producer sites).


const SHADER_ERROR_CODES_7: ReadonlySet<ShaderErrorCode> = new Set<ShaderErrorCode>([
  'shader-compile-failed',
  'compiler-init-failed',
  'manifest-malformed',
  'shader-not-found',
  'shader-import-not-found',
  'shader-circular-import',
  'shader-define-conflict',
]);

describe('ShaderErrorCode closed union - 7 members', () => {
  it('contains the 4 legacy members (position locked, no rename/delete)', () => {
    expect(SHADER_ERROR_CODES_7.has('shader-compile-failed')).toBe(true);
    expect(SHADER_ERROR_CODES_7.has('compiler-init-failed')).toBe(true);
    expect(SHADER_ERROR_CODES_7.has('manifest-malformed')).toBe(true);
    expect(SHADER_ERROR_CODES_7.has('shader-not-found')).toBe(true);
  });

  it('contains the 3 new M3 members (feat-20260512)', () => {
    expect(SHADER_ERROR_CODES_7.has('shader-import-not-found')).toBe(true);
    expect(SHADER_ERROR_CODES_7.has('shader-circular-import')).toBe(true);
    expect(SHADER_ERROR_CODES_7.has('shader-define-conflict')).toBe(true);
    expect(SHADER_ERROR_CODES_7.size).toBe(7);
  });

  it('exhaustive switch (code) without default compiles under tsc strict', () => {
    function describeCode(code: ShaderErrorCode): string {
      switch (code) {
        case 'shader-compile-failed':
          return 'compile';
        case 'compiler-init-failed':
          return 'init';
        case 'manifest-malformed':
          return 'manifest';
        case 'shader-not-found':
          return 'not-found';
        case 'shader-import-not-found':
          return 'import';
        case 'shader-circular-import':
          return 'cycle';
        case 'shader-define-conflict':
          return 'define';
        // === 5 new material-* codes (feat-20260523-shader-template-instance-split M1-T02) ===
        case 'material-schema-mismatch':
          return 'mismatch';
        case 'material-shader-not-found':
          return 'ms-not-found';
        case 'material-param-type-mismatch':
          return 'param-type';
        case 'material-param-unknown':
          return 'param-unknown';
        case 'material-param-missing-required':
          return 'param-missing';
      }
    }
    expect(describeCode('shader-import-not-found')).toBe('import');
    expect(describeCode('shader-circular-import')).toBe('cycle');
    expect(describeCode('shader-define-conflict')).toBe('define');
  });
});

describe('ShaderErrorDetail discriminated union - 6 typed variants + 5 new material-* (D-9 + M1-T02)', () => {
  it('ShaderImportNotFoundDetail carries importPath + fromModuleId (offset optional)', () => {
    const detail: ShaderImportNotFoundDetail = {
      code: 'shader-import-not-found',
      importPath: 'forgeax_pbr::brdf',
      fromModuleId: 'entry_a',
    };
    expect(detail.code).toBe('shader-import-not-found');
    expect(detail.importPath).toBe('forgeax_pbr::brdf');
    expect(detail.fromModuleId).toBe('entry_a');

    const withOffset: ShaderImportNotFoundDetail = {
      code: 'shader-import-not-found',
      importPath: 'forgeax_foo::bar',
      fromModuleId: 'ac02_entry',
      offset: 42,
    };
    expect(withOffset.offset).toBe(42);
  });

  it('ShaderCircularImportDetail carries the complete cycle (first/last repeated per D-04)', () => {
    const detail: ShaderCircularImportDetail = {
      code: 'shader-circular-import',
      cycle: ['a', 'b', 'c', 'a'],
    };
    expect(detail.cycle[0]).toBe(detail.cycle[detail.cycle.length - 1]);
    expect(detail.cycle.length).toBe(4);
  });

  it('ShaderDefineConflictDetail carries defineName + sites array', () => {
    const detail: ShaderDefineConflictDetail = {
      code: 'shader-define-conflict',
      defineName: 'FOO',
      sites: [{ moduleId: 'mod1' }, { moduleId: 'mod2' }],
    };
    expect(detail.defineName).toBe('FOO');
    expect(detail.sites.length).toBe(2);
    expect(detail.sites[0]?.moduleId).toBe('mod1');
  });

  it('ShaderCompileFailedDetail carries compilerMessages (reason optional)', () => {
    const detail: ShaderCompileFailedDetail = {
      code: 'shader-compile-failed',
      compilerMessages: [],
    };
    expect(detail.code).toBe('shader-compile-failed');
    expect(detail.compilerMessages.length).toBe(0);

    const withReason: ShaderCompileFailedDetail = {
      code: 'shader-compile-failed',
      compilerMessages: [],
      reason: 'naga validator rejected',
    };
    expect(withReason.reason).toBe('naga validator rejected');
  });

  it('ShaderInitFailedDetail carries optional reason', () => {
    const detail: ShaderInitFailedDetail = { code: 'compiler-init-failed' };
    expect(detail.code).toBe('compiler-init-failed');
    expect(detail.reason).toBeUndefined();

    const withReason: ShaderInitFailedDetail = {
      code: 'compiler-init-failed',
      reason: 'wasm artefact missing',
    };
    expect(withReason.reason).toBe('wasm artefact missing');
  });

  it('ShaderManifestMalformedDetail carries optional reason', () => {
    const detail: ShaderManifestMalformedDetail = { code: 'manifest-malformed' };
    expect(detail.code).toBe('manifest-malformed');
    expect(detail.reason).toBeUndefined();

    const withReason: ShaderManifestMalformedDetail = {
      code: 'manifest-malformed',
      reason: 'JSON parse failed at offset 17',
    };
    expect(withReason.reason).toBe('JSON parse failed at offset 17');
  });

  it('narrowing on detail.code surfaces the per-variant payload without casts (all 11)', () => {
    function inspect(detail: ShaderErrorDetail): string {
      switch (detail.code) {
        case 'shader-import-not-found':
          return `import:${detail.importPath}:${detail.fromModuleId}`;
        case 'shader-circular-import':
          return `cycle:${detail.cycle.join('->')}`;
        case 'shader-define-conflict':
          return `define:${detail.defineName}:${detail.sites.length}`;
        case 'shader-compile-failed':
          return `compile:${detail.compilerMessages.length}:${detail.reason ?? '<no-reason>'}`;
        case 'compiler-init-failed':
          return `init:${detail.reason ?? '<no-reason>'}`;
        case 'manifest-malformed':
          return `manifest:${detail.reason ?? '<no-reason>'}`;
        // === 5 new material-* detail variants (feat-20260523-shader-template-instance-split M1-T02) ===
        case 'material-schema-mismatch':
          return `mismatch:${detail.mismatchKind}:${detail.materialShaderPath}`;
        case 'material-shader-not-found':
          return `ms-not-found:${detail.identifier}`;
        case 'material-param-type-mismatch':
          return `param-type:${detail.paramName}:${detail.expectedType}`;
        case 'material-param-unknown':
          return `param-unknown:${detail.paramName}`;
        case 'material-param-missing-required':
          return `param-missing:${detail.paramName}`;
      }
    }

    expect(
      inspect({
        code: 'shader-import-not-found',
        importPath: 'forgeax_foo::bar',
        fromModuleId: 'entry',
      }),
    ).toBe('import:forgeax_foo::bar:entry');
    expect(inspect({ code: 'shader-circular-import', cycle: ['a', 'b', 'a'] })).toBe(
      'cycle:a->b->a',
    );
    expect(
      inspect({
        code: 'shader-define-conflict',
        defineName: 'BAR',
        sites: [{ moduleId: 'x' }, { moduleId: 'y' }],
      }),
    ).toBe('define:BAR:2');
    expect(inspect({ code: 'shader-compile-failed', compilerMessages: [] })).toBe(
      'compile:0:<no-reason>',
    );
    expect(inspect({ code: 'compiler-init-failed' })).toBe('init:<no-reason>');
    expect(inspect({ code: 'manifest-malformed', reason: 'bad json' })).toBe('manifest:bad json');
  });
});

describe('AssetUnion 3 new discriminated union narrowing (compile-time)', () => {
  it('narrows SkeletonAsset by kind', () => {
    function describe(a: SkeletonAsset): string {
      expect(a.kind).toBe('skeleton');
      return `skeleton ${a.jointCount}`;
    }
    expect(typeof describe).toBe('function');
  });

  it('narrows SkinAsset by kind', () => {
    function describe(a: SkinAsset): string {
      expect(a.kind).toBe('skin');
      return `skin -> ${a.skeletonGuid}`;
    }
    expect(typeof describe).toBe('function');
  });

  it('narrows AnimationClip by kind', () => {
    function describe(a: AnimationClip): string {
      expect(a.kind).toBe('animation-clip');
      return `clip ${a.duration}s`;
    }
    expect(typeof describe).toBe('function');
  });
});

}

{
  // --- from submesh-error.test.ts ---
// submesh-error.test.ts — unit tests for Submesh interface, AssetErrorCode 19
// members, and AssetErrorDetail discriminated union exhaustiveness
// (feat-20260608-mesh-multi-section-primitive-multi-material-slot M1 / w3).
//
// Anchors: requirements AC-01 + AC-03; plan-strategy §5.1 M1 type-driven;
//          plan-strategy §5.3 key test points "AC-03 three error codes each
//          one unit".


describe('Submesh interface', () => {
  it('all 4 fields required — full assignment compiles', () => {
    const s: Submesh = {
      indexOffset: 0,
      indexCount: 36,
      vertexCount: 24,
      topology: 'triangle-list',
    };
    expect(s.indexOffset).toBe(0);
    expect(s.indexCount).toBe(36);
    expect(s.vertexCount).toBe(24);
    expect(s.topology).toBe('triangle-list');
  });

  it('primitive topologies round-trip through Submesh', () => {
    const topologies: Submesh['topology'][] = [
      'point-list',
      'line-list',
      'line-strip',
      'triangle-list',
      'triangle-strip',
    ];
    for (const topo of topologies) {
      const s: Submesh = {
        indexOffset: 0,
        indexCount: 0,
        vertexCount: 1,
        topology: topo,
      };
      expect(s.topology).toBe(topo);
    }
  });

  it('vertex-only submesh (indexCount=0) compiles', () => {
    const s: Submesh = {
      indexOffset: 0,
      indexCount: 0,
      vertexCount: 24,
      topology: 'line-list',
    };
    expect(s.indexCount).toBe(0);
    expect(s.vertexCount).toBe(24);
  });
});

describe('AssetErrorCode — closed union', () => {
  it('mesh slot and renderer override codes are present with hint strings', () => {
    const codes = [
      'mesh-renderer-material-override-invalid',
      'mesh-renderer-material-override-overflow',
      'mesh-asset-submeshes-empty',
      'mesh-asset-material-slot-index-out-of-range',
      'mesh-submesh-index-range-out-of-bounds',
    ] as const;
    for (const code of codes) {
      expect(ASSET_ERROR_HINTS[code]).toBeDefined();
      expect(ASSET_ERROR_HINTS[code].length).toBeGreaterThan(0);
    }
  });

  it('M0 baseline-restored code tileset-region-index-out-of-range has a hint string', () => {
    expect(ASSET_ERROR_HINTS['tileset-region-index-out-of-range']).toBeDefined();
    expect(ASSET_ERROR_HINTS['tileset-region-index-out-of-range'].length).toBeGreaterThan(0);
  });

  it('M1 new code tileset-tile-entry-malformed has a hint string', () => {
    expect(ASSET_ERROR_HINTS['tileset-tile-entry-malformed']).toBeDefined();
    expect(ASSET_ERROR_HINTS['tileset-tile-entry-malformed'].length).toBeGreaterThan(0);
  });

  it('new code asset-invalidated has a hint string', () => {
    expect(ASSET_ERROR_HINTS['asset-invalidated']).toBeDefined();
    expect(ASSET_ERROR_HINTS['asset-invalidated'].length).toBeGreaterThan(0);
  });

  it('new code source-not-imported has a hint string', () => {
    expect(ASSET_ERROR_HINTS['source-not-imported']).toBeDefined();
    expect(ASSET_ERROR_HINTS['source-not-imported'].length).toBeGreaterThan(0);
  });

  it('all codes have non-empty hint strings', () => {
    for (const [code, hint] of Object.entries(ASSET_ERROR_HINTS)) {
      expect(hint.length, `hint for ${code} must be non-empty`).toBeGreaterThan(0);
    }
  });

  // Type-level: verify exhaustive switch on 22-member AssetErrorCode compiles
  // without default case. TS compiler validates union completeness at compile
  // time — this function exists solely for tsc type-checking.
  it('switch on AssetErrorCode with every case compiles without default', () => {
    function describe(code: AssetErrorCode): string {
      switch (code) {
        case 'asset-not-ready':
          return 'asset-not-ready';
        case 'asset-reference-invalid':
          return 'asset-reference-invalid';
        case 'asset-owner-closed':
          return 'asset-owner-closed';
        case 'asset-write-conflict':
          return 'asset-write-conflict';
        case 'asset-budget-exceeded':
          return 'asset-budget-exceeded';
        case 'asset-not-found':
          return 'not found';
        case 'asset-parse-failed':
          return 'parse failed';
        case 'asset-format-unsupported':
          return 'unsupported';
        case 'asset-fetch-failed':
          return 'fetch failed';
        case 'catalog-source-unconfigured':
          return 'catalog source unconfigured';
        case 'asset-invalid-value':
          return 'invalid value';
        case 'cubemap-handle-missing':
          return 'cubemap missing';
        case 'invalid-source-format':
          return 'invalid source';
        case 'load-failed':
          return 'load failed';
        case 'device-unsupported':
          return 'device unsupported';
        case 'ibl-precompute-not-dispatched':
          return 'ibl not dispatched';
        case 'mesh-vertex-stride-mismatch':
          return 'stride mismatch';
        case 'material-shader-ref-broken':
          return 'shader ref broken';
        case 'material-circular-inheritance':
          return 'circular';
        case 'loader-not-registered':
          return 'loader not registered';
        case 'asset-not-imported':
          return 'not imported';
        case 'texture-source-not-imported':
          return 'texture source not imported';
        case 'mesh-renderer-material-override-invalid':
          return 'override invalid';
        case 'mesh-renderer-material-override-overflow':
          return 'override overflow';
        case 'mesh-asset-submeshes-empty':
          return 'submeshes empty';
        case 'mesh-asset-material-slot-index-out-of-range':
          return 'material slot index oob';
        case 'mesh-submesh-index-range-out-of-bounds':
          return 'index oob';
        case 'tileset-region-index-out-of-range':
          return 'tileset region index oob';
        case 'tileset-tile-entry-malformed':
          return 'tileset tile entry malformed';
        case 'asset-invalidated':
          return 'invalidated';
        case 'mesh-bin-contract-violation':
          return 'mesh bin contract violation';
        case 'source-not-imported':
          return 'source not imported';
        case 'mipgen-unsupported-compressed-format':
          return 'mipgen unsupported compressed format';
      }
    }
    // Runtime: verify function returns for each code
    for (const code of Object.keys(ASSET_ERROR_HINTS) as AssetErrorCode[]) {
      const result = describe(code);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });
});

describe('AssetErrorDetail discriminated union', () => {
  it('material-count-mismatch variant is assignable to AssetErrorDetail', () => {
    const detail: AssetErrorDetail = {
      expectedCount: 3,
      actualCount: 1,
      meshAssetGuid: '550e8400-e29b-41d4-a716-446655440000',
    };
    expect(detail.expectedCount).toBe(3);
    expect(detail.actualCount).toBe(1);
    expect(detail.meshAssetGuid).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('submeshes-empty variant is assignable to AssetErrorDetail', () => {
    const detail: AssetErrorDetail = {
      meshAssetGuid: '550e8400-e29b-41d4-a716-446655440000',
    };
    expect(detail.meshAssetGuid).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('index-range-oob variant is assignable with all 5 fields', () => {
    const detail: AssetErrorDetail = {
      submeshIndex: 1,
      indexOffset: 36,
      indexCount: 72,
      indexBufferLength: 54,
      meshAssetGuid: '550e8400-e29b-41d4-a716-446655440000',
    };
    expect(detail.submeshIndex).toBe(1);
    expect(detail.indexOffset).toBe(36);
    expect(detail.indexCount).toBe(72);
    expect(detail.indexBufferLength).toBe(54);
    expect(detail.meshAssetGuid).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('all 4 variant shapes are distinct (no structural overlap)', () => {
    // Verify each variant shape is structurally distinguishable at compile
    // time by checking field presence.

    const countMismatch: AssetErrorDetail = {
      expectedCount: 1,
      actualCount: 1,
      meshAssetGuid: 'g1',
    };
    const submeshesEmpty: AssetErrorDetail = {
      meshAssetGuid: 'g2',
    };
    const indexOob: AssetErrorDetail = {
      submeshIndex: 0,
      indexOffset: 0,
      indexCount: 0,
      indexBufferLength: 0,
      meshAssetGuid: 'g3',
    };

    // Each variant is structurally distinct — the fact that these three
    // separate assignments compile proves assignability
    void countMismatch;
    void submeshesEmpty;
    void indexOob;
  });
});

}

{
  // --- from physics-error-code.test.ts ---
// packages/types/__tests__/physics-error-code.test.ts
//
// feat-20260528-rapier-physics-2d-3d · M1 · t5 (red)
//
// TDD red stage: PhysicsErrorCode closed union exhaustiveness.
// Tests fail until PhysicsErrorCode is registered in engine-types (t6).
// Extended feat-20260617 M1 with controller-requires-kinematic.
// Covers:
//   - All 8 members are accessible as a closed union (exhaustiveness check).
//   - PhysicsError class construction with all 4 fields.
//   - PhysicsErrorDetail discriminated union narrowed per .code.
//   - PHYSICS_ERROR_HINTS has entries for all 8 codes.


describe('feat-20260528 M1 t5 PhysicsErrorCode closed union exhaustiveness', () => {
  it('has 8 member codes: all kebab-case', () => {
    const codes: PhysicsErrorCode[] = [
      'wasm-load-failed',
      'wasm-simd-unsupported',
      'step-failed',
      'invalid-body-config',
      'body-not-found',
      'collider-not-found',
      'backend-not-registered',
      'controller-requires-kinematic',
    ];
    expect(new Set(codes).size).toBe(8);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  it('PhysicsErrorCode is exhaustive — switch covers all 8 members with no default branch', () => {
    const code: PhysicsErrorCode = 'wasm-load-failed';
    // Exhaustiveness check: if a new member is added, this switch fails
    // to compile because the return type is no longer uniformly string.
    const message = exhaustiveSwitchFromCode(code);
    expect(typeof message).toBe('string');
    expect(message.length).toBeGreaterThan(0);
  });

  it('PhysicsError construction with all 4 fields', () => {
    const err = new PhysicsError({
      code: 'step-failed',
      expected: 'Rapier World.step to complete without WASM trap',
      hint: 'check for invalid body parameters or NaN values',
      detail: { code: 'step-failed', reason: 'WASM trap: out of bounds memory access' },
    });
    expect(err.code).toBe('step-failed');
    expect(err.expected).toContain('WASM trap');
    expect(err.hint).toContain('NaN');
    expect(err.detail?.code).toBe('step-failed');
    expect(err.message).toContain('[PhysicsError step-failed]');
  });

  it('PhysicsError detail is narrowed per code', () => {
    const detail: PhysicsErrorDetail = {
      code: 'invalid-body-config',
      field: 'mass',
      value: 0,
    };

    switch (detail.code) {
      case 'wasm-load-failed':
        expect(typeof detail.reason).toBe('string');
        break;
      case 'wasm-simd-unsupported':
        expect(typeof detail.reason).toBe('string');
        break;
      case 'step-failed':
        expect(typeof detail.reason).toBe('string');
        break;
      case 'invalid-body-config':
        expect(detail.field).toBe('mass');
        expect(detail.value).toBe(0);
        break;
      case 'body-not-found':
        expect(typeof detail.entity).toBe('number');
        break;
      case 'collider-not-found':
        expect(typeof detail.entity).toBe('number');
        break;
      case 'backend-not-registered':
        expect(typeof detail.attemptedBackend).toBe('string');
        break;
      case 'controller-requires-kinematic':
        expect(typeof detail.entity).toBe('number');
        expect(typeof detail.bodyType).toBe('string');
        break;
    }
  });

  it('PHYSICS_ERROR_HINTS has all 8 entries', () => {
    const allCodes: PhysicsErrorCode[] = [
      'wasm-load-failed',
      'wasm-simd-unsupported',
      'step-failed',
      'invalid-body-config',
      'body-not-found',
      'collider-not-found',
      'backend-not-registered',
      'controller-requires-kinematic',
    ];
    for (const code of allCodes) {
      expect(PHYSICS_ERROR_HINTS[code]).toBeDefined();
      expect(PHYSICS_ERROR_HINTS[code].length).toBeGreaterThan(0);
    }
    // TS compile-time: Record<PhysicsErrorCode, string> enforces completeness.
    expect(Object.keys(PHYSICS_ERROR_HINTS)).toHaveLength(8);
  });

  it('PhysicsError construction with controller-requires-kinematic carries entity + bodyType detail', () => {
    const err = new PhysicsError({
      code: 'controller-requires-kinematic',
      expected: 'a kinematic RigidBody',
      hint: "set the entity's RigidBody.type to 'kinematic'",
      detail: { code: 'controller-requires-kinematic', entity: 42, bodyType: 'dynamic' },
    });
    expect(err.code).toBe('controller-requires-kinematic');
    expect(err.expected).toContain('kinematic');
    expect(err.hint).toContain('kinematic');
    if (err.detail && err.detail.code === 'controller-requires-kinematic') {
      expect(err.detail.entity).toBe(42);
      expect(err.detail.bodyType).toBe('dynamic');
    }
    expect(err.message).toContain('[PhysicsError controller-requires-kinematic]');
  });
});

/**
 * Exhaustive switch on PhysicsErrorCode — no default fallback.
 * Adding a member to PhysicsErrorCode should cause this to fail typecheck.
 */
function exhaustiveSwitchFromCode(code: PhysicsErrorCode): string {
  switch (code) {
    case 'wasm-load-failed':
      return 'WASM dynamic import rejected';
    case 'wasm-simd-unsupported':
      return 'SIMD not available';
    case 'step-failed':
      return 'physics step panicked';
    case 'invalid-body-config':
      return 'body config invalid';
    case 'body-not-found':
      return 'body not found';
    case 'collider-not-found':
      return 'collider not found';
    case 'backend-not-registered':
      return 'backend not registered';
    case 'controller-requires-kinematic':
      return 'controller requires kinematic body';
  }
}

describe('MeshAsset LOD contract', () => {
  it('exposes root-owned ordered LOD levels and bounded hysteresis', () => {
    const level = null as unknown as MeshLodLevel;
    expectTypeOf<MeshLodLevel['mesh']>().toEqualTypeOf<import('../src/index').AssetGuid>();
    expectTypeOf<MeshLodLevel['screenCoverage']>().toEqualTypeOf<number>();
    expectTypeOf<MeshAsset['lods']>().toEqualTypeOf<readonly MeshLodLevel[] | undefined>();
    expectTypeOf<MeshAsset['lodHysteresis']>().toEqualTypeOf<number | undefined>();
    expect(level).toBeNull();
  });
});
}
