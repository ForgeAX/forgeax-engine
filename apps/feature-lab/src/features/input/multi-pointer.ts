import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { privateBackend } from './support/private-backend';

export default defineFeature({
  title: 'Multi-pointer (touch / pen / mouse by pointerId)',
  catalog: 'Multi-pointer input',
  kind: 'probe',
  summary:
    'Every PointerEvent is tracked by pointerId with position, pressure, type, per-frame delta and an ordered phase list, independent of the mouse cluster.',
  expect:
    'All checks pass: two touches and a pen are tracked separately, deltas are per pointer, phase events are ordered and one-frame, lifted pointers become inactive.',
  setup({ world }) {
    spawnStage(world);
    return {
      checks() {
        const c = new CheckList();
        const b = privateBackend();
        b.pointer('pointerdown', {
          pointerId: 11,
          pointerType: 'touch',
          x: 20,
          y: 20,
          pressure: 0.3,
        });
        b.pointer('pointerdown', {
          pointerId: 12,
          pointerType: 'touch',
          x: 120,
          y: 60,
          pressure: 0.8,
        });
        b.pointer('pointerdown', {
          pointerId: 13,
          pointerType: 'pen',
          x: 60,
          y: 40,
          pressure: 0.5,
        });
        let s = b.step();
        const p11 = s.pointer(11);
        const p12 = s.pointer(12);
        c.ok('touch 11 active', p11.active && p11.pointerType === 'touch');
        c.equal('touch 11 position', [p11.x, p11.y], [20, 20]);
        c.near('touch 12 pressure', p12.pressure, 0.8, 1e-6);
        c.equal('pen 13 type', s.pointer(13).pointerType, 'pen');
        c.equal(
          'three down phases in order',
          s.pointerEvents.map((e) => `${e.pointerId}:${e.phase}`),
          ['11:down', '12:down', '13:down'],
        );
        c.ok('touch does not press mouse buttons', !s.mouse.button(0));
        b.pointer('pointermove', { pointerId: 11, pointerType: 'touch', x: 30, y: 25 });
        s = b.step();
        c.equal('delta per pointer (11)', s.pointer(11).delta, { x: 10, y: 5 });
        c.equal('unmoved pointer delta 0 (12)', s.pointer(12).delta, { x: 0, y: 0 });
        c.equal(
          'move phase only',
          s.pointerEvents.map((e) => e.phase),
          ['move'],
        );
        b.pointer('pointerup', { pointerId: 11, pointerType: 'touch', x: 30, y: 25 });
        b.pointer('pointercancel', { pointerId: 13, pointerType: 'pen', x: 60, y: 40 });
        s = b.step();
        c.ok('lifted pointer inactive', !s.pointer(11).active);
        c.ok('cancelled pointer inactive', !s.pointer(13).active);
        c.ok('remaining pointer active', s.pointer(12).active);
        c.equal(
          'up + cancel phases',
          s.pointerEvents.map((e) => e.phase),
          ['up', 'cancel'],
        );
        c.equal('phases are one-frame', b.step().pointerEvents.length, 0);
        c.ok('unknown pointer inactive', !s.pointer(999).active);
        b.dispose();
        return c.items;
      },
    };
  },
});
