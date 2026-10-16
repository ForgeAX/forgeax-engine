import type { ParticleEffectSourceV3 } from '@forgeax/engine/vfx';

// Browser-safe author facts shared by the Node cook probe (which regenerates and
// verifies lab-effect.cooked.json) and the browser features (which load that
// cooked output through the owner Pack loader).

export const LAB_EFFECT_GUID = 'f1ab0000-0000-7000-8000-00000000e000';
export const LAB_CUBE_MESH_GUID = 'f1ab0000-0000-7000-8000-00000000e0c0';

export const LAB_MATERIALS = {
  billboard: 'f1ab0000-0000-7000-8000-00000000e001',
  mesh: 'f1ab0000-0000-7000-8000-00000000e002',
  ribbon: 'f1ab0000-0000-7000-8000-00000000e003',
  trail: 'f1ab0000-0000-7000-8000-00000000e004',
  beam: 'f1ab0000-0000-7000-8000-00000000e005',
} as const;

export type LabEmitterKind = keyof typeof LAB_MATERIALS;

export const LAB_EMITTER_IDS: Readonly<Record<LabEmitterKind, string>> = {
  billboard: 'lab.billboard',
  mesh: 'lab.mesh',
  ribbon: 'lab.ribbon',
  trail: 'lab.trail',
  beam: 'lab.beam',
};

/** Column x position per emitter; the camera frames all five columns. */
export const LAB_COLUMNS: Readonly<Record<LabEmitterKind, number>> = {
  billboard: -3,
  mesh: -1.5,
  ribbon: 0,
  trail: 1.5,
  beam: 3,
};

function bounds(kind: LabEmitterKind) {
  return {
    kind: 'sphere' as const,
    center: [LAB_COLUMNS[kind], 1, 0] as [number, number, number],
    radius: 1.6,
  };
}

const GPU = { required: 'gpu' } as const;

export const LAB_EFFECT_SOURCE: ParticleEffectSourceV3 = {
  schemaVersion: 3,
  emitters: [
    {
      id: LAB_EMITTER_IDS.billboard,
      capacity: 256,
      backend: GPU,
      space: 'world',
      bounds: bounds('billboard'),
      schedule: { rate: 90, bursts: [{ time: 0, count: 40 }] },
      program: { module: 'lab-billboard.vfx.wgsl' },
      renderers: [{ kind: 'billboard', material: LAB_MATERIALS.billboard, blend: 'additive' }],
      simulationWhenCulled: 'continue',
    },
    {
      id: LAB_EMITTER_IDS.mesh,
      capacity: 64,
      backend: GPU,
      space: 'world',
      bounds: bounds('mesh'),
      schedule: { rate: 12, bursts: [{ time: 0, count: 12 }] },
      program: { module: 'lab-mesh.vfx.wgsl' },
      renderers: [{ kind: 'mesh', material: LAB_MATERIALS.mesh, mesh: LAB_CUBE_MESH_GUID }],
      simulationWhenCulled: 'continue',
    },
    {
      id: LAB_EMITTER_IDS.ribbon,
      capacity: 96,
      backend: GPU,
      space: 'world',
      bounds: bounds('ribbon'),
      schedule: { rate: 48 },
      program: { module: 'lab-ribbon.vfx.wgsl' },
      renderers: [
        {
          kind: 'ribbon',
          material: LAB_MATERIALS.ribbon,
          stripKey: 'alive-index',
          capacity: 96,
          overflow: 'drop-oldest',
          width: 0.16,
        },
      ],
      simulationWhenCulled: 'continue',
    },
    {
      id: LAB_EMITTER_IDS.trail,
      capacity: 16,
      backend: GPU,
      space: 'world',
      bounds: bounds('trail'),
      schedule: { rate: 4, bursts: [{ time: 0, count: 6 }] },
      program: { module: 'lab-trail.vfx.wgsl' },
      renderers: [
        {
          kind: 'trail',
          material: LAB_MATERIALS.trail,
          historyLength: 8,
          capacity: 16,
          overflow: 'drop-oldest',
          width: 0.12,
        },
      ],
      simulationWhenCulled: 'continue',
    },
    {
      id: LAB_EMITTER_IDS.beam,
      capacity: 16,
      backend: GPU,
      space: 'world',
      bounds: bounds('beam'),
      schedule: { rate: 0, bursts: [{ time: 0, count: 9 }], loopDuration: 1 },
      program: { module: 'lab-beam.vfx.wgsl' },
      renderers: [
        {
          kind: 'beam',
          material: LAB_MATERIALS.beam,
          endpointField: 'velocity',
          capacity: 16,
          overflow: 'drop-newest',
          width: 0.1,
        },
      ],
      simulationWhenCulled: 'continue',
    },
  ],
};

const PRELUDE =
  '#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}\n';

/** Author WGSL modules keyed by `program.module`; each defines exactly vfx_spawn and vfx_update. */
export const LAB_EFFECT_MODULES: Readonly<Record<string, string>> = {
  'lab-billboard.vfx.wgsl': `${PRELUDE}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let angle = vfx_random_spawn(ctx, 0u) * 6.2831853;
  let spread = 0.4 + vfx_random_spawn(ctx, 1u) * 0.6;
  (*particle).position = vec3<f32>(-3.0, 0.2, 0.0);
  (*particle).velocity = vec3<f32>(cos(angle) * spread, 3.2 + vfx_random_spawn(ctx, 2u), sin(angle) * spread);
  (*particle).color = vec4<f32>(4.0, 0.4, 2.6, 1.0);
  (*particle).sprite_size = vec2<f32>(0.34);
  (*particle).lifetime = 1.4;
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  (*particle).mesh_scale = vec3<f32>(1.0);
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  (*particle).velocity.y -= 3.5 * ctx.delta;
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  (*particle).color.a = 1.0 - life;
}
`,
  'lab-mesh.vfx.wgsl': `${PRELUDE}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let angle = vfx_random_spawn(ctx, 0u) * 6.2831853;
  (*particle).position = vec3<f32>(-1.5 + cos(angle) * 0.45, 0.2, sin(angle) * 0.45);
  (*particle).velocity = vec3<f32>(0.0, 1.1 + vfx_random_spawn(ctx, 1u) * 0.4, 0.0);
  (*particle).color = vec4<f32>(0.2, 1.0, 0.3, 1.0);
  (*particle).sprite_size = vec2<f32>(0.3);
  (*particle).lifetime = 1.8;
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  (*particle).mesh_scale = vec3<f32>(0.3);
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  vfx_integrate(ctx, particle);
  let spin = (*particle).age * 3.0 + f32((*particle).id % 7u);
  let axis = normalize(vec3<f32>(1.0, 1.0, 0.3));
  (*particle).mesh_orientation = vec4<f32>(axis * sin(spin * 0.5), cos(spin * 0.5));
}
`,
  'lab-ribbon.vfx.wgsl': `${PRELUDE}
fn helix(age: f32) -> vec3<f32> {
  let angle = age * 7.0;
  return vec3<f32>(cos(angle) * 0.55, 0.2 + age * 1.3, sin(angle) * 0.55);
}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = helix(0.0);
  (*particle).velocity = vec3<f32>(0.0);
  (*particle).color = vec4<f32>(0.2, 2.4, 3.2, 1.0);
  (*particle).sprite_size = vec2<f32>(0.16);
  (*particle).lifetime = 1.8;
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  (*particle).mesh_scale = vec3<f32>(1.0);
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = helix((*particle).age);
}
`,
  'lab-trail.vfx.wgsl': `${PRELUDE}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let phase = vfx_random_spawn(ctx, 0u) * 6.2831853;
  (*particle).position = vec3<f32>(1.5 + cos(phase) * 0.8, 1.0 + sin(phase) * 0.8, 0.0);
  (*particle).velocity = vec3<f32>(-sin(phase), cos(phase), 0.0) * 3.2;
  (*particle).color = vec4<f32>(3.2, 2.6, 0.2, 1.0);
  (*particle).sprite_size = vec2<f32>(0.12);
  (*particle).lifetime = 3.0;
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  (*particle).mesh_scale = vec3<f32>(1.0);
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  let offset = (*particle).position - vec3<f32>(1.5, 1.0, 0.0);
  (*particle).velocity = vec3<f32>(-offset.y, offset.x, 0.0) * 4.0;
  vfx_integrate(ctx, particle);
}
`,
  'lab-beam.vfx.wgsl': `${PRELUDE}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let index = f32(ctx.particleId % 9u);
  let angle = 0.35 + index * 0.3;
  let start = vec3<f32>(3.0, 0.1, 0.0);
  let end = start + vec3<f32>(cos(angle), sin(angle), 0.0) * 1.9;
  (*particle).lifetime = 0.98;
  (*particle).position = start;
  (*particle).velocity = (end - start) / (*particle).lifetime;
  (*particle).color = vec4<f32>(3.4, 0.9, 0.2, 1.0);
  (*particle).sprite_size = vec2<f32>(0.1);
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  (*particle).mesh_scale = vec3<f32>(1.0);
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(3.0, 0.1, 0.0);
}
`,
};
