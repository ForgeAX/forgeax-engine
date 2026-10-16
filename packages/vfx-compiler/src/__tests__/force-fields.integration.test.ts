import { describe, expect, it } from 'vitest';
import { cookParticleCodeEffect } from '../code-program.js';
import { createVfxVectorFieldTexture } from '../force-fields.js';

const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const texture = '01a11250-0000-7000-8000-000000000001';
const material = '01a11250-0000-7000-8000-000000000002';
const entry = `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate}
#import forgeax_vfx::data::force_fields
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  vfx_apply_force_fields(ctx, particle);
  vfx_integrate(ctx, particle);
}`;
const source = {
  schemaVersion: 3,
  emitters: [
    {
      id: 'fields',
      capacity: 256,
      backend: { required: 'gpu' },
      space: 'world',
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 2 },
      schedule: { rate: 0 },
      program: { module: 'fields.wgsl' },
      renderers: [{ kind: 'billboard', material }],
      forceFields: [
        { kind: 'vector', texture, sampling: 'trilinear', transform, strength: 1, attenuation: 0 },
      ],
    },
  ],
};

describe('ordinary managed force-field cooking', () => {
  it('rejects a JSON array in the texture GUID slot through the public cook path', async () => {
    const result = await cookParticleCodeEffect(
      {
        ...source,
        emitters: source.emitters.map((emitter) => ({
          ...emitter,
          forceFields: emitter.forceFields.map((field) => ({ ...field, texture: [texture] })),
        })),
      },
      { 'fields.wgsl': { entry } },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'vfx-source-invalid', detail: { path: 'emitters[0].forceFields[0]' } },
    });
  });

  it('cooks executable sampling and retains GUID closure and deterministic bytes', async () => {
    const first = await cookParticleCodeEffect(source, { 'fields.wgsl': { entry } });
    if (!first.ok) throw first.error;
    const second = await cookParticleCodeEffect(source, { 'fields.wgsl': { entry } });
    if (!second.ok) throw second.error;
    expect(first.value.artifact.bytes).toEqual(second.value.artifact.bytes);
    expect(first.value.refs).toEqual([texture, material].sort());
    const emitter = first.value.artifact.program.emitters[0];
    if (emitter === undefined) throw new Error('missing emitter');
    expect(emitter.forceFields).toEqual(source.emitters[0]?.forceFields);
    expect(emitter.reflection.dataInterfaces).toEqual([
      {
        token: 'vfx:force-fields',
        kind: 'force-fields',
        binding: 17,
        bindingType: 'read-only-storage',
        lifetime: 'generation',
      },
    ]);
    expect(emitter.reflection.bindings[0]?.entries).toContainEqual(
      expect.objectContaining({
        binding: 17,
        buffer: expect.objectContaining({ type: 'read-only-storage' }),
      }),
    );
    expect(emitter.wgsl).toContain('forgeax_vfx_force_fields');
  });

  it('rejects an unbound helper and declarations without their consuming import', async () => {
    for (const [input, code] of [
      [
        { ...source, emitters: source.emitters.map(({ forceFields: _, ...emitter }) => emitter) },
        entry,
      ],
      [
        source,
        entry
          .replace('#import forgeax_vfx::data::force_fields', '')
          .replace('vfx_apply_force_fields(ctx, particle);', ''),
      ],
    ] as const) {
      const result = await cookParticleCodeEffect(input, { 'fields.wgsl': { entry: code } });
      expect(result).toMatchObject({ ok: false, error: { code: 'vfx-shader-invalid' } });
    }
  });

  it('saves canonical finite constant, radial and vortex 3D texture bytes', () => {
    for (const field of [
      { kind: 'constant' as const, value: [0.5, 0.25, -0.125] as const },
      { kind: 'radial' as const, magnitude: 1 },
      { kind: 'vortex' as const, magnitude: 1 },
    ]) {
      const result = createVfxVectorFieldTexture({ resolution: [8, 8, 8], field });
      if (!result.ok) throw result.error;
      expect(result.value).toMatchObject({
        kind: 'texture',
        format: 'rgba32float',
        shape: { viewDimension: '3d', extent: { width: 8, height: 8, depth: 8 } },
      });
      expect(result.value.data.byteLength).toBe(8192);
    }
    expect(
      createVfxVectorFieldTexture({
        resolution: [65, 8, 8],
        field: { kind: 'radial', magnitude: 1 },
      }),
    ).toMatchObject({ ok: false });
    for (const field of [
      { kind: 'unsupported', magnitude: 1 },
      { kind: 'constant', value: null },
      { kind: 'radial', magnitude: '1' },
    ]) {
      expect(createVfxVectorFieldTexture({ resolution: [8, 8, 8], field } as never)).toMatchObject({
        ok: false,
        error: { code: 'vfx-field-invalid' },
      });
    }
  });

  it('rejects fields combined with storage work beyond the portable compute budget', async () => {
    const result = await cookParticleCodeEffect(
      {
        ...source,
        emitters: [
          {
            ...source.emitters[0],
            channels: [{ id: 'hit', capacity: 2, overflow: 'drop-newest' }],
            events: [
              { id: 'hit', channel: 'hit', subEmitter: 'fields', fanOut: 1, recursionDepth: 1 },
            ],
          },
        ],
      },
      {
        'fields.wgsl': {
          entry: entry
            .replace('fn vfx_spawn', 'struct VfxCustom { heat:f32, }\nfn vfx_spawn')
            .replaceAll(
              'particle: ptr<function, VfxParticle>',
              'particle: ptr<function, VfxParticle>, custom:ptr<function,VfxCustom>',
            ),
        },
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'vfx-shader-invalid', detail: { cause: { storageBindings: 9 } } },
    });
  });
});
