import { createHash } from 'node:crypto';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { particleEffectContribution, prepareVfxGpuEffect } from '@forgeax/engine-vfx';
import { expect, it } from 'vitest';
import { cookParticleCodeEffect } from '../code-program.js';

const entry = `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
struct VfxCustom { heat: f32, }
fn vfx_spawn(ctx: VfxSpawnContext, p: ptr<function, VfxParticle>, c: ptr<function, VfxCustom>) { (*c).heat = 1.0; }
fn vfx_update(ctx: VfxUpdateContext, p: ptr<function, VfxParticle>, c: ptr<function, VfxCustom>) { (*c).heat += ctx.delta; }`;
const source = {
  schemaVersion: 3,
  emitters: [
    {
      id: 'spark',
      capacity: 128,
      backend: { required: 'gpu' },
      space: 'world',
      schedule: { rate: 8 },
      bounds: { kind: 'aabb', min: [-1, -1, -1], max: [1, 1, 1] },
      program: { module: 'spark' },
      renderers: [{ kind: 'billboard', material: 'material' }],
    },
  ],
};
const cook = (text = entry, capacity = 128) =>
  cookParticleCodeEffect(
    { ...source, emitters: [{ ...source.emitters[0], capacity }] },
    { spark: { entry: text } },
  );

it('cooks an explicit validated job program and freezes its retained runtime version', async () => {
  const result = await cook();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const { asset, artifact } = result.value,
    job = artifact.program.emitters[0]?.instanceCompute;
  expect(job).toMatchObject({ format: 'forgeax-vfx-instance-compute-1', jobBytes: 336 });
  expect(job?.bindings[0]?.entries.map((e) => e.binding)).toEqual([0, 1, 2, 3, 4, 5, 6, 11, 12]);
  expect(
    job?.bindings[0]?.entries.filter(
      (e) => e.buffer?.type === 'storage' || e.buffer?.type === 'read-only-storage',
    ),
  ).toHaveLength(8);
  const input = {
    guid: '019e2cc6-0c86-79da-aa76-b0984c86d45c',
    kind: 'particle-effect',
    payload: asset as unknown as Record<string, unknown>,
    artifacts: {
      'particle-effect/program.json': {
        descriptor: { path: 'program.json', mediaType: 'application/vnd.forgeax.vfx-program+json' },
        bytes: artifact.bytes,
      },
    },
  };
  const loaded = await prepareVfxGpuEffect(input);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const assets = new AssetRegistry();
  assets.installDecoder(particleEffectContribution.kind, particleEffectContribution.decoder);
  const material = assets
    .create({
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'forgeax::unlit' } }],
      values: { baseColor: [1, 1, 1, 1] },
    })
    .unwrap();
  const handle = assets
    .create({
      ...loaded.value,
      program: {
        ...loaded.value.program,
        emitters: loaded.value.program.emitters.map((emitter) => ({
          ...emitter,
          renderers: emitter.renderers.map((renderer) => ({ ...renderer, material })),
        })),
      },
    })
    .unwrap();
  const retained = runtimeAssets(assets).pin<typeof loaded.value>(handle).unwrap();
  try {
    const loadedJob = retained.value.program.emitters[0]?.instanceCompute;
    expect(loadedJob).toEqual(job);
    expect(Object.isFrozen(loadedJob)).toBe(true);
    expect(Object.isFrozen(loadedJob?.bindings[0]?.entries)).toBe(true);
  } finally {
    retained.dispose();
    assets.dispose();
  }
  const invalid = JSON.parse(new TextDecoder().decode(artifact.bytes));
  invalid.emitters[0].instanceCompute.bindings[0].entries[1].buffer.type = 'uniform';
  const bytes = new TextEncoder().encode(JSON.stringify(invalid)),
    fingerprint = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const rejected = await prepareVfxGpuEffect({
    ...input,
    payload: {
      ...asset,
      programFingerprint: fingerprint,
      program: { ...asset.program, fingerprint },
    },
    artifacts: {
      'particle-effect/program.json': {
        ...input.artifacts['particle-effect/program.json'],
        bytes,
      },
    },
  });
  expect(rejected).toMatchObject({
    ok: false,
    error: { code: 'vfx-asset-v3-invalid', detail: { guid: input.guid, path: 'program' } },
  });
});
it('keeps unsupported capacity and parameter/data-interface programs on the ordinary ABI', async () => {
  for (const [text, capacity] of [
    [entry, 257],
    [`${entry}\nstruct VfxParameters { gain:f32, }`, 128],
    [`${entry}\n#import forgeax_vfx::data::camera`, 128],
  ] as const) {
    const result = await cook(text, capacity);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.artifact.program.emitters[0]?.instanceCompute).toBeUndefined();
  }
});
it('does not infer instance isolation from immutable WGSL or reflection', async () => {
  const managed = entry.replace(
    '(*c).heat = 1.0;',
    '(*c).heat = f32(forgeax_vfx_runtime.capacity);',
  );
  const result = await cook(managed);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.artifact.program.emitters[0]?.instanceCompute).toBeUndefined();
  const comment = await cook(`${entry}\n// forgeax_vfx_runtime is only a comment`);
  expect(comment.ok).toBe(true);
  if (comment.ok) expect(comment.value.artifact.program.emitters[0]?.instanceCompute).toBeDefined();
});

it('retains the original program for legacy and unknown optional job formats', async () => {
  const cooked = await cook();
  expect(cooked.ok).toBe(true);
  if (!cooked.ok) return;
  for (const format of [undefined, 'future-instance-compute']) {
    const program = JSON.parse(new TextDecoder().decode(cooked.value.artifact.bytes));
    if (format === undefined) delete program.emitters[0].instanceCompute;
    else program.emitters[0].instanceCompute.format = format;
    const bytes = new TextEncoder().encode(JSON.stringify(program)),
      fingerprint = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const payload = {
      ...cooked.value.asset,
      programFingerprint: fingerprint,
      program: { ...program, fingerprint },
    };
    const loaded = await prepareVfxGpuEffect({
      guid: '019e2cc6-0c86-79da-aa76-b0984c86d45c',
      kind: 'particle-effect',
      payload,
      artifacts: {
        'particle-effect/program.json': {
          descriptor: {
            path: 'program.json',
            mediaType: 'application/vnd.forgeax.vfx-program+json',
          },
          bytes,
        },
      },
    });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.program.emitters[0]?.instanceCompute?.format).toBe(format);
    }
  }
});
