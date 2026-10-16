import { Update, World } from '@forgeax/engine/ecs';
import { CheckList, defineFeature, type FeatureCheck } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Draw source routing (multi-World)',
  catalog: 'Draw source routing',
  kind: 'visual',
  summary:
    'setDrawSource(() => ({ worlds: [app.world, overlay], cameraOwner: 0, resourceOwner: 0 })) makes the one frame loop update and draw a second World seen through the primary camera.',
  expect:
    'ON: a green sphere from the overlay World appears beside the red cube. OFF: setDrawSource(undefined) restores the single-World path and only the red cube remains.',
  setup({ app, world, frames }) {
    spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.9, 0.15, 0.15, 1] }), {
      pos: [-1, 0.5, 0],
    });
    const overlay = new World();
    spawnMesh(overlay, MESH.sphere, standard(overlay, { baseColor: [0.1, 0.9, 0.2, 1] }), {
      pos: [1.2, 0.8, 0],
      scale: [1.4, 1.4, 1.4],
    });
    let overlayUpdates = 0;
    let primaryUpdates = 0;
    overlay.addSystem(Update, {
      name: 'fl-overlay-count',
      queries: [],
      fn: () => {
        overlayUpdates += 1;
      },
    });
    world.addSystem(Update, {
      name: 'fl-primary-count',
      queries: [],
      fn: () => {
        primaryUpdates += 1;
      },
    });
    const route = () =>
      app.setDrawSource(() => ({ worlds: [app.world, overlay], cameraOwner: 0, resourceOwner: 0 }));
    route();
    let memo: Promise<readonly FeatureCheck[]> | undefined;
    return {
      toggle(on) {
        if (on) route();
        else app.setDrawSource(undefined);
      },
      checks() {
        memo ??= (async () => {
          const c = new CheckList();
          route();
          let submitted = 0;
          const off = app.renderer.subscribe((e) => {
            if (e.kind === 'frame-submitted') submitted += 1;
          });
          const o0 = overlayUpdates;
          const p0 = primaryUpdates;
          await frames(8);
          const dOverlay = overlayUpdates - o0;
          const dPrimary = primaryUpdates - p0;
          c.ok('overlay World updated by the same loop', dOverlay > 3, `overlay=${dOverlay}`);
          c.ok(
            'one update per frame (no second loop)',
            Math.abs(dOverlay - dPrimary) <= 1,
            `overlay=${dOverlay} primary=${dPrimary}`,
          );
          c.ok(
            'frames per update stay 1:1',
            Math.abs(submitted - dPrimary) <= 1,
            `frames=${submitted} primary=${dPrimary}`,
          );
          app.setDrawSource(undefined);
          await frames(2);
          const o1 = overlayUpdates;
          const p1 = primaryUpdates;
          await frames(4);
          c.equal('undefined restores single-World path', overlayUpdates, o1);
          c.ok('primary keeps updating', primaryUpdates > p1, `primary +${primaryUpdates - p1}`);
          route();
          off();
          c.equal('no dispatch error', app.lastError?.code ?? null, null);
          return c.items;
        })();
        return memo;
      },
    };
  },
});
