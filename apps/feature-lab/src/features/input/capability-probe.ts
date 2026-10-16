import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { privateBackend } from './support/private-backend';

export default defineFeature({
  title: 'Input capability probe',
  catalog: 'Input capability probe',
  kind: 'probe',
  summary:
    'Capabilities { gamepad, pointer } are detected once at attach time from API presence, never from a user gesture outcome, and ride every snapshot unchanged.',
  expect:
    'All checks pass: the live App snapshot reports pointer=true and a stable capability object; injected navigators toggle gamepad without any gamepad being connected.',
  async setup({ world, frames }) {
    spawnStage(world);
    await frames(2);
    return {
      async checks() {
        const c = new CheckList();
        const first = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY).capabilities;
        await frames(3);
        const later = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY).capabilities;
        c.equal('live pointer capability', first.pointer, typeof PointerEvent !== 'undefined');
        c.equal(
          'live gamepad capability = API presence',
          first.gamepad,
          typeof navigator.getGamepads === 'function',
        );
        c.equal('capabilities stable across frames', later, first);
        const withPad = privateBackend({ navigator: { getGamepads: () => [] } });
        const s = withPad.step();
        c.ok(
          'getGamepads present -> gamepad true with zero pads',
          s.capabilities.gamepad && !s.gamepad(0).connected,
        );
        withPad.dispose();
        const without = privateBackend({ navigator: {} });
        c.equal('no getGamepads -> gamepad false', without.step().capabilities.gamepad, false);
        without.dispose();
        return c.items;
      },
    };
  },
});
