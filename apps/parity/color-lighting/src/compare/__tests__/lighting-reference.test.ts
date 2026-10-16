import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildLightingReferenceEvidence,
  buildRecoveryLightingReferenceEvidence,
  buildSpotCombinedLightingReferenceEvidence,
  createCookieAsset,
  createIesProfileAsset,
  createSymmetricIesProfileAsset,
  createLightingSceneManifest,
  evaluateCookieReference,
  evaluateTypeCReference,
} from '../lighting-reference';

const referenceSource = readFileSync(new URL('../lighting-reference.ts', import.meta.url), 'utf8');

describe('lighting comparison reference contract', () => {
  it('keeps Type-C azimuth and roll independent from the native 1D subset', () => {
    const first = evaluateTypeCReference(24, 0, 8);
    const second = evaluateTypeCReference(24, 30, 8);
    const rolled = evaluateTypeCReference(24, 8, 0);
    expect(first).not.toBe(second);
    expect(rolled).toBeCloseTo(first, 12);
    const evidence = buildLightingReferenceEvidence('ies');
    expect(evidence.ies?.nativePath).toBe('three-r184-IESSpotLight-1d');
    expect(evidence.falsifiers).toContain('ies-native-1d-is-not-type-c-2d');
    expect(evidence.adapters.every((adapter) => adapter.independentOfForgeaxKernel)).toBe(true);
  });

  it('uses the symmetric radial asset only for compare IES and keeps standalone Type-C azimuth', async () => {
    const standalone = await createLightingSceneManifest('ies', 'product-head', false);
    const compare = await createLightingSceneManifest('ies', 'product-head', true);
    const symmetric = createSymmetricIesProfileAsset();
    const asymmetric = createIesProfileAsset();
    const symmetricView = new DataView(symmetric.data.buffer);
    const asymmetricView = new DataView(asymmetric.data.buffer);
    const row = 32;
    const symmetricValue = symmetricView.getUint16((row * 256 + 0) * 2, true);
    expect(compare.ies.data).toEqual(symmetric.data);
    expect(standalone.ies.data).toEqual(asymmetric.data);
    expect(compare.manifest.sourceAssets.iesProfileVariant).toBe('rotationally-symmetric-compare');
    expect(standalone.manifest.sourceAssets.iesProfileVariant).toBe('type-c-asymmetric-standalone');
    expect(compare.manifest.sourceAssets.iesProfileSha256).not.toBe(standalone.manifest.sourceAssets.iesProfileSha256);
    for (const column of [1, 64, 128, 255]) {
      expect(symmetricView.getUint16((row * 256 + column) * 2, true)).toBe(symmetricValue);
    }
    expect(asymmetricView.getUint16((row * 256 + 0) * 2, true)).not.toBe(asymmetricView.getUint16((row * 256 + 64) * 2, true));
    expect(buildLightingReferenceEvidence('ies', true).ies?.profileVariant).toBe('rotationally-symmetric-compare');
    expect(buildLightingReferenceEvidence('ies', false).ies?.profileVariant).toBe('type-c-asymmetric-standalone');
  });

  it('uses native WebGL2 SpotLight.map and exposes RGBA projection falsifiers', () => {
    const front = evaluateCookieReference({ point: [0, 0, 2.2], aspect: 1.4, rollDeg: 22 });
    const edge = evaluateCookieReference({ point: [0.759, 0, 2.2], aspect: 1.4, rollDeg: 22 });
    const back = evaluateCookieReference({ point: [0, 0, 4.2], aspect: 1.4, rollDeg: 22 });
    expect(front.reason).toBe('projected');
    expect(front.rgba[3]).toBeGreaterThan(0);
    expect(edge.reason).toBe('projected');
    expect(back).toMatchObject({ visible: false, reason: 'backface', rgba: [0, 0, 0, 0] });
    const evidence = buildLightingReferenceEvidence('cookie');
    expect(evidence.cookie?.nativePath).toBe('three-r184-WebGL2-SpotLight-map');
    expect(evidence.falsifiers).toEqual(expect.arrayContaining(['cookie-alpha', 'cookie-aspect', 'cookie-roll', 'cookie-cone-edge', 'cookie-backface']));
  });

  it('keeps the native WebGL cookie map on the shadow-coordinate path', () => {
    expect(referenceSource).toContain('renderer.shadowMap.enabled = true');
    expect(referenceSource).toContain('light.castShadow = false');
    expect(referenceSource).toContain('light.shadow.aspect = asset.width / asset.height');
    expect(referenceSource).toContain('receiverMesh.receiveShadow = true');
    expect(referenceSource).toContain('const lightColor = plainSpot ? spot.iesColor : spot.cookieColor;');
    expect(buildLightingReferenceEvidence('cookie').adapters[0]?.source).not.toContain('three/src/nodes/lighting/SpotLightNode.js');
    expect(buildLightingReferenceEvidence('cookie').adapters[0]?.source).toContain('lights_fragment_begin.glsl.js');
  });

  it('describes the real combined Spot and recovery baseline as separate Three references', () => {
    const combined = buildSpotCombinedLightingReferenceEvidence(true);
    expect(combined.referenceKind).toBe('three-r184-native-webgpu-spot-ies-cookie-shadow-combined');
    expect(combined.cookie?.nativePath).toBe('three-r184-WebGPU-SpotLight-map');
    expect(combined.adapters.map((adapter) => adapter.adapterId)).toEqual([
      'three-r184-ies-spot-light',
      'three-r184-webgpu-spot-light-map',
      'three-r184-webgpu-spot-shadow',
    ]);
    expect(combined.falsifiers).toEqual(expect.arrayContaining(['combined-cookie-roll', 'combined-shadow']));

    const recovery = buildRecoveryLightingReferenceEvidence(true);
    expect(recovery.referenceKind).toBe('three-r184-native-webgpu-recovery-lighting-baseline');
    expect(recovery.adapters.map((adapter) => adapter.adapterId)).toEqual([
      'three-r184-webgpu-rect-area-light',
      'three-r184-ies-spot-light',
      'three-r184-webgpu-spot-light-map',
      'three-r184-webgpu-light-probe',
    ]);
    expect(recovery.falsifiers).toEqual(expect.arrayContaining([
      'recovery-no-local-volume-equivalent',
      'recovery-no-lkg-equivalent',
      'recovery-device-generation-forgeax-owned',
    ]));
  });

  it('freezes shared scene identity and deterministic source hashes', async () => {
    const first = await createLightingSceneManifest('cookie', 'product-head');
    const second = await createLightingSceneManifest('cookie', 'product-head');
    expect(first.manifest).toEqual(second.manifest);
    expect(first.manifest.sceneId).toBe('extended-lighting-shared-scene');
    expect(first.manifest.camera.position).toEqual([0, 0.15, 8.7]);
    expect(first.manifest.exposure.value).toBe(1.15);
    expect(first.manifest.three).toEqual({ revision: 'r184', backend: 'webgl2' });
    expect(first.ies.data.byteLength).toBe(256 * 128 * 2);
    expect(first.cookie.data.length).toBe(280 * 200 * 4);
    expect(first.manifest.sourceAssets.iesProfileSha256).toHaveLength(64);
    expect(first.manifest.sourceAssets.cookieTextureSha256).toHaveLength(64);
    expect(createIesProfileAsset().data).toEqual(first.ies.data);
    expect(createCookieAsset().data).toEqual(first.cookie.data);
  });
});
