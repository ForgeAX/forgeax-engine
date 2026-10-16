import * as naga from '@forgeax/engine-naga';
import { afterEach, expect, it, vi } from 'vitest';
import { cookParticleCodeEffect } from '../code-program.js';

const entry = `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(0.0, 0.0, 0.0);
  (*particle).lifetime = 100.0;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}`;
const source = {
  schemaVersion: 3,
  emitters: [
    {
      id: 'reuse-mesh-regression',
      capacity: 1,
      backend: { required: 'gpu' as const },
      space: 'world',
      schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 4 },
      program: { module: 'mesh.wgsl' },
      renderers: [
        {
          kind: 'mesh',
          mesh: 'mesh-first',
          material: 'material-first',
          lighting: 'standard',
          receiveShadows: true,
        },
      ],
    },
  ],
} as const;
afterEach(() => vi.restoreAllMocks());

it('reuses real VFX composition across effect metadata while publishing fresh projections', async () => {
  const compose = vi.spyOn(naga, 'composeShader');
  const first = await cookParticleCodeEffect(source, { 'mesh.wgsl': { entry } });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(compose).toHaveBeenCalledTimes(1);
  const second = await cookParticleCodeEffect(
    {
      ...source,
      emitters: [
        {
          ...source.emitters[0],
          capacity: 2,
          renderers: [
            {
              ...source.emitters[0].renderers[0],
              material: 'material-second',
              mesh: 'mesh-second',
            },
          ],
        },
      ],
    },
    { 'mesh.wgsl': { entry } },
  );
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.value.asset.program.emitters[0]?.wgsl).toBe(
    first.value.asset.program.emitters[0]?.wgsl,
  );
  expect(second.value.refs).toEqual(['material-second', 'mesh-second']);
  expect(first.value.refs).toEqual(['material-first', 'mesh-first']);
  expect(second.value.asset.program.emitters[0]?.capacity).toBe(2);
  expect(second.value.asset.program.emitters[0]?.renderers[0]).toMatchObject({
    lighting: 'standard',
    receiveShadows: true,
  });
  expect(second.value.artifact.fingerprint).not.toBe(first.value.artifact.fingerprint);
  expect(compose).toHaveBeenCalledTimes(1);

  // Lighting controls change the generated mesh ABI and must compile anew.
  const controls = await cookParticleCodeEffect(
    {
      ...source,
      emitters: [
        {
          ...source.emitters[0],
          renderers: [
            { ...source.emitters[0].renderers[0], lighting: 'unlit', receiveShadows: false },
          ],
        },
      ],
    },
    { 'mesh.wgsl': { entry } },
  );
  expect(controls.ok).toBe(true);
  if (!controls.ok) return;
  expect(controls.value.asset.program.emitters[0]?.wgsl).not.toBe(
    first.value.asset.program.emitters[0]?.wgsl,
  );
  expect(compose).toHaveBeenCalledTimes(2);

  const edited = await cookParticleCodeEffect(source, {
    'mesh.wgsl': { entry: entry.replace('vec3<f32>(0.0, 0.0, 0.0)', 'vec3<f32>(1.0, 0.0, 0.0)') },
  });
  expect(edited.ok).toBe(true);
  if (!edited.ok) return;
  expect(edited.value.asset.program.emitters[0]?.wgsl).not.toBe(
    first.value.asset.program.emitters[0]?.wgsl,
  );
  expect(compose).toHaveBeenCalledTimes(3);

  // Failed composition cannot suppress a retry or poison an accepted program.
  const invalid = { 'mesh.wgsl': { entry: `${entry}\nfn broken() { unknown_function(); }` } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const rejected = await cookParticleCodeEffect(source, invalid);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('vfx-shader-invalid');
  }
  expect(compose).toHaveBeenCalledTimes(5);
  const recovered = await cookParticleCodeEffect(source, { 'mesh.wgsl': { entry } });
  expect(recovered.ok).toBe(true);
  if (recovered.ok) expect(recovered.value.artifact.bytes).toEqual(first.value.artifact.bytes);
  expect(compose).toHaveBeenCalledTimes(5);
}, 30_000);
