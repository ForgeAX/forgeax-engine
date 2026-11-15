import type { App } from '@forgeax/engine/app';
import { defineSystem, Time, Update } from '@forgeax/engine/ecs';
import { InputFrameStartScan, INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { quat, vec3 } from '@forgeax/engine/math';

export interface CameraPose {
  readonly eye: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

const SYSTEM_NAME = 'waterR3FreeCamera';
const PITCH_LIMIT = Math.PI / 2 - 0.01;
const LOOK_SENSITIVITY = 0.003;

export function createCameraControls(input: {
  readonly app: App;
  readonly canvas: HTMLCanvasElement;
  readonly readPose: () => CameraPose;
  readonly writePose: (pose: CameraPose) => void;
}) {
  const { app, canvas } = input;
  const { world } = app;
  let enabled = true;
  let pointerId: number | undefined;
  const rotation = quat.create();
  const forward = vec3.create();
  const right = vec3.create();
  const displacement = vec3.create();
  const reset = () => {
    pointerId = undefined;
    app.input?.clear?.();
  };
  app.pluginContext.effect(() => {
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }), options);
    canvas.addEventListener('contextmenu', (event) => event.preventDefault(), options);
    canvas.addEventListener(
      'keydown',
      (event) => {
        if (event.code.startsWith('Arrow')) event.preventDefault();
      },
      options,
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
    const cameraSystem = defineSystem({
        name: SYSTEM_NAME,
        after: [InputFrameStartScan],
        queries: [],
        fn: () => {
          if (
            !enabled ||
            document.activeElement !== canvas ||
            !document.hasFocus() ||
            document.visibilityState !== 'visible'
          ) {
            pointerId = undefined;
            return;
          }
          const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
          const updatePointerOwnership = () => {
            for (const event of snapshot.pointerEvents) {
              if (event.phase === 'down' && pointerId === undefined) pointerId = event.pointerId;
              if (event.pointerId === pointerId && (event.phase === 'up' || event.phase === 'cancel'))
                pointerId = undefined;
            }
          };
updatePointerOwnership();
          let lookX = 0;
          let lookY = 0;
          if (pointerId !== undefined) {
            const pointer = snapshot.pointer(pointerId);
            if (
              pointer.active &&
              (pointer.pointerType !== 'mouse' ||
                snapshot.mouse.button(0) ||
                snapshot.mouse.button(2))
            ) {
              lookX = pointer.delta.x * (canvas.clientWidth / Math.max(1, canvas.width));
              lookY = pointer.delta.y * (canvas.clientHeight / Math.max(1, canvas.height));
            } else pointerId = undefined;
          }
          const keyboard = snapshot.keyboard;
          const delta = world.getResource(Time).delta;
          const yawDelta =
            -lookX * LOOK_SENSITIVITY +
            (Number(keyboard.downCode('ArrowLeft')) - Number(keyboard.downCode('ArrowRight'))) *
              delta *
              1.4;
          const pitchDelta =
            -lookY * LOOK_SENSITIVITY +
            (Number(keyboard.downCode('ArrowUp')) - Number(keyboard.downCode('ArrowDown'))) *
              delta *
              1.4;
          const moveX = Number(keyboard.downCode('KeyD')) - Number(keyboard.downCode('KeyA'));
          const moveY = Number(keyboard.downCode('KeyE')) - Number(keyboard.downCode('KeyQ'));
          const moveZ = Number(keyboard.downCode('KeyW')) - Number(keyboard.downCode('KeyS'));
          if (yawDelta === 0 && pitchDelta === 0 && moveX === 0 && moveY === 0 && moveZ === 0)
            return;
          const applyCameraPose = () => {
            const pose = input.readPose();
            quat.fromLookAt(rotation, pose.eye, pose.target, [0, 1, 0]);
            quat.forward(forward, rotation);
            // Derive orientation from the current pose so presets and diagnostic writes stay authoritative.
            const yaw = Math.atan2(-(forward[0] ?? 0), -(forward[2] ?? -1)) + yawDelta;
            const pitch = Math.max(
              -PITCH_LIMIT,
              Math.min(PITCH_LIMIT, Math.asin(Math.max(-1, Math.min(1, forward[1] ?? 0))) + pitchDelta),
            );
            quat.fromEuler(rotation, pitch, yaw, 0, 'YXZ');
            quat.forward(forward, rotation);
            quat.right(right, rotation);
            displacement.set([
              (right[0] ?? 0) * moveX + (forward[0] ?? 0) * moveZ,
              moveY + (forward[1] ?? 0) * moveZ,
              (right[2] ?? 0) * moveX + (forward[2] ?? 0) * moveZ,
            ]);
            const speed = keyboard.downCode('ShiftLeft') || keyboard.downCode('ShiftRight') ? 15 : 5;
            vec3.normalize(displacement, displacement);
            vec3.scale(displacement, displacement, speed * delta);
            const eye: [number, number, number] = [
              pose.eye[0] + (displacement[0] ?? 0),
              pose.eye[1] + (displacement[1] ?? 0),
              pose.eye[2] + (displacement[2] ?? 0),
            ];
            const distance = vec3.distance(pose.eye, pose.target);
            input.writePose({
              eye,
              target: [
                eye[0] + (forward[0] ?? 0) * distance,
                eye[1] + (forward[1] ?? 0) * distance,
                eye[2] + (forward[2] ?? 0) * distance,
              ],
            });
          };
          applyCameraPose();
        },
      });
    world
      .addSystem(Update, cameraSystem)
      .unwrap();
    return () => {
      listeners.abort();
      reset();
      world.removeSystem(Update, cameraSystem).unwrap();
    };
  });
  return {
    get enabled() {
      return enabled;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
      reset();
    },
    reset,
  };
}
