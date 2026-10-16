/// <reference types="node" />
import { readFileSync, writeFileSync } from 'node:fs';
import { env } from 'node:process';
import { cookParticleCodeEffect, type ParticleCodeModuleSet } from '@forgeax/engine/vfx-compiler';
import {
  LAB_CUBE_MESH_GUID,
  LAB_EFFECT_MODULES,
  LAB_EFFECT_SOURCE,
  LAB_MATERIALS,
} from '../../features/vfx/support/lab-effect';
import { defineFeature } from '../../lab/feature';

const FIXTURE_URL = new URL('../../features/vfx/support/lab-effect.cooked.json', import.meta.url);

const MODULES: Record<string, ParticleCodeModuleSet> = Object.fromEntries(
  Object.entries(LAB_EFFECT_MODULES).map(([name, entry]) => [name, { entry }]),
);

function withModule(module: string, entry: string): Record<string, ParticleCodeModuleSet> {
  return { ...MODULES, [module]: { entry } };
}

const BILLBOARD_MODULE = 'lab-billboard.vfx.wgsl';

export default defineFeature({
  title: 'VFX compiler/cooker',
  catalog: 'VFX compiler/cooker',
  kind: 'headless',
  summary:
    'Cooks the lab schema-v3 effect with cookParticleCodeEffect: five emitters, author WGSL hooks, deterministic program artifact, and structured refusals for bad modules.',
  expect:
    'Two cooks produce the same fingerprint and bytes; the committed browser fixture matches; missing module/hook, reserved-surface and invalid-WGSL sources fail with their closed codes.',
  async run(checks) {
    const first = await cookParticleCodeEffect(LAB_EFFECT_SOURCE, MODULES);
    const second = await cookParticleCodeEffect(LAB_EFFECT_SOURCE, MODULES);
    if (!first.ok || !second.ok) {
      checks.ok('lab effect cooks', false, JSON.stringify(first.ok ? second : first));
      return;
    }
    const { asset, artifact, refs } = first.value;
    const programText = new TextDecoder().decode(artifact.bytes);
    checks.ok('lab effect cooks', true, `${programText.length} program chars`);
    checks.equal('artifact key', artifact.artifactKey, 'particle-effect/program.json');
    checks.equal(
      'artifact media type',
      artifact.mimeType,
      'application/vnd.forgeax.vfx-program+json',
    );
    checks.equal(
      'payload fingerprint equals artifact fingerprint',
      asset.programFingerprint,
      artifact.fingerprint,
    );
    checks.equal(
      'fingerprint is deterministic',
      second.value.artifact.fingerprint,
      artifact.fingerprint,
    );
    checks.equal(
      'program bytes are deterministic',
      new TextDecoder().decode(second.value.artifact.bytes),
      programText,
    );
    checks.equal('five emitters', asset.emitters.length, 5);
    checks.equal(
      'refs are the sorted material and mesh GUIDs',
      refs.join(','),
      [...Object.values(LAB_MATERIALS), LAB_CUBE_MESH_GUID].sort().join(','),
    );
    checks.equal(
      'renderer kinds',
      artifact.program.emitters
        .map((emitter) => emitter.renderers.map((renderer) => renderer.kind).join('+'))
        .join(','),
      'billboard,mesh,ribbon,trail,beam',
    );

    const fixture = JSON.stringify({ payload: asset, programText }, null, 2);
    if (env.FEATURE_LAB_VFX_WRITE_FIXTURE === '1') writeFileSync(FIXTURE_URL, `${fixture}\n`);
    // Compare canonical JSON so formatter whitespace in the committed file is not staleness.
    let committed = '';
    try {
      committed = JSON.stringify(JSON.parse(readFileSync(FIXTURE_URL, 'utf8')));
    } catch {
      committed = '';
    }
    checks.ok(
      'browser fixture lab-effect.cooked.json is fresh',
      committed === JSON.stringify(JSON.parse(fixture)),
      'regenerate: FEATURE_LAB_VFX_WRITE_FIXTURE=1 npx vitest run -t vfx',
    );

    const missingModule = await cookParticleCodeEffect(
      LAB_EFFECT_SOURCE,
      Object.fromEntries(Object.entries(MODULES).filter(([name]) => name !== BILLBOARD_MODULE)),
    );
    checks.equal(
      'missing module refused',
      missingModule.ok ? 'ok' : missingModule.error.code,
      'vfx-module-missing',
    );

    const noUpdate = await cookParticleCodeEffect(
      LAB_EFFECT_SOURCE,
      withModule(
        BILLBOARD_MODULE,
        '#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext}\nfn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {}\n',
      ),
    );
    checks.equal(
      'missing vfx_update refused',
      noUpdate.ok ? 'ok' : noUpdate.error.code,
      'vfx-hook-missing',
    );

    const reserved = await cookParticleCodeEffect(
      LAB_EFFECT_SOURCE,
      withModule(
        BILLBOARD_MODULE,
        `${LAB_EFFECT_MODULES[BILLBOARD_MODULE]}\n@compute @workgroup_size(1) fn main() {}\n`,
      ),
    );
    checks.equal(
      'author entry point refused',
      reserved.ok ? 'ok' : reserved.error.code,
      'vfx-reserved-surface-conflict',
    );

    const invalid = await cookParticleCodeEffect(
      LAB_EFFECT_SOURCE,
      withModule(
        BILLBOARD_MODULE,
        `${LAB_EFFECT_MODULES[BILLBOARD_MODULE]}\nfn broken() -> f32 { return vec3<f32>(1.0); }\n`,
      ),
    );
    checks.equal(
      'invalid WGSL refused',
      invalid.ok ? 'ok' : invalid.error.code,
      'vfx-shader-invalid',
    );
  },
});
