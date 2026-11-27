import type { ParticleEffectAsset, Result } from '@forgeax/engine-types';
import type { ParticleCodeModuleSet } from '@forgeax/engine-vfx-compiler';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyStructuredInputGpu } from './structured-input.gpu-fixture';

declare module 'vitest/internal/browser' {
  interface BrowserCommands {
    cookVfxMeshLighting: (
      source: unknown,
      modules: Readonly<Record<string, ParticleCodeModuleSet>>,
    ) => Promise<Result<{ readonly asset: ParticleEffectAsset }, unknown>>;
  }
}
it('reads all four 17 KiB bank records on native GPU with per-entry layouts and clean submission', async () => {
  const cooked = await commands.cookVfxMeshLighting(
    {
      schemaVersion: 3,
      parameters: { stationIndex: { type: 'f32', default: 0 } },
      emitters: [
        {
          id: 'bank',
          capacity: 4,
          backend: { required: 'gpu' },
          space: 'world',
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
          simulationWhenCulled: 'continue',
          schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
          program: { module: 'bank.wgsl' },
          renderers: [],
        },
      ],
    },
    {
      'bank.wgsl': {
        entry: `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
#import forgeax_vfx::data::structured_input
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>){(*p).lifetime=100.0;}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>){let base=u32(vfx_parameters().stationIndex)*273u;(*p).position.x=bitcast<vec4<f32>>(structured_input[base]).x;(*p).velocity.x=bitcast<vec4<f32>>(structured_input[base+65u]).x;(*p).color.x=bitcast<vec4<f32>>(structured_input[base+272u]).x;var checksum=0.0;for(var i=0u;i<273u;i+=1u){let value=bitcast<vec4<f32>>(structured_input[base+i]);checksum+=value.x+value.y+value.z+value.w;}(*p).color.w=checksum;(*p).age+=ctx.delta;}
`,
      },
    },
  );
  if (!cooked.ok) throw new Error(JSON.stringify(cooked.error));
  await verifyStructuredInputGpu(cooked.value.asset);
}, 120_000);
