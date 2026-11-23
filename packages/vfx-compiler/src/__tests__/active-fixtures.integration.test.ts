import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePackSourceJson, projectDirectPackJson } from '@forgeax/engine-pack/source';
import type { MaterialParticleInput } from '@forgeax/engine-types';
import { type ParticleEffectSourceV3, parseParticleEffectSourceV3 } from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';
import { cookParticleCodeEffect, type ParticleCodeModuleSet } from '../code-program.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const ACTIVE_PACKS = [
  'apps/game-capability-lab/assets/boss-lightning-contact.pack.json',
  'apps/game-capability-lab/assets/boss-lightning-flight.pack.json',
  'apps/game-capability-lab/assets/boss-lightning-suite.pack.json',
  'apps/game-capability-lab/assets/boss-lightning-telegraph.pack.json',
  'apps/game-capability-lab/assets/charge-vfx-effect.pack.json',
  'apps/game-capability-lab/assets/hit-vfx-effect.pack.json',
  'apps/hello/boss-lightning/assets/boss-lightning.pack.json',
  'apps/hello/cinder-fall/assets/cinder-fall.pack.json',
  'apps/showcase/brotato-3d/assets/brotato-impact-vfx.pack.json',
] as const;

function entriesFromPack(packPath: string) {
  const value = JSON.parse(readFileSync(resolve(repoRoot, packPath), 'utf8')) as unknown;
  const pack = parsePackSourceJson(value).unwrap();
  if (pack.format !== 'direct') throw new Error(`active fixture ${packPath} must be a direct Pack`);
  return projectDirectPackJson(pack).assets;
}

function particleSource(packPath: string): ParticleEffectSourceV3 {
  const entry = entriesFromPack(packPath).find((candidate) => candidate.kind === 'particle-effect');
  if (entry?.payload === undefined) {
    throw new Error(`active fixture ${packPath} does not contain a particle-effect payload`);
  }
  return parseParticleEffectSourceV3(entry.payload).unwrap();
}

function materialInputs(): Readonly<Record<string, readonly MaterialParticleInput[]>> {
  const packPath = 'apps/hello/cinder-fall/assets/cinder-materials.pack.json';
  const catalog: Record<string, readonly MaterialParticleInput[]> = {};
  for (const entry of entriesFromPack(packPath)) {
    if (entry.kind !== 'material' || typeof entry.payload !== 'object' || entry.payload === null) {
      continue;
    }
    const payload = entry.payload as { particleInputs?: readonly MaterialParticleInput[] };
    if (payload.particleInputs !== undefined) catalog[entry.guid] = payload.particleInputs;
  }
  return catalog;
}

describe('active Program v3 source fixtures', () => {
  for (const packPath of ACTIVE_PACKS) {
    it(`cooks ${packPath}`, async () => {
      const source = particleSource(packPath);
      const packDirectory = resolve(repoRoot, packPath, '..');
      const modules: Record<string, ParticleCodeModuleSet> = {};
      for (const emitter of source.emitters) {
        const moduleName = emitter.program.module;
        modules[moduleName] = {
          entry: readFileSync(resolve(packDirectory, moduleName), 'utf8'),
        };
      }

      const cooked = await cookParticleCodeEffect(
        source,
        modules,
        packPath.includes('cinder-fall') ? materialInputs() : undefined,
      );
      expect(cooked.ok, cooked.ok ? undefined : cooked.error.hint).toBe(true);
      if (cooked.ok && packPath.includes('cinder-fall')) {
        expect(
          cooked.value.artifact.program.emitters.some((emitter) =>
            /forgeax_vfx_custom\[[^\]]+\]\.heat/.test(emitter.wgsl),
          ),
        ).toBe(true);
      }
    });
  }
});
