import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { booleanSolids } from '../../../src/brep/boolean.ts';
import { box } from '../../../src/brep/build.ts';
import { curvePoint } from '../../../src/brep/curves.ts';
import { intersectSurfaces } from '../../../src/brep/intersect.ts';
import { measure } from '../../../src/brep/measure.ts';
import { sweep } from '../../../src/brep/sweep.ts';
import { tessellate } from '../../../src/brep/tessellate.ts';
import { transformShape } from '../../../src/brep/transform.ts';
import { renderScene, type Scene, type SceneMarker, toPng } from '../../brep-kit/index.ts';
import { asPolyMesh, meshSurface } from '../../brep-kit/mesh-scene.ts';
import { renderShape } from '../../brep-kit/render.ts';
import { gitProvenance, vizOutputDir } from '../../test-output.ts';

const vizDir = vizOutputDir('nurbs-boolean-s2');

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

// Same stub and plate as src/brep/__tests__/nurbs-boolean-union.unit.test.ts (the S2 case).
const sq = (h: number) =>
  [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
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

const PLATE_VOLUME = 1 * 0.3 * 0.2;
const overlapArea = (() => {
  const anti = (r2: number, y: number) =>
    (y / 2) * Math.sqrt(r2 - y * y) + (r2 / 2) * Math.asin(y / Math.sqrt(r2));
  return (
    anti(4.25 ** 2, 0.5) - anti(3.75 ** 2, 0.5) - (anti(4.25 ** 2, 0.2) - anti(3.75 ** 2, 0.2))
  );
})();
const ANALYTIC_UNION = Math.PI / 2 + PLATE_VOLUME - 0.2 * overlapArea;

const ORANGE: [number, number, number] = [255, 140, 40];

it('renders the S2 sweep stub union plate with SSI chain end markers', { timeout: 240000 }, () => {
  mkdirSync(vizDir, { recursive: true });
  const stub = must(
    sweep({
      profile: sq(0.25),
      path: { kind: 'circle', frame, radius: 4 },
      xHint: [0, 0, 1],
      stations: 17,
      range: [0, Math.PI / 2],
    }),
  );
  const plate = must(
    transformShape(must(box({ size: [1, 0.3, 0.2] })), { rot: identity as never, t: [4, 0.35, 0] }),
  );
  const union = must(booleanSolids(stub, plate, 'union'));
  const volume = must(measure(union)).volume;

  const markers: SceneMarker[] = [];
  const branchCounts: Record<string, number> = {};
  stub.faces.forEach((f, i) => {
    const s = stub.surfaces[f.surface];
    if (s?.kind !== 'nurbs') return;
    plate.faces.forEach((pf, j) => {
      const ps = plate.surfaces[pf.surface];
      if (ps?.kind !== 'plane') return;
      const r = intersectSurfaces(s, ps, 1e-7, { window: { c: [4, 0.35, 0], r: 6 } });
      if (!r.ok) return;
      branchCounts[`wall${i}-plate${j}`] = r.value.branches.length;
      for (const b of r.value.branches) {
        for (const t of [b.t0, b.t1]) {
          markers.push({
            p: [...curvePoint(b.curve, t)] as [number, number, number],
            color: ORANGE,
            radius: 5,
          });
        }
      }
    });
  });

  renderShape(union, {
    modes: ['shaded', 'features', 'iso'],
    views: ['iso', 'front', 'top'],
    outDir: vizDir,
    name: 's2-union-',
  });
  // SSI chain end markers over the shaded union: same tessellated triangles as the shaded render.
  const mesh = tessellate(union, { angle: Math.PI / 32 });
  if (!mesh.ok) throw new Error(JSON.stringify(mesh.error));
  const tris = meshSurface(asPolyMesh(mesh.value), { color: [170, 170, 170] });
  const overlay: Scene = { tris, lines: [], markers };
  writeFileSync(`${vizDir}/s2-ssi-ends-iso.png`, toPng(renderScene(overlay, 'iso', { size: 640 })));

  const summary = {
    case: 'nurbs-boolean-s2: NURBS sweep stub union plate',
    op: 'union',
    volume,
    analyticVolume: ANALYTIC_UNION,
    volumeError: Math.abs(volume - ANALYTIC_UNION),
    volumeTolerance: 1e-3,
    volumeGatePass: Math.abs(volume - ANALYTIC_UNION) < 1e-3,
    ssiBranchesPerPair: branchCounts,
    ssiEndMarkers: markers.length,
  };
  writeFileSync(`${vizDir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  const { head, tree } = gitProvenance();
  writeFileSync(
    `${vizDir}/provenance.txt`,
    [
      'case: nurbs-boolean-s2 (sweep stub union plate, S2 bare union)',
      `commit: ${head}`,
      `tree_clean: ${tree === 'clean' ? 'yes' : tree}`,
      'command: node_modules/.bin/vitest run examples/ssi-nurbs-quadrics/__tests__/nurbs-boolean-s2.render.test.ts',
      'images: s2-union-{shaded,features,iso}-{iso,front,top}.png, s2-ssi-ends-iso.png (orange = SSI branch ends)',
      `volume: ${volume}`,
      `analytic: ${ANALYTIC_UNION}`,
      '',
    ].join('\n'),
  );
});
