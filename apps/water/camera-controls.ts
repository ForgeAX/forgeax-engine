import type { App } from '@forgeax/engine/app';
import { defineSystem, Time, Update } from '@forgeax/engine/ecs';
import {
  INPUT_SNAPSHOT_RESOURCE_KEY,
  InputFrameStartScan,
  type InputSnapshot,
} from '@forgeax/engine/input';

export interface CameraPose {
  readonly eye: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

const NAVIGATION_CODES = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowLeft',
  'ArrowDown',
  'ArrowRight',
  'KeyE',
  'KeyQ',
  'Space',
  'PageUp',
  'PageDown',
  'ShiftLeft',
  'ShiftRight',
];

/** A single frame-scanned navigation owner; scene presets remain the pose authority. */
export function createWaterCameraControls(input: {
  readonly app: App;
  readonly canvas: HTMLCanvasElement;
  readonly readPose: () => CameraPose;
  readonly writePose: (pose: CameraPose) => void;
  readonly speedMps?: number;
  readonly enabled?: boolean | (() => boolean);
  readonly onNavigate?: () => void;
}) {
  const { app, canvas } = input;
  const { world } = app;
  const systemName = 'waterSceneFreeCamera';
  let enabled = typeof input.enabled === 'boolean' ? input.enabled : true;
  let speedMps = input.speedMps ?? 7;
  let previousMouse: { readonly x: number; readonly y: number } | undefined;
  const releasedCodes = new Set<string>();
  const reset = () => {
    previousMouse = undefined;
    for (const code of NAVIGATION_CODES) releasedCodes.add(code);
    canvas.classList.remove('looking');
    app.input?.clear?.();
  };
  app.pluginContext.effect(() => {
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button === 0 || event.button === 2) canvas.focus({ preventScroll: true });
      },
      options,
    );
    canvas.addEventListener('contextmenu', (event) => event.preventDefault(), options);
    canvas.addEventListener(
      'keydown',
      (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.code === 'Escape') canvas.blur();
        if (NAVIGATION_CODES.includes(event.code)) event.preventDefault();
      },
      options,
    );
    canvas.addEventListener(
      'wheel',
      (event) => {
        if (document.activeElement === canvas && !event.ctrlKey && !event.metaKey && !event.altKey)
          event.preventDefault();
      },
      { ...options, passive: false },
    );
    canvas.addEventListener('blur', reset, options);
    window.addEventListener('blur', reset, options);
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState !== 'visible') reset();
      },
      options,
    );
    const navigationSystem = defineSystem({
      name: systemName,
      after: [InputFrameStartScan],
      queries: [],
      fn: () => {
        const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        const keyboard = snapshot.keyboard;
        for (const code of releasedCodes) if (!keyboard.downCode(code)) releasedCodes.delete(code);
        const navigationActive = () => {
          const active =
            enabled &&
            (typeof input.enabled !== 'function' || input.enabled()) &&
            document.activeElement === canvas &&
            document.hasFocus() &&
            document.visibilityState === 'visible' &&
            !keyboard.down('Control') &&
            !keyboard.down('Meta') &&
            !keyboard.down('Alt');
          return active;
        };
        const active = navigationActive();
        if (!active) {
          previousMouse = undefined;
          canvas.classList.remove('looking');
          return;
        }
        const down = (...codes: string[]) =>
          codes.some((code) => !releasedCodes.has(code) && keyboard.downCode(code));
        const looking = snapshot.mouse.button(0) || snapshot.mouse.button(2);
        canvas.classList.toggle('looking', looking);
        const mouse = snapshot.mouse.position;
        let dx = 0;
        let dy = 0;
        if (
          looking &&
          mouse &&
          previousMouse &&
          !snapshot.mouse.justPressed(0) &&
          !snapshot.mouse.justPressed(2)
        ) {
          dx = ((mouse.x - previousMouse.x) * canvas.clientWidth) / Math.max(1, canvas.width);
          dy = ((mouse.y - previousMouse.y) * canvas.clientHeight) / Math.max(1, canvas.height);
        }
        previousMouse = mouse;
        if (snapshot.mouse.wheelDelta !== 0)
          speedMps = Math.max(0.5, Math.min(500, speedMps * 1.2 ** -snapshot.mouse.wheelDelta));
        const moveX = Number(down('KeyD', 'ArrowRight')) - Number(down('KeyA', 'ArrowLeft'));
        const moveY = Number(down('KeyE', 'Space', 'PageUp')) - Number(down('KeyQ', 'PageDown'));
        const moveZ = Number(down('KeyW', 'ArrowUp')) - Number(down('KeyS', 'ArrowDown'));
        if (!dx && !dy && !moveX && !moveY && !moveZ) return;
        const applyNavigationPose = () => {
          const pose = input.readPose();
          const direction = [
            pose.target[0] - pose.eye[0],
            pose.target[1] - pose.eye[1],
            pose.target[2] - pose.eye[2],
          ];
          const distance = Math.max(0.01, Math.hypot(...direction));
          const yaw = Math.atan2(direction[0] ?? 0, direction[2] ?? 0) - dx * 0.004;
          const pitch = Math.max(
            -1.5,
            Math.min(
              1.5,
              Math.asin(Math.max(-1, Math.min(1, (direction[1] ?? 0) / distance))) - dy * 0.004,
            ),
          );
          const forward = [
            Math.sin(yaw) * Math.cos(pitch),
            Math.sin(pitch),
            Math.cos(yaw) * Math.cos(pitch),
          ];
          const movement = [
            (forward[0] ?? 0) * moveZ - Math.cos(yaw) * moveX,
            (forward[1] ?? 0) * moveZ + moveY,
            (forward[2] ?? 0) * moveZ + Math.sin(yaw) * moveX,
          ];
          const length = Math.hypot(...movement);
          const step =
            (world.getResource(Time).delta * speedMps * (down('ShiftLeft', 'ShiftRight') ? 3 : 1)) /
            Math.max(1, length);
          const eye: [number, number, number] = [
            pose.eye[0] + (movement[0] ?? 0) * step,
            pose.eye[1] + (movement[1] ?? 0) * step,
            pose.eye[2] + (movement[2] ?? 0) * step,
          ];
          input.onNavigate?.();
          input.writePose({
            eye,
            target: [
              eye[0] + (forward[0] ?? 0) * distance,
              eye[1] + (forward[1] ?? 0) * distance,
              eye[2] + (forward[2] ?? 0) * distance,
            ],
          });
        };
        applyNavigationPose();
      },
    });
    world.addSystem(Update, navigationSystem).unwrap();
    return () => {
      listeners.abort();
      reset();
      world.removeSystem(Update, navigationSystem).unwrap();
    };
  });
  return {
    get enabled() {
      return enabled && (typeof input.enabled !== 'function' || input.enabled());
    },
    get speedMps() {
      return speedMps;
    },
    setEnabled(value: boolean) {
      enabled = value;
      reset();
    },
    reset,
  };
}
