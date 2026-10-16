import type { GestureEvent, InputSnapshot } from '@forgeax/engine/input';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { privateBackend } from './support/private-backend';

const kinds = (s: InputSnapshot) => s.gestureEvents.map((e: GestureEvent) => e.kind);

export default defineFeature({
  title: 'Gesture recognition (pinch / rotate / swipe / long-press / double-tap)',
  catalog: 'Gesture recognition',
  kind: 'probe',
  summary:
    'Touch PointerEvents on a private canvas with an injected clock drive the recognizer; results appear as snapshot.gesture state and one-frame gestureEvents.',
  expect:
    'All checks pass: two spreading touches pinch (scale 2) and rotate, a fast drag swipes right, a held touch long-presses after 500 ms, two quick taps double-tap.',
  setup({ world }) {
    spawnStage(world);
    return {
      checks() {
        const c = new CheckList();
        const b = privateBackend();
        const touch = (type: string, pointerId: number, x: number, y: number) =>
          b.pointer(type, { pointerId, pointerType: 'touch', x, y });
        const frame = (ms: number) => {
          b.clock.now += ms;
          return b.step();
        };
        c.equal('identity gesture at rest', b.step().gesture, { pinchScale: 1, rotationAngle: 0 });
        touch('pointerdown', 1, 80, 50);
        touch('pointerdown', 2, 120, 50);
        let s = frame(16);
        c.ok(
          'pinch-begin + rotate-begin',
          kinds(s).includes('pinch-begin') && kinds(s).includes('rotate-begin'),
          kinds(s).join(','),
        );
        touch('pointermove', 1, 60, 50);
        touch('pointermove', 2, 140, 50);
        s = frame(16);
        c.near('pinchScale doubles', s.gesture.pinchScale, 2, 1e-3);
        touch('pointermove', 2, 60, 130);
        s = frame(16);
        c.ok(
          'rotationAngle changes',
          Math.abs(s.gesture.rotationAngle) > 0.5,
          `angle=${s.gesture.rotationAngle}`,
        );
        touch('pointerup', 1, 60, 50);
        touch('pointerup', 2, 60, 130);
        s = frame(16);
        c.ok('pinch-end on lift', kinds(s).includes('pinch-end'), kinds(s).join(','));
        frame(400);
        touch('pointerdown', 5, 20, 50);
        frame(20);
        touch('pointermove', 5, 60, 50);
        frame(20);
        touch('pointermove', 5, 100, 50);
        touch('pointerup', 5, 100, 50);
        s = frame(20);
        const swipe = s.gestureEvents.find((e) => e.kind === 'swipe');
        c.ok('fast drag -> swipe', swipe !== undefined, kinds(s).join(','));
        c.equal(
          'swipe direction',
          (swipe as { direction?: string } | undefined)?.direction,
          'right',
        );
        frame(400);
        touch('pointerdown', 6, 100, 50);
        s = frame(100);
        c.ok('no long-press before 500 ms', !kinds(s).includes('long-press'));
        s = frame(500);
        c.ok('long-press after 500 ms', kinds(s).includes('long-press'), kinds(s).join(','));
        touch('pointerup', 6, 100, 50);
        frame(400);
        touch('pointerdown', 7, 150, 50);
        touch('pointerup', 7, 150, 50);
        frame(80);
        touch('pointerdown', 8, 152, 51);
        touch('pointerup', 8, 152, 51);
        s = frame(16);
        c.ok('two quick taps -> double-tap', kinds(s).includes('double-tap'), kinds(s).join(','));
        c.equal('events are one-frame', frame(16).gestureEvents.length, 0);
        b.dispose();
        return c.items;
      },
    };
  },
});
