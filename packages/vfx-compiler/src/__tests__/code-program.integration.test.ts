import type { ParticleEffectAsset } from '@forgeax/engine-types';
import { PARTICLE_CODE_DEFAULT_MODULE_ID } from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';
import { cookParticleCodeProgram } from '../code-program.js';

const source = {
  schemaVersion: 3,
  emitters: [
    {
      id: 'sparks',
      capacity: 128,
      backend: { required: 'gpu' as const },
      space: 'world',
      schedule: { rate: 8, bursts: [{ time: 0, count: 4 }] },
      bounds: { kind: 'aabb', min: [-4, -4, -4], max: [4, 4, 4] },
      program: { module: 'sparks.vfx.wgsl' },
      renderers: [{ kind: 'billboard', material: 'material-guid' }],
    },
  ],
};

const entry = `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).velocity = vec3<f32>(0.0, 1.0, 0.0);
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  vfx_integrate(ctx, particle);
}`;

describe('code-first VFX program cook', () => {
  it('composes hooks with managed entry points and reflects the ABI', async () => {
    const result = await cookParticleCodeProgram(source, {
      'sparks.vfx.wgsl': { entry },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const emitter = result.value.program.emitters.at(0);
    expect(emitter).toBeDefined();
    if (emitter === undefined) return;
    expect(emitter.module).toBe('sparks.vfx.wgsl');
    expect(emitter.reflection.hooks).toEqual(['vfx_spawn', 'vfx_update']);
    expect(emitter.reflection.entryPoints).toEqual([
      'forgeax_vfx_spawn_main',
      'forgeax_vfx_update_main',
      'forgeax_vfx_scan_blocks_main',
      'forgeax_vfx_scan_block_offsets_main',
      'forgeax_vfx_add_offsets_main',
      'forgeax_vfx_compact_main',
      'forgeax_vfx_sort_main',
      'forgeax_vfx_billboard_main',
      'forgeax_vfx_mesh_main',
      'forgeax_vfx_ribbon_main',
      'forgeax_vfx_trail_history_main',
      'forgeax_vfx_trail_offsets_main',
      'forgeax_vfx_trail_main',
      'forgeax_vfx_beam_main',
    ]);
    expect(emitter.wgsl).toContain('@compute');
    expect(emitter.wgsl).toContain('forgeax_vfx_particles');
    expect(emitter.wgsl).toContain('fn forgeax_vfx_sort_main');
    expect(emitter.wgsl).toContain('fn forgeax_vfx_trail_history_main');
    expect(emitter.wgsl).toContain('forgeax_vfx_runtime.topology');
    expect(result.value.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const asset: ParticleEffectAsset = {
      kind: 'particle-effect',
      schemaVersion: 3,
      programFingerprint: result.value.fingerprint,
      emitters: result.value.program.emitters.map(({ id, capacity }) => ({ id, capacity })),
      program: {
        format: 'forgeax-vfx-program-4',
        fingerprint: result.value.fingerprint,
        emitters: result.value.program.emitters,
      },
    };
    expect(asset.program).toMatchObject({
      format: 'forgeax-vfx-program-4',
      fingerprint: result.value.fingerprint,
    });
    expect(asset.program.emitters).toEqual(result.value.program.emitters);
  });

  it('carries explicit data imports into the cooked reflection', async () => {
    const result = await cookParticleCodeProgram(source, {
      'sparks.vfx.wgsl': {
        entry: `${entry}\n#import forgeax_vfx::data::camera\n#import forgeax_vfx::data::scene_depth`,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.program.emitters[0]?.reflection.dataInterfaces).toEqual([
      expect.objectContaining({ token: 'vfx:camera', binding: 12 }),
      expect.objectContaining({ token: 'vfx:scene-depth', binding: 13 }),
    ]);
  });

  it('projects mesh instances from quaternion orientation and Scale3', async () => {
    const result = await cookParticleCodeProgram(source, { 'sparks.vfx.wgsl': { entry } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wgsl = result.value.program.emitters[0]?.wgsl ?? '';
    const meshStart = wgsl.indexOf('fn forgeax_vfx_mesh_main');
    const ribbonStart = wgsl.indexOf('fn forgeax_vfx_ribbon_main');
    expect(meshStart).toBeGreaterThanOrEqual(0);
    expect(ribbonStart).toBeGreaterThan(meshStart);
    const mesh = wgsl.slice(meshStart, ribbonStart);
    expect(mesh).toContain('forgeax_vfx_renderer_orientation');
    expect(mesh).toContain('forgeax_vfx_renderer_scale');
    expect(mesh).toContain('forgeax_vfx_quaternion_rotate');
    expect(mesh).not.toContain('size_rotation');
    expect(mesh).not.toContain('sprite_size');
    expect(mesh).toContain('forgeax_vfx_mesh_transform_valid');
    expect(mesh).toContain('forgeax_vfx_zero_mesh_instance');
    expect(mesh).toContain('droppedCount');
  });

  it('is byte deterministic and rejects reserved author bindings', async () => {
    const modules = { 'sparks.vfx.wgsl': { entry } };
    const first = await cookParticleCodeProgram(source, modules);
    const second = await cookParticleCodeProgram(source, modules);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value.bytes).toEqual(second.value.bytes);

    const invalid = await cookParticleCodeProgram(source, {
      'sparks.vfx.wgsl': { entry: `@group(0) @binding(0) var<uniform> stolen: u32;\n${entry}` },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('vfx-reserved-surface-conflict');

    const invalidImport = await cookParticleCodeProgram(source, {
      'sparks.vfx.wgsl': {
        entry,
        imports: { 'game::bad': '@compute @workgroup_size(1) fn hidden_stage() {}' },
      },
    });
    expect(invalidImport.ok).toBe(false);
    if (!invalidImport.ok) {
      expect(invalidImport.error).toMatchObject({
        code: 'vfx-reserved-surface-conflict',
        detail: { module: 'game::bad' },
      });
    }
  });

  it('cooks the engine-owned default module without an application catalog entry', async () => {
    const result = await cookParticleCodeProgram(
      {
        ...source,
        emitters: [{ ...source.emitters[0], program: { module: PARTICLE_CODE_DEFAULT_MODULE_ID } }],
      },
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.program.emitters[0]?.wgsl).toContain('fn vfx_spawn');
  });

  it('does not produce an artifact when reflected declarations are invalid', async () => {
    const invalid = await cookParticleCodeProgram(source, {
      'sparks.vfx.wgsl': {
        entry: `${entry}\nstruct VfxParameters { value: mat3x3<f32>, }`,
      },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('vfx-reflection-unknown-type');
  });
});
