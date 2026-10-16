// material-stingray.test.ts -- M4 t41: StingrayPBS fixture unit test.
//
// R1 fixup: tests now import the real parseMaterial from src/parse-material.ts
// (instead of an inline stub), closing the AC-02 coverage gap.

import { describe, expect, it } from 'vitest';
import type { MaterialPod } from '@forgeax/engine-types';
import { parseMaterial } from '../src/parse-material.js';
import type { FbxRawMaterial } from '../src/parse-material.js';

const MOCK_STINGRAY_MATERIAL: FbxRawMaterial = {
  name: 'StingrayPBS_Mat',
  kind: 'stingray-pbs',
  stingrayProps: {
    baseColor: [0.8, 0.6, 0.4],
    metallic: 0.9,
    roughness: 0.3,
    emissive: [0.1, 0.05, 0],
  },
};

describe('parseMaterial stingray-pbs', () => {
  it('maps StingrayPBS base_color directly to baseColorFactor', () => {
    const pod: MaterialPod = parseMaterial(MOCK_STINGRAY_MATERIAL, 0);
    expect(pod.baseColorFactor[0]).toBeCloseTo(0.8);
    expect(pod.baseColorFactor[1]).toBeCloseTo(0.6);
    expect(pod.baseColorFactor[2]).toBeCloseTo(0.4);
    expect(pod.baseColorFactor[3]).toBeCloseTo(1);
  });

  it('maps StingrayPBS metallic directly to metallicFactor', () => {
    const pod = parseMaterial(MOCK_STINGRAY_MATERIAL, 0);
    expect(pod.metallicFactor).toBeCloseTo(0.9);
  });

  it('maps StingrayPBS roughness directly to roughnessFactor', () => {
    const pod = parseMaterial(MOCK_STINGRAY_MATERIAL, 0);
    expect(pod.roughnessFactor).toBeCloseTo(0.3);
  });

  it('preserves material name', () => {
    const pod = parseMaterial(MOCK_STINGRAY_MATERIAL, 0);
    expect(pod.name).toBe('StingrayPBS_Mat');
  });

  it('uses defaults when stingrayProps has missing fields', () => {
    const minimal: FbxRawMaterial = {
      name: 'MinimalStingray',
      kind: 'stingray-pbs',
      stingrayProps: {},
    };
    const pod = parseMaterial(minimal, 1);
    expect(pod.baseColorFactor[0]).toBeCloseTo(0.5);
    expect(pod.baseColorFactor[1]).toBeCloseTo(0.5);
    expect(pod.baseColorFactor[2]).toBeCloseTo(0.5);
    expect(pod.metallicFactor).toBeCloseTo(0);
    expect(pod.roughnessFactor).toBeCloseTo(0.5);
  });
});