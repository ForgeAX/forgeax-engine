// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=18):
//   - packages/gltf/src/__tests__/cli-gltf.test.ts
//   - packages/gltf/src/__tests__/errors.test.ts
//   - packages/gltf/src/__tests__/ext-mesh-gpu-instancing.test.ts
//   - packages/gltf/src/__tests__/format-entries.test.ts
//   - packages/gltf/src/__tests__/gltf-importer-byte-equivalence.test.ts
//   - packages/gltf/src/__tests__/gltf-importer-texture-data-uri.test.ts
//   - packages/gltf/src/__tests__/gltf-importer-texture-external.test.ts
//   - packages/gltf/src/__tests__/gltf-importer-texture-glb.test.ts
//   - packages/gltf/src/__tests__/image-color-space.test.ts
//   - packages/gltf/src/__tests__/khr-extensions.test.ts
//   - packages/gltf/src/__tests__/multi-primitive.test.ts
//   - packages/gltf/src/__tests__/pbr-material.test.ts
//   - packages/gltf/src/__tests__/reimport-reuse-meta.test.ts
//   - packages/gltf/src/__tests__/skin-to-asset-pack.test.ts
//   - packages/gltf/src/__tests__/texture-load.test.ts
//   - packages/gltf/src/__tests__/to-asset-pack-texture.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

// Shared helper: encode float array as base64 data URI (used by multi-primitive, pbr-material, texture-load)
function buildBase64Buffer(floats: number[]): string {
  const bytes = new Uint8Array(floats.length * 4);
  const view = new Float32Array(bytes.buffer);
  floats.forEach((v, i) => {
    view[i] = v;
  });
  return `data:application/octet-stream;base64,${btoa(String.fromCharCode(...bytes))}`;
}

{
  describe('KHR_lights_punctual import contract', () => {
    it('accepts directional, point, and spot author facts with numeric fields', async () => {
      const result = await parseGltf(
        {
          asset: { version: '2.0' },
          extensionsUsed: ['KHR_lights_punctual'],
          extensionsRequired: ['KHR_lights_punctual'],
          extensions: {
            KHR_lights_punctual: {
              lights: [
                { type: 'directional', color: [0.1, 0.2, 0.3], intensity: 4 },
                { type: 'point', color: [0.4, 0.5, 0.6], intensity: 8, range: 3 },
                {
                  type: 'spot',
                  color: [0.7, 0.8, 0.9],
                  intensity: 16,
                  range: 5,
                  spot: { innerConeAngle: 0.1, outerConeAngle: 0.5 },
                },
              ],
            },
          },
          scenes: [{ nodes: [] }],
          scene: 0,
          nodes: [],
          meshes: [],
          materials: [],
        },
        async () => new ArrayBuffer(0),
        '/direct-light.gltf',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const lights = (result.value as unknown as { lights?: readonly Record<string, unknown>[] })
        .lights;
      expect(lights?.map((light) => light.type)).toEqual(['directional', 'point', 'spot']);
      expect(lights?.[1]?.intensity).toBe(8);
      expect(lights?.[1]?.range).toBe(3);
      expect((lights?.[2]?.spot as { innerConeAngle: number }).innerConeAngle).toBe(0.1);
    });

    it('rejects unsupported required extensions instead of creating an implicit light', async () => {
      const result = await parseGltf(
        {
          asset: { version: '2.0' },
          extensionsRequired: ['KHR_unknown_light'],
          scenes: [{ nodes: [] }],
          scene: 0,
          nodes: [],
          meshes: [],
          materials: [],
        },
        async () => new ArrayBuffer(0),
        '/invalid-light.gltf',
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('gltf-extension-unsupported');
    });
  });
}

// Shared loader stub (used by multi-primitive, pbr-material)
const noopLoader = async (_: string) => new ArrayBuffer(0);

import type { ImportRunnerFs } from '@forgeax/engine-import';
import { ImporterRegistry, type RunImportMeta, runImport } from '@forgeax/engine-import';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type {
  ImportContext,
  ImportError as ImportErrorType,
  ImportedAsset,
  ImportSubAsset,
  TextureAsset,
} from '@forgeax/engine-types';

function unwrap(result: {
  readonly ok: boolean;
  readonly value?: { readonly assets: readonly ImportedAsset[] };
}): readonly ImportedAsset[] {
  return result.ok && result.value !== undefined ? result.value.assets : [];
}

import { toMaterialAsset } from '../bridge.js';
import { checkExtensions, EXTENSION_ALLOWLIST } from '../check-extensions.js';
import { runCliGltf } from '../cli-gltf.js';
import {
  GLTF_ERROR_HINTS,
  type GltfError,
  type GltfErrorCode,
  type GltfErrorDetail,
  gltfErr,
} from '../errors.js';
import { gltfImporter } from '../gltf-importer.js';
import { deriveTextureColorSpace } from '../image-color-space.js';
import type { GltfDoc } from '../parse-gltf.js';
import { parseGlb, parseGltf, toAssetPack } from '../parse-gltf.js';
import {
  type GltfDocItem,
  type GltfMetaJson,
  reimportReuseMeta,
  subAssetKey,
} from '../reimport-reuse-meta.js';
import { unwrapMeshAsset as meshIrToMeshAsset } from './bridge-test-helpers.js';

function unwrapAssetPack(result: ReturnType<typeof toAssetPack>) {
  if (!result.ok) throw new Error(`toAssetPack failed: ${result.error.code}`);
  return result.value;
}

function unwrapReimport(result: ReturnType<typeof reimportReuseMeta>) {
  if (!result.ok) throw new Error(`reimportReuseMeta failed: ${result.error.code}`);
  return result.value;
}

{
  // ─── from cli-gltf.test.ts ───

  interface CapturedIO {
    stdout: string[];
    stderr: string[];
  }

  function makeIO(): CapturedIO {
    return { stdout: [], stderr: [] };
  }

  function ctxFor(io: CapturedIO) {
    return {
      stdoutWrite: (line: string): void => {
        io.stdout.push(line);
      },
      stderrWrite: (line: string): void => {
        io.stderr.push(line);
      },
    };
  }

  describe('cli-gltf.test.ts', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'gltf-cli-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    describe('cli-gltf (forgeax asset import plugin bin)', () => {
      describe('subcommand routing (a)', () => {
        it('prints help on --help and exits 0', async () => {
          const io = makeIO();
          const code = await runCliGltf(['--help'], ctxFor(io));
          expect(code).toBe(0);
          const help = io.stdout.join('\n');
          expect(help).toContain('import');
          expect(help).toContain('produces texture');
        });

        it('emits a JSON Lines envelope with code on unknown subcommand and exits 1', async () => {
          const io = makeIO();
          const code = await runCliGltf(['scan'], ctxFor(io));
          expect(code).toBe(1);
          expect(io.stderr.length).toBe(1);
          const parsed = JSON.parse(io.stderr[0] as string);
          expect(typeof parsed.code).toBe('string');
          expect(typeof parsed.expected).toBe('string');
          expect(typeof parsed.hint).toBe('string');
        });

        it('routes import without args -> 1 with cli-parse-error JSON envelope', async () => {
          const io = makeIO();
          const code = await runCliGltf(['import'], ctxFor(io));
          expect(code).toBe(1);
          expect(io.stderr.length).toBeGreaterThanOrEqual(1);
          const parsed = JSON.parse(io.stderr[0] as string);
          expect(typeof parsed.code).toBe('string');
        });
      });

      describe('GltfError stderr JSON Lines (b)', () => {
        it('emits gltf-malformed-header (code/expected/hint) for an invalid .gltf file', async () => {
          const badPath = join(tempDir, 'bad.gltf');
          await writeFile(badPath, '{this is not}valid json', 'utf-8');
          const io = makeIO();
          const code = await runCliGltf(['import', badPath], ctxFor(io));
          expect(code).toBe(1);
          expect(io.stderr.length).toBe(1);
          const line = io.stderr[0] as string;
          expect(line.includes('\n')).toBe(false);
          const parsed = JSON.parse(line);
          expect(parsed.code).toBe('gltf-malformed-header');
          expect(typeof parsed.expected).toBe('string');
          expect(typeof parsed.hint).toBe('string');
        });

        it('--check on a dir with a .gltf source missing sidecar emits gltf-meta-missing', async () => {
          const sourcePath = join(tempDir, 'sample.gltf');
          await writeFile(sourcePath, '{}', 'utf-8');
          const io = makeIO();
          const code = await runCliGltf(['import', '--check', tempDir], ctxFor(io));
          expect(code).toBe(1);
          expect(io.stderr.length).toBe(1);
          const parsed = JSON.parse(io.stderr[0] as string);
          expect(parsed.code).toBe('gltf-meta-missing');
          expect(typeof parsed.expected).toBe('string');
          expect(typeof parsed.hint).toBe('string');
        });
      });

      describe('exit codes (c)', () => {
        it('--check on an empty dir exits 0', async () => {
          const io = makeIO();
          const code = await runCliGltf(['import', '--check', tempDir], ctxFor(io));
          expect(code).toBe(0);
        });

        it('rejects non-gltf/glb extension with exit 1', async () => {
          const txtPath = join(tempDir, 'notgltf.txt');
          await writeFile(txtPath, 'hello', 'utf-8');
          const io = makeIO();
          const code = await runCliGltf(['import', txtPath], ctxFor(io));
          expect(code).toBe(1);
        });
      });
    });
  });
}

{
  // ─── from errors.test.ts ───

  const ALL_CODES: readonly GltfErrorCode[] = [
    'gltf-camera-invalid',
    'gltf-animation-sampler-invalid',
    'gltf-malformed-header',
    'gltf-version-unsupported',
    'gltf-buffer-out-of-bounds',
    'gltf-extension-unsupported',
    'gltf-lod-invalid',
    'gltf-material-transmission-invalid',
    'gltf-material-physical-invalid',
    'gltf-accessor-type-mismatch',
    'gltf-texture-load-failed',
    'gltf-meta-missing',
    'gltf-instancing-count-mismatch',
    'gltf-image-mime-unsupported',
    'gltf-skin-joint-count-exceeded',
    'gltf-animation-cubicspline-unsupported',
    'gltf-morph-unsupported',
    'gltf-skin-joint-name-missing',
    'gltf-image-extract-failed',
    'gltf-skin-attr-asymmetric',
    'gltf-animation-target-invalid',
    'gltf-meshopt-decoder-required',
    'gltf-meshopt-decode-failed',
    'gltf-morph-invalid',
    'gltf-color-accessor-unsupported',
    'gltf-color-accessor-malformed',
    'gltf-mesh-bridge-invalid',
  ];

  function classifyByExhaustiveSwitch(err: GltfError): string {
    const code = err.code;
    switch (code) {
      case 'gltf-camera-invalid':
        return 'camera';
      case 'gltf-animation-sampler-invalid':
        return 'sampler';
      case 'gltf-malformed-header':
        return 'malformed';
      case 'gltf-version-unsupported':
        return 'version';
      case 'gltf-buffer-out-of-bounds':
        return 'oob';
      case 'gltf-extension-unsupported':
        return 'ext';
      case 'gltf-lod-invalid':
        return 'lod';
      case 'gltf-material-transmission-invalid':
        return 'material-transmission-invalid';
      case 'gltf-material-physical-invalid':
        return 'material-physical-invalid';
      case 'gltf-accessor-type-mismatch':
        return 'accessor';
      case 'gltf-texture-load-failed':
        return 'tex-load';
      case 'gltf-meta-missing':
        return 'meta';
      case 'gltf-instancing-count-mismatch':
        return 'inst';
      case 'gltf-image-mime-unsupported':
        return 'mime';
      case 'gltf-skin-joint-count-exceeded':
        return 'joint-count';
      case 'gltf-animation-cubicspline-unsupported':
        return 'cubic';
      case 'gltf-morph-unsupported':
        return 'morph';
      case 'gltf-skin-joint-name-missing':
        return 'joint-name';
      case 'gltf-image-extract-failed':
        return 'image-extract';
      case 'gltf-skin-attr-asymmetric':
        return 'skin-attr-asym';
      case 'gltf-animation-target-invalid':
        return 'animation-target';
      case 'gltf-meshopt-decoder-required':
        return 'meshopt-decoder';
      case 'gltf-meshopt-decode-failed':
        return 'meshopt-decode';
      case 'gltf-morph-invalid':
        return 'morph-invalid';
      case 'gltf-color-accessor-unsupported':
        return 'color-unsupported';
      case 'gltf-color-accessor-malformed':
        return 'color-malformed';
      case 'gltf-mesh-bridge-invalid':
        return 'mesh-bridge-invalid';
    }
    throw new Error(`unhandled glTF error code: ${code}`);
  }

  function buildErrSample(code: GltfErrorCode): GltfError {
    switch (code) {
      case 'gltf-camera-invalid':
        return gltfErr(code, { cameraIndex: 0 });
      case 'gltf-animation-sampler-invalid':
        return gltfErr(code, { animationIndex: 0, samplerIndex: 0, reason: 'times' });
      case 'gltf-malformed-header':
        return gltfErr(code, { filePath: '/x.glb', byteOffset: 0 });
      case 'gltf-version-unsupported':
        return gltfErr(code, { filePath: '/x.gltf', actualVersion: '1.0' });
      case 'gltf-buffer-out-of-bounds':
        return gltfErr(code, { accessor: 0, byteOffset: 0, byteLength: 0, bufferIndex: 0 });
      case 'gltf-extension-unsupported':
        return gltfErr(code, { extension: 'KHR_x', source: 'extensionsRequired' });
      case 'gltf-lod-invalid':
        return gltfErr(code, { rootNode: 0, ids: [1], reason: 'missing-node' });
      case 'gltf-material-transmission-invalid':
        return gltfErr(code, {
          extension: 'KHR_materials_transmission',
          field: 'transmissionFactor',
          reason: 'range',
          actual: 2,
        });
      case 'gltf-material-physical-invalid':
        return gltfErr(code, {
          extension: 'KHR_materials_clearcoat',
          field: 'clearcoatFactor',
          reason: 'range',
          actual: 2,
        });
      case 'gltf-accessor-type-mismatch':
        return gltfErr(code, { accessorIndex: 0, reason: 'sparse' });
      case 'gltf-texture-load-failed':
        return gltfErr(code, { uri: 'textures/test.png' });
      case 'gltf-meta-missing':
        return gltfErr(code, { filePath: '/x.gltf', expectedMetaPath: '/x.meta.json' });
      case 'gltf-instancing-count-mismatch':
        return gltfErr(code, {
          nodeIndex: 0,
          accessor: 'TRANSLATION',
          expectedCount: 2,
          actualCount: 3,
        });
      case 'gltf-image-mime-unsupported':
        return gltfErr(code, { mimeType: 'image/bmp' });
      case 'gltf-skin-joint-count-exceeded':
        return gltfErr(code, { skinIndex: 0, jointCount: 300, maxJoints: 256 });
      case 'gltf-animation-cubicspline-unsupported':
        return gltfErr(code, { animationIndex: 0, samplerIndex: 1 });
      case 'gltf-morph-unsupported':
        return gltfErr(code, { animationIndex: 0, channelIndex: 2, nodeIndex: 3 });
      case 'gltf-skin-joint-name-missing':
        return gltfErr(code, {
          reason: 'name-missing',
          skinIndex: 0,
          jointPathIndex: 4,
          nodeIndex: 5,
        });
      case 'gltf-image-extract-failed':
        return gltfErr(code, { imageIndex: 0, source: 'bufferView', reason: 'sample' });
      case 'gltf-skin-attr-asymmetric':
        return gltfErr(code, {
          meshIndex: 0,
          primitiveIndex: 0,
          hasJoints: true,
          hasWeights: false,
        });
      case 'gltf-animation-target-invalid':
        return gltfErr(code, {
          reason: 'name-missing',
          animationIndex: 0,
          channelIndex: 0,
          nodeIndex: 0,
        });
      case 'gltf-meshopt-decoder-required':
        return gltfErr(code, {
          bufferView: 0,
          actual: 'required',
          hasCoreFallback: false,
        });
      case 'gltf-meshopt-decode-failed':
        return gltfErr(code, {
          bufferView: 0,
          actual: 'invalid declaration',
          mode: 'ATTRIBUTES',
          filter: 'NONE',
        });
      case 'gltf-morph-invalid':
        return gltfErr(code, {
          meshIndex: 0,
          primitiveIndex: 0,
          reason: 'target-count-exceeded',
          targetCount: 9,
          attributeCount: 9,
          vertexCount: 3,
        });
      case 'gltf-color-accessor-unsupported':
        return gltfErr(code, {
          semantic: 'COLOR_0',
          accessorIndex: 0,
          reason: 'component',
        });
      case 'gltf-color-accessor-malformed':
        return gltfErr(code, {
          semantic: 'COLOR_0',
          accessorIndex: 0,
          reason: 'bounds',
        });
      case 'gltf-mesh-bridge-invalid':
        return gltfErr(code, { reason: 'empty-input', primitiveCount: 0 });
    }
    throw new Error(`unhandled glTF error code: ${code}`);
  }

  describe('errors.test.ts', () => {
    it('GltfErrorDetail projects the complete error detail surface', () => {
      expectTypeOf<GltfErrorDetail>().toEqualTypeOf<GltfError['detail']>();
    });

    describe('GltfErrorCode roster', () => {
      it('GLTF_ERROR_HINTS exposes exactly 29 keys', () => {
        expect(Object.keys(GLTF_ERROR_HINTS).length).toBe(29);
      });

      it.each(ALL_CODES)('hint for %s is a non-empty string', (code) => {
        const hint = GLTF_ERROR_HINTS[code];
        expect(typeof hint).toBe('string');
        expect(hint.length).toBeGreaterThan(0);
      });

      it.each(ALL_CODES)('gltfErr(%s) carries non-empty .expected literal', (code) => {
        const err: GltfError = buildErrSample(code);
        expect(err.expected).toBeTypeOf('string');
        expect(err.expected.length).toBeGreaterThan(0);
        expect(err.code).toBe(code);
      });

      it('gltf-instancing-count-mismatch carries the 4-field detail shape', () => {
        const err = gltfErr('gltf-instancing-count-mismatch', {
          nodeIndex: 3,
          accessor: 'ROTATION',
          expectedCount: 4,
          actualCount: 3,
        });
        expect(err.code).toBe('gltf-instancing-count-mismatch');
        if (err.code === 'gltf-instancing-count-mismatch') {
          expect(err.detail.nodeIndex).toBe(3);
          expect(err.detail.accessor).toBe('ROTATION');
          expect(err.detail.expectedCount).toBe(4);
          expect(err.detail.actualCount).toBe(3);
        }
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.expected.length).toBeGreaterThan(0);
      });

      it('gltf-texture-load-failed carries .detail.uri', () => {
        const err = gltfErr('gltf-texture-load-failed', { uri: 'textures/brick_wall.jpg' });
        expect(err.code).toBe('gltf-texture-load-failed');
        if (err.code === 'gltf-texture-load-failed') {
          expect(err.detail.uri).toBe('textures/brick_wall.jpg');
        }
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.expected.length).toBeGreaterThan(0);
      });

      it('gltf-image-mime-unsupported carries .detail.mimeType', () => {
        const err = gltfErr('gltf-image-mime-unsupported', { mimeType: 'image/webp' });
        expect(err.code).toBe('gltf-image-mime-unsupported');
        if (err.code === 'gltf-image-mime-unsupported') {
          expect(err.detail.mimeType).toBe('image/webp');
        }
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.expected.length).toBeGreaterThan(0);
      });

      it('gltf-image-extract-failed carries the 3-field detail shape', () => {
        const err = gltfErr('gltf-image-extract-failed', {
          imageIndex: 2,
          source: 'bufferView',
          reason: 'bufferView 3 byte range out of range of buffer',
        });
        expect(err.code).toBe('gltf-image-extract-failed');
        if (err.code === 'gltf-image-extract-failed') {
          expect(err.detail.imageIndex).toBe(2);
          expect(err.detail.source).toBe('bufferView');
          expect(err.detail.reason).toContain('out of range');
        }
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.expected.length).toBeGreaterThan(0);
      });

      it('exhaustive switch (no default) covers all 14 codes', () => {
        const codes = ALL_CODES;
        for (const code of codes) {
          const err = buildErrSample(code);
          const familyLabel = classifyByExhaustiveSwitch(err);
          expect(familyLabel).not.toBe('UNREACHED');
        }
      });
    });
  });
}

{
  // ─── from ext-mesh-gpu-instancing.test.ts ───

  type GltfJson = Record<string, unknown>;

  function makeQuat(x: number, y: number, z: number, w: number): ReturnType<typeof quat.create> {
    const q = quat.create();
    q[0] = x;
    q[1] = y;
    q[2] = z;
    q[3] = w;
    return q;
  }

  const NEVER_LOADER = async (uri: string): Promise<ArrayBuffer> => {
    throw new Error(`unexpected externalLoader call for ${uri}`);
  };

  function f32ToBase64(values: readonly number[]): string {
    const f = new Float32Array(values);
    const u = new Uint8Array(f.buffer);
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i] ?? 0);
    return `data:application/octet-stream;base64,${btoa(s)}`;
  }

  function u16ToBase64(values: readonly number[]): string {
    const f = new Uint16Array(values);
    const u = new Uint8Array(f.buffer);
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i] ?? 0);
    return `data:application/octet-stream;base64,${btoa(s)}`;
  }

  interface InstancingFixtureOptions {
    readonly translations?: readonly number[];
    readonly rotations?: readonly number[];
    readonly scales?: readonly number[];
    readonly translationsCount?: number;
    readonly rotationsCount?: number;
    readonly scalesCount?: number;
  }

  function buildInstancingFixture(opts: InstancingFixtureOptions): GltfJson {
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const indices = [0, 1, 2];

    const buffers: Array<{ byteLength: number; uri: string }> = [
      { byteLength: positions.length * 4, uri: f32ToBase64(positions) },
      { byteLength: indices.length * 2, uri: u16ToBase64(indices) },
    ];
    const bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number }> = [
      { buffer: 0, byteOffset: 0, byteLength: positions.length * 4 },
      { buffer: 1, byteOffset: 0, byteLength: indices.length * 2 },
    ];
    const accessors: Array<Record<string, unknown>> = [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ];

    const ext: Record<string, number> = {};
    if (opts.translations !== undefined) {
      const idx = buffers.length;
      buffers.push({
        byteLength: opts.translations.length * 4,
        uri: f32ToBase64(opts.translations),
      });
      bufferViews.push({ buffer: idx, byteOffset: 0, byteLength: opts.translations.length * 4 });
      accessors.push({
        bufferView: bufferViews.length - 1,
        componentType: 5126,
        count: opts.translationsCount ?? opts.translations.length / 3,
        type: 'VEC3',
      });
      ext.TRANSLATION = accessors.length - 1;
    }
    if (opts.rotations !== undefined) {
      const idx = buffers.length;
      buffers.push({ byteLength: opts.rotations.length * 4, uri: f32ToBase64(opts.rotations) });
      bufferViews.push({ buffer: idx, byteOffset: 0, byteLength: opts.rotations.length * 4 });
      accessors.push({
        bufferView: bufferViews.length - 1,
        componentType: 5126,
        count: opts.rotationsCount ?? opts.rotations.length / 4,
        type: 'VEC4',
      });
      ext.ROTATION = accessors.length - 1;
    }
    if (opts.scales !== undefined) {
      const idx = buffers.length;
      buffers.push({ byteLength: opts.scales.length * 4, uri: f32ToBase64(opts.scales) });
      bufferViews.push({ buffer: idx, byteOffset: 0, byteLength: opts.scales.length * 4 });
      accessors.push({
        bufferView: bufferViews.length - 1,
        componentType: 5126,
        count: opts.scalesCount ?? opts.scales.length / 3,
        type: 'VEC3',
      });
      ext.SCALE = accessors.length - 1;
    }

    return {
      asset: { version: '2.0' },
      extensionsUsed: ['EXT_mesh_gpu_instancing'],
      scene: 0,
      scenes: [{ name: 'S', nodes: [0] }],
      nodes: [
        {
          name: 'InstancedBox',
          mesh: 0,
          extensions: { EXT_mesh_gpu_instancing: { attributes: ext } },
        },
      ],
      meshes: [
        { name: 'M', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
      ],
      materials: [{ name: 'Mat' }],
      accessors,
      bufferViews,
      buffers,
    };
  }

  function expectMat4Close(actual: Float32Array, offset: number, expected: Float32Array): void {
    for (let i = 0; i < 16; i++) {
      const a = actual[offset + i] ?? Number.NaN;
      const e = expected[i] ?? Number.NaN;
      expect(Math.abs(a - e), `index ${offset + i}: actual ${a} expected ${e}`).toBeLessThanOrEqual(
        1e-6,
      );
    }
  }

  describe('ext-mesh-gpu-instancing.test.ts', () => {
    describe('parseGltf - EXT_mesh_gpu_instancing extension routing (AC-01)', () => {
      it('extensionsRequired contains EXT_mesh_gpu_instancing + node carries extension -> ok', async () => {
        const json = buildInstancingFixture({ translations: [0, 0, 0] });
        json.extensionsRequired = ['EXT_mesh_gpu_instancing'];
        const result = await parseGltf(json, NEVER_LOADER, '/x.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.instancing).toBeDefined();
      });

      it('extensionsRequired contains EXT_mesh_gpu_instancing + node lacks extension -> ok with no instancing', async () => {
        const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
        const indices = [0, 1, 2];
        const json: GltfJson = {
          asset: { version: '2.0' },
          extensionsRequired: ['EXT_mesh_gpu_instancing'],
          scene: 0,
          scenes: [{ name: 'S', nodes: [0] }],
          nodes: [{ name: 'N', mesh: 0 }],
          meshes: [{ name: 'M', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
          accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
            { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
          ],
          bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: positions.length * 4 },
            { buffer: 1, byteOffset: 0, byteLength: indices.length * 2 },
          ],
          buffers: [
            { byteLength: positions.length * 4, uri: f32ToBase64(positions) },
            { byteLength: indices.length * 2, uri: u16ToBase64(indices) },
          ],
        };
        const result = await parseGltf(json, NEVER_LOADER, '/x.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.instancing).toBeUndefined();
      });

      it('extensionsUsed only + node carries extension -> ok', async () => {
        const json = buildInstancingFixture({ translations: [0, 0, 0] });
        json.extensionsUsed = ['EXT_mesh_gpu_instancing'];
        const result = await parseGltf(json, NEVER_LOADER, '/x.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.instancing).toBeDefined();
      });

      it('extensionsUsed only + no node extension -> ok with no instancing', async () => {
        const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
        const indices = [0, 1, 2];
        const json: GltfJson = {
          asset: { version: '2.0' },
          extensionsUsed: ['EXT_mesh_gpu_instancing'],
          scene: 0,
          scenes: [{ name: 'S', nodes: [0] }],
          nodes: [{ name: 'N', mesh: 0 }],
          meshes: [{ name: 'M', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
          accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
            { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
          ],
          bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: positions.length * 4 },
            { buffer: 1, byteOffset: 0, byteLength: indices.length * 2 },
          ],
          buffers: [
            { byteLength: positions.length * 4, uri: f32ToBase64(positions) },
            { byteLength: indices.length * 2, uri: u16ToBase64(indices) },
          ],
        };
        const result = await parseGltf(json, NEVER_LOADER, '/x.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.instancing).toBeUndefined();
      });
    });

    describe('parseGltf - EXT_mesh_gpu_instancing decode (AC-02/03/04)', () => {
      it('happy-path N=2 with TRANSLATION + ROTATION + SCALE all present', async () => {
        const json = buildInstancingFixture({
          translations: [1, 2, 3, 4, 5, 6],
          rotations: [0, 0, 0, 1, 0, 0, 0, 1],
          scales: [1, 1, 1, 2, 2, 2],
        });
        const result = await parseGltf(json, NEVER_LOADER, '/x.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node?.instancing).toBeDefined();
        expect(node?.instancing?.count).toBe(2);
        expect(node?.instancing?.transforms.length).toBe(2 * 16);
        const ref = mat4.create();
        mat4.compose(ref, vec3.create(1, 2, 3), makeQuat(0, 0, 0, 1), vec3.create(1, 1, 1));
        expectMat4Close(node?.instancing?.transforms ?? new Float32Array(), 0, ref);
        mat4.compose(ref, vec3.create(4, 5, 6), makeQuat(0, 0, 0, 1), vec3.create(2, 2, 2));
        expectMat4Close(node?.instancing?.transforms ?? new Float32Array(), 16, ref);
      });

      it('fixture A: only TRANSLATION (rotation -> identity quat, scale -> 1,1,1)', async () => {
        const json = buildInstancingFixture({ translations: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
        const result = await parseGltf(json, NEVER_LOADER, '/x.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node?.instancing?.count).toBe(3);
        const ref = mat4.create();
        mat4.compose(ref, vec3.create(0, 1, 0), makeQuat(0, 0, 0, 1), vec3.create(1, 1, 1));
        expectMat4Close(node?.instancing?.transforms ?? new Float32Array(), 16, ref);
      });

      it('fixture B: single TRANSLATION key (alpha path, N=1)', async () => {
        const json = buildInstancingFixture({ translations: [9, 9, 9] });
        const result = await parseGltf(json, NEVER_LOADER, '/x.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node?.instancing?.count).toBe(1);
        expect(node?.instancing?.transforms.length).toBe(16);
        const ref = mat4.create();
        mat4.compose(ref, vec3.create(9, 9, 9), makeQuat(0, 0, 0, 1), vec3.create(1, 1, 1));
        expectMat4Close(node?.instancing?.transforms ?? new Float32Array(), 0, ref);
      });

      it('fixture C: TRANSLATION + SCALE present, ROTATION default to identity', async () => {
        const json = buildInstancingFixture({
          translations: [0, 0, 0, 1, 1, 1],
          scales: [1, 1, 1, 2, 3, 4],
        });
        const result = await parseGltf(json, NEVER_LOADER, '/x.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node?.instancing?.count).toBe(2);
        const ref = mat4.create();
        mat4.compose(ref, vec3.create(1, 1, 1), makeQuat(0, 0, 0, 1), vec3.create(2, 3, 4));
        expectMat4Close(node?.instancing?.transforms ?? new Float32Array(), 16, ref);
      });

      it('count-mismatch T=4/R=3 returns gltf-instancing-count-mismatch', async () => {
        const json = buildInstancingFixture({
          translations: [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0],
          rotations: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
          translationsCount: 4,
          rotationsCount: 3,
        });
        json.buffers = (json.buffers as Array<{ byteLength: number; uri: string }>).map((b, i) =>
          i === 3
            ? { byteLength: 3 * 4 * 4, uri: f32ToBase64([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]) }
            : b,
        );
        json.bufferViews = (
          json.bufferViews as Array<{ buffer: number; byteOffset: number; byteLength: number }>
        ).map((b, i) => (i === 3 ? { ...b, byteLength: 3 * 4 * 4 } : b));
        const result = await parseGltf(json, NEVER_LOADER, '/x.gltf');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('gltf-instancing-count-mismatch');
        if (result.error.code !== 'gltf-instancing-count-mismatch') return;
        expect(result.error.detail.nodeIndex).toBe(0);
        expect(result.error.detail.accessor).toBe('ROTATION');
        expect(result.error.detail.expectedCount).toBe(4);
        expect(result.error.detail.actualCount).toBe(3);
      });
    });
  });
}

{
  // ─── from format-entries.test.ts ───

  interface MinimalGltfJsonInput {
    readonly bin?: Uint8Array;
    readonly bufferUri?: string;
    readonly bufferLength: number;
    readonly bufferIndex: number;
  }

  const BOX_POSITIONS = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  ]);
  const BOX_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);

  function makeBoxBin(): Uint8Array {
    const positionBytes = new Uint8Array(BOX_POSITIONS.buffer);
    const indexBytes = new Uint8Array(BOX_INDICES.buffer);
    const merged = new Uint8Array(positionBytes.byteLength + indexBytes.byteLength);
    merged.set(positionBytes, 0);
    merged.set(indexBytes, positionBytes.byteLength);
    return merged;
  }

  function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    return ab;
  }

  function makeBoxJson(input: MinimalGltfJsonInput): Record<string, unknown> {
    const bufferEntry: { byteLength: number; uri?: string } = { byteLength: input.bufferLength };
    if (input.bufferUri !== undefined) bufferEntry.uri = input.bufferUri;
    const buffers = [bufferEntry];
    return {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ name: 'BoxScene', nodes: [0] }],
      nodes: [{ name: 'BoxNode', mesh: 0, translation: [1, 2, 3] }],
      meshes: [
        { name: 'BoxMesh', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
      ],
      materials: [{ name: 'BoxMat', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3' },
        { bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: BOX_POSITIONS.byteLength },
        { buffer: 0, byteOffset: BOX_POSITIONS.byteLength, byteLength: BOX_INDICES.byteLength },
      ],
      buffers,
    };
  }

  const GLB_MAGIC = 0x46546c67;
  const CHUNK_TYPE_JSON = 0x4e4f534a;
  const CHUNK_TYPE_BIN = 0x004e4942;

  function packGlb(jsonText: string, binBytes: Uint8Array): ArrayBuffer {
    const jsonPad = jsonText.length % 4 === 0 ? 0 : 4 - (jsonText.length % 4);
    const binPad = binBytes.byteLength % 4 === 0 ? 0 : 4 - (binBytes.byteLength % 4);
    const jsonChunkLen = jsonText.length + jsonPad;
    const binChunkLen = binBytes.byteLength + binPad;
    const totalLen = 12 + 8 + jsonChunkLen + 8 + binChunkLen;
    const buffer = new ArrayBuffer(totalLen);
    const view = new DataView(buffer);
    view.setUint32(0, GLB_MAGIC, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, totalLen, true);
    view.setUint32(12, jsonChunkLen, true);
    view.setUint32(16, CHUNK_TYPE_JSON, true);
    const u8 = new Uint8Array(buffer);
    u8.set(new TextEncoder().encode(jsonText), 20);
    for (let i = 0; i < jsonPad; i++) u8[20 + jsonText.length + i] = 0x20;
    view.setUint32(20 + jsonChunkLen, binChunkLen, true);
    view.setUint32(20 + jsonChunkLen + 4, CHUNK_TYPE_BIN, true);
    u8.set(binBytes, 20 + jsonChunkLen + 8);
    return buffer;
  }

  function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i] ?? 0);
    return btoa(binary);
  }

  describe('format-entries.test.ts', () => {
    describe('parseGltf / parseGlb / toAssetPack (w16 fixture set)', () => {
      const bin = makeBoxBin();

      it('(a) parses .gltf with external .bin URI through the externalLoader', async () => {
        const json = makeBoxJson({
          bufferLength: bin.byteLength,
          bufferUri: 'box.bin',
          bufferIndex: 0,
        });
        const result = await parseGltf(
          json,
          async (uri: string) => {
            expect(uri).toBe('box.bin');
            return bytesToArrayBuffer(bin);
          },
          '/fixture/box.gltf',
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.meshes.length).toBe(1);
        expect(result.value.scenes.length).toBe(1);
        expect(result.value.materials.length).toBe(1);
        expect(result.value.diagnostics.nodeNames).toEqual(['BoxNode']);
      });

      it('(b) parses .glb through parseGlb (binary chunk path)', async () => {
        const jsonText = JSON.stringify(
          makeBoxJson({ bufferLength: bin.byteLength, bufferIndex: 0 }),
        );
        const glb = packGlb(jsonText, bin);
        const result = await parseGlb(glb, '/fixture/box.glb');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.meshes.length).toBe(1);
        expect(result.value.diagnostics.nodeNames).toEqual(['BoxNode']);
      });

      it('(c) parses .gltf with embedded base64 buffer (no externalLoader call)', async () => {
        const dataUri = `data:application/octet-stream;base64,${bytesToBase64(bin)}`;
        const json = makeBoxJson({
          bufferLength: bin.byteLength,
          bufferUri: dataUri,
          bufferIndex: 0,
        });
        const externalLoader = async (uri: string): Promise<ArrayBuffer> => {
          throw new Error(`externalLoader should not be called for data: URIs (got ${uri})`);
        };
        const result = await parseGltf(json, externalLoader, '/fixture/box.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.meshes.length).toBe(1);
        expect(result.value.scenes.length).toBe(1);
      });

      it('toAssetPack writes 3 subAssets (mesh / material / scene) for a Tier-B box', async () => {
        const json = makeBoxJson({
          bufferLength: bin.byteLength,
          bufferUri: 'box.bin',
          bufferIndex: 0,
        });
        const docResult = await parseGltf(
          json,
          async () => bytesToArrayBuffer(bin),
          '/fixture/box.gltf',
        );
        expect(docResult.ok).toBe(true);
        if (!docResult.ok) return;
        const pack = unwrapAssetPack(toAssetPack(docResult.value, undefined, 'box.gltf'));
        expect(pack.meta.kind).toBe('external-asset-package');
        expect(pack.meta.subAssets.length).toBe(3);
        const kinds = pack.meta.subAssets.map((s) => s.kind).sort();
        expect(kinds).toEqual(['material', 'mesh', 'scene']);
        expect(pack.meta.subAssets).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'mesh', name: 'BoxMesh' }),
            expect.objectContaining({ kind: 'material', name: 'BoxMat' }),
            expect.objectContaining({ kind: 'scene', name: 'BoxScene' }),
          ]),
        );
      });

      it('toAssetPack reuses GUIDs byte-identically on second pass (AC-13)', async () => {
        const json = makeBoxJson({
          bufferLength: bin.byteLength,
          bufferUri: 'box.bin',
          bufferIndex: 0,
        });
        const doc1 = await parseGltf(
          json,
          async () => bytesToArrayBuffer(bin),
          '/fixture/box.gltf',
        );
        if (!doc1.ok) throw new Error('doc1 failed');
        const pack1 = unwrapAssetPack(toAssetPack(doc1.value, undefined, 'box.gltf'));
        const doc2 = await parseGltf(
          json,
          async () => bytesToArrayBuffer(bin),
          '/fixture/box.gltf',
        );
        if (!doc2.ok) throw new Error('doc2 failed');
        const pack2 = unwrapAssetPack(toAssetPack(doc2.value, pack1.meta, 'box.gltf'));
        expect(pack2.meta.subAssets.map((s) => s.guid)).toEqual(
          pack1.meta.subAssets.map((s) => s.guid),
        );
      });
    });
  });
}

{
  // ─── from gltf-importer-byte-equivalence.test.ts ───

  const MESH_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d450';
  const MAT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d451';
  const SCENE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d452';

  function importerBuildSelfContainedGltfBytes(): Uint8Array {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
    const indices = new Uint16Array([0, 1, 2]);

    const posBytes = new Uint8Array(positions.buffer);
    const normBytes = new Uint8Array(normals.buffer);
    const uvBytes = new Uint8Array(uvs.buffer);
    const idxBytes = new Uint8Array(indices.buffer);

    const segments = [posBytes, normBytes, uvBytes, idxBytes];
    const total = segments.reduce((n, s) => n + s.byteLength, 0);
    const blob = new Uint8Array(total);
    let off = 0;
    const offsets: number[] = [];
    for (const s of segments) {
      offsets.push(off);
      blob.set(s, off);
      off += s.byteLength;
    }
    const b64 = Buffer.from(blob).toString('base64');

    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 },
          ],
        },
      ],
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorFactor: [0.8, 0.4, 0.2, 1],
            metallicFactor: 0.25,
            roughnessFactor: 0.75,
          },
        },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
        { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: offsets[0], byteLength: posBytes.byteLength },
        { buffer: 0, byteOffset: offsets[1], byteLength: normBytes.byteLength },
        { buffer: 0, byteOffset: offsets[2], byteLength: uvBytes.byteLength },
        { buffer: 0, byteOffset: offsets[3], byteLength: idxBytes.byteLength },
      ],
      buffers: [{ uri: `data:application/octet-stream;base64,${b64}`, byteLength: total }],
    };
    return new TextEncoder().encode(JSON.stringify(gltf));
  }

  function normalize(value: unknown): unknown {
    if (
      value instanceof Float32Array ||
      value instanceof Uint8Array ||
      value instanceof Uint16Array ||
      value instanceof Uint32Array
    ) {
      return Array.from(value);
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = normalize(v);
      }
      return out;
    }
    return value;
  }

  function serialize(value: unknown): string {
    return JSON.stringify(normalize(value));
  }

  async function parseFixture(bytes: Uint8Array): Promise<GltfDoc> {
    const json = JSON.parse(new TextDecoder().decode(bytes));
    const externalLoader = async (uri: string): Promise<ArrayBuffer> => {
      throw new Error(`unexpected external buffer ${uri}`);
    };
    const res = await parseGltf(json, externalLoader, 'fixture.gltf');
    if (!res.ok) throw new Error(`fixture parse failed: ${res.error.code}`);
    return res.value;
  }

  function fixtureMeta(): RunImportMeta {
    return {
      importer: 'gltf',
      source: 'fixture.gltf',
      subAssets: [
        { guid: MESH_GUID, sourceIndex: 0, sourceKey: 'mesh', kind: 'mesh' },
        { guid: MAT_GUID, sourceIndex: 0, sourceKey: 'material', kind: 'material' },
        { guid: SCENE_GUID, sourceIndex: 0, sourceKey: 'scene', kind: 'scene' },
      ],
    };
  }

  describe('gltf-importer-byte-equivalence.test.ts', () => {
    describe('gltfImporter byte-equivalence (AC-12, DDC basis / D-5)', () => {
      it('importer DDC payloads are byte-identical to the bridge-function baseline', async () => {
        const bytes = importerBuildSelfContainedGltfBytes();
        const fs: ImportRunnerFs = {
          readSource: async () => ({ ok: true as const, value: bytes }),
        };

        const reg = new ImporterRegistry();
        reg.register(gltfImporter);
        const res = await runImport(fixtureMeta(), reg, fs);
        expect(res.ok).toBe(true);
        if (!res.ok || 'skipped' in res.value) throw new Error('expected a DDC pack');
        const importerPack = res.value.pack;

        const doc = await parseFixture(bytes);
        const meshIr = doc.meshes[0];
        const matIr = doc.materials[0];
        if (meshIr === undefined || matIr === undefined)
          throw new Error('fixture doc must carry one mesh + one material');
        const baselineMesh = meshIrToMeshAsset([meshIr], {
          guidByIndex: new Map([[0, MAT_GUID]]),
          sourceKeyByIndex: new Map([[0, 'material']]),
          ...(matIr.name === undefined ? {} : { nameByIndex: new Map([[0, matIr.name]]) }),
        });
        const baselineMat = toMaterialAsset(matIr);

        const importerMesh = importerPack.assets.find((a) => a.guid === MESH_GUID);
        const importerMat = importerPack.assets.find((a) => a.guid === MAT_GUID);

        expect(serialize(importerMesh?.payload)).toBe(serialize(baselineMesh));
        const meshBody = importerMesh?.artifacts.body;
        expect(meshBody?.mediaType).toBe('application/x-forgeax-mesh');
        expect(meshBody?.assetCodec).toEqual({ name: 'mesh-binary', version: '5' });
        expect(meshBody?.bytes).toBeInstanceOf(Uint8Array);
        const meshHeader = new DataView(
          (meshBody?.bytes as Uint8Array).buffer,
          (meshBody?.bytes as Uint8Array).byteOffset,
          (meshBody?.bytes as Uint8Array).byteLength,
        );
        expect(meshHeader.getUint32(0, true)).toBe(5);
        expect(meshHeader.getUint32(4, true)).toBe(1);
        expect(meshHeader.getUint32(12, true)).toBe(
          baselineMesh.vertices.byteLength / (baselineMesh.vertices.length / 12),
        );
        expect(meshHeader.getUint32(16, true)).toBe(baselineMesh.vertices.length / 12);
        expect(meshHeader.getUint32(24, true)).toBe(
          (baselineMesh.indices ?? new Uint16Array()).length,
        );
        expect(meshHeader.getUint32(28, true)).toBe(
          (baselineMesh.indices ?? new Uint16Array()).BYTES_PER_ELEMENT,
        );

        expect(serialize(importerMat?.payload)).toBe(serialize(baselineMat));
        expect(importerPack.assets.map((a) => a.guid)).toEqual([MESH_GUID, MAT_GUID, SCENE_GUID]);
      });

      it('the fixture meta GUIDs round-trip through toAssetPack stably (reimport-stable)', async () => {
        const doc = await parseFixture(importerBuildSelfContainedGltfBytes());
        const { subAssets } = unwrapAssetPack(toAssetPack(doc, undefined, 'fixture.gltf'));
        const kinds = subAssets.map((s) => s.kind);
        expect(kinds).toContain('mesh');
        expect(kinds).toContain('material');
        expect(kinds).toContain('scene');
      });
    });
  });
}

{
  // ─── from gltf-importer-texture-data-uri.test.ts ───

  const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';

  const MOCK_TEXTURE: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm-srgb',
    data: new Uint8Array([0, 0, 0, 0]),
    colorSpace: 'srgb',
    mips: { kind: 'generate' },
  };

  function buildSelfContainedGltfWithDataUriImage(): Uint8Array {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
    const indices = new Uint16Array([0, 1, 2]);
    const segments = [
      new Uint8Array(positions.buffer),
      new Uint8Array(normals.buffer),
      new Uint8Array(uvs.buffer),
      new Uint8Array(indices.buffer),
    ];
    const total = segments.reduce((n, s) => n + s.byteLength, 0);
    const blob = new Uint8Array(total);
    let off = 0;
    const offsets: number[] = [];
    for (const s of segments) {
      offsets.push(off);
      blob.set(s, off);
      off += s.byteLength;
    }
    const b64 = Buffer.from(blob).toString('base64');

    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 },
          ],
        },
      ],
      materials: [
        {
          emissiveFactor: [0.8, 0.4, 0.1],
          emissiveTexture: { index: 0 },
          pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
        },
      ],
      textures: [{ source: 0, sampler: 0 }],
      samplers: [{}],
      images: [{ uri: `data:image/png;base64,${TINY_PNG_BASE64}` }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
        { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: offsets[0], byteLength: segments[0]?.byteLength },
        { buffer: 0, byteOffset: offsets[1], byteLength: segments[1]?.byteLength },
        { buffer: 0, byteOffset: offsets[2], byteLength: segments[2]?.byteLength },
        { buffer: 0, byteOffset: offsets[3], byteLength: segments[3]?.byteLength },
      ],
      buffers: [{ uri: `data:application/octet-stream;base64,${b64}`, byteLength: total }],
    };
    return new TextEncoder().encode(JSON.stringify(gltf));
  }

  interface DecodeCall {
    readonly mimeType: string;
  }

  function makeDataUriCtx(opts: {
    bytes: Uint8Array;
    subAssets: readonly ImportSubAsset[];
    decodeCalls: DecodeCall[];
    importSettings?: Readonly<Record<string, unknown>>;
  }): ImportContext {
    return {
      source: 'inline.gltf',
      readSource: async () => ({ ok: true, value: opts.bytes }),
      readSibling: async (uri: string) => ({
        ok: false,
        error: {
          code: 'source-read-failed',
          expected: '',
          hint: '',
          detail: { source: uri, reason: 'no sibling reads expected on data: URI path' },
          message: 'unused',
          name: 'ImportError',
        } as never,
      }),
      decodeImage: async (_bytes, mimeType) => {
        opts.decodeCalls.push({ mimeType });
        return {
          ok: true,
          value: { texture: { ...MOCK_TEXTURE, colorSpace: 'srgb' }, bytes: new Uint8Array(8) },
        };
      },
      subAssets: opts.subAssets,
      importSettings: opts.importSettings ?? {},
    };
  }

  function buildSkinOnlyGltf(): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: 'root', children: [1] }, { name: 'joint' }],
        skins: [{ joints: [1] }],
      }),
    );
  }

  describe('gltf-importer-texture-data-uri.test.ts', () => {
    describe('gltfImporter texture extraction (c) data URI / .gltf / AC-10', () => {
      it('decodes the data: URI inline (no readSibling) and funnels through ctx.decodeImage', async () => {
        const bytes = buildSelfContainedGltfWithDataUriImage();
        const calls: DecodeCall[] = [];
        const TEX_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d480';
        const MAT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d481';
        const ctx = makeDataUriCtx({
          bytes,
          subAssets: [
            { guid: TEX_GUID, sourceIndex: 0, kind: 'texture' },
            { guid: MAT_GUID, sourceIndex: 0, kind: 'material' },
            { guid: '019e2cc6-0c86-79da-aa76-b0984c86d482', sourceIndex: 0, kind: 'mesh' },
            { guid: '019e2cc6-0c86-79da-aa76-b0984c86d483', sourceIndex: 0, kind: 'scene' },
          ],
          decodeCalls: calls,
        });

        const produced = unwrap(await gltfImporter.import(ctx));
        expect(calls.length).toBe(1);
        expect(calls[0]?.mimeType).toBe('image/png');

        const tex = produced.find((p) => p.guid === TEX_GUID);
        expect(tex?.kind).toBe('texture');
        const mat = produced.find((p) => p.guid === MAT_GUID);
        expect(mat?.refs.map((r) => r.guid)).toContain(TEX_GUID);
        expect(mat?.refs.at(-1)?.sourceField?.fieldName).toBe('emissiveTexture');
        const materialPayload = mat?.payload as {
          readonly values?: Readonly<Record<string, unknown>>;
        };
        expect(materialPayload.values?.emissive).toEqual([0.8, 0.4, 0.1]);
        expect(materialPayload.values?.emissiveIntensity).toBe(1);
        expect(materialPayload.values?.emissiveTexture).toMatchObject({ texture: 1 });
      });
    });

    it('derives animated bounds through the real glTF import path without metadata', async () => {
      const binary = new Uint8Array(72);
      new Float32Array(binary.buffer, 0, 3).set([1, 0, 0]);
      new Uint16Array(binary.buffer, 12, 4).set([0, 0, 0, 0]);
      new Float32Array(binary.buffer, 20, 4).set([1, 0, 0, 0]);
      new Float32Array(binary.buffer, 36, 2).set([0, 1]);
      new Float32Array(binary.buffer, 44, 6).set([0, 0, 0, 4, 2, 0]);
      const guid = '019e2cc6-0c86-79da-aa76-b0984c86d493';
      const source = {
        asset: { version: '2.0' },
        buffers: [
          {
            byteLength: 72,
            uri: `data:application/octet-stream;base64,${Buffer.from(binary).toString('base64')}`,
          },
        ],
        bufferViews: [
          [0, 12],
          [12, 8],
          [20, 16],
          [36, 8],
          [44, 24],
        ].map(([byteOffset, byteLength]) => ({ buffer: 0, byteOffset, byteLength })),
        accessors: [
          { bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' },
          { bufferView: 1, componentType: 5123, count: 1, type: 'VEC4' },
          { bufferView: 2, componentType: 5126, count: 1, type: 'VEC4' },
          { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR' },
          { bufferView: 4, componentType: 5126, count: 2, type: 'VEC3' },
        ],
        meshes: [
          { primitives: [{ mode: 0, attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] },
        ],
        nodes: [
          { name: 'root', children: [1, 2] },
          { name: 'mesh', mesh: 0, skin: 0 },
          { name: 'joint' },
        ],
        scenes: [{ nodes: [0] }],
        scene: 0,
        skins: [{ joints: [2] }],
        animations: [
          {
            channels: [{ sampler: 0, target: { node: 2, path: 'translation' } }],
            samplers: [{ input: 3, output: 4, interpolation: 'LINEAR' }],
          },
        ],
      };
      const produced = unwrap(
        await gltfImporter.import(
          makeDataUriCtx({
            bytes: new TextEncoder().encode(JSON.stringify(source)),
            subAssets: [{ guid, kind: 'skeleton', sourceIndex: 0 }],
            decodeCalls: [],
          }),
        ),
      );
      const skeleton = produced.find((asset) => asset.guid === guid);
      if (skeleton?.payload.kind !== 'skeleton') throw new Error('missing skeleton');
      const bounds = skeleton.payload.bounds;
      if (bounds === undefined) throw new Error('missing imported animation bounds');
      expect(bounds[0]).toBeLessThanOrEqual(1);
      expect(bounds[3]).toBeGreaterThanOrEqual(5);
      expect(bounds[4]).toBeGreaterThanOrEqual(2);
      expect((bounds[3] ?? NaN) - (bounds[0] ?? NaN)).toBeLessThan(4.01);
    });

    it('imports producer-authored animated skin bounds from importSettings with the SkinAsset', async () => {
      const skeletonGuid = '019e2cc6-0c86-79da-aa76-b0984c86d490';
      const skinGuid = '019e2cc6-0c86-79da-aa76-b0984c86d491';
      const sceneGuid = '019e2cc6-0c86-79da-aa76-b0984c86d492';
      const produced = unwrap(
        await gltfImporter.import(
          makeDataUriCtx({
            bytes: buildSkinOnlyGltf(),
            subAssets: [
              { guid: skeletonGuid, sourceIndex: 0, kind: 'skeleton' },
              { guid: skinGuid, sourceIndex: 0, kind: 'skin' },
              { guid: sceneGuid, sourceIndex: 0, kind: 'scene' },
            ],
            decodeCalls: [],
            importSettings: {
              conservativeAnimatedBounds: [[-2, -3, -4, 2, 3, 4]],
            },
          }),
        ),
      );
      const skeleton = produced.find((asset) => asset.guid === skeletonGuid);
      expect(skeleton?.payload).toMatchObject({ kind: 'skeleton', jointCount: 1 });
      if (skeleton?.payload.kind !== 'skeleton') throw new Error('expected SkeletonAsset');
      expect(skeleton.payload.bounds).toEqual(new Float32Array([-2, -3, -4, 2, 3, 4]));

      const skin = produced.find((asset) => asset.guid === skinGuid);
      expect(skin?.payload).toEqual({
        kind: 'skin',
        skeletonGuid,
        jointPaths: ['root/joint'],
      });
    });

    it('reads glTF ForgeaX extras as producer-authored bounds without bind-pose derivation', async () => {
      const parsed = await parseGltf(
        {
          asset: { version: '2.0' },
          nodes: [{ name: 'root', children: [1] }, { name: 'joint' }],
          scenes: [{ nodes: [0] }],
          skins: [
            {
              joints: [1],
              extras: { forgeax: { conservativeAnimatedBounds: [-1, -2, -3, 1, 2, 3] } },
            },
          ],
        },
        async () => new ArrayBuffer(0),
        'extras.gltf',
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.skeletons[0]?.bounds).toEqual(new Float32Array([-1, -2, -3, 1, 2, 3]));
    });

    it('leaves animated bounds absent when skinned positions have no producer metadata', async () => {
      const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
      const parsed = await parseGltf(
        {
          asset: { version: '2.0' },
          buffers: [{ byteLength: positions.length * 4, uri: buildBase64Buffer(positions) }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length * 4 }],
          accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
          nodes: [{ name: 'root', mesh: 0, skin: 0, children: [1] }, { name: 'joint' }],
          scenes: [{ nodes: [0] }],
          scene: 0,
          skins: [{ joints: [1] }],
        },
        noopLoader,
        'no-animated-bounds.gltf',
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.meshes[0]?.positions).toEqual(new Float32Array(positions));
      expect(parsed.value.skeletons[0]?.bounds).toBeUndefined();
    });
  });
}

{
  // ─── from gltf-importer-texture-external.test.ts ───

  const FIXTURE_DIR = path.resolve(
    __dirname,
    '../../../../forgeax-engine-assets/khronos-gltf-samples/BoxTextured/glTF',
  );

  const EXT_MOCK_TEXTURE: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm-srgb',
    data: new Uint8Array([200, 100, 50, 255]),
    colorSpace: 'srgb',
    mips: { kind: 'generate' },
  };

  interface SiblingCall {
    readonly uri: string;
  }
  interface ExtDecodeCall {
    readonly mimeType: string;
    readonly settings: Readonly<Record<string, unknown>>;
  }

  function makeExtCtx(opts: {
    source: string;
    bytes: Uint8Array;
    subAssets: readonly ImportSubAsset[];
    siblingCalls: SiblingCall[];
    decodeCalls: ExtDecodeCall[];
  }): ImportContext {
    return {
      source: opts.source,
      readSource: async () => ({ ok: true, value: opts.bytes }),
      readSibling: async (uri: string) => {
        opts.siblingCalls.push({ uri });
        try {
          const buf = await readFile(path.join(FIXTURE_DIR, uri));
          return { ok: true, value: new Uint8Array(buf) };
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          const err: ImportErrorType = {
            code: 'source-read-failed',
            expected: '',
            hint: '',
            detail: { source: uri, reason },
            message: '[ImportError source-read-failed]',
            name: 'ImportError',
          } as never;
          return { ok: false, error: err };
        }
      },
      decodeImage: async (_bytes, mimeType, settings) => {
        opts.decodeCalls.push({ mimeType, settings });
        return {
          ok: true,
          value: {
            texture: {
              ...EXT_MOCK_TEXTURE,
              colorSpace: settings.colorSpace === 'linear' ? 'linear' : 'srgb',
              format: settings.colorSpace === 'linear' ? 'rgba8unorm' : 'rgba8unorm-srgb',
            },
            bytes: new Uint8Array(8),
          },
        };
      },
      subAssets: opts.subAssets,
      importSettings: {},
    };
  }

  describe('gltf-importer-texture-external.test.ts', () => {
    describe('gltfImporter texture extraction (b) external URI / .gltf / AC-09', () => {
      it('reads the external image via ctx.readSibling and decodes through ctx.decodeImage', async () => {
        const bytes = new Uint8Array(await readFile(path.join(FIXTURE_DIR, 'BoxTextured.gltf')));
        const sibCalls: SiblingCall[] = [];
        const decCalls: ExtDecodeCall[] = [];

        const TEX_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d470';
        const MAT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d471';
        const MESH_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d472';
        const SCENE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d473';
        const ctx = makeExtCtx({
          source: 'BoxTextured.gltf',
          bytes,
          subAssets: [
            { guid: TEX_GUID, sourceIndex: 0, kind: 'texture' },
            { guid: MAT_GUID, sourceIndex: 0, kind: 'material' },
            { guid: MESH_GUID, sourceIndex: 0, kind: 'mesh' },
            { guid: SCENE_GUID, sourceIndex: 0, kind: 'scene' },
          ],
          siblingCalls: sibCalls,
          decodeCalls: decCalls,
        });

        const produced = unwrap(await gltfImporter.import(ctx));
        const sibUris = sibCalls.map((c) => c.uri);
        expect(sibUris).toContain('CesiumLogoFlat.png');
        expect(sibUris).toContain('BoxTextured0.bin');
        expect(decCalls.length).toBe(1);
        expect(decCalls[0]?.mimeType).toBe('image/png');

        const tex = produced.find((p) => p.guid === TEX_GUID);
        expect(tex?.kind).toBe('texture');
        expect((tex?.payload as TextureAsset).colorSpace).toBe('srgb');

        const mat = produced.find((p) => p.guid === MAT_GUID);
        expect(mat?.refs.map((r) => r.guid)).toContain(TEX_GUID);
      });
    });
  });
}

{
  // ─── from gltf-importer-texture-glb.test.ts ───

  const GLB_MOCK_TEXTURE: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm-srgb',
    data: new Uint8Array([255, 128, 64, 255]),
    colorSpace: 'srgb',
    mips: { kind: 'generate' },
  };

  interface GlbDecodeCall {
    readonly mimeType: string;
    readonly settings: Readonly<Record<string, unknown>>;
    readonly byteCount: number;
  }

  function makeGlbCtx(opts: {
    source: string;
    bytes: Uint8Array;
    subAssets: readonly ImportSubAsset[];
    decodeCalls: GlbDecodeCall[];
    importSettings?: Readonly<Record<string, unknown>>;
    sourceOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    compressedArtifact?: boolean;
  }): ImportContext {
    return {
      source: opts.source,
      readSource: async () => ({ ok: true, value: opts.bytes }),
      readSibling: async (uri: string) => ({
        ok: false,
        error: {
          code: 'source-read-failed',
          expected: '',
          hint: '',
          detail: { source: uri, reason: 'no sibling reads expected on GLB path' },
          message: 'unused',
          name: 'ImportError',
        } as never,
      }),
      decodeImage: async (bytes, mimeType, settings) => {
        opts.decodeCalls.push({ mimeType, settings, byteCount: bytes.byteLength });
        const texture: TextureAsset = {
          ...GLB_MOCK_TEXTURE,
          colorSpace: settings.colorSpace === 'linear' ? 'linear' : 'srgb',
          format: settings.colorSpace === 'linear' ? 'rgba8unorm' : 'rgba8unorm-srgb',
        };
        const decodeValue = {
          texture,
          bytes: new Uint8Array(bytes),
          ...(opts.compressedArtifact === true
            ? {
                mediaType: 'image/ktx2',
                assetCodec: { name: 'basis', profile: 'etc1s' },
              }
            : {}),
        };
        return {
          ok: true,
          value: decodeValue,
        };
      },
      subAssets: opts.subAssets,
      importSettings: opts.importSettings ?? {},
      ...(opts.sourceOverrides === undefined ? {} : { sourceOverrides: opts.sourceOverrides }),
    };
  }

  const FIXTURE_GLB = path.resolve(
    __dirname,
    '../../../../forgeax-engine-assets/khronos-gltf-samples/BoxTextured/BoxTextured.glb',
  );

  describe('gltf-importer-texture-glb.test.ts', () => {
    it('cooks an authored Mesh slot default from the source override', async () => {
      const bytes = new Uint8Array(await readFile(FIXTURE_GLB));
      const textureGuid = '019e2cc6-0c86-79da-aa76-b0984c86d470';
      const sourceMaterialGuid = '019e2cc6-0c86-79da-aa76-b0984c86d471';
      const authoredMaterialGuid = '019e2cc6-0c86-79da-aa76-b0984c86d472';
      const meshGuid = '019e2cc6-0c86-79da-aa76-b0984c86d473';
      const sceneGuid = '019e2cc6-0c86-79da-aa76-b0984c86d474';
      const produced = unwrap(
        await gltfImporter.import(
          makeGlbCtx({
            source: 'BoxTextured.glb',
            bytes,
            subAssets: [
              { guid: textureGuid, sourceIndex: 0, sourceKey: 'texture/0', kind: 'texture' },
              {
                guid: sourceMaterialGuid,
                sourceIndex: 0,
                sourceKey: 'gltf:material:0',
                kind: 'material',
              },
              { guid: meshGuid, sourceIndex: 0, sourceKey: 'mesh/0', kind: 'mesh' },
              { guid: sceneGuid, sourceIndex: 0, sourceKey: 'scene/0', kind: 'scene' },
            ],
            sourceOverrides: {
              'mesh/0': {
                materialSlots: [
                  {
                    slotName: 'Material',
                    sourceKey: 'gltf:material:0',
                    defaultMaterialGuid: sourceMaterialGuid,
                  },
                ],
                materialSlotDefaultOverrides: { 'gltf:material:0': authoredMaterialGuid },
              },
            },
            decodeCalls: [],
          }),
        ),
      );
      const mesh = produced.find((asset) => asset.guid === meshGuid)?.payload;

      expect(mesh?.kind).toBe('mesh');
      if (mesh?.kind !== 'mesh') throw new Error('expected imported MeshAsset');
      expect(AssetGuid.format(mesh.materialSlots[0]?.defaultMaterial as never)).toBe(
        authoredMaterialGuid,
      );
    });

    it('keeps a removed authored slot as a defaultless tombstone without a dependency ref', async () => {
      const bytes = new Uint8Array(await readFile(FIXTURE_GLB));
      const removedGuid = '019e2cc6-0c86-79da-aa76-b0984c86d499';
      const meshGuid = '019e2cc6-0c86-79da-aa76-b0984c86d473';
      const produced = unwrap(
        await gltfImporter.import(
          makeGlbCtx({
            source: 'BoxTextured.glb',
            bytes,
            subAssets: [
              {
                guid: '019e2cc6-0c86-79da-aa76-b0984c86d470',
                sourceIndex: 0,
                sourceKey: 'texture/0',
                kind: 'texture',
              },
              {
                guid: '019e2cc6-0c86-79da-aa76-b0984c86d471',
                sourceIndex: 0,
                sourceKey: 'gltf:material:0',
                kind: 'material',
              },
              { guid: meshGuid, sourceIndex: 0, sourceKey: 'mesh/0', kind: 'mesh' },
              {
                guid: '019e2cc6-0c86-79da-aa76-b0984c86d474',
                sourceIndex: 0,
                sourceKey: 'scene/0',
                kind: 'scene',
              },
            ],
            sourceOverrides: {
              'mesh/0': {
                materialSlots: [
                  { slotName: 'Material', sourceKey: 'gltf:material:0' },
                  { slotName: 'Removed', sourceKey: 'gltf:material:removed' },
                ],
                materialSlotDefaultOverrides: { 'gltf:material:removed': removedGuid },
              },
            },
            decodeCalls: [],
          }),
        ),
      );
      const meshAsset = produced.find((asset) => asset.guid === meshGuid);
      if (meshAsset?.payload.kind !== 'mesh') throw new Error('expected imported MeshAsset');
      expect(meshAsset.payload.materialSlots[1]?.defaultMaterial).toBeUndefined();
      expect(meshAsset.refs.map((ref) => ref.guid)).not.toContain(removedGuid);
    });

    describe('gltfImporter texture extraction (a) bufferView path / GLB / AC-08', () => {
      it('extracts the bufferView image, decodes through ctx.decodeImage, and emits a kind:"texture" ImportedAsset', async () => {
        const bytes = new Uint8Array(await readFile(FIXTURE_GLB));
        const calls: GlbDecodeCall[] = [];
        const TEX_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d460';
        const MAT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d461';
        const MESH_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d462';
        const SCENE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d463';
        const ctx = makeGlbCtx({
          source: 'BoxTextured.glb',
          bytes,
          subAssets: [
            { guid: TEX_GUID, sourceIndex: 0, kind: 'texture' },
            { guid: MAT_GUID, sourceIndex: 0, kind: 'material' },
            { guid: MESH_GUID, sourceIndex: 0, kind: 'mesh' },
            { guid: SCENE_GUID, sourceIndex: 0, kind: 'scene' },
          ],
          decodeCalls: calls,
        });

        const produced = unwrap(await gltfImporter.import(ctx));
        const tex = produced.find((p) => p.guid === TEX_GUID);
        expect(tex).toBeDefined();
        expect(tex?.kind).toBe('texture');
        expect((tex?.payload as TextureAsset).colorSpace).toBe('srgb');
        expect(calls.length).toBe(1);
        expect(calls[0]?.mimeType).toBe('image/png');

        const mat = produced.find((p) => p.guid === MAT_GUID);
        expect(mat?.refs.map((r) => r.guid)).toContain(TEX_GUID);
      });

      it('preserves Basis artifact facts from a compressed embedded GLB texture', async () => {
        const bytes = new Uint8Array(await readFile(FIXTURE_GLB));
        const TEX_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d470';
        const MAT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d471';
        const MESH_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d472';
        const SCENE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d473';
        const produced = unwrap(
          await gltfImporter.import(
            makeGlbCtx({
              source: 'BoxTextured.glb',
              bytes,
              subAssets: [
                { guid: TEX_GUID, sourceIndex: 0, kind: 'texture' },
                { guid: MAT_GUID, sourceIndex: 0, kind: 'material' },
                { guid: MESH_GUID, sourceIndex: 0, kind: 'mesh' },
                { guid: SCENE_GUID, sourceIndex: 0, kind: 'scene' },
              ],
              decodeCalls: [],
              importSettings: { compressionMode: 'etc1s' },
              compressedArtifact: true,
            }),
          ),
        );

        const texture = produced.find((asset) => asset.guid === TEX_GUID);
        expect(texture?.artifacts.body?.mediaType).toBe('image/ktx2');
        expect(texture?.artifacts.body?.assetCodec).toEqual({
          name: 'basis',
          profile: 'etc1s',
        });
      });
    });
  });

  describe('asset-ref-edge-metadata-contract (AC-02 / w6)', () => {
    it('(a) scene refs mesh edge: sourceField filled with componentName/fieldName', async () => {
      const bytes = new Uint8Array(await readFile(FIXTURE_GLB));
      const TEX_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d460';
      const MAT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d461';
      const MESH_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d462';
      const SCENE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d463';
      const ctx = makeGlbCtx({
        source: 'BoxTextured.glb',
        bytes,
        subAssets: [
          { guid: TEX_GUID, sourceIndex: 0, kind: 'texture' },
          { guid: MAT_GUID, sourceIndex: 0, kind: 'material' },
          { guid: MESH_GUID, sourceIndex: 0, kind: 'mesh' },
          { guid: SCENE_GUID, sourceIndex: 0, kind: 'scene' },
        ],
        decodeCalls: [],
      });
      const produced = unwrap(await gltfImporter.import(ctx));
      const scene = produced.find((p) => p.guid === SCENE_GUID);
      expect(scene).toBeDefined();
      const meshRefs = scene?.refs.filter((r) => r.guid === MESH_GUID);
      expect(meshRefs?.length).toBeGreaterThanOrEqual(1);
      const meshRef = meshRefs?.[0];
      expect(meshRef?.sourceField?.componentName).toBe('MeshFilter');
      expect(meshRef?.sourceField?.fieldName).toBe('assetHandle');
      expect(meshRef?.sceneEntityKey).toMatch(/^node-\d+$/);
      expect(scene?.refs.some((ref) => ref.guid === MAT_GUID)).toBe(false);
    });

    it('(b) sceneEntityKey identifies the keyed entity for handle-field refs', async () => {
      const bytes = new Uint8Array(await readFile(FIXTURE_GLB));
      const TEX_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d460';
      const MAT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d461';
      const MESH_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d462';
      const SCENE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d463';
      const ctx = makeGlbCtx({
        source: 'BoxTextured.glb',
        bytes,
        subAssets: [
          { guid: TEX_GUID, sourceIndex: 0, kind: 'texture' },
          { guid: MAT_GUID, sourceIndex: 0, kind: 'material' },
          { guid: MESH_GUID, sourceIndex: 0, kind: 'mesh' },
          { guid: SCENE_GUID, sourceIndex: 0, kind: 'scene' },
        ],
        decodeCalls: [],
      });
      const produced = unwrap(await gltfImporter.import(ctx));
      const scene = produced.find((p) => p.guid === SCENE_GUID);
      expect(scene).toBeDefined();
      const meshRef = scene?.refs.find((r) => r.guid === MESH_GUID);
      expect(meshRef?.sceneEntityKey).toMatch(/^node-\d+$/);
    });

    it('(c) transitive texture edges live on MaterialAsset, not SceneAsset', async () => {
      const bytes = new Uint8Array(await readFile(FIXTURE_GLB));
      const TEX_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d460';
      const MAT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d461';
      const MESH_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d462';
      const SCENE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d463';
      const ctx = makeGlbCtx({
        source: 'BoxTextured.glb',
        bytes,
        subAssets: [
          { guid: TEX_GUID, sourceIndex: 0, kind: 'texture' },
          { guid: MAT_GUID, sourceIndex: 0, kind: 'material' },
          { guid: MESH_GUID, sourceIndex: 0, kind: 'mesh' },
          { guid: SCENE_GUID, sourceIndex: 0, kind: 'scene' },
        ],
        decodeCalls: [],
      });
      const produced = unwrap(await gltfImporter.import(ctx));
      const scene = produced.find((p) => p.guid === SCENE_GUID);
      expect(scene).toBeDefined();
      expect(scene?.refs.some((ref) => ref.guid === TEX_GUID)).toBe(false);
    });

    it('(d) material parent edge points at the injected standard root', async () => {
      const bytes = new Uint8Array(await readFile(FIXTURE_GLB));
      const TEX_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d460';
      const MAT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d461';
      const MESH_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d462';
      const SCENE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d463';
      const ctx = makeGlbCtx({
        source: 'BoxTextured.glb',
        bytes,
        subAssets: [
          { guid: TEX_GUID, sourceIndex: 0, kind: 'texture' },
          { guid: MAT_GUID, sourceIndex: 0, kind: 'material' },
          { guid: MESH_GUID, sourceIndex: 0, kind: 'mesh' },
          { guid: SCENE_GUID, sourceIndex: 0, kind: 'scene' },
        ],
        decodeCalls: [],
        importSettings: { standardMaterialGuid: '019e2cc6-0c86-79da-aa76-b0984c86d4ff' },
      });
      const produced = unwrap(await gltfImporter.import(ctx));
      const mat = produced.find((p) => p.guid === MAT_GUID);
      expect(mat).toBeDefined();
      const parentRefs = mat?.refs.filter((r) => r.sourceField?.fieldName === 'parent');
      expect(parentRefs?.map((ref) => ref.guid)).toEqual(['019e2cc6-0c86-79da-aa76-b0984c86d4ff']);
      expect(mat?.payload).toMatchObject({
        kind: 'material',
        parent: '019e2cc6-0c86-79da-aa76-b0984c86d4ff',
      });
      expect(Object.keys((mat?.payload ?? {}) as Record<string, unknown>).sort()).toEqual([
        'kind',
        'parent',
        'values',
      ]);
    });

    it('(e) material refs texture edges: sourceField.componentName="<material>" and fieldName is texture slot', async () => {
      const bytes = new Uint8Array(await readFile(FIXTURE_GLB));
      const TEX_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d460';
      const MAT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d461';
      const MESH_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d462';
      const SCENE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d463';
      const ctx = makeGlbCtx({
        source: 'BoxTextured.glb',
        bytes,
        subAssets: [
          { guid: TEX_GUID, sourceIndex: 0, kind: 'texture' },
          { guid: MAT_GUID, sourceIndex: 0, kind: 'material' },
          { guid: MESH_GUID, sourceIndex: 0, kind: 'mesh' },
          { guid: SCENE_GUID, sourceIndex: 0, kind: 'scene' },
        ],
        decodeCalls: [],
      });
      const produced = unwrap(await gltfImporter.import(ctx));
      const mat = produced.find((p) => p.guid === MAT_GUID);
      expect(mat).toBeDefined();
      const texRef = mat?.refs.find((r) => r.guid === TEX_GUID);
      expect(texRef).toBeDefined();
      expect(texRef?.sourceField?.componentName).toBe('<material>');
      expect(texRef?.sourceField?.fieldName).toBe('baseColorTexture');
      expect(texRef?.sceneEntityKey).toBeUndefined();
    });

    it('(f) all scene refs AssetRef entries have valid shape', async () => {
      const bytes = new Uint8Array(await readFile(FIXTURE_GLB));
      const TEX_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d460';
      const MAT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d461';
      const MESH_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d462';
      const SCENE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d463';
      const ctx = makeGlbCtx({
        source: 'BoxTextured.glb',
        bytes,
        subAssets: [
          { guid: TEX_GUID, sourceIndex: 0, kind: 'texture' },
          { guid: MAT_GUID, sourceIndex: 0, kind: 'material' },
          { guid: MESH_GUID, sourceIndex: 0, kind: 'mesh' },
          { guid: SCENE_GUID, sourceIndex: 0, kind: 'scene' },
        ],
        decodeCalls: [],
      });
      const produced = unwrap(await gltfImporter.import(ctx));
      const scene = produced.find((p) => p.guid === SCENE_GUID);
      expect(scene).toBeDefined();
      for (const ref of scene?.refs ?? []) {
        expect(typeof ref.guid).toBe('string');
        expect(ref.guid.length).toBeGreaterThan(0);
        if (ref.sourceField !== undefined) {
          expect(typeof ref.sourceField.fieldName).toBe('string');
          expect(ref.sourceField.fieldName.length).toBeGreaterThan(0);
          if (ref.sourceField.componentName !== undefined) {
            expect(typeof ref.sourceField.componentName).toBe('string');
          }
          if (ref.sourceField.arrayIndex !== undefined) {
            expect(typeof ref.sourceField.arrayIndex).toBe('number');
          }
        }
      }
    });
  });
}

{
  // ─── from image-color-space.test.ts ───

  describe('image-color-space.test.ts', () => {
    describe('deriveTextureColorSpace (D-3 / AC-08)', () => {
      it('baseColorTexture image classifies as srgb', () => {
        const map = deriveTextureColorSpace({
          imageCount: 1,
          textures: [{ source: 0 }],
          materials: [{ baseColorTexture: 0 }],
        });
        expect(map.get(0)).toBe('srgb');
      });

      it('normalTexture image classifies as linear', () => {
        const map = deriveTextureColorSpace({
          imageCount: 1,
          textures: [{ source: 0 }],
          materials: [{ normalTexture: 0 }],
        });
        expect(map.get(0)).toBe('linear');
      });

      it('metallicRoughnessTexture image classifies as linear', () => {
        const map = deriveTextureColorSpace({
          imageCount: 1,
          textures: [{ source: 0 }],
          materials: [{ metallicRoughnessTexture: 0 }],
        });
        expect(map.get(0)).toBe('linear');
      });

      it('emissiveTexture image classifies as srgb', () => {
        const map = deriveTextureColorSpace({
          imageCount: 1,
          textures: [{ source: 0 }],
          materials: [{ emissiveTexture: 0 }],
        });
        expect(map.get(0)).toBe('srgb');
      });

      it('physical extension texture slots keep their glTF color domains', () => {
        const map = deriveTextureColorSpace({
          imageCount: 4,
          textures: [{ source: 0 }, { source: 1 }, { source: 2 }, { source: 3 }],
          materials: [
            {
              sheenColorTexture: 0,
              specularColorTexture: 1,
              anisotropyTexture: 2,
              thicknessTexture: 3,
            },
          ],
        });
        expect(map.get(0)).toBe('srgb');
        expect(map.get(1)).toBe('srgb');
        expect(map.get(2)).toBe('linear');
        expect(map.get(3)).toBe('linear');
      });

      it('occlusionTexture image classifies as linear', () => {
        const map = deriveTextureColorSpace({
          imageCount: 1,
          textures: [{ source: 0 }],
          materials: [{ occlusionTexture: 0 }],
        });
        expect(map.get(0)).toBe('linear');
      });

      it('orphan image (no texture references it) defaults to linear (AC-13)', () => {
        const map = deriveTextureColorSpace({
          imageCount: 3,
          textures: [{ source: 0 }],
          materials: [{ baseColorTexture: 0 }],
        });
        expect(map.get(0)).toBe('srgb');
        expect(map.get(1)).toBe('linear');
        expect(map.get(2)).toBe('linear');
      });

      it('conflict (same image bound to baseColor + normal) resolves to srgb (requirements section 8)', () => {
        const map = deriveTextureColorSpace({
          imageCount: 1,
          textures: [{ source: 0 }, { source: 0 }],
          materials: [{ baseColorTexture: 0, normalTexture: 1 }],
        });
        expect(map.get(0)).toBe('srgb');
      });

      it('conflict resolves to srgb regardless of slot ordering (linear seen first then srgb)', () => {
        const map = deriveTextureColorSpace({
          imageCount: 1,
          textures: [{ source: 0 }, { source: 0 }],
          materials: [{ normalTexture: 0, baseColorTexture: 1 }],
        });
        expect(map.get(0)).toBe('srgb');
      });

      it('multi-material multi-image scene resolves each image independently', () => {
        const map = deriveTextureColorSpace({
          imageCount: 4,
          textures: [{ source: 0 }, { source: 1 }, { source: 2 }, { source: 3 }],
          materials: [
            { baseColorTexture: 0, metallicRoughnessTexture: 1, normalTexture: 2 },
            { emissiveTexture: 3 },
          ],
        });
        expect(map.get(0)).toBe('srgb');
        expect(map.get(1)).toBe('linear');
        expect(map.get(2)).toBe('linear');
        expect(map.get(3)).toBe('srgb');
      });

      it('empty doc (no images / no materials) returns empty map', () => {
        const map = deriveTextureColorSpace({ imageCount: 0, textures: [], materials: [] });
        expect(map.size).toBe(0);
      });

      it('undefined textures array (glTF without top-level textures[]) treats nothing as referenced', () => {
        const map = deriveTextureColorSpace({ imageCount: 2, textures: undefined, materials: [] });
        expect(map.get(0)).toBe('linear');
        expect(map.get(1)).toBe('linear');
      });

      it('texture index out of range is silently ignored (no throw, no map entry forced)', () => {
        const map = deriveTextureColorSpace({
          imageCount: 1,
          textures: [{ source: 0 }],
          materials: [{ baseColorTexture: 99 }],
        });
        expect(map.get(0)).toBe('linear');
      });
    });
  });
}

{
  // ─── from khr-extensions.test.ts ───

  describe('khr-extensions.test.ts', () => {
    describe('checkExtensions (w14 fixture set)', () => {
      let stderrSpy: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      });
      afterEach(() => {
        stderrSpy.mockRestore();
      });

      it('public allowlist contains every currently supported extension (literal)', () => {
        expect(EXTENSION_ALLOWLIST).toEqual([
          'EXT_mesh_gpu_instancing',
          'EXT_meshopt_compression',
          'KHR_draco_mesh_compression',
          'KHR_lights_punctual',
          'KHR_texture_transform',
          'KHR_materials_unlit',
          'KHR_materials_emissive_strength',
          'KHR_materials_transmission',
          'KHR_materials_ior',
          'KHR_materials_volume',
          'KHR_materials_clearcoat',
          'KHR_materials_anisotropy',
          'KHR_materials_sheen',
          'KHR_materials_iridescence',
          'KHR_materials_specular',
          'KHR_materials_diffuse_transmission',
        ]);
      });

      it('(a) rejects unsupported extensionsRequired entries', () => {
        const result = checkExtensions({
          extensionsRequired: ['KHR_materials_pbrSpecularGlossiness'],
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('gltf-extension-unsupported');
        if (result.error.code !== 'gltf-extension-unsupported') return;
        expect(result.error.detail.extension).toBe('KHR_materials_pbrSpecularGlossiness');
        expect(result.error.detail.source).toBe('extensionsRequired');
      });

      it('(b) accepts extensionsUsed (not required) into diagnostics list with no stderr', () => {
        const result = checkExtensions({
          extensionsUsed: ['KHR_materials_pbrSpecularGlossiness', 'KHR_materials_transmission'],
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.unsupportedUsed).toEqual(['KHR_materials_pbrSpecularGlossiness']);
        expect(stderrSpy).not.toHaveBeenCalled();
      });

      it('(b2) extensionsUsed over-declared (no material references it) stays silent', () => {
        // Exporters routinely list an extension in extensionsUsed that no
        // material/node/texture actually references (e.g. KHR_materials_unlit).
        // It is informational per the glTF spec -> diagnostics-only, never stderr.
        const result = checkExtensions({ extensionsUsed: ['KHR_materials_unlit'] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.unsupportedUsed).toEqual([]);
        expect(stderrSpy).not.toHaveBeenCalled();
      });

      it('extensionsRequired wins fail-fast over a benign extensionsUsed entry', () => {
        const result = checkExtensions({
          extensionsRequired: ['KHR_materials_unknown'],
          extensionsUsed: ['KHR_materials_unlit'],
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('gltf-extension-unsupported');
      });

      it('passes empty extensions JSON without warning', () => {
        const result = checkExtensions({});
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.unsupportedUsed).toEqual([]);
        expect(stderrSpy).not.toHaveBeenCalled();
      });

      it('EXT_mesh_gpu_instancing in extensionsRequired routes ok (allowlisted)', () => {
        const result = checkExtensions({ extensionsRequired: ['EXT_mesh_gpu_instancing'] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.unsupportedUsed).toEqual([]);
        expect(stderrSpy).not.toHaveBeenCalled();
      });

      it.each([
        'KHR_materials_transmission',
        'KHR_materials_ior',
        'KHR_materials_volume',
        'KHR_materials_clearcoat',
        'KHR_materials_anisotropy',
        'KHR_materials_sheen',
        'KHR_materials_iridescence',
        'KHR_materials_specular',
      ])('%s in extensionsRequired routes ok (supported)', (extension) => {
        const result = checkExtensions({ extensionsRequired: [extension] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.unsupportedUsed).toEqual([]);
        expect(stderrSpy).not.toHaveBeenCalled();
      });

      it('EXT_mesh_gpu_instancing in extensionsUsed (not required) routes ok with no warn', () => {
        const result = checkExtensions({ extensionsUsed: ['EXT_mesh_gpu_instancing'] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.unsupportedUsed).toEqual([]);
        expect(stderrSpy).not.toHaveBeenCalled();
      });
    });
  });
}

{
  // ─── from multi-primitive.test.ts ───

  describe('multi-primitive.test.ts', () => {
    describe('parseGltf multi-primitive (T-M2-01)', () => {
      it('produces one GltfMeshIr per primitive for a multi-primitive mesh', async () => {
        const bufferUri = buildBase64Buffer([0.5, 0.5, 0.5, 1.5, 1.5, 1.5, 2.5, 2.5, 2.5]);
        const json = {
          asset: { version: '2.0' },
          buffers: [{ uri: bufferUri }],
          bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: 12 },
            { buffer: 0, byteOffset: 12, byteLength: 12 },
            { buffer: 0, byteOffset: 24, byteLength: 12 },
            { buffer: 0, byteOffset: 36, byteLength: 0 },
          ],
          accessors: [
            {
              bufferView: 0,
              componentType: 5126,
              type: 'VEC3',
              count: 1,
              min: [0.5, 0.5, 0.5],
              max: [0.5, 0.5, 0.5],
            },
            {
              bufferView: 1,
              componentType: 5126,
              type: 'VEC3',
              count: 1,
              min: [1.5, 1.5, 1.5],
              max: [1.5, 1.5, 1.5],
            },
            {
              bufferView: 2,
              componentType: 5126,
              type: 'VEC3',
              count: 1,
              min: [2.5, 2.5, 2.5],
              max: [2.5, 2.5, 2.5],
            },
            { bufferView: 3, componentType: 5123, type: 'SCALAR', count: 0 },
          ],
          meshes: [
            {
              name: 'Foo',
              primitives: [
                { attributes: { POSITION: 0 }, material: 0 },
                { attributes: { POSITION: 1 }, material: 1 },
                { attributes: { POSITION: 2 }, material: 0 },
              ],
            },
          ],
          materials: [{ name: 'matA' }, { name: 'matB' }],
          nodes: [{ name: 'Root', mesh: 0 }],
          scenes: [{ nodes: [0] }],
        };
        const result = await parseGltf(json, noopLoader, '/test.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const doc: GltfDoc = result.value;
        expect(doc.meshes.length).toBe(3);
        expect(doc.meshes[0]?.materialIndex).toBe(0);
        expect(doc.meshes[1]?.materialIndex).toBe(1);
        expect(doc.meshes[2]?.materialIndex).toBe(0);
        expect(doc.meshes[0]?.positions[0]).toBeCloseTo(0.5);
        expect(doc.meshes[1]?.positions[0]).toBeCloseTo(1.5);
        expect(doc.meshes[2]?.positions[0]).toBeCloseTo(2.5);
      });

      it('mesh name is carried to each primitive GltfMeshIr', async () => {
        const bufferUri = buildBase64Buffer([0, 0, 0, 0, 0, 0]);
        const json = {
          asset: { version: '2.0' },
          buffers: [{ uri: bufferUri }],
          bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: 12 },
            { buffer: 0, byteOffset: 12, byteLength: 12 },
          ],
          accessors: [
            {
              bufferView: 0,
              componentType: 5126,
              type: 'VEC3',
              count: 1,
              min: [0, 0, 0],
              max: [0, 0, 0],
            },
            {
              bufferView: 1,
              componentType: 5126,
              type: 'VEC3',
              count: 1,
              min: [0, 0, 0],
              max: [0, 0, 0],
            },
          ],
          meshes: [
            {
              name: 'NamedMesh',
              primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 1 } }],
            },
          ],
          materials: [],
          nodes: [],
          scenes: [],
        };
        const result = await parseGltf(json, noopLoader, '/test.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const doc: GltfDoc = result.value;
        expect(doc.meshes.length).toBe(2);
        expect(doc.meshes[0]?.name).toBe('NamedMesh');
        expect(doc.meshes[1]?.name).toBe('NamedMesh');
      });

      it('single-primitive mesh still produces one GltfMeshIr (no regression)', async () => {
        const bufferUri = buildBase64Buffer([1, 1, 1]);
        const json = {
          asset: { version: '2.0' },
          buffers: [{ uri: bufferUri }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
          accessors: [
            {
              bufferView: 0,
              componentType: 5126,
              type: 'VEC3',
              count: 1,
              min: [1, 1, 1],
              max: [1, 1, 1],
            },
          ],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
          materials: [],
          nodes: [],
          scenes: [],
        };
        const result = await parseGltf(json, noopLoader, '/test.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.meshes.length).toBe(1);
      });
    });
  });
}

{
  // ─── from pbr-material.test.ts ───

  describe('pbr-material.test.ts', () => {
    describe('parseGltf PBR material 6 fields (T-M3-01)', () => {
      it('decodes all 6 pbrMetallicRoughness fields into GltfMaterialIr', async () => {
        const bufferUri = buildBase64Buffer([0, 0, 0]);
        const json = {
          asset: { version: '2.0' },
          buffers: [{ uri: bufferUri }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
          accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 1 }],
          meshes: [
            { name: 'test-mesh', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] },
          ],
          materials: [
            {
              name: 'test-material',
              pbrMetallicRoughness: {
                baseColorFactor: [0.8, 0.6, 0.4, 1.0],
                baseColorTexture: { index: 0 },
                metallicFactor: 0.25,
                roughnessFactor: 0.75,
                metallicRoughnessTexture: { index: 1 },
              },
              normalTexture: { index: 2 },
              doubleSided: true,
            },
          ],
          textures: [{ source: 0 }, { source: 1 }, { source: 2 }],
          images: [
            { uri: 'baseColor.png', mimeType: 'image/png' },
            { uri: 'metallicRoughness.png', mimeType: 'image/png' },
            { uri: 'normal.png', mimeType: 'image/png' },
          ],
        };
        const result = await parseGltf(json, noopLoader, '/test.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected ok');
        const doc: GltfDoc = result.value;
        expect(doc.materials.length).toBe(1);
        const mat = doc.materials[0];
        expect(mat).toBeDefined();
        if (!mat) throw new Error('expected material[0]');
        expect(mat.baseColorFactor).toEqual([0.8, 0.6, 0.4, 1.0]);
        expect(mat.baseColorTexture).toMatchObject({ texture: 0 });
        expect(mat.metallicFactor).toBe(0.25);
        expect(mat.roughnessFactor).toBe(0.75);
        expect(mat.metallicRoughnessTexture).toMatchObject({ texture: 1 });
        expect(mat.normalTexture).toMatchObject({ texture: 2 });
        expect(mat.doubleSided).toBe(true);
        expect(doc.textures).toBeDefined();
        const texs = doc.textures;
        if (!texs) throw new Error('expected textures');
        expect(texs.length).toBe(3);
        expect(texs[0]?.source ?? -1).toBe(0);
        expect(doc.images).toBeDefined();
        const imgs = doc.images;
        if (!imgs) throw new Error('expected images');
        expect(imgs.length).toBe(3);
        expect(imgs[0]?.uri ?? '').toBe('baseColor.png');
      });

      it('fills glTF spec defaults for missing pbrMetallicRoughness fields', async () => {
        const bufferUri = buildBase64Buffer([0, 0, 0]);
        const json = {
          asset: { version: '2.0' },
          buffers: [{ uri: bufferUri }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
          accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 1 }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
          materials: [{ pbrMetallicRoughness: {} }],
        };
        const result = await parseGltf(json, noopLoader, '/test.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected ok');
        const mat = result.value.materials[0];
        expect(mat).toBeDefined();
        if (!mat) throw new Error('expected material[0]');
        expect(mat.baseColorFactor).toEqual([1, 1, 1, 1]);
        expect(mat.metallicFactor).toBe(1.0);
        expect(mat.roughnessFactor).toBe(1.0);
        expect(mat.baseColorTexture).toBeUndefined();
        expect(mat.metallicRoughnessTexture).toBeUndefined();
        expect(mat.normalTexture).toBeUndefined();
      });

      it('decodes emissiveFactor and emissiveTexture into GltfMaterialIr', async () => {
        const bufferUri = buildBase64Buffer([0, 0, 0]);
        const json = {
          asset: { version: '2.0' },
          buffers: [{ uri: bufferUri }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
          accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 1 }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
          materials: [
            {
              emissiveFactor: [0.8, 0.4, 0.1],
              emissiveTexture: { index: 0 },
            },
          ],
          textures: [{ source: 0 }],
          images: [{ uri: 'emissive.png', mimeType: 'image/png' }],
        };
        const result = await parseGltf(json, noopLoader, '/emissive.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected ok');
        const mat = result.value.materials[0];
        expect(mat?.emissiveFactor).toEqual([0.8, 0.4, 0.1]);
        expect(mat?.emissiveTexture).toMatchObject({ texture: 0 });
      });

      it('resolves texture.index -> textures[ti] -> source two-level hop', async () => {
        const bufferUri = buildBase64Buffer([0, 0, 0]);
        const json = {
          asset: { version: '2.0' },
          buffers: [{ uri: bufferUri }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
          accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 1 }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
          materials: [
            {
              pbrMetallicRoughness: {
                baseColorFactor: [0.5, 0.5, 0.5, 1.0],
                baseColorTexture: { index: 1 },
              },
            },
          ],
          textures: [
            { source: 3, sampler: 0 },
            { source: 5, sampler: 0 },
          ],
          images: [
            {},
            {},
            {},
            { uri: 'tex3.png', mimeType: 'image/png' },
            {},
            { uri: 'tex5.png', mimeType: 'image/png' },
          ],
        };
        const result = await parseGltf(json, noopLoader, '/test.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected ok');
        const doc = result.value;
        const mat = doc.materials[0];
        expect(mat).toBeDefined();
        if (!mat) throw new Error('expected material[0]');
        expect(mat.baseColorTexture).toMatchObject({ texture: 1 });
        const texs2 = doc.textures;
        if (!texs2) throw new Error('expected textures');
        expect(texs2[1]?.source ?? -1).toBe(5);
        const imgs2 = doc.images;
        if (!imgs2) throw new Error('expected images');
        expect(imgs2[5]?.uri ?? '').toBe('tex5.png');
      });
    });
  });
}

{
  // ─── from reimport-reuse-meta.test.ts ───

  function existingMeta(
    entries: ReadonlyArray<{ kind: string; sourceIndex: number; guid: string }>,
  ): GltfMetaJson {
    return {
      schemaVersion: 1,
      kind: 'external-asset-package',
      importer: 'gltf',
      source: 'box.gltf',
      subAssets: entries.map((e) => ({ guid: e.guid, sourceIndex: e.sourceIndex, kind: e.kind })),
      importSettings: {
        defaultSceneIndex: 0,
        diagnostics: { nodeNames: [], unsupportedExtensions: [], matrixTrsCoexistNodes: [] },
      },
    };
  }

  describe('reimport-reuse-meta.test.ts', () => {
    describe('subAssetKey', () => {
      it('builds indexFallback combining pluralised kind and sourceIndex', () => {
        expect(subAssetKey({ kind: 'mesh', sourceIndex: 2, name: 'foo' })).toEqual({
          kind: 'mesh',
          name: 'foo',
          indexFallback: 'meshes/2',
        });
      });

      it('preserves name=null when source is unnamed', () => {
        expect(subAssetKey({ kind: 'material', sourceIndex: 0 })).toEqual({
          kind: 'material',
          name: null,
          indexFallback: 'materials/0',
        });
      });
    });

    describe('reimportReuseMeta (w12 fixture set)', () => {
      let stderrSpy: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      });
      afterEach(() => {
        stderrSpy.mockRestore();
      });

      it('(a) reuses every GUID byte-identically when nothing changes', () => {
        const items: GltfDocItem[] = [
          { kind: 'mesh', sourceIndex: 0, name: 'Box' },
          { kind: 'material', sourceIndex: 0, name: 'Mat' },
          { kind: 'scene', sourceIndex: 0, name: 'Scene0' },
        ];
        const meta = existingMeta([
          { kind: 'mesh', sourceIndex: 0, guid: '01928000-7c00-7000-8000-000000000001' },
          { kind: 'material', sourceIndex: 0, guid: '01928000-7c00-7000-8000-000000000002' },
          { kind: 'scene', sourceIndex: 0, guid: '01928000-7c00-7000-8000-000000000003' },
        ]);
        const result = unwrapReimport(reimportReuseMeta(items, meta));
        expect(result.subAssets.map((s) => s.guid)).toEqual([
          '01928000-7c00-7000-8000-000000000001',
          '01928000-7c00-7000-8000-000000000002',
          '01928000-7c00-7000-8000-000000000003',
        ]);
      });

      it('(b) double-name conflict routes every mesh through indexFallback + warns once per conflict', () => {
        const items: GltfDocItem[] = [
          { kind: 'mesh', sourceIndex: 0, name: 'foo' },
          { kind: 'mesh', sourceIndex: 1, name: 'foo' },
        ];
        const meta = existingMeta([
          { kind: 'mesh', sourceIndex: 0, guid: '01928000-7c00-7000-8000-00000000000a' },
          { kind: 'mesh', sourceIndex: 1, guid: '01928000-7c00-7000-8000-00000000000b' },
        ]);
        const result = reimportReuseMeta(items, meta);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('duplicate-source-key');
        expect(result.error.detail.sourceIndices).toEqual([0, 1]);
        expect(stderrSpy).not.toHaveBeenCalled();
      });

      it('(c) deleted mesh is dropped, surviving mesh reused, new mesh gets fresh v7', () => {
        const items: GltfDocItem[] = [
          { kind: 'mesh', sourceIndex: 1, name: 'B' },
          { kind: 'mesh', sourceIndex: 2, name: 'NewMesh' },
        ];
        const meta = existingMeta([
          { kind: 'mesh', sourceIndex: 0, guid: '01928000-7c00-7000-8000-00000000aaaa' },
          { kind: 'mesh', sourceIndex: 1, guid: '01928000-7c00-7000-8000-00000000bbbb' },
        ]);
        const result = unwrapReimport(reimportReuseMeta(items, meta));
        expect(result.subAssets[0]?.guid).toBe('01928000-7c00-7000-8000-00000000bbbb');
        const fresh = result.subAssets[1]?.guid ?? '';
        expect(fresh).not.toBe('01928000-7c00-7000-8000-00000000aaaa');
        expect(AssetGuid.parse(fresh).ok).toBe(true);
        expect(
          result.subAssets.some((s) => s.guid === '01928000-7c00-7000-8000-00000000aaaa'),
        ).toBe(false);
      });

      it('(d) stage 2 reuses GUID when name differs but (kind,indexFallback) matches', () => {
        const items: GltfDocItem[] = [{ kind: 'mesh', sourceIndex: 0, name: 'Renamed' }];
        const meta = existingMeta([
          { kind: 'mesh', sourceIndex: 0, guid: '01928000-7c00-7000-8000-0000000000aa' },
        ]);
        const result = unwrapReimport(reimportReuseMeta(items, meta));
        expect(result.subAssets[0]?.guid).toBe('01928000-7c00-7000-8000-0000000000aa');
      });

      it('first-import (no existing meta) mints all-fresh v7 GUIDs', () => {
        const items: GltfDocItem[] = [
          { kind: 'mesh', sourceIndex: 0, name: 'Box' },
          { kind: 'scene', sourceIndex: 0, name: 'Scene0' },
        ];
        const result = unwrapReimport(reimportReuseMeta(items, undefined));
        expect(result.subAssets.length).toBe(2);
        for (const sa of result.subAssets) {
          expect(AssetGuid.parse(sa.guid).ok).toBe(true);
        }
        expect(result.subAssets[0]?.guid).not.toBe(result.subAssets[1]?.guid);
      });
    });
  });
}

{
  // ─── from skin-to-asset-pack.test.ts ───

  function makeFixtureDoc(): GltfDoc {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const ibm = new Float32Array(16);
    ibm[0] = 1;
    ibm[5] = 1;
    ibm[10] = 1;
    ibm[15] = 1;

    return {
      meshes: [{ name: 'SkinnedMesh', positions, indices, materialIndex: 0, meshIndex: 0 }],
      materials: [{ baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }],
      nodes: [
        {
          name: 'root',
          transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          meshIndex: 0,
          skinIndex: 0,
          camera: null,
          children: [1],
        },
        {
          name: 'jointA',
          transform: { translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          meshIndex: null,
          skinIndex: null,
          camera: null,
          children: [],
        },
      ],
      scenes: [{ nodes: [0] }],
      textures: undefined,
      images: undefined,
      samplers: undefined,
      skeletons: [{ jointCount: 1, inverseBindMatrices: ibm, jointPaths: ['root/jointA'] }],
      animationClips: [
        {
          duration: 1.0,
          channels: [
            {
              targetId: 'ab9b78fd51898a86ab273a47863a7601' as never,
              targetNodeIndex: 1,
              property: 'rotation',
              sampler: {
                input: new Float32Array([0, 1]),
                output: new Float32Array([0, 0, 0, 1, 0, 1, 0, 0]),
                interpolation: 'LINEAR',
              },
            },
          ],
        },
      ],
      defaultSceneIndex: 0,
      diagnostics: {
        nodeNames: ['root', 'jointA'],
        unsupportedExtensions: [],
        matrixTrsCoexistNodes: [],
      },
    };
  }

  describe('skin-to-asset-pack.test.ts', () => {
    describe('toAssetPack with skin + animation (M0 integration)', () => {
      it('produces 6 sub-asset kind types (mesh, material, scene, skeleton, skin, animation-clip)', () => {
        const doc = makeFixtureDoc();
        const { subAssets } = unwrapAssetPack(toAssetPack(doc, undefined, 'test.gltf'));
        const kinds = new Set(subAssets.map((s) => s.kind));
        expect(kinds.has('mesh')).toBe(true);
        expect(kinds.has('material')).toBe(true);
        expect(kinds.has('scene')).toBe(true);
        expect(kinds.has('skeleton')).toBe(true);
        expect(kinds.has('skin')).toBe(true);
        expect(kinds.has('animation-clip')).toBe(true);
        expect(subAssets.length).toBe(6);
      });

      it('sub-asset GUIDs are non-empty strings', () => {
        const doc = makeFixtureDoc();
        const { subAssets } = unwrapAssetPack(toAssetPack(doc, undefined, 'test.gltf'));
        for (const sa of subAssets) {
          expect(typeof sa.guid).toBe('string');
          expect(sa.guid.length).toBe(36);
        }
      });

      it('skeleton sub-asset keeps sourceIndex aligned with GltfDoc.skeletons', () => {
        const doc = makeFixtureDoc();
        const { subAssets } = unwrapAssetPack(toAssetPack(doc, undefined, 'test.gltf'));
        const skeletonEntries = subAssets.filter((s) => s.kind === 'skeleton');
        expect(skeletonEntries.length).toBe(1);
        expect(skeletonEntries[0]?.sourceIndex).toBe(0);
      });

      it('animation-clip sub-asset keeps sourceIndex aligned', () => {
        const doc = makeFixtureDoc();
        const { subAssets } = unwrapAssetPack(toAssetPack(doc, undefined, 'test.gltf'));
        const animEntries = subAssets.filter((s) => s.kind === 'animation-clip');
        expect(animEntries.length).toBe(1);
        expect(animEntries[0]?.sourceIndex).toBe(0);
      });

      it('uses animation names for stable source keys', () => {
        const doc = makeFixtureDoc();
        const clip = doc.animationClips[0];
        expect(clip).toBeDefined();
        if (clip === undefined) return;
        const named = {
          ...doc,
          animationClips: [
            { ...clip, name: 'Walk' },
            { ...clip, name: 'Run' },
          ],
        };
        const { subAssets } = unwrapAssetPack(toAssetPack(named, undefined, 'test.gltf'));
        expect(
          subAssets.filter((s) => s.kind === 'animation-clip').map((s) => s.sourceKey),
        ).toEqual(['animation-clip:Walk', 'animation-clip:Run']);
      });

      it('reimport with same content produces identical GUIDs', () => {
        const doc = makeFixtureDoc();
        const first = unwrapAssetPack(toAssetPack(doc, undefined, 'test.gltf'));
        const second = unwrapAssetPack(
          toAssetPack(
            doc,
            {
              schemaVersion: 1,
              kind: 'external-asset-package',
              importer: 'gltf',
              source: 'test.gltf',
              subAssets: first.subAssets,
              importSettings: {
                defaultSceneIndex: 0,
                diagnostics: {
                  nodeNames: [],
                  unsupportedExtensions: [],
                  matrixTrsCoexistNodes: [],
                },
              },
            },
            'test.gltf',
          ),
        );
        expect(second.subAssets.length).toBe(first.subAssets.length);
        for (let i = 0; i < first.subAssets.length; i++) {
          expect(second.subAssets[i]?.guid).toBe(first.subAssets[i]?.guid);
        }
      });
    });
  });
}

{
  // ─── from texture-load.test.ts ───

  function buildMinimalJson(materialOverrides: object, images: object[]) {
    const bufferUri = buildBase64Buffer([0, 0, 0]);
    return {
      asset: { version: '2.0' },
      buffers: [{ uri: bufferUri }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
      accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 1 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [
        {
          pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index: 0 } },
          ...materialOverrides,
        },
      ],
      textures: [{ source: 0 }],
      images,
    };
  }

  const pngLoader = async (_: string) => new ArrayBuffer(0);
  const jpegLoader = async (_: string) => new ArrayBuffer(0);

  describe('texture-load.test.ts', () => {
    describe('parseGltf texture load (T-M3-02)', () => {
      it('resolves textures via externalLoader (URI success path)', async () => {
        const json = buildMinimalJson({}, [{ uri: 'textures/checker.png', mimeType: 'image/png' }]);
        const result = await parseGltf(json, pngLoader, '/test.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected ok');
        const doc = result.value;
        expect(doc.textures).toBeDefined();
        const texs3 = doc.textures;
        if (!texs3) throw new Error('expected textures');
        expect(texs3.length).toBe(1);
        expect(texs3[0]?.source ?? -1).toBe(0);
        expect(doc.images).toBeDefined();
        const imgs3 = doc.images;
        if (!imgs3) throw new Error('expected images');
        expect(imgs3.length).toBe(1);
        expect(imgs3[0]?.uri ?? '').toBe('textures/checker.png');
      });

      it('fails with gltf-texture-load-failed when externalLoader rejects', async () => {
        const failingLoader = async (_: string) => {
          throw new Error('network error');
        };
        const json = buildMinimalJson({}, [{ uri: 'textures/missing.png', mimeType: 'image/png' }]);
        const result = await parseGltf(json, failingLoader, '/test.gltf');
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected error');
        const err = result.error;
        expect(err.code).toBe('gltf-texture-load-failed');
        if (err.code === 'gltf-texture-load-failed') {
          expect(err.detail.uri).toBe('textures/missing.png');
        }
      });

      it('fails with gltf-image-mime-unsupported for non-JPEG/PNG mimeType', async () => {
        const failingLoader = async (_: string) => {
          throw new Error('should not be called - mime check comes first');
        };
        const json = buildMinimalJson({}, [{ uri: 'textures/photo.webp', mimeType: 'image/webp' }]);
        const result = await parseGltf(json, failingLoader, '/test.gltf');
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected error');
        const err = result.error;
        expect(err.code).toBe('gltf-image-mime-unsupported');
        if (err.code === 'gltf-image-mime-unsupported') {
          expect(err.detail.mimeType).toBe('image/webp');
        }
      });

      it('accepts image/jpeg mimeType successfully', async () => {
        const json = buildMinimalJson({}, [{ uri: 'textures/photo.jpg', mimeType: 'image/jpeg' }]);
        const result = await parseGltf(json, jpegLoader, '/test.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected ok');
        const imgs4 = result.value.images;
        if (!imgs4) throw new Error('expected images');
        expect(imgs4[0]?.uri ?? '').toBe('textures/photo.jpg');
      });

      it('accepts image/png mimeType successfully', async () => {
        const json = buildMinimalJson({}, [{ uri: 'textures/photo.png', mimeType: 'image/png' }]);
        const result = await parseGltf(json, pngLoader, '/test.gltf');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected ok');
        const imgs5 = result.value.images;
        if (!imgs5) throw new Error('expected images');
        expect(imgs5[0]?.uri ?? '').toBe('textures/photo.png');
      });
    });
  });
}

{
  // ─── from to-asset-pack-texture.test.ts ───

  function makeDoc(images: Array<{ readonly name?: string }>): GltfDoc {
    return {
      meshes: [],
      materials: [],
      nodes: [],
      scenes: [],
      textures: undefined,
      images: images.length > 0 ? images : undefined,
      samplers: undefined,
      skeletons: [],
      animationClips: [],
      defaultSceneIndex: 0,
      diagnostics: { nodeNames: [], unsupportedExtensions: [], matrixTrsCoexistNodes: [] },
    };
  }

  describe('to-asset-pack-texture.test.ts', () => {
    describe('toAssetPack emits texture sub-assets (G-2 fix / AC-13)', () => {
      it('emits one kind:"texture" sub-asset per glTF images[] row', () => {
        const doc = makeDoc([{ name: 'logo' }, { name: 'normal' }]);
        const { subAssets } = unwrapAssetPack(toAssetPack(doc, undefined, 'box.gltf'));
        const textureSubs = subAssets.filter((s) => s.kind === 'texture');
        expect(textureSubs.length).toBe(2);
        expect(textureSubs.map((s) => s.sourceIndex).sort()).toEqual([0, 1]);
      });

      it('orphan images (no textures[] reference) still produce texture sub-assets (AC-13)', () => {
        const doc = makeDoc([{ name: 'orphan-a' }, { name: 'orphan-b' }]);
        const { subAssets } = unwrapAssetPack(toAssetPack(doc, undefined, 'orphans.gltf'));
        const textureSubs = subAssets.filter((s) => s.kind === 'texture');
        expect(textureSubs.length).toBe(2);
      });

      it('no images[] -> no texture sub-assets emitted', () => {
        const doc = makeDoc([]);
        const { subAssets } = unwrapAssetPack(toAssetPack(doc, undefined, 'no-tex.gltf'));
        expect(subAssets.filter((s) => s.kind === 'texture')).toEqual([]);
      });

      it('image without a name produces a texture sub-asset (indexFallback path)', () => {
        const doc = makeDoc([{}]);
        const { subAssets } = unwrapAssetPack(toAssetPack(doc, undefined, 'unnamed.gltf'));
        const tex = subAssets.find((s) => s.kind === 'texture');
        expect(tex).toBeDefined();
        expect(tex?.sourceIndex).toBe(0);
      });

      it('texture sub-assets get freshly-minted UUIDv7 GUIDs on first import', () => {
        const doc = makeDoc([{ name: 'a' }]);
        const { subAssets } = unwrapAssetPack(toAssetPack(doc, undefined, 'fresh.gltf'));
        const tex = subAssets.find((s) => s.kind === 'texture');
        expect(tex?.guid).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      });
    });
  });
}

{
  // ─── from gltf-importer-name.test.ts (AC-09) ───

  const NAME_MESH_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d460';
  const NAME_MAT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d461';

  function buildNamedGltfBytes(): Uint8Array {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const posBytes = new Uint8Array(positions.buffer);
    const b64 = Buffer.from(posBytes).toString('base64');

    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0], name: 'MainScene' }],
      nodes: [{ mesh: 0 }],
      meshes: [{ name: 'Triangle', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [
        {
          name: 'RedMat',
          pbrMetallicRoughness: {
            baseColorFactor: [0.8, 0.2, 0.2, 1],
            metallicFactor: 0,
            roughnessFactor: 1,
          },
        },
      ],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: posBytes.byteLength }],
      buffers: [
        { uri: `data:application/octet-stream;base64,${b64}`, byteLength: posBytes.byteLength },
      ],
    };
    return new TextEncoder().encode(JSON.stringify(gltf));
  }

  function buildSingleAssetGltfBytes(): Uint8Array {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const posBytes = new Uint8Array(positions.buffer);
    const b64 = Buffer.from(posBytes).toString('base64');

    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: posBytes.byteLength }],
      buffers: [
        { uri: `data:application/octet-stream;base64,${b64}`, byteLength: posBytes.byteLength },
      ],
    };
    return new TextEncoder().encode(JSON.stringify(gltf));
  }

  describe('gltf-importer-name.test.ts', () => {
    describe('gltfImporter asset name plumbing (AC-09)', () => {
      it('multi-asset glTF: mesh and material name from glTF names', async () => {
        const bytes = buildNamedGltfBytes();
        const reg = new ImporterRegistry();
        reg.register(gltfImporter);
        const meta: RunImportMeta = {
          importer: 'gltf',
          source: 'named.gltf',
          subAssets: [
            { guid: NAME_MESH_GUID, sourceIndex: 0, sourceKey: 'mesh:Triangle', kind: 'mesh' },
            { guid: NAME_MAT_GUID, sourceIndex: 0, sourceKey: 'material:RedMat', kind: 'material' },
          ],
        };
        const fs: ImportRunnerFs = {
          readSource: async () => ({ ok: true as const, value: bytes }),
        };
        const res = await runImport(meta, reg, fs);
        expect(res.ok).toBe(true);
        if (!res.ok || 'skipped' in res.value) throw new Error('expected a DDC pack');
        const pack = res.value.pack;
        const mesh = pack.assets.find((a) => a.guid === NAME_MESH_GUID);
        const mat = pack.assets.find((a) => a.guid === NAME_MAT_GUID);
        expect(mesh?.name).toBe('Triangle');
        expect(mat?.name).toBe('RedMat');
      });

      it('multi-asset glTF: scene name from scene name', async () => {
        const bytes = buildNamedGltfBytes();
        const reg = new ImporterRegistry();
        reg.register(gltfImporter);
        const SCENE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d462';
        const meta: RunImportMeta = {
          importer: 'gltf',
          source: 'named.gltf',
          subAssets: [
            { guid: NAME_MESH_GUID, sourceIndex: 0, sourceKey: 'mesh:Triangle', kind: 'mesh' },
            { guid: NAME_MAT_GUID, sourceIndex: 0, sourceKey: 'material:RedMat', kind: 'material' },
            { guid: SCENE_GUID, sourceIndex: 0, sourceKey: 'scene:MainScene', kind: 'scene' },
          ],
        };
        const fs: ImportRunnerFs = {
          readSource: async () => ({ ok: true as const, value: bytes }),
        };
        const res = await runImport(meta, reg, fs);
        expect(res.ok).toBe(true);
        if (!res.ok || 'skipped' in res.value) throw new Error('expected a DDC pack');
        const pack = res.value.pack;
        const scene = pack.assets.find((a) => a.guid === SCENE_GUID);
        expect(scene?.name).toBe('MainScene');
      });

      it('single-asset glTF: name is undefined (derived from packagePath)', async () => {
        const bytes = buildSingleAssetGltfBytes();
        const reg = new ImporterRegistry();
        reg.register(gltfImporter);
        const SINGLE_SCENE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d463';
        const meta: RunImportMeta = {
          importer: 'gltf',
          source: 'unnamed.gltf',
          subAssets: [{ guid: SINGLE_SCENE_GUID, sourceIndex: 0, kind: 'scene' }],
        };
        const fs: ImportRunnerFs = {
          readSource: async () => ({ ok: true as const, value: bytes }),
        };
        const res = await runImport(meta, reg, fs);
        expect(res.ok).toBe(true);
        if (!res.ok || 'skipped' in res.value) throw new Error('expected a DDC pack');
        const pack = res.value.pack;
        const scene = pack.assets.find((a) => a.guid === SINGLE_SCENE_GUID);
        expect(scene?.name).toBeUndefined();
      });
    });
  });
}
