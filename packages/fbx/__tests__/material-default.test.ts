// material-default.test.ts -- M4 t43: default PBR fallback unit test.
//
// R1 fixup: tests now import the real parseMaterial from src/parse-material.ts
// (instead of an inline stub), closing the AC-02 coverage gap.

import { describe, expect, it } from 'vitest';
import type { MaterialPod } from '@forgeax/engine-types';
import { parseMaterial } from '../src/parse-material.js';
import type { FbxRawMaterial } from '../src/parse-material.js';

describe('parseMaterial default fallback', () => {
  it('returns default grey baseColor for kind=fallback', () => {
    const raw: FbxRawMaterial = { kind: 'fallback' };
    const pod: MaterialPod = parseMaterial(raw, 0);
    expect(pod.baseColorFactor[0]).toBeCloseTo(0.5);
    expect(pod.baseColorFactor[1]).toBeCloseTo(0.5);
    expect(pod.baseColorFactor[2]).toBeCloseTo(0.5);
    expect(pod.baseColorFactor[3]).toBeCloseTo(1);
    expect(pod.metallicFactor).toBeCloseTo(0);
    expect(pod.roughnessFactor).toBeCloseTo(0.5);
  });

  it('returns default metallic=0 for fallback', () => {
    const pod = parseMaterial({ kind: 'fallback' }, 0);
    expect(pod.metallicFactor).toBeCloseTo(0);
  });

  it('returns default roughness=0.5 for fallback', () => {
    const pod = parseMaterial({ kind: 'fallback' }, 0);
    expect(pod.roughnessFactor).toBeCloseTo(0.5);
  });

  it('handles lambert material with diffuse', () => {
    const raw: FbxRawMaterial = {
      name: 'Lamb',
      kind: 'lambert',
      diffuse: [0.7, 0.3, 0.1],
    };
    const pod = parseMaterial(raw, 0);
    expect(pod.name).toBe('Lamb');
    expect(pod.baseColorFactor[0]).toBeCloseTo(0.7);
    expect(pod.baseColorFactor[1]).toBeCloseTo(0.3);
    expect(pod.baseColorFactor[2]).toBeCloseTo(0.1);
    expect(pod.metallicFactor).toBeCloseTo(0);
    expect(pod.roughnessFactor).toBeCloseTo(0.5); // lambert default
  });
});