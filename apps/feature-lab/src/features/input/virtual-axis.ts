import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { privateBackend } from './support/private-backend';

export default defineFeature({
  title: 'Virtual joystick / virtual axis',
  catalog: 'Virtual axis/joystick',
  kind: 'probe',
  summary:
    'virtualJoysticks configs bind the first pointerdown inside their region and publish a clamped, deadzoned vector via snapshot.virtualAxis(name), separate from actions.',
  expect:
    'All checks pass: floating stick reads (1,0) at full radius and clamps beyond it, fixed stick uses its anchor, deadzone zeroes small moves, release returns (0,0), unknown names read (0,0).',
  setup({ world }) {
    spawnStage(world);
    return {
      checks() {
        const c = new CheckList();
        const b = privateBackend({
          virtualJoysticks: [
            {
              name: 'move',
              mode: 'floating',
              region: { x: 0, y: 0, width: 100, height: 100 },
              radius: 40,
              deadzone: 0.1,
            },
            {
              name: 'aim',
              mode: 'fixed',
              region: { x: 100, y: 0, width: 100, height: 100 },
              anchor: { x: 150, y: 50 },
              radius: 40,
              deadzone: 0.1,
            },
          ],
        });
        const touch = (type: string, pointerId: number, x: number, y: number) =>
          b.pointer(type, { pointerId, pointerType: 'touch', x, y });
        c.equal('unbound stick reads zero', b.step().virtualAxis('move'), { x: 0, y: 0 });
        touch('pointerdown', 21, 50, 50);
        c.equal('floating origin at touch point', b.step().virtualAxis('move'), { x: 0, y: 0 });
        touch('pointermove', 21, 90, 50);
        let s = b.step();
        c.near('full radius x = 1', s.virtualAxis('move').x, 1);
        touch('pointermove', 21, 50, 150);
        s = b.step();
        c.near(
          'beyond radius clamps to unit',
          Math.hypot(s.virtualAxis('move').x, s.virtualAxis('move').y),
          1,
        );
        touch('pointermove', 21, 52, 50);
        c.equal('deadzone zeroes small moves', b.step().virtualAxis('move'), { x: 0, y: 0 });
        touch('pointerdown', 22, 170, 50);
        s = b.step();
        c.near('fixed stick uses anchor (x=0.5)', s.virtualAxis('aim').x, 0.5);
        c.near('second stick independent', s.virtualAxis('move').x, 0);
        touch('pointerup', 21, 52, 50);
        touch('pointerup', 22, 170, 50);
        s = b.step();
        c.equal(
          'release returns zero',
          [s.virtualAxis('move'), s.virtualAxis('aim')],
          [
            { x: 0, y: 0 },
            { x: 0, y: 0 },
          ],
        );
        c.equal('unknown axis reads zero', s.virtualAxis('nope'), { x: 0, y: 0 });
        c.ok('virtual axis is not an action', !s.action('move').isPressed());
        b.dispose();
        return c.items;
      },
    };
  },
});
