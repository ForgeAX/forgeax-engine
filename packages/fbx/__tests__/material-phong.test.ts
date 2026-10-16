// material-phong.test.ts -- M4 t42: Phong->PBR formula mapping unit test.
//
// R1 fixup: tests now import the real parseMaterial from src/parse-material.ts
// (instead of an inline stub), closing the AC-02 coverage gap.

import { describe, expect, it } from 'vitest';
import type { MaterialPod } from '@forgeax/engine-types';
import { parseMaterial } from '../src/parse-material.js';
import type { FbxRawMaterial } from '../src/parse-material.js';

describe('parseMaterial phong mapping', () => {
  it('maps Phong shininess=25 to roughness=0.5', () => {
    const raw: FbxRawMaterial = {
      name: 'Phong_25',
      kind: 'phong',
      diffuse: [0.8, 0.6, 0.4],
      shininess: 25,
    };
    const pod: MaterialPod = parseMaterial(raw, 0);
    // roughness = 1 - sqrt(25/100) = 1 - 0.5 = 0.5
    expect(pod.roughnessFactor).toBeCloseTo(0.5, 5);
  });

  it('maps Phong diffuse to baseColor', () => {
    const raw: FbxRawMaterial = {
      name: 'Phong_25',
      kind: 'phong',
      diffuse: [0.8, 0.6, 0.4],
      shininess: 25,
    };
    const pod = parseMaterial(raw, 0);
    expect(pod.baseColorFactor[0]).toBeCloseTo(0.8);
    expect(pod.baseColorFactor[1]).toBeCloseTo(0.6);
    expect(pod.baseColorFactor[2]).toBeCloseTo(0.4);
    expect(pod.baseColorFactor[3]).toBeCloseTo(1);
  });

  it('sets metallic=0 for Phong materials', () => {
    const raw: FbxRawMaterial = {
      name: 'Phong_25',
      kind: 'phong',
      diffuse: [0.8, 0.6, 0.4],
      shininess: 25,
    };
    const pod = parseMaterial(raw, 0);
    expect(pod.metallicFactor).toBeCloseTo(0);
  });

  it('clamps shininess at 100 (max_gloss) to roughness=0', () => {
    const raw: FbxRawMaterial = {
      name: 'MaxGloss',
      kind: 'phong',
      diffuse: [0.5, 0.5, 0.5],
      shininess: 100,
    };
    const pod = parseMaterial(raw, 0);
    expect(pod.roughnessFactor).toBeCloseTo(0, 5);
  });

  it('clamps shininess beyond 100 to roughness=0', () => {
    const raw: FbxRawMaterial = {
      name: 'OverMaxGloss',
      kind: 'phong',
      diffuse: [0.5, 0.5, 0.5],
      shininess: 200,
    };
    const pod = parseMaterial(raw, 0);
    expect(pod.roughnessFactor).toBeCloseTo(0, 5);
  });

  it('clamps shininess=0 to roughness=1', () => {
    const raw: FbxRawMaterial = {
      name: 'Dull',
      kind: 'phong',
      diffuse: [0.5, 0.5, 0.5],
      shininess: 0,
    };
    const pod = parseMaterial(raw, 0);
    expect(pod.roughnessFactor).toBeCloseTo(1, 5);
  });

  it('uses defaults when diffuse is absent', () => {
    const raw: FbxRawMaterial = {
      name: 'NoDiffuse',
      kind: 'phong',
      shininess: 50,
    };
    const pod = parseMaterial(raw, 0);
    expect(pod.roughnessFactor).toBeCloseTo(1 - Math.sqrt(0.5), 5);
    expect(pod.baseColorFactor[0]).toBeCloseTo(0.5);
    expect(pod.baseColorFactor[1]).toBeCloseTo(0.5);
    expect(pod.baseColorFactor[2]).toBeCloseTo(0.5);
  });
});