import { pickVertex, pickVertexOnEntity } from '@forgeax/engine/picking';
import { defineFeature } from '../../lab/feature';
import { makePickScene, VIEWPORT } from './_shared/pick-scene';

export default defineFeature({
  title: 'Vertex-level picking',
  catalog: 'Vertex-level picking',
  kind: 'headless',
  summary:
    'pickVertex / pickVertexOnEntity return the nearest mesh vertices to a screen point as VertexHit (index, world position, screen and world distance).',
  expect:
    'A click on the near box top-right front corner resolves to world (0.5,0.5,1.5); limit returns a screen-distance-sorted list; entity scoping only returns that entity.',
  run(checks) {
    const scene = makePickScene();
    const cornerX = VIEWPORT / 2 + (0.47 / (3.5 * Math.tan(Math.PI / 8))) * (VIEWPORT / 2);
    const cornerY = VIEWPORT / 2 - (0.47 / (3.5 * Math.tan(Math.PI / 8))) * (VIEWPORT / 2);
    const hit = pickVertex(scene.world, scene.camera, cornerX, cornerY, VIEWPORT, VIEWPORT);
    const pos =
      hit === undefined
        ? []
        : [hit.worldPos[0], hit.worldPos[1], hit.worldPos[2]].map(
            (v) => Math.round((v ?? Number.NaN) * 100) / 100,
          );
    checks.ok(
      'nearest vertex is the front top-right corner',
      JSON.stringify(pos) === '[0.5,0.5,1.5]',
      JSON.stringify(pos),
    );
    checks.ok(
      'screen distance is a few pixels',
      hit !== undefined && hit.screenDist < 12,
      String(hit?.screenDist),
    );
    checks.ok('static mesh reports deformed=false', hit?.deformed === false);
    const list = pickVertex(scene.world, scene.camera, cornerX, cornerY, VIEWPORT, VIEWPORT, {
      limit: 4,
    });
    checks.ok('limit returns 4 hits', list.length === 4, String(list.length));
    checks.ok(
      'hits sorted by screenDist',
      list.every((h, i) => i === 0 || (list[i - 1]?.screenDist ?? 0) <= h.screenDist),
    );
    const scoped = pickVertexOnEntity(
      scene.world,
      scene.camera,
      VIEWPORT / 2 + 190,
      VIEWPORT / 2,
      VIEWPORT,
      VIEWPORT,
      scene.side,
      { limit: 3 },
    );
    checks.ok(
      'entity-scoped query only returns that entity',
      scoped.length > 0 && scoped.every((h) => h.entity === scene.side),
    );
  },
});
