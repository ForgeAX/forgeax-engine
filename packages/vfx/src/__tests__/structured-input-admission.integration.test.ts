import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { describe, expect, it } from 'vitest';
import { prepareRuntimeParticleEffect } from '../runtime-prepare.js';

const cooked = (
  await cookParticleCodeProgram(
    {
      schemaVersion: 3,
      emitters: [
        {
          id: 'structured',
          capacity: 8,
          backend: { required: 'gpu' },
          space: 'world',
          schedule: { rate: 0 },
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
          program: { module: 'structured.wgsl' },
          renderers: [{ kind: 'billboard', material: 'material' }],
        },
      ],
    },
    {
      'structured.wgsl': {
        entry: `
#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
#import forgeax_vfx::data::structured_input
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>) {
  (*p).position=bitcast<vec4<f32>>(structured_input[0u]).xyz;(*p).lifetime=1.0;
}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>) {(*p).age+=ctx.delta;}
`,
      },
    },
  )
).unwrap();
const input = { kind: 'particle-effect', schemaVersion: 3, program: cooked.program };

describe('entry-local structured input admission', () => {
  it('preserves the compiler-owned resource reads during runtime preparation', () => {
    const prepared = prepareRuntimeParticleEffect(input).unwrap();
    expect(prepared.program.emitters[0]?.reflection.entryPointBindings).toEqual(
      cooked.program.emitters[0]?.reflection.entryPointBindings,
    );
  });

  it('rejects absent, incomplete, duplicated, foreign, and non-compute resource reads', () => {
    const emitter = cooked.program.emitters[0];
    if (!emitter) throw new Error('missing emitter');
    const reads = emitter.reflection.entryPointBindings;
    if (!reads?.[0]) throw new Error('missing compiler reads');
    for (const entryPointBindings of [
      undefined,
      [],
      [...reads, reads[0]],
      [{ ...reads[0], stage: 'fragment' }, ...reads.slice(1)],
      [{ ...reads[0], bindings: [{ group: 0, binding: 99 }] }, ...reads.slice(1)],
      [
        {
          ...reads[0],
          bindings: [
            { group: 0, binding: 26 },
            { group: 0, binding: 26 },
          ],
        },
        ...reads.slice(1),
      ],
    ]) {
      expect(
        prepareRuntimeParticleEffect({
          ...input,
          program: {
            ...cooked.program,
            emitters: [
              {
                ...emitter,
                reflection: { ...emitter.reflection, entryPointBindings },
              },
            ],
          },
        }),
      ).toMatchObject({ ok: false, error: { code: 'asset-invalid-value' } });
    }
  });
});
