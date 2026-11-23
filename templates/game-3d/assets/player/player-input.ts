import type { InputSnapshot } from '@forgeax/engine/input';
import { PLAYER_CONTROL_CHANNEL, type PlayerInput } from '../shared/player-protocol.ts';

const bounded = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
const stick = (value: number) => Math.sign(value) * Math.max(0, (Math.abs(value) - 0.18) / 0.82);

// The single local player uses the first connected standard controller.
function firstGamepad(input: InputSnapshot) {
  let pad = input.gamepad(0);
  for (let slot = 1; !pad.standardMapping && slot < 4; slot++) pad = input.gamepad(slot);
  return pad;
}

/** UI owns touch gestures; the existing World Update samples bounded semantic intent. */
export function createPlayerInput() {
  let horizontal = 0, vertical = 0, lookX = 0, lookY = 0;
  let run = false, jumpQueued = false, jumpPending = false;
  let transformQueued = false, transformPending = false;
  let previousWidth = 0, previousHeight = 0;
  const reset = () => {
    horizontal = vertical = lookX = lookY = 0;
    run = jumpQueued = jumpPending = transformQueued = transformPending = false;
  };
  return {
    reset,
    receive(value: unknown): void {
      if (!value || typeof value !== 'object' || !('channel' in value) || value.channel !== PLAYER_CONTROL_CHANNEL) return;
      const message = value as Record<string, unknown>;
      switch (message.kind) {
        case 'move': {
          if (typeof message.horizontal !== 'number' || typeof message.vertical !== 'number' ||
            !Number.isFinite(message.horizontal) || !Number.isFinite(message.vertical)) return;
          const length = Math.max(1, Math.hypot(message.horizontal, message.vertical));
          horizontal = message.horizontal / length;
          vertical = message.vertical / length;
          break;
        }
        case 'look':
          if (typeof message.x !== 'number' || typeof message.y !== 'number' ||
            !Number.isFinite(message.x) || !Number.isFinite(message.y)) return;
          lookX = bounded(lookX + bounded(message.x, 250), 250);
          lookY = bounded(lookY + bounded(message.y, 250), 250);
          break;
        case 'jump': jumpQueued = true; break;
        case 'transform': transformQueued = true; break;
        case 'run': if (typeof message.held === 'boolean') run = message.held; break;
        case 'reset': reset(); break;
      }
    },
    sample(input: InputSnapshot, width: number, height: number, deltaSeconds = 0): PlayerInput {
      if (previousWidth > 0 && (width !== previousWidth || height !== previousHeight)) reset();
      previousWidth = width;
      previousHeight = height;
      const pad = firstGamepad(input);
      jumpPending ||= jumpQueued || input.keyboard.justPressedCode('Space') || pad.justPressed(0);
      jumpQueued = false;
      transformPending ||= transformQueued || input.keyboard.justPressedCode('KeyT') || pad.justPressed(3);
      transformQueued = false;
      const mouseLook = input.mouse.pointerLocked || input.mouse.button(2);
      const result = {
        horizontal: horizontal + stick(pad.axis(0)) + Number(input.keyboard.downCode('KeyD') || input.keyboard.downCode('ArrowRight')) -
          Number(input.keyboard.downCode('KeyA') || input.keyboard.downCode('ArrowLeft')),
        vertical: vertical - stick(pad.axis(1)) + Number(input.keyboard.downCode('KeyW') || input.keyboard.downCode('ArrowUp')) -
          Number(input.keyboard.downCode('KeyS') || input.keyboard.downCode('ArrowDown')),
        lookX: lookX + (mouseLook ? input.mouse.movementDelta.x : 0) + stick(pad.axis(2)) * deltaSeconds * 560,
        lookY: lookY + (mouseLook ? input.mouse.movementDelta.y : 0) + stick(pad.axis(3)) * deltaSeconds * 560,
        run: run || input.keyboard.downCode('ShiftLeft') || input.keyboard.downCode('ShiftRight') || pad.button(10),
      };
      lookX = lookY = 0;
      return result;
    },
    takeTransform(): boolean {
      const value = transformPending; transformPending = false; return value;
    },
    takeJump(): boolean {
      const jump = jumpPending;
      jumpPending = false;
      return jump;
    },
  };
}
