import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';

const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export async function prepareFixedFieldProgram() {
  const cooked = (
    await cookParticleCodeProgram(
      {
        schemaVersion: 3,
        emitters: [
          {
            id: 'field',
            capacity: 4,
            backend: { required: 'gpu' },
            space: 'world',
            bounds: { kind: 'sphere', center: [1000, 0, 0], radius: 1 },
            simulationWhenCulled: 'continue',
            schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
            program: { module: 'field.wgsl' },
            renderers: [{ kind: 'billboard', material: 'material' }],
            forceFields: [
              {
                kind: 'vector',
                texture: '01a11250-0000-7000-8000-000000000001',
                sampling: 'nearest',
                transform,
                strength: 1,
                attenuation: 0,
              },
            ],
          },
        ],
      },
      {
        'field.wgsl': {
          entry: `
#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
#import forgeax_vfx::data::force_fields
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>){(*p).lifetime=100.0;}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>){vfx_apply_force_fields(ctx,p);}
`,
        },
      },
    )
  ).unwrap();
  return { fingerprint: cooked.fingerprint, program: cooked.program };
}

export const fixedFieldCommands = {
  prepareFixedFieldProgram,
};
