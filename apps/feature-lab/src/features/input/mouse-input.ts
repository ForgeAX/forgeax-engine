import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { privateBackend } from './support/private-backend';

export default defineFeature({
  title: 'Mouse position / delta / buttons / wheel',
  catalog: 'Mouse input',
  kind: 'probe',
  summary:
    'Synthetic mouse PointerEvents and WheelEvents on a private canvas produce canvas-pixel position, accumulated movementDelta, button edges and a quantized wheel.',
  expect:
    'All checks pass: position is in canvas pixels, movement accumulates within a frame and resets, button edges last one frame, pen/touch never press mouse buttons.',
  setup({ world }) {
    spawnStage(world);
    return {
      checks() {
        const c = new CheckList();
        const b = privateBackend();
        c.equal('no position before any event', b.step().mouse.position, undefined);
        b.pointer('pointermove', { x: 40, y: 30, movementX: 3, movementY: -2 });
        b.pointer('pointermove', { x: 50, y: 35, movementX: 4, movementY: 1 });
        let s = b.step();
        c.equal('position in canvas pixels', s.mouse.position, { x: 50, y: 35 });
        c.equal('movementDelta accumulates in frame', s.mouse.movementDelta, { x: 7, y: -1 });
        c.equal('movementDelta resets next frame', b.step().mouse.movementDelta, { x: 0, y: 0 });
        b.pointer('pointerdown', { x: 50, y: 35, button: 0, buttons: 1 });
        s = b.step();
        c.ok('button(0) down', s.mouse.button(0));
        c.ok('justPressed(0)', s.mouse.justPressed(0));
        s = b.step();
        c.ok('held without justPressed', s.mouse.button(0) && !s.mouse.justPressed(0));
        b.pointer('pointerup', { x: 50, y: 35, button: 0, buttons: 0 });
        s = b.step();
        c.ok('justReleased(0)', s.mouse.justReleased(0) && !s.mouse.button(0));
        b.pointer('pointerdown', { x: 10, y: 10, button: 2, buttons: 2 });
        c.ok('right button index 2', b.step().mouse.button(2));
        b.pointer('pointerup', { x: 10, y: 10, button: 2, buttons: 0 });
        b.step();
        b.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
        b.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 3 }));
        c.equal('wheel quantized per event (+1 +1)', b.step().mouse.wheelDelta, 2);
        b.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }));
        c.equal('wheel negative', b.step().mouse.wheelDelta, -1);
        c.equal('wheel resets', b.step().mouse.wheelDelta, 0);
        b.pointer('pointerdown', { x: 20, y: 20, button: 0, pointerType: 'pen', pointerId: 7 });
        c.ok('pen does not press mouse button', !b.step().mouse.button(0));
        b.pointer('pointerup', { x: 20, y: 20, button: 0, pointerType: 'pen', pointerId: 7 });
        b.step();
        c.equal('pointerLocked false without lock', b.step().mouse.pointerLocked, false);
        b.dispose();
        return c.items;
      },
    };
  },
});
