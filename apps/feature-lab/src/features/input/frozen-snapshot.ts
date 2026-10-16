import { Update } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { CheckList, defineFeature, type FeatureCheck } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';

interface Frame {
  readonly aSnap: InputSnapshot;
  readonly bSnap: InputSnapshot;
  readonly bSaw: boolean;
}

export default defineFeature({
  title: 'Frozen per-frame InputSnapshot',
  catalog: 'Frozen InputSnapshot',
  kind: 'probe',
  summary:
    'The live App scans input once at frame start into the InputSnapshot resource. A keydown dispatched on window from inside system A is not visible to system B in the same frame; it appears on the next frame.',
  expect:
    'All checks pass: both systems read the same snapshot object, the mid-frame key is invisible until the next frame, and each frame gets a fresh snapshot.',
  setup({ world, frames }) {
    spawnStage(world);
    const log: Frame[] = [];
    let inject = false;
    let aSnap: InputSnapshot | undefined;
    world.addSystem(Update, {
      name: 'fl-frozen-a',
      queries: [],
      fn: (world) => {
        aSnap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        if (inject) {
          inject = false;
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ' }));
        }
      },
    });
    world.addSystem(Update, {
      name: 'fl-frozen-b',
      queries: [],
      after: ['fl-frozen-a'],
      fn: (world) => {
        const bSnap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        if (aSnap !== undefined) log.push({ aSnap, bSnap, bSaw: bSnap.keyboard.down('q') });
      },
    });
    let memo: Promise<readonly FeatureCheck[]> | undefined;
    return {
      checks() {
        memo ??= (async () => {
          const c = new CheckList();
          await frames(2);
          log.length = 0;
          inject = true;
          await frames(4);
          window.dispatchEvent(new KeyboardEvent('keyup', { key: 'q', code: 'KeyQ' }));
          const first = log[0];
          const second = log[1];
          c.ok(
            'frames recorded',
            first !== undefined && second !== undefined,
            `frames=${log.length}`,
          );
          if (first !== undefined && second !== undefined) {
            c.ok('A and B share one snapshot object per frame', first.aSnap === first.bSnap);
            c.ok('mid-frame keydown invisible to later system', !first.bSaw);
            c.ok('key visible on the next frame', second.bSaw);
            c.ok('next frame is a fresh snapshot', second.bSnap !== first.bSnap);
            c.ok('justPressed on the next frame', second.bSnap.keyboard.justPressed('q'));
            c.ok('old snapshot stays frozen', !first.bSnap.keyboard.down('q'));
          }
          return c.items;
        })();
        return memo;
      },
    };
  },
});
