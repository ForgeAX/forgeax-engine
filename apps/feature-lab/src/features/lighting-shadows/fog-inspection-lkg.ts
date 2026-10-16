import { Fog } from '@forgeax/engine/render';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Fog inspection/LKG',
  catalog: 'Fog inspection/LKG',
  kind: 'probe',
  summary:
    'An invalid Fog update (density = -1) is rejected at extract: the renderer keeps the last-known-good fog signature and records a structured failure in inspect().environment.lastCandidateFailure. A valid update then replaces it.',
  expect:
    'Checks: valid fog publishes a fogSignature, the invalid update keeps that exact signature and records a failure code, and a new valid density publishes a new signature.',
  async setup({ world, app, frames }) {
    spawnStage(world, { eye: [0, 1.2, 4], target: [0, 0.6, -4] });
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.1, 0.8, 0.3, 1] }), {
      pos: [0, 0.5, -3],
      scale: [1, 1, 1],
    });
    const env = () => app.renderer.inspect().environment;
    const fog = world
      .spawn({ component: Fog, data: { color: [0.8, 0.4, 0.9], density: 0.1 } as never })
      .unwrap();
    await frames(10);
    const valid = env().fogSignature;
    world.set(fog, Fog, { density: -1 } as never);
    await frames(10);
    const invalid = env();
    world.set(fog, Fog, { density: 0.2 } as never);
    await frames(10);
    const repaired = env().fogSignature;
    return {
      checks(): FeatureCheck[] {
        return [
          {
            name: 'valid fog publishes a signature',
            ok: valid !== undefined && valid !== '',
            detail: `fogSignature=${valid}`,
          },
          {
            name: 'invalid update keeps LKG signature',
            ok: invalid.fogSignature === valid,
            detail: `${valid} vs ${invalid.fogSignature}`,
          },
          {
            name: 'invalid update records a structured failure',
            ok:
              invalid.lastCandidateFailure !== undefined &&
              invalid.lastCandidateFailure.code !== '',
            detail: JSON.stringify(invalid.lastCandidateFailure),
          },
          {
            name: 'repaired fog publishes a new signature',
            ok: repaired !== undefined && repaired !== valid,
            detail: `fogSignature=${repaired}`,
          },
        ];
      },
    };
  },
});
