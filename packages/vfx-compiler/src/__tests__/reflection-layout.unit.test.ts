import { describe, expect, it } from 'vitest';
import { reflectVfxLayout } from '../reflection.js';

const moduleSource = `
// forgeax-vfx-default amount = 0.5
// forgeax-vfx-default direction = vec3<f32>(0.0, 1.0, 0.0)
struct VfxParameters {
  unused: f32,
  direction: vec3<f32>,
  index: i32,
  amount: f32,
  scale: vec2<f32>,
  unsigned: u32,
}

struct VfxCustom {
  tint: vec4<f32>,
  velocity: vec3<f32>,
}

fn use_values() {
  var parameters: VfxParameters;
  var custom: VfxCustom;
  _ = parameters.amount;
  _ = parameters.direction;
  _ = parameters.index;
  _ = parameters.scale;
  _ = parameters.unsigned;
  _ = custom.tint;
  _ = custom.velocity;
}
`;

describe('VFX reflection layout', () => {
  it('preserves authored member order with WGSL alignment and defaults', () => {
    const result = reflectVfxLayout({ root: moduleSource });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.parameters.fields.map((field) => field.name)).toEqual([
      'unused',
      'direction',
      'index',
      'amount',
      'scale',
      'unsigned',
    ]);
    expect(result.value.parameters.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'amount',
          type: 'f32',
          alignment: 4,
          size: 4,
          offset: 32,
          defaultValue: 0.5,
        }),
        expect.objectContaining({
          name: 'direction',
          type: 'vec3<f32>',
          alignment: 16,
          size: 12,
          offset: 16,
        }),
        expect.objectContaining({ name: 'index', type: 'i32', alignment: 4, size: 4, offset: 28 }),
        expect.objectContaining({
          name: 'scale',
          type: 'vec2<f32>',
          alignment: 8,
          size: 8,
          offset: 40,
        }),
        expect.objectContaining({
          name: 'unsigned',
          type: 'u32',
          alignment: 4,
          size: 4,
          offset: 48,
        }),
      ]),
    );
    expect(result.value.parameters.size).toBe(64);
    expect(result.value.custom.fields.map((field) => field.name)).toEqual(['tint', 'velocity']);
    expect(result.value.custom.size).toBe(32);
    expect(result.value.parameters.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'unused', offset: 0, size: 4 })]),
    );
    expect(result.value.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('treats an omitted declaration as an empty layout and rejects an explicit empty struct', () => {
    const omitted = reflectVfxLayout({ root: 'fn main() {}' });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect(omitted.value.parameters.fields).toEqual([]);
      expect(omitted.value.custom.fields).toEqual([]);
      expect(omitted.value.parameters.size).toBe(0);
      expect(omitted.value.custom.size).toBe(0);
    }

    const explicit = reflectVfxLayout({ root: 'struct VfxParameters {}' });
    expect(explicit.ok).toBe(false);
    if (!explicit.ok) expect(explicit.error.code).toBe('vfx-reflection-empty-struct');
  });

  it('produces identical fingerprints and bytes for repeated cold reflection', () => {
    const first = reflectVfxLayout({ root: moduleSource });
    const second = reflectVfxLayout({ root: moduleSource });
    expect(first).toEqual(second);
    if (first.ok && second.ok) {
      expect(new TextEncoder().encode(JSON.stringify(first.value))).toEqual(
        new TextEncoder().encode(JSON.stringify(second.value)),
      );
    }
  });
});
