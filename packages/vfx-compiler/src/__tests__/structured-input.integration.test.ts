import { describe, expect, it } from 'vitest';
import { cookParticleCodeEffect } from '../code-program.js';
import { reflectVfxLayout } from '../reflection.js';

const source = {
  schemaVersion: 3,
  parameters: { stationIndex: { type: 'f32', default: 0 } },
  emitters: [
    {
      id: 'bank',
      capacity: 64,
      backend: { required: 'gpu' },
      space: 'world',
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 4 },
      schedule: { rate: 0 },
      program: { module: 'bank.wgsl' },
      renderers: [{ kind: 'billboard', material: '01a11250-0000-7000-8000-000000000002' }],
    },
  ],
};
const entry = `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
#import forgeax_vfx::data::structured_input

fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>) {
  let words=structured_input[u32(vfx_parameters().stationIndex)*273u];
  (*p).position=bitcast<vec4<f32>>(words).xyz;
  (*p).lifetime=1.0;
}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>) {
  let words=structured_input[u32(vfx_parameters().stationIndex)*273u+113u];
  (*p).color.x=f32(words.x);
}`;

describe('structured input code-first storage', () => {
  it('cooks an exact read-only u32 bank independently of the dynamic parameter budget', async () => {
    const cooked = await cookParticleCodeEffect(source, { 'bank.wgsl': { entry } });
    expect(cooked.ok, cooked.ok ? '' : JSON.stringify(cooked.error)).toBe(true);
    if (!cooked.ok) return;
    const emitter = cooked.value.artifact.program.emitters[0];
    expect(emitter?.reflection.dataInterfaces).toEqual([
      {
        token: 'vfx:structured-input',
        kind: 'structured-input',
        binding: 26,
        bindingType: 'read-only-storage',
        lifetime: 'generation',
      },
    ]);
    expect(emitter?.reflection.bindings[0]?.entries).toContainEqual(
      expect.objectContaining({
        binding: 26,
        buffer: expect.objectContaining({ type: 'read-only-storage' }),
      }),
    );
    expect(emitter?.wgsl).toMatch(
      /var<storage(?:,\s*read)?>\s+structured_input[^:]*:\s*array<vec4<u32>>/,
    );
    expect(emitter?.reflection.layout.parameters.fields.map((field) => field.name)).toEqual([
      'stationIndex',
    ]);
  });

  it('omits the binding and storage code without the explicit import', async () => {
    const cooked = await cookParticleCodeEffect(source, {
      'bank.wgsl': {
        entry: entry
          .replace('#import forgeax_vfx::data::structured_input', '')
          .replace(/let words=structured_input[^;]+;/g, 'let words=vec4<u32>(0u);'),
      },
    });
    expect(cooked.ok, cooked.ok ? '' : JSON.stringify(cooked.error)).toBe(true);
    if (!cooked.ok) return;
    expect(cooked.value.artifact.program.emitters[0]?.reflection.dataInterfaces).toEqual([]);
    expect(cooked.value.artifact.program.emitters[0]?.wgsl).not.toContain('@binding(26)');
  });

  it('rejects writes instead of treating the bank as mutable particle state', async () => {
    const cooked = await cookParticleCodeEffect(source, {
      'bank.wgsl': {
        entry: entry.replace('(*p).color.x=f32(words.x);', 'structured_input[0u]=words;'),
      },
    });
    expect(cooked).toMatchObject({ ok: false, error: { code: 'vfx-shader-invalid' } });
  });

  it('keeps all existing resource slots distinct and rejects duplicate declarations', () => {
    const result = reflectVfxLayout({
      root: '#import forgeax_vfx::data::{structured_input,water_surface,water_config,water_hull,water_displacement,gpu_events}',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const slots =
      result.value.dataInterfaces?.flatMap((row) => [
        row.binding,
        ...(row.solverNormalBinding === undefined ? [] : [row.solverNormalBinding]),
        ...(row.domainBinding === undefined ? [] : [row.domainBinding]),
      ]) ?? [];
    expect(new Set(slots).size).toBe(slots.length);
    expect(slots).toContain(26);
    expect(
      reflectVfxLayout({ root: '#import forgeax_vfx::data::{structured_input,structured_input}' }),
    ).toMatchObject({ ok: false, error: { code: 'vfx-reflection-duplicate-data-interface' } });
  });
});
