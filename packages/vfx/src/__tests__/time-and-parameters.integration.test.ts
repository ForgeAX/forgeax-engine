import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { describe, expect, it } from 'vitest';
import type { VfxGpuEffectAsset } from '../gpu-program.js';
import {
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from '../gpu-runtime.js';
import { ParticleEffectPlayer, vfxPlayerParameters } from '../player.js';
import { validateVfxPlayerParameters } from '../player-parameters.js';
import { runtimeEffectFixture } from './runtime-effect-fixture';

const cookWith = (originType: string) =>
  cookParticleCodeProgram(
    {
      schemaVersion: 3,
      parameters: {
        origin: { type: originType, default: [1, 2, 3] },
        worldScale: { type: 'f32', default: 9.5 },
      },
      emitters: [
        {
          id: 'smoke',
          capacity: 8,
          backend: { required: 'gpu' },
          space: 'world',
          schedule: { rate: 0, bursts: [{ time: 0, count: 4 }] },
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 10 },
          program: { module: 'smoke.vfx.wgsl' },
          renderers: [{ kind: 'billboard', material: 'material-guid' }],
        },
      ],
    },
    {
      'smoke.vfx.wgsl': {
        entry: `
#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext,vfx_forever}
fn vfx_spawn(ctx: VfxSpawnContext, p: ptr<function,VfxParticle>) {
  (*p).lifetime = vfx_forever();
  (*p).position = vfx_parameters().origin;
}
fn vfx_update(ctx: VfxUpdateContext, p: ptr<function,VfxParticle>) {
  (*p).sprite_size = vec2<f32>(vfx_parameters().worldScale + ctx.time);
}
`,
      },
    },
  );
const cooked = (await cookWith('vec3<f32>')).unwrap();
const effect: VfxGpuEffectAsset = {
  guid: 'smoke-guid',
  kind: 'particle-effect',
  schemaVersion: 3,
  programFingerprint: cooked.fingerprint,
  emitters: [{ id: 'smoke', capacity: 8 }],
  program: { ...cooked.program, fingerprint: cooked.fingerprint },
};

function floats(bytes: Uint8Array): number[] {
  return [...new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)];
}

async function setup(data: Record<string, unknown> = {}) {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const handle = assets.create(runtimeEffectFixture(world, effect)).unwrap();
  const player = world
    .spawn({ component: ParticleEffectPlayer, data: { effect: handle, ...data } })
    .unwrap();
  const ctx = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  return { world, runtime, player, assets, ctx };
}

describe('VFX per-Player parameters', () => {
  it('uses effect defaults when the Player overrides nothing', async () => {
    const { world, runtime, assets, ctx } = await setup();
    try {
      world.update(1 / 60).unwrap();
      const block = floats(required(runtime.snapshot()[0]).parameterBlock);
      expect(block.slice(0, 3)).toEqual([1, 2, 3]);
      expect(block[3]).toBe(9.5);
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('applies component overrides, then reverts names removed from the text', async () => {
    const { world, runtime, player, assets, ctx } = await setup({
      parameters: vfxPlayerParameters({ origin: [-5, 0, 7], worldScale: 4 }),
    });
    try {
      world.update(1 / 60).unwrap();
      const first = floats(required(runtime.snapshot()[0]).parameterBlock);
      expect(first.slice(0, 3)).toEqual([-5, 0, 7]);
      expect(first[3]).toBe(4);
      runtime.commit(runtime.snapshot().map((intent) => intent.sequence));
      world
        .set(player, ParticleEffectPlayer, { parameters: vfxPlayerParameters({ worldScale: 6 }) })
        .unwrap();
      world.update(1 / 60).unwrap();
      const second = floats(required(runtime.snapshot().at(-1)).parameterBlock);
      expect(second.slice(0, 3)).toEqual([1, 2, 3]);
      expect(second[3]).toBe(6);
      expect(runtime.diagnostics()).toEqual([]);
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('reports unknown names and wrong types with the valid names', async () => {
    const { world, runtime, assets, ctx } = await setup({
      parameters: '{"origen":[1,2,3]}',
    });
    try {
      world.update(1 / 60).unwrap();
      const diagnostic = runtime.diagnostics().find((d) => d.code === 'vfx-parameters-invalid');
      expect(diagnostic?.detail.parameter).toBe('origen');
      expect(diagnostic?.detail.validNames).toEqual(['origin', 'worldScale']);
      expect(diagnostic?.hint).toContain('origin, worldScale');
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('validates and applies parameter changes on a paused Player', async () => {
    const { world, runtime, player, assets, ctx } = await setup();
    try {
      world.update(1 / 60).unwrap();
      runtime.commit(runtime.snapshot().map((intent) => intent.sequence));
      world.set(player, ParticleEffectPlayer, { playing: false }).unwrap();
      world.update(1 / 60).unwrap();
      world.set(player, ParticleEffectPlayer, { parameters: '{"origen":[1,2,3]}' }).unwrap();
      world.update(1 / 60).unwrap();
      const diagnostic = runtime.diagnostics().find((d) => d.code === 'vfx-parameters-invalid');
      expect(diagnostic?.detail.parameter).toBe('origen');
      expect(diagnostic?.detail.actual).toBeUndefined();
      world
        .set(player, ParticleEffectPlayer, {
          parameters: vfxPlayerParameters({ origin: [4, 5, 6] }),
        })
        .unwrap();
      world.update(1 / 60).unwrap();
      expect(runtime.diagnostics().filter((d) => d.code === 'vfx-parameters-invalid')).toEqual([]);
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('accepts material-style vector spellings in the effect parameter table', async () => {
    const alias = (await cookWith('vec3')).unwrap();
    expect(alias.program.fingerprint ?? alias.fingerprint).toBeDefined();
    const bad = await cookWith('vec9');
    expect(bad.ok).toBe(false);
  });

  it('validates offline with the same rules', () => {
    const fields = [
      { name: 'origin', type: 'vec3<f32>' as const },
      { name: 'worldScale', type: 'f32' as const },
    ];
    expect(validateVfxPlayerParameters('', fields).ok).toBe(true);
    expect(validateVfxPlayerParameters('{"worldScale":2}', fields).ok).toBe(true);
    const bad = validateVfxPlayerParameters('{"worldScale":[1,2]}', fields);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.parameter).toBe('worldScale');
    const notObject = validateVfxPlayerParameters('[1]', fields);
    expect(notObject.ok).toBe(false);
  });
});

describe('VFX time in intents', () => {
  it('carries scaled player elapsed and world elapsed', async () => {
    const { world, runtime, assets, ctx } = await setup({ timeScale: 0.5 });
    try {
      world.update(0.05).unwrap();
      world.update(0.05).unwrap();
      const last = required(runtime.snapshot().at(-1));
      expect(last.elapsed).toBeCloseTo(0.05, 6);
      expect(last.worldElapsed).toBeGreaterThanOrEqual(0.09);
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing VFX fixture input');
  return value;
}
