import { Update } from '@forgeax/engine/ecs';
import {
  type ActionConfig,
  deriveActionStates,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputBackendSample,
  type InputSnapshot,
  snapshotFromSample,
} from '@forgeax/engine/input';
import { CheckList, defineFeature, type FeatureCheck } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { privateBackend } from './support/private-backend';

const MAP: readonly ActionConfig[] = [
  {
    action: 'jump',
    bindings: [
      { type: 'key', key: ' ' },
      { type: 'gamepadButton', button: 0 },
    ],
  },
  { action: 'fire', bindings: [{ type: 'mouseButton', button: 0 }] },
  { action: 'left', bindings: [{ type: 'key', key: 'a' }] },
  { action: 'right', bindings: [{ type: 'key', key: 'd' }] },
  { action: 'up', bindings: [{ type: 'key', key: 'w' }] },
  { action: 'down', bindings: [{ type: 'key', key: 's' }] },
];

export default defineFeature({
  title: 'Action mapping (InputMap -> action / axis / vector)',
  catalog: 'Action mapping',
  kind: 'probe',
  summary:
    'appOptions.inputMap binds semantic actions to keys, mouse buttons and gamepad inputs; systems read snapshot.action(name), getAxis and getVector instead of devices.',
  expect:
    'All checks pass: a window Space press drives the live jump action edges, mouse fire works, getAxis/getVector compose opposing keys with unit-length diagonals, unknown actions read empty.',
  appOptions: { inputMap: MAP },
  setup({ world, frames }) {
    spawnStage(world);
    const seen: { pressed: boolean; just: boolean; released: boolean }[] = [];
    world.addSystem(Update, {
      name: 'fl-action-read',
      queries: [],
      fn: (world) => {
        const jump = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY).action('jump');
        seen.push({
          pressed: jump.isPressed(),
          just: jump.justPressed(),
          released: jump.justReleased(),
        });
      },
    });
    let memo: Promise<readonly FeatureCheck[]> | undefined;
    return {
      checks() {
        memo ??= (async () => {
          const c = new CheckList();
          await frames(2);
          seen.length = 0;
          window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
          await frames(3);
          window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space' }));
          await frames(3);
          c.ok(
            'live: jump pressed while Space held',
            seen.some((s) => s.pressed),
          );
          c.equal('live: exactly one justPressed frame', seen.filter((s) => s.just).length, 1);
          c.ok('live: released after keyup', !(seen[seen.length - 1]?.pressed ?? true));
          const b = privateBackend();
          b.pointer('pointerdown', { button: 0, buttons: 1, x: 10, y: 10 });
          c.ok('mouseButton binding -> fire', b.step(MAP).action('fire').justPressed());
          b.pointer('pointerup', { button: 0, buttons: 0, x: 10, y: 10 });
          c.ok('fire justReleased', b.step(MAP).action('fire').justReleased());
          b.key('keydown', 'd', 'KeyD');
          let s = b.step(MAP);
          c.equal('getAxis(left,right) = 1', s.getAxis('left', 'right'), 1);
          b.key('keydown', 'a', 'KeyA');
          s = b.step(MAP);
          c.equal('opposing keys cancel', s.getAxis('left', 'right'), 0);
          b.key('keyup', 'a', 'KeyA');
          b.key('keydown', 'w', 'KeyW');
          s = b.step(MAP);
          const v = s.getVector('left', 'right', 'down', 'up');
          c.near('diagonal vector is unit length', Math.hypot(v.x, v.y), 1, 1e-4);
          c.ok('vector points right+up', v.x > 0 && v.y > 0, `(${v.x}, ${v.y})`);
          c.equal('strength of digital action', s.action('right').strength, 1);
          c.ok(
            'unknown action is empty, no throw',
            !s.action('nope').isPressed() && s.action('nope').strength === 0,
          );
          b.dispose();
          const sample = { ...privateBackend().backend.sample() } as InputBackendSample;
          const states = deriveActionStates(sample, MAP);
          c.equal(
            'deriveActionStates covers every action',
            states.map((a) => a.action),
            MAP.map((a) => a.action),
          );
          c.ok(
            'snapshotFromSample without map: action empty',
            !snapshotFromSample(sample).action('jump').isPressed(),
          );
          return c.items;
        })();
        return memo;
      },
    };
  },
});
