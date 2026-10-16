import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLightingReferenceEvidence, buildRecoveryLightingReferenceEvidence, buildSpotCombinedLightingReferenceEvidence } from '../lighting-reference';

const demoSource = readFileSync(new URL('../../extended-lighting-demo.ts', import.meta.url), 'utf8');
const referenceSource = readFileSync(new URL('../lighting-reference.ts', import.meta.url), 'utf8');
const probeSource = readFileSync(new URL('../probe-reference.ts', import.meta.url), 'utf8');

describe('lighting demo comparison contract', () => {
  it('exposes compare=three for every extended-lighting mode', () => {
    for (const mode of ['rect', 'ies', 'cookie', 'probe'] as const) {
      const evidence = buildLightingReferenceEvidence(mode);
      expect(evidence.referenceKind).toContain('three-r184');
      expect(evidence.adapters.length).toBeGreaterThan(0);
      expect(evidence.falsifiers.length).toBeGreaterThan(0);
    }
    expect(demoSource).toContain("const compare = searchParams.get('compare') === 'three';");
    expect(demoSource).toContain('renderThreeIesReference');
    expect(demoSource).toContain('renderThreeCookieReference');
    expect(demoSource).toContain('renderThreeProbeReference');
    expect(demoSource).toContain('renderThreeSpotCombinedReference');
    expect(demoSource).toContain('renderThreeRecoveryReference');
  });

  it('keeps native/reference boundaries explicit in source and metadata', () => {
    expect(referenceSource).toContain('three-r184-IESSpotLight-1d');
    expect(referenceSource).toContain('three-r184-WebGL2-SpotLight-map');
    expect(referenceSource).toContain('three-r184-LightProbe-SH9');
    expect(demoSource).toContain('SpotLight.map + alpha-folded product semantics + aspect');
    expect(demoSource).toContain('LightProbe SH9 + analytic local volume (not native local volume)');
    expect(demoSource).toContain('IES native + product-equivalent cone fold + Type-C analytic');
    expect(referenceSource).not.toContain('probe-blend');
    expect(probeSource).not.toContain('@forgeax/engine-render');
    expect(probeSource).not.toContain('blendLightProbes');
    expect(buildLightingReferenceEvidence('probe').probe?.localVolumeSupport).toBe('not-native');
    expect(buildSpotCombinedLightingReferenceEvidence().referenceKind).toBe('three-r184-native-webgpu-spot-ies-cookie-shadow-combined');
    expect(buildRecoveryLightingReferenceEvidence().referenceKind).toBe('three-r184-native-webgpu-recovery-lighting-baseline');
  });

  it('requires nine authored Probe results instead of one central result', () => {
    const objects = buildLightingReferenceEvidence('probe').probe?.objects ?? [];
    expect(objects).toHaveLength(9);
    expect(objects[0]?.position).toEqual([-4, -0.05, 0]);
    expect(objects[4]?.position).toEqual([0, -0.05, 0]);
    expect(objects[8]?.position).toEqual([4, -0.05, 0]);
    expect(objects[0]?.SH_preblend).not.toEqual(objects[4]?.SH_preblend);
    expect(objects[4]?.SH_preblend).not.toEqual(objects[8]?.SH_preblend);
    expect(referenceSource).toContain('results.length !== 9');
    expect(referenceSource).toContain('for (const result of results)');
    expect(referenceSource).toContain('result.position[0]');
    expect(referenceSource).toContain('renderer.autoClear = false');
  });
});
