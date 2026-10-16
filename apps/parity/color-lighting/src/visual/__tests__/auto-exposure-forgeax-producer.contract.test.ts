import { describe, expect, it } from 'vitest';
import {
  AC27_COMMON_STAGE_MAPPING,
} from '../../evidence/auto-exposure-ac27-join';
import {
  AUTO_EXPOSURE_SCENE_CASE,
  AUTO_EXPOSURE_THREE_R184_FIXTURE,
} from '../../contracts/auto-exposure-scene-case';
import {
  normalizeAutoExposureFinalReadback,
  validateAutoExposureForgeaxArtifact,
} from '../auto-exposure-forgeax-capture';

function artifact(decoded: readonly number[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'auto-exposure-forgeax-live',
    qualification: 'live-forgeax-renderer-readback',
    caseId: AUTO_EXPOSURE_SCENE_CASE.caseId,
    side: 'forgeax',
    referenceLane: 'direct',
    testedRevision: 'a'.repeat(40),
    runner: { kind: 'dawn', id: 'contract' },
    resolution: { width: 128, height: 128 },
    provenance: {
      implementation: 'forgeax',
      package: '@forgeax/engine',
      version: 'workspace',
      commit: 'a'.repeat(40),
      build: 'b'.repeat(64),
      backend: 'dawn',
    },
    fixtureIdentity: AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity,
    scene: AUTO_EXPOSURE_THREE_R184_FIXTURE,
    config: AUTO_EXPOSURE_SCENE_CASE.rendererConfig,
    stageOrder: AC27_COMMON_STAGE_MAPPING,
    stages: AC27_COMMON_STAGE_MAPPING.map(({ stage, domain }) => ({
      stage,
      domain,
      values: stage === 'decoded-sRGB-roi' ? decoded : [0.1, 0.2],
      rawHash: 'c'.repeat(64),
    })),
    readback: {
      method: 'renderer.observe',
      origin: 'top-left',
      sourceFormat: 'rgba8unorm-srgb',
      normalization: 'none',
      sourceRawHash: 'c'.repeat(64),
      normalizedRawHash: 'c'.repeat(64),
      roi: { x: 56, y: 20, width: 16, height: 16 },
      receipt: { frameId: 2, deviceGeneration: 0, graphGeneration: 1 },
      stages: AC27_COMMON_STAGE_MAPPING.map(({ stage }) => ({
        stage,
        format: 'rgba16float',
        byteLength: 131072,
        bytesPerRow: 1024,
        rawHash: 'c'.repeat(64),
      })),
    },
    status: 'observation',
    overallParityClaim: false,
    notApplicable: AUTO_EXPOSURE_SCENE_CASE.notApplicable,
  };
}

describe('ForgeaX AC-27 producer contract', () => {
  it('normalizes only the native BGRA display format and rejects non-display formats', () => {
    const bgra = Uint8Array.from([1, 2, 3, 4]);
    const normalized = normalizeAutoExposureFinalReadback(bgra, 'bgra8unorm-srgb');
    expect(Array.from(normalized.bytes)).toEqual([3, 2, 1, 4]);
    expect(normalized.normalization).toBe('bgra-to-rgba');

    const rgba = Uint8Array.from([1, 2, 3, 4]);
    const identity = normalizeAutoExposureFinalReadback(rgba, 'rgba8unorm-srgb');
    expect(identity.bytes).toBe(rgba);
    expect(identity.normalization).toBe('none');
    expect(() => normalizeAutoExposureFinalReadback(rgba, 'rgba16float')).toThrow(/8-bit display format/);
    expect(() => normalizeAutoExposureFinalReadback(rgba, undefined as never)).toThrow(/8-bit display format/);
  });

  it('accepts a complete non-vacuous live readback', () => {
    expect(validateAutoExposureForgeaxArtifact(artifact([0.2, 0.3]))).toEqual({ ok: true });
  });

  it('keeps native and normalized final hashes distinct on a BGRA readback', () => {
    const candidate = artifact([0.2, 0.3]);
    candidate.readback = {
      ...(candidate.readback as Record<string, unknown>),
      sourceFormat: 'bgra8unorm-srgb',
      normalization: 'bgra-to-rgba',
      sourceRawHash: 'd'.repeat(64),
      normalizedRawHash: 'c'.repeat(64),
    };
    expect(validateAutoExposureForgeaxArtifact(candidate)).toEqual({ ok: true });

    candidate.readback = {
      ...(candidate.readback as Record<string, unknown>),
      normalizedRawHash: 'e'.repeat(64),
    };
    expect(validateAutoExposureForgeaxArtifact(candidate)).toEqual({
      ok: false,
      reason: 'artifact normalized output hash does not match the output-encoding stage',
    });
  });

  it('rejects an all-zero decoded ROI', () => {
    expect(validateAutoExposureForgeaxArtifact(artifact([0, 0]))).toEqual({
      ok: false,
      reason: 'artifact decoded-sRGB ROI is vacuous',
    });
  });
});
