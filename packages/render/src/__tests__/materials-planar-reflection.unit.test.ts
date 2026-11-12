import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  STANDARD_PIPELINE_PARAM_SCHEMA,
  STANDARD_PLANAR_REFLECTION_TEXTURE_BINDING,
  STANDARD_PLANAR_REFLECTION_UNIFORM_BINDING,
} from '@forgeax/engine-shader';
import { standardSurfaceParameters } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  materialUsesPlanarReflection,
  PLANAR_REFLECTION_MATERIAL_LAYOUT_ENTRIES,
  planarCaptureDemanded,
  planarReflectionMaterialEntries,
  planarRoutedPasses,
  setPlanarCaptureDemand,
} from '../capture/planar-material.js';
import { Materials } from '../materials.js';
import {
  PLANAR_REFLECTION_DISABLED_UNIFORM_OFFSET,
  PLANAR_REFLECTION_UNIFORM_OFFSET,
  VIEW_UNIFORM_SLOT_STRIDE,
} from '../record/view-ubo.js';

describe('Standard planar reflection capability', () => {
  it('stays absent from the default and baseline Standard contracts', () => {
    expect(
      Materials.standard({ baseColor: [1, 1, 1, 1] }).parameters?.some(
        (p) => p.name === 'planarReflection',
      ),
    ).toBe(false);
    for (const schema of [
      DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
      STANDARD_PIPELINE_PARAM_SCHEMA,
      standardSurfaceParameters([]),
    ])
      expect(materialUsesPlanarReflection(schema)).toBe(false);
  });

  it('publishes one real u32 field and keeps both colour passes for extract routing', () => {
    const material = Materials.standard({ baseColor: [1, 1, 1, 1], planarReflection: true });
    expect(material.parameters).toContainEqual({
      name: 'planarReflection',
      type: 'u32',
      default: 1,
      optional: true,
    });
    expect(material.values?.planarReflection).toBe(1);
    expect(materialUsesPlanarReflection(material.parameters)).toBe(true);
    expect(material.passes?.map((p) => p.name)).toContain('forward');
    expect(material.passes?.map((p) => p.name)).toContain('deferred');
  });

  it('still drops the Deferred pass for transmission, which reads the backdrop', () => {
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      transmission: 0.5,
      planarReflection: true,
    });
    expect(material.passes?.map((p) => p.name)).not.toContain('deferred');
  });

  it('binds the capture with its projection, or a fallback with the disabled projection', () => {
    expect(PLANAR_REFLECTION_MATERIAL_LAYOUT_ENTRIES.map((entry) => entry.binding)).toEqual([
      STANDARD_PLANAR_REFLECTION_TEXTURE_BINDING,
      STANDARD_PLANAR_REFLECTION_UNIFORM_BINDING,
    ]);
    // The disabled projection shares the planar slot and is never written.
    expect(PLANAR_REFLECTION_DISABLED_UNIFORM_OFFSET % 256).toBe(0);
    expect(PLANAR_REFLECTION_DISABLED_UNIFORM_OFFSET + 96).toBeLessThanOrEqual(
      PLANAR_REFLECTION_UNIFORM_OFFSET + VIEW_UNIFORM_SLOT_STRIDE,
    );
    const buffer = {} as never;
    const capture = { label: 'capture' } as never;
    const fallback = { label: 'fallback' } as never;
    const offsets = (view: never | undefined) =>
      planarReflectionMaterialEntries(buffer, view, fallback).map((entry) =>
        entry.resource.kind === 'buffer' ? entry.resource.value.offset : entry.resource.value,
      );
    expect(offsets(capture)).toEqual([capture, PLANAR_REFLECTION_UNIFORM_OFFSET]);
    expect(offsets(undefined)).toEqual([fallback, PLANAR_REFLECTION_DISABLED_UNIFORM_OFFSET]);
  });

  it('rejects a code-created planar material: only a cooked program mirrors', () => {
    const registry = new AssetRegistry();
    try {
      const created = registry.create(
        Materials.standard({ baseColor: [1, 1, 1, 1], planarReflection: true }),
      );
      expect(created.ok).toBe(false);
      if (created.ok) return;
      expect(created.error).toMatchObject({
        code: 'material-specialization-not-cooked',
        detail: { staticSelection: ['parameter:planarReflection'] },
      });
    } finally {
      registry.dispose();
    }
  });
});

describe('custom Standard Surface planar reflection', () => {
  const wet = () =>
    Materials.standard({
      surfaceModule: 'game::wet_ground',
      parameters: [{ name: 'rippleStrength', type: 'f32' }],
      values: { rippleStrength: 0.08 },
      planarReflection: true,
    });

  it('adds the engine-owned u32 field so the Surface normal can distort the mirror', () => {
    const material = wet();
    expect(material.parameters).toContainEqual({
      name: 'planarReflection',
      type: 'u32',
      default: 1,
      optional: true,
    });
    expect(material.values).toMatchObject({ rippleStrength: 0.08, planarReflection: 1 });
    expect(materialUsesPlanarReflection(material.parameters)).toBe(true);
    expect(material.passes?.map((p) => p.name)).toContain('forward');
    expect(material.passes?.map((p) => p.name)).toContain('deferred');
  });

  it('keeps an opted-out Surface free of the planar contract', () => {
    const material = Materials.standard({
      surfaceModule: 'game::wet_ground',
      parameters: [{ name: 'rippleStrength', type: 'f32' }],
      values: { rippleStrength: 0.08 },
    });
    expect(materialUsesPlanarReflection(material.parameters)).toBe(false);
    expect(material.values).not.toHaveProperty('planarReflection');
  });

  it('refuses a caller-declared planarReflection parameter', () => {
    expect(() =>
      Materials.standard({
        surfaceModule: 'game::wet_ground',
        parameters: [{ name: 'planarReflection', type: 'u32' }],
        values: {},
        planarReflection: true,
      }),
    ).toThrow(/engine-owned/);
  });
});

describe('planar receiver routing between the G-buffer and the forward mirror', () => {
  const names = (passes: readonly { name: string }[]) => passes.map((p) => p.name);

  it('keeps the Deferred pass (G-buffer, SSR receiver) while no capture is published', () => {
    const world = {};
    const material = Materials.standard({ baseColor: [1, 1, 1, 1], planarReflection: true });
    const routed = planarRoutedPasses(material.passes ?? [], material.parameters, world);
    expect(routed.routed).toBe(false);
    expect(names(routed.passes)).toContain('deferred');
    expect(names(routed.passes)).toContain('forward');
  });

  it('shades forward only while its world publishes a PlanarReflection capture', () => {
    const world = {};
    const material = Materials.standard({
      surfaceModule: 'game::wet_ground',
      parameters: [{ name: 'rippleStrength', type: 'f32' }],
      values: { rippleStrength: 0.08 },
      planarReflection: true,
    });
    setPlanarCaptureDemand(world, true);
    expect(planarCaptureDemanded(world)).toBe(true);
    const routed = planarRoutedPasses(material.passes ?? [], material.parameters, world);
    expect(routed.routed).toBe(true);
    expect(names(routed.passes)).not.toContain('deferred');
    expect(names(routed.passes)).toContain('forward');
    setPlanarCaptureDemand(world, false);
    expect(planarCaptureDemanded(world)).toBe(false);
    expect(
      names(planarRoutedPasses(material.passes ?? [], material.parameters, world).passes),
    ).toContain('deferred');
  });

  it('leaves non-planar materials untouched, even in a world with a capture', () => {
    const world = {};
    setPlanarCaptureDemand(world, true);
    const material = Materials.standard({ baseColor: [1, 1, 1, 1] });
    const routed = planarRoutedPasses(material.passes ?? [], material.parameters, world);
    expect(routed.routed).toBeUndefined();
    expect(routed.passes).toBe(material.passes);
    expect(planarCaptureDemanded(undefined)).toBe(false);
  });
});
