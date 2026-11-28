import type { InputSnapshot } from '@forgeax/engine/input';
import type { PoolRipples } from './ripples';

export type Vec3 = [number, number, number];
const add = (a: Vec3, b: Vec3, scale = 1): Vec3 => [
  a[0] + b[0] * scale,
  a[1] + b[1] * scale,
  a[2] + b[2] * scale,
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(...a);
  return [a[0] / length, a[1] / length, a[2] / length];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export class PoolControls {
  yaw = (159.5 * Math.PI) / 180;
  pitch = (25 * Math.PI) / 180;
  distance = 4;
  sphere: Vec3 = [-0.4, -0.75, 0.2];
  readonly radius = 0.25;
  light: Vec3 = normalize([2, 2, -1]);
  paused = false;
  gravity = false;
  caustics = true;
  fieldView = false;
  gain = 1;
  private verticalVelocity = 0;
  private mode: 'idle' | 'orbit' | 'sphere' | 'ripple' = 'idle';
  private previous = { x: 0, y: 0 };
  private dragDistance = 0;
  private dragOffset: Vec3 = [0, 0, 0];
  private touchPointer: number | undefined;

  constructor(readonly ripples: PoolRipples) {}

  setView(view: 'reference' | 'underwater') {
    this.yaw = (159.5 * Math.PI) / 180;
    this.pitch = view === 'reference' ? (25 * Math.PI) / 180 : -0.2;
    this.distance = view === 'reference' ? 4 : 0.65;
  }

  basis() {
    const target: Vec3 = [0, -0.5, 0];
    const eye: Vec3 = [
      Math.sin(this.yaw) * Math.cos(this.pitch) * this.distance,
      Math.sin(this.pitch) * this.distance - 0.5,
      Math.cos(this.yaw) * Math.cos(this.pitch) * this.distance,
    ];
    const forward = normalize(add(target, eye, -1));
    const right = normalize(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    return { eye, forward, right, up };
  }

  private moveSphere(next: Vec3) {
    const previous = this.sphere;
    this.sphere = [
      clamp(next[0], -1 + this.radius, 1 - this.radius),
      clamp(next[1], -1 + this.radius, 0.8),
      clamp(next[2], -1 + this.radius, 1 - this.radius),
    ];
    const moved = Math.hypot(...add(this.sphere, previous, -1));
    if (moved > 0.0001 && Math.min(previous[1], this.sphere[1]) < this.radius) {
      const strength = Math.min(0.012, moved * 0.12);
      this.ripples.disturb(previous[0], previous[2], this.radius, -strength);
      this.ripples.disturb(this.sphere[0], this.sphere[2], this.radius, strength);
    }
  }

  step(delta: number) {
    if (this.paused || !this.gravity || this.mode === 'sphere') return;
    const submerged = clamp((this.radius - this.sphere[1]) / (2 * this.radius), 0, 1);
    this.verticalVelocity += (-4 + 4.4 * submerged) * delta;
    this.verticalVelocity *= Math.exp(-submerged * 2 * delta);
    const y = this.sphere[1] + this.verticalVelocity * delta;
    if (y < -1 + this.radius) this.verticalVelocity = Math.abs(this.verticalVelocity) * 0.55;
    this.moveSphere([this.sphere[0], y, this.sphere[2]]);
  }

  private updateKeyboard(input: InputSnapshot) {
    if (input.keyboard.justPressedCode('Space')) this.paused = !this.paused;
    if (input.keyboard.justPressedCode('KeyG')) this.gravity = !this.gravity;
    if (input.keyboard.justPressedCode('KeyC')) this.caustics = !this.caustics;
    if (input.keyboard.justPressedCode('KeyR')) this.reset();
    const basis = this.basis();
    if (input.keyboard.justPressedCode('KeyL')) {
      const direction = add(basis.eye, [0, -0.5, 0], -1);
      direction[1] = Math.max(0.05, direction[1]);
      this.light = normalize(direction);
    }
    return basis;
  }

  private pointerState(input: InputSnapshot) {
    let pointer = input.mouse.position;
    let pressed = input.mouse.justPressed(0);
    let held = input.mouse.button(0);
    for (const event of input.pointerEvents) {
      if (event.pointerType !== 'touch') continue;
      if (event.phase === 'down' && this.touchPointer === undefined) {
        this.touchPointer = event.pointerId;
        pressed = true;
      }
      if (event.pointerId !== this.touchPointer) continue;
      pointer = { x: event.x, y: event.y };
      if (event.phase === 'up' || event.phase === 'cancel') this.touchPointer = undefined;
    }
    if (this.touchPointer !== undefined) {
      const touch = input.pointer(this.touchPointer);
      pointer = { x: touch.x, y: touch.y };
      held = touch.active;
    }
    return { pointer, pressed, held };
  }

  private beginDrag(
    pointer: { x: number; y: number },
    basis: ReturnType<PoolControls['basis']>,
    ray: Vec3,
    water: Vec3,
    waterT: number,
    orbit: boolean,
  ) {
    const toBall = add(basis.eye, this.sphere, -1);
    const b = dot(toBall, ray);
    const disc = b * b - dot(toBall, toBall) + this.radius * this.radius;
    this.previous = pointer;
    if (orbit) this.mode = 'orbit';
    else if (disc > 0 && -b - Math.sqrt(disc) > 0) {
      this.mode = 'sphere';
      this.dragDistance = dot(add(this.sphere, basis.eye, -1), basis.forward);
      const hit = add(basis.eye, ray, this.dragDistance / dot(ray, basis.forward));
      this.dragOffset = add(this.sphere, hit, -1);
      this.verticalVelocity = 0;
    } else
      this.mode =
        waterT > 0 && Math.abs(water[0]) < 1 && Math.abs(water[2]) < 1 ? 'ripple' : 'orbit';
  }

  update(input: InputSnapshot, width: number, height: number) {
    const basis = this.updateKeyboard(input);
    this.distance = clamp(this.distance + input.mouse.wheelDelta * 0.15, 0.45, 7);
    const { pointer, pressed, held } = this.pointerState(input);
    if (pointer === undefined) return;
    const x = (pointer.x / width) * 2 - 1;
    const y = 1 - (pointer.y / height) * 2;
    const ray = normalize(
      add(
        add(basis.forward, basis.right, (x * 0.41421356 * width) / height),
        basis.up,
        y * 0.41421356,
      ),
    );
    const waterT = -basis.eye[1] / ray[1];
    const water = add(basis.eye, ray, waterT);
    if (pressed || input.mouse.justPressed(2)) {
      this.beginDrag(pointer, basis, ray, water, waterT, input.mouse.justPressed(2));
    }
    if (held || input.mouse.button(2) || pressed || input.mouse.justPressed(2)) {
      const dx = pointer.x - this.previous.x;
      const dy = pointer.y - this.previous.y;
      if (this.mode === 'orbit') {
        this.yaw -= dx * 0.005;
        this.pitch = clamp(this.pitch + dy * 0.005, -1.35, 1.35);
      } else if (this.mode === 'sphere') {
        this.moveSphere(
          add(add(basis.eye, ray, this.dragDistance / dot(ray, basis.forward)), this.dragOffset),
        );
      } else if (this.mode === 'ripple' && (pressed || dx * dx + dy * dy > 1)) {
        if (waterT > 0 && Math.abs(water[0]) < 1 && Math.abs(water[2]) < 1)
          this.ripples.disturb(water[0], water[2]);
      }
      this.previous = pointer;
    } else this.mode = 'idle';
  }

  reset() {
    this.ripples.reset();
    this.sphere = [-0.4, -0.75, 0.2];
    this.verticalVelocity = 0;
    this.gravity = false;
  }
}
