import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  STANDARD_PBR_ARTIFACT_RECEIPT,
  STANDARD_PBR_SKIN_ARTIFACT_RECEIPT,
} from '../material-schemas.js';

describe('material derived built-in integration contract', () => {
  it('routes every Standard lit consumer through the single Cluster accessor', () => {
    const sources = [
      readFileSync(resolve(import.meta.dirname, '../standard-surface.wgsl'), 'utf8'),
      readFileSync(resolve(import.meta.dirname, '../default-standard-pbr-skin.wgsl'), 'utf8'),
    ];

    for (const source of sources) {
      expect(source).toContain('evaluateStandardClusterLights');
      expect(source).not.toContain('evaluate_cluster_lights');
      expect(source).not.toContain('forgeax_hdrp');
      expect(source).not.toContain('forgeax_urp');
    }

    const sprite = readFileSync(resolve(import.meta.dirname, '../sprite-lit.wgsl'), 'utf8');
    expect(sprite).toContain('evaluateStandardClusterLights');
    expect(sprite).toContain('CLUSTER_FORWARD_AVAILABLE');
    expect(sprite).toContain('ndc, viewZ, worldPos');
    expect(sprite).not.toContain('forgeax_hdrp');
    expect(sprite).not.toContain('forgeax_urp');

    for (const source of [...sources, sprite]) {
      expect(source).not.toMatch(/in\.clip\.xy\s*\/\s*in\.clip\.w/);
    }
  });

  it('uses the same derived identity for standard and skinned standard schemas', () => {
    const standard = derive(DEFAULT_STANDARD_PBR_PARAM_SCHEMA);
    const skinned = derive(DEFAULT_STANDARD_PBR_PARAM_SCHEMA);
    expect(skinned.layoutIdentity).toBe(standard.layoutIdentity);
    expect(skinned.totalBytes).toBe(standard.totalBytes);
  });

  it('keeps direct and scene-index entries on one producer receipt', () => {
    expect(STANDARD_PBR_ARTIFACT_RECEIPT.receiptIdentity).toBe(
      STANDARD_PBR_SKIN_ARTIFACT_RECEIPT.receiptIdentity,
    );
    expect(STANDARD_PBR_ARTIFACT_RECEIPT.directEntry).toBe('vs_main');
    expect(STANDARD_PBR_ARTIFACT_RECEIPT.sceneIndexEntry).toBe('vs_scene_index');
    expect(STANDARD_PBR_SKIN_ARTIFACT_RECEIPT.skinPaletteAddress).toMatchObject({
      group: 2,
      binding: 1,
    });
  });

  it('includes a coordinate member pair for every built-in texture binding', () => {
    const derived = derive(DEFAULT_STANDARD_PBR_PARAM_SCHEMA);
    const textureNames = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter(
      (entry) => entry.type === 'texture2d',
    ).map((entry) => entry.name);
    expect(derived.coordinateRecords.map((record) => record.parameter)).toEqual(textureNames);
    expect(
      derived.coordinateRecords.every((record) =>
        record.transformMember.endsWith('CoordinatesTransform'),
      ),
    ).toBe(true);
    expect(
      derived.coordinateRecords.every((record) =>
        record.metadataMember.endsWith('CoordinatesMetadata'),
      ),
    ).toBe(true);
  });
});
