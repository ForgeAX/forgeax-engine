/** @typedef {import('../src/scenes.ts').GiCamera} GiCamera */
/** @typedef {import('../src/scenes.ts').Vec3} Vec3 */

/** The initial CLI request and the H control share one hardware-RT state. */
export function initialHardwareRayTracing(value = 'on') {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new TypeError('--hardware-ray-tracing must be on or off');
}

/** The initial CLI request and the L control share one HWRT reflection state. */
export function initialReflections(value = 'on') {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new TypeError('--reflections must be on or off');
}

/** Sky miss radiance source for Sponza: sun-derived physical sky or legacy constant. */
export function initialSkyEnvironment(value = 'legacy') {
  if (value === 'sun' || value === 'legacy') return value;
  throw new TypeError('--sky-environment must be sun or legacy');
}

/** Apply one native event batch without losing key edges or held-key state. */
export function consumeNativeWindowEvents(heldKeys, events, onEvent = () => {}) {
  const pressed = [];
  let closeRequested = false;
  let surfaceLost = false;
  let displayChanged = false;
  let visible;
  let focused;

  for (const event of events) {
    switch (event.kind) {
      case 'key-down':
        heldKeys.add(event.code);
        if (!event.repeat) pressed.push(event.code);
        break;
      case 'key-up':
        heldKeys.delete(event.code);
        break;
      case 'focus':
        focused = event.focused;
        if (!focused) heldKeys.clear();
        break;
      case 'close-requested':
        closeRequested = true;
        break;
      case 'surface-lost':
        surfaceLost = true;
        break;
      case 'display':
        displayChanged = true;
        break;
      case 'visibility':
        visible = event.visible;
        break;
      case 'redraw':
        break;
    }
    onEvent(event);
  }

  return { pressed, closeRequested, surfaceLost, displayChanged, visible, focused };
}

/** @param {GiCamera} pose
 * @returns {{ origin: [number, number, number]; yaw: number; pitch: number; up: [number, number, number]; verticalFov: number }}
 */
export function createRoamCamera(pose) {
  const dx = pose.target[0] - pose.origin[0];
  const dy = pose.target[1] - pose.origin[1];
  const dz = pose.target[2] - pose.origin[2];
  return {
    origin: [...pose.origin],
    yaw: Math.atan2(dx, dz),
    pitch: Math.atan2(dy, Math.hypot(dx, dz)),
    up: [...pose.up],
    verticalFov: pose.verticalFov,
  };
}

/** @param {{ readonly origin: Vec3; readonly yaw: number; readonly pitch: number; readonly up: Vec3; readonly verticalFov: number }} camera
 *  @returns {GiCamera}
 */
export function roamCameraPose(camera) {
  const horizontal = Math.cos(camera.pitch);
  /** @type {Vec3} */
  const target = [
    camera.origin[0] + Math.sin(camera.yaw) * horizontal,
    camera.origin[1] + Math.sin(camera.pitch),
    camera.origin[2] + Math.cos(camera.yaw) * horizontal,
  ];
  return {
    origin: camera.origin,
    target,
    up: camera.up,
    verticalFov: camera.verticalFov,
  };
}

/** Free-fly movement in metres, with bounded input time after stalls or focus changes. */
export function advanceRoamCamera(camera, heldKeys, deltaSeconds, look = { x: 0, y: 0 }) {
  const dt = Math.min(Math.max(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0), 0.05);

  const down = (code) => heldKeys.has(code);
  const yawInput = Number(down('ArrowLeft')) - Number(down('ArrowRight'));
  const pitchInput = Number(down('ArrowUp')) - Number(down('ArrowDown'));
  const yaw = camera.yaw + yawInput * 1.5 * dt - look.x * 0.003;
  const pitch = Math.max(-1.35, Math.min(1.35, camera.pitch + pitchInput * 1.2 * dt - look.y * 0.003));
  const forward = Number(down('KeyW')) - Number(down('KeyS'));
  const strafe = Number(down('KeyD')) - Number(down('KeyA'));
  const vertical = Number(down('KeyE')) - Number(down('KeyQ'));
  const length = Math.hypot(forward, strafe, vertical);
  const speed = (down('ShiftLeft') || down('ShiftRight') ? 9 : 3) * dt;
  const origin = [...camera.origin];
  if (length > 0) {
    const f = forward / length;
    const s = strafe / length;
    const v = vertical / length;
    origin[0] += (Math.sin(yaw) * f - Math.cos(yaw) * s) * speed;
    origin[1] += v * speed;
    origin[2] += (Math.cos(yaw) * f + Math.sin(yaw) * s) * speed;
  }
  if (yaw === camera.yaw && pitch === camera.pitch &&
      origin.every((value, index) => value === camera.origin[index])) return camera;
  return { ...camera, origin, yaw, pitch };
}

/** Route ordered native pointer facts: left activates UI, right exclusively rotates.
 * Motion is physical pixels; convert once to logical pixels for UI and look sensitivity.
 */
function cancelsNativePointer(event) {
  return (event.kind === 'focus' && !event.focused) ||
    ['pointer-leave', 'display', 'surface-lost', 'close-requested'].includes(event.kind) ||
    (event.kind === 'visibility' && !event.visible);
}

export function consumeNativePointerEvents(state, events, input, scaleFactor) {
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const look = { x: 0, y: 0 };
  for (const event of events) {
    if (cancelsNativePointer(event)) {
      state.anchor = undefined;
      input.cancel();
      continue;
    }
    if (!event.kind.startsWith('pointer-') || !Number.isFinite(event.x) || !Number.isFinite(event.y)) continue;
    const point = { x: event.x / scale, y: event.y / scale };
    if (event.kind === 'pointer-down' && event.button === 'right') {
      state.anchor = point;
      input.cancel({ preserveFocus: true });
    } else if (event.kind === 'pointer-up' && event.button === 'right') {
      if (state.anchor) {
        look.x += point.x - state.anchor.x;
        look.y += point.y - state.anchor.y;
      }
      state.anchor = undefined;
    } else if (event.kind === 'pointer-move' && state.anchor) {
      look.x += point.x - state.anchor.x;
      look.y += point.y - state.anchor.y;
      state.anchor = point;
    } else if (!state.anchor && (event.kind === 'pointer-move' || event.button === 'left')) {
      input.pointer({ phase: event.kind === 'pointer-move' ? 'move' :
        event.kind === 'pointer-down' ? 'down' : 'up', pointerId: 1, pointerType: 'mouse', ...point });
    }
  }
  return look;
}

/** Buttons and non-repeating key edges feed the same command owner. */
export function commandForKey(code) {
  return ({ Digit1: 'off', Digit2: 'irradiance-field', Digit3: 'screen-probe',
    KeyF: 'toggle-exposure', BracketLeft: 'exposure-down', BracketRight: 'exposure-up',
    KeyR: 'reset-camera', KeyH: 'toggle-hardware', KeyL: 'toggle-reflections' })[code];
}

/** Exposure is Camera-owned; this only constructs its public authoring value.
 * @param {boolean} automatic
 * @param {number} ev
 * @param {boolean} ue
 * @returns {import('@forgeax/engine-render').CameraExposure}
 */
export function exposureForControls(automatic, ev, ue = false) {
  if (!Number.isFinite(ev)) throw new TypeError('Exposure EV must be finite');
  const compensationEv = Math.max(-8, Math.min(8, ev));
  // The meter needs headroom for the shaded arcade and outward-facing views.
  if (!automatic) return { kind: 'manual', multiplier: 2 ** compensationEv };
  return {
    kind: 'auto',
    ...(ue ? { adaptation: 'ue-eye-adaptation' } : {}),
    fallback: 1,
    compensationEv: ue ? 1 + compensationEv : compensationEv,
    // UE5 extended EV100 [-10, 20] maps to inverse gain EV [-20, 10]
    // with the default lens attenuation. The project applies +1 EV separately.
    rangeEv: ue ? [-20, 10] : [-4, 8],
    rates: ue ? [3, 1] : [2, 1],
  };
}
