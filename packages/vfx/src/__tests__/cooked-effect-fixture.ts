import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import type { VfxGpuEffectAsset, VfxGpuEmitterProgramV3, VfxReflectedField } from '../index';

/** Real compiler output for bookkeeping fixtures that need no authored particle behavior. */
export async function cookedEffectFixture(input: {
  readonly guid?: string;
  readonly program: { readonly emitters: readonly unknown[] };
}): Promise<VfxGpuEffectAsset> {
  const modules: Record<string, { entry: string }> = {};
  const emitters = input.program.emitters.map((unknown, index) => {
    const emitter = unknown as VfxGpuEmitterProgramV3;
    const module = emitter.module ?? `fixture-${index}.wgsl`;
    const struct = (name: string, fields: readonly VfxReflectedField[] | undefined) =>
      fields?.length
        ? `struct ${name} { ${fields.map((field) => `${field.name}: ${field.type},`).join(' ')} }`
        : '';
    const custom = (emitter.reflection?.layout?.custom?.fields.length ?? 0) > 0;
    modules[module] = {
      entry: `
#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
${[...new Set([...(emitter.reflection?.dataInterfaces ?? []).map((requirement) => requirement.kind), ...(emitter.forceFields === undefined ? [] : ['force-fields'])])].map((kind) => `#import forgeax_vfx::data::${kind.replaceAll('-', '_')}`).join('\n')}
${struct('VfxParameters', emitter.reflection?.layout?.parameters?.fields)}
${struct('VfxCustom', emitter.reflection?.layout?.custom?.fields)}
fn vfx_spawn(ctx: VfxSpawnContext, p: ptr<function,VfxParticle>${custom ? ', c: ptr<function,VfxCustom>' : ''}) { (*p).lifetime = 2.0; }
fn vfx_update(ctx: VfxUpdateContext, p: ptr<function,VfxParticle>${custom ? ', c: ptr<function,VfxCustom>' : ''}) { (*p).age += ctx.delta; }
${(emitter.reflection?.stages ?? []).map((stage) => `// #vfx stage ${stage.id} entry=${stage.entry} domain=${stage.domain} resources=${stage.resources.length ? stage.resources.map((resource) => `${resource.name}:${resource.access}`).join(',') : 'particles:read-write'} dependsOn=${stage.dependsOn.join(',')} iterationBudget=${stage.iterationBudget}\nfn ${stage.entry}(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>) {}`).join('\n')}
`,
    };
    return {
      id: emitter.id,
      capacity: emitter.capacity,
      backend: { required: 'gpu' },
      space: emitter.space ?? 'world',
      bounds: emitter.bounds ?? { kind: 'sphere', center: [0, 0, 0], radius: 1 },
      schedule: emitter.schedule ?? { rate: 0 },
      program: { module },
      renderers: emitter.renderers ?? [],
      simulationWhenCulled: emitter.simulationWhenCulled ?? 'continue',
      ...(emitter.channels?.length ? { channels: emitter.channels } : {}),
      ...(emitter.events?.length ? { events: emitter.events } : {}),
      ...(emitter.forceFields === undefined ? {} : { forceFields: emitter.forceFields }),
    };
  });
  const cooked = (await cookParticleCodeProgram({ schemaVersion: 3, emitters }, modules)).unwrap();
  return {
    guid: input.guid ?? 'fixture',
    kind: 'particle-effect',
    schemaVersion: 3,
    programFingerprint: cooked.fingerprint,
    emitters: cooked.program.emitters.map(({ id, capacity }) => ({ id, capacity })),
    program: { ...cooked.program, fingerprint: cooked.fingerprint },
  };
}
