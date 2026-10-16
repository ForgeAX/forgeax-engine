import { describe, expect, it } from 'vitest';
import { Materials } from '../materials';

const surface = {
  surfaceModule: 'game_3d::rusted_iron_surface',
  parameters: [
    { name: 'ironColor', type: 'color' as const },
    { name: 'alphaClipThreshold', type: 'f32' as const, optional: true },
  ],
  values: { ironColor: [0.4, 0.45, 0.47, 1], alphaClipThreshold: 0.5 },
};

describe('custom Standard Surface pass policy', () => {
  it('keeps opaque and alpha-clip custom surfaces on Forward, Deferred, and ShadowCaster', () => {
    const material = Materials.standard(surface as never);
    expect(material.passes?.map((pass) => pass.name)).toEqual([
      'forward',
      'deferred',
      'shadow-caster',
    ]);
  });

  it('does not create Deferred for an explicitly blended custom surface', () => {
    const material = Materials.standard({
      ...surface,
      renderState: { blend: { color: {}, alpha: {} } },
    } as never);
    expect(material.passes?.map((pass) => pass.name)).not.toContain('deferred');
  });

  it('does not create Deferred when the effective root declares a physical layer', () => {
    const material = Materials.standard({
      ...surface,
      staticSwitches: { clearcoat: true },
      parameters: [
        { name: 'clearcoat', type: 'f32' },
        { name: 'clearcoatRoughness', type: 'f32' },
      ],
      values: { clearcoat: 0, clearcoatRoughness: 0.5 },
    } as never);
    expect(material.passes?.map((pass) => pass.name)).toEqual(['forward', 'shadow-caster']);
  });

  it('keeps optional physical fields inactive until the root makes the fragment effective', () => {
    const material = Materials.standard({
      ...surface,
      parameters: [
        { name: 'clearcoat', type: 'f32', optional: true },
        { name: 'clearcoatRoughness', type: 'f32', optional: true },
      ],
      values: { clearcoat: 0, clearcoatRoughness: 0.5 },
    } as never);
    expect(material.passes?.map((pass) => pass.name)).toEqual([
      'forward',
      'deferred',
      'shadow-caster',
    ]);
  });

  it('projects an explicitly declared default clearcoat root as Forward-only', () => {
    const material = Materials.standard({
      staticSwitches: { clearcoat: true },
      baseColor: [0.28, 0.035, 0.075, 1],
      metallic: 0.12,
      roughness: 0.18,
      clearcoat: 0.82,
      clearcoatRoughness: 0.08,
    });
    expect(material.passes?.map((pass) => pass.name)).toEqual(['forward', 'shadow-caster']);
  });
});
