import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { booleanSolids } from '../../../src/brep/boolean.ts';
import { cylinder } from '../../../src/brep/build.ts';
import { measure } from '../../../src/brep/measure.ts';
import { quadrangulate } from '../../../src/brep/quad.ts';
import { sweep } from '../../../src/brep/sweep.ts';
import { tessellate } from '../../../src/brep/tessellate.ts';
import { transformShape } from '../../../src/brep/transform.ts';
import { validate } from '../../../src/brep/validate.ts';
import { meshVolume } from '../../../src/geom.ts';
import { asPolyMesh } from '../../brep-kit/mesh-scene.ts';
import { renderShape } from '../../brep-kit/render.ts';
import { vizOutputDir } from '../../test-output.ts';

const vizDir = vizOutputDir('nurbs-boolean-s4');

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const sq = [
  [-0.25, -0.25],
  [0.25, -0.25],
  [0.25, 0.25],
  [-0.25, 0.25],
] as const;
const frame = {
  o: [0, 0, 0] as [number, number, number],
  x: [1, 0, 0] as [number, number, number],
  y: [0, 1, 0] as [number, number, number],
  z: [0, 0, 1] as [number, number, number],
};
const identity = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const;
const ANALYTIC_UNION = Math.PI / 2 + 0.02262;

it('measures the S4 NURBS wall with a transverse cylinder hole and renders what tessellates', {
  timeout: 240000,
}, () => {
  mkdirSync(vizDir, { recursive: true });
  const stub = must(
    sweep({
      profile: sq,
      path: { kind: 'circle', frame, radius: 4 },
      xHint: [0, 0, 1],
      stations: 17,
      range: [0, Math.PI / 2],
    } as never),
  );
  const rod = must(
    transformShape(must(cylinder({ radius: 0.12, height: 1 } as never)), {
      rot: identity as never,
      t: [3.2, 2.4, 0],
    }),
  );
  const union = must(booleanSolids(stub, rod, 'union'));
  const valid = validate(union).ok;
  const volume = must(measure(union)).volume;

  // Trimmed NURBS walls with holes tessellate; the union is rendered and gated on its own mesh.
  const tessellation = { angle: Math.PI / 32, chord: 0.05 };
  const rodRender = renderShape(rod, {
    modes: ['shaded', 'features'],
    views: ['iso', 'front', 'top'],
    outDir: vizDir,
    name: 's4-rod-',
  });
  const unionRender = renderShape(union, {
    modes: ['shaded', 'features'],
    views: ['iso', 'front', 'top'],
    outDir: vizDir,
    name: 's4-union-',
    tessellation,
  });
  const quad = quadrangulate(union, { size: 0.2 });
  const quadRender = quad.ok
    ? renderShape(asPolyMesh(quad.value.mesh), {
        modes: ['shaded', 'features'],
        views: ['iso'],
        outDir: vizDir,
        name: 's4-quad-',
      })
    : undefined;
  const meshed = tessellate(union, tessellation);
  const meshVolumeValue = meshed.ok ? meshVolume(meshed.value) : Number.NaN;
  const openEdges = meshed.ok
    ? meshed.value.edges().filter((e) => meshed.value.isBoundaryEdge(e)).length
    : -1;

  if (!unionRender.ok) throw new Error(JSON.stringify(unionRender.error));
  if (!meshed.ok) throw new Error(JSON.stringify(meshed.error));
  expect(openEdges).toBe(0);
  expect(Math.abs(meshVolumeValue - volume) / volume).toBeLessThan(0.01);

  const summary = {
    case: 'nurbs-boolean-s4: NURBS sweep stub union transverse cylinder rod',
    op: 'union',
    valid,
    volume,
    analyticVolume: ANALYTIC_UNION,
    volumeError: Math.abs(volume - ANALYTIC_UNION),
    meshVolume: meshVolumeValue,
    meshVolumeRelError: Math.abs(meshVolumeValue - volume) / volume,
    meshOpenEdges: openEdges,
    tessellation,
    rodRender: rodRender.ok ? 'ok' : rodRender.error,
    unionRender: 'ok',
    quadRoute: quad.ok ? 'ok' : quad.error,
    quadRender: quadRender === undefined ? 'skipped' : quadRender.ok ? 'ok' : quadRender.error,
    label: 'labelled preview: union tessellated at chord 0.05; quad route recorded above',
  };
  writeFileSync(`${vizDir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
});
