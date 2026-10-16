import type { EntityHandle, World } from '@forgeax/engine/ecs';
import {
  admitPointsLines,
  Lines,
  Materials,
  MeshFilter,
  MeshRenderer,
  Points,
} from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import type { MeshAsset } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnOrthoCamera, VIEW_HALF_WIDTH } from './_shared/sprite';

type Topology = 'line-strip' | 'line-list' | 'point-list' | 'triangle-list';

function mesh(positions: readonly number[], topology: Topology): MeshAsset {
  const vertices = new Float32Array(positions);
  return {
    kind: 'mesh',
    vertices,
    attributes: { position: vertices },
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 0,
        vertexCount: positions.length / 3,
        topology,
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'default' }],
  } as MeshAsset;
}

function zigzag(y: number, amplitude: number): number[] {
  const out: number[] = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const x = -VIEW_HALF_WIDTH + 0.3 + ((2 * VIEW_HALF_WIDTH - 0.6) * i) / steps;
    out.push(x, y + (i % 2 === 0 ? amplitude : -amplitude), 0);
  }
  return out;
}

const DASHED = { width: 22, dashSize: 0.35, gapSize: 0.35, dashOffset: 0 } as const;
const COLORS = [
  [1, 0.15, 0.1, 1],
  [0.1, 0.9, 0.3, 1],
  [0.2, 0.5, 1, 1],
  [1, 0.85, 0.1, 1],
] as const;

function spawnPath(
  world: World,
  positions: readonly number[],
  color: (typeof COLORS)[number],
): EntityHandle {
  const material = Materials.unlit(color);
  return world
    .spawn(
      { component: Transform, data: {} },
      {
        component: MeshFilter,
        data: {
          assetHandle: world.allocSharedRef('MeshAsset', mesh(positions, 'line-strip')),
        } as never,
      },
      {
        component: MeshRenderer,
        data: { materials: [world.allocSharedRef('MaterialAsset', material)] } as never,
      },
      { component: Lines, data: DASHED },
    )
    .unwrap() as EntityHandle;
}

function admissionChecks(c: CheckList): void {
  const unlit = Materials.unlit([1, 1, 1, 1]);
  const strip = mesh(zigzag(0, 0.5), 'line-strip');
  const code = (r: ReturnType<typeof admitPointsLines>): string => (r.ok ? 'ok' : r.error.code);

  const admitted = admitPointsLines({ entity: 1, lines: DASHED, mesh: strip, material: unlit });
  c.ok('dashed strip admits', admitted.ok, code(admitted));
  if (admitted.ok) {
    c.equal('strip of 11 vertices has 10 segments', admitted.value.segmentCount, 10);
    c.equal(
      'admission keeps the dash style',
      [admitted.value.dashSize, admitted.value.gapSize],
      [0.35, 0.35],
    );
  }
  const list = admitPointsLines({
    entity: 1,
    lines: {},
    mesh: mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 'line-list'),
    material: unlit,
  });
  c.ok('paired line-list admits 2 segments', list.ok && list.value.segmentCount === 2, code(list));
  c.equal(
    'triangle topology is refused',
    code(
      admitPointsLines({
        entity: 1,
        lines: {},
        mesh: mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], 'triangle-list'),
        material: unlit,
      }),
    ),
    'points-lines-topology-mismatch',
  );
  c.equal(
    'odd line-list tail is refused',
    code(
      admitPointsLines({
        entity: 1,
        lines: {},
        mesh: mesh([0, 0, 0, 1, 0, 0, 2, 0, 0], 'line-list'),
        material: unlit,
      }),
    ),
    'points-lines-topology-mismatch',
  );
  c.equal(
    'one-vertex strip is refused',
    code(
      admitPointsLines({
        entity: 1,
        lines: {},
        mesh: mesh([0, 0, 0], 'line-strip'),
        material: unlit,
      }),
    ),
    'points-lines-topology-mismatch',
  );
  c.equal(
    'negative gapSize is refused',
    code(admitPointsLines({ entity: 1, lines: { gapSize: -1 }, mesh: strip, material: unlit })),
    'points-lines-invalid-style',
  );
  c.equal(
    'Points and Lines together are refused',
    code(admitPointsLines({ entity: 1, points: {}, lines: {}, mesh: strip, material: unlit })),
    'points-lines-invalid-style',
  );
  c.equal(
    'standard material is refused',
    code(
      admitPointsLines({
        entity: 1,
        lines: {},
        mesh: strip,
        material: Materials.standard({ baseColor: [1, 1, 1, 1] } as never),
      }),
    ),
    'points-lines-material-unsupported',
  );
  const budget = admitPointsLines({
    entity: 1,
    lines: {},
    mesh: strip,
    material: unlit,
    limits: { maxSegments: 4 },
  });
  c.equal('segment budget is enforced', code(budget), 'points-lines-budget-exceeded');
  if (!budget.ok)
    c.ok(
      'refusal carries expected and hint',
      budget.error.expected.length > 0 && budget.error.hint.length > 0,
    );
  c.ok('Points component is exported', Points !== undefined);
}

export default defineFeature({
  title: 'Continuous and dashed line paths',
  catalog: 'Continuous and dashed line paths',
  kind: 'visual',
  summary:
    'Lines on a line-strip MeshAsset draws a pixel-width path with miter joins; dashSize/gapSize/dashOffset are mesh-local units and only update the draw uniform.',
  expect:
    'ON: four zigzag paths, each 22px wide and dashed (equal dash and gap). OFF: gapSize 0, so the same paths are solid.',
  setup({ world, app, canvas }) {
    spawnOrthoCamera(world, canvas);
    const paths = COLORS.map((color, i) => spawnPath(world, zigzag(1.5 - i, 0.3), color));
    return {
      toggle(on) {
        for (const path of paths)
          world.set(path, Lines, { gapSize: on ? DASHED.gapSize : 0 }).unwrap();
      },
      checks() {
        const c = new CheckList();
        admissionChecks(c);
        const lanes = app.renderer.inspect().renderScene.pointsLines;
        c.equal('renderer inspects four Lines candidates', lanes.length, 4);
        c.ok(
          'every candidate is admitted (not refused/pending)',
          lanes.every((lane) => lane.lane !== 'refused' && lane.lane !== 'pending'),
          lanes.map((lane) => lane.lane).join(','),
        );
        return c.items;
      },
    };
  },
});
