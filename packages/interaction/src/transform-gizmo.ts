import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { viewportToWorld } from '@forgeax/engine-picking';
import { Camera, cameraProjectionFromF32 } from '@forgeax/engine-render';
import { ChildOf, GlobalTransform, Transform } from '@forgeax/engine-scene';
import {
  add,
  cross,
  dot,
  mul,
  norm,
  plane,
  segmentDistance,
  sub,
  transform,
  tuple,
  type V3,
} from './gizmo-math';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type GizmoSpace = 'world' | 'local';
export type GizmoHandle = 'X' | 'Y' | 'Z' | 'XY' | 'YZ' | 'XZ' | 'XYZ';
export interface GizmoOptions {
  mode?: GizmoMode;
  space?: GizmoSpace;
  /** Physical output pixels from pivot to axis tip. */
  size?: number;
  /** Translation units, rotation radians, or scale units. Zero disables snapping. */
  snap?: number;
}
export interface GizmoFrame {
  readonly origin: V3;
  readonly axes: readonly [V3, V3, V3];
  readonly orientation: quat.Quat;
  readonly radius: number;
  readonly eye: V3;
  readonly up: V3;
  readonly visible: readonly GizmoHandle[];
  readonly project: (p: V3) => V3;
}
interface Pose {
  pos: V3;
  quat: readonly [number, number, number, number];
  scale: V3;
}
interface Drag {
  frame: GizmoFrame;
  handle: GizmoHandle;
  mode: GizmoMode;
  snap: number;
  pose: Pose;
  parentInverse: mat4.Mat4;
  parentRotation: quat.Quat;
  normal: V3;
  start: V3;
  previousAngle: number;
  angle: number;
}
const AXES = ['X', 'Y', 'Z'] as const;
const PAIRS = ['XY', 'YZ', 'XZ'] as const;
const UNIT: readonly [V3, V3, V3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const indices = (h: GizmoHandle): number[] => AXES.flatMap((a, i) => (h.includes(a) ? [i] : []));
const snapped = (x: number, s: number): number => (s > 0 ? Math.round(x / s) * s : x);

/** Input and World mutation only; DOM capture, selection and undo belong to the host. */
export class TransformGizmo {
  readonly options: Readonly<Required<GizmoOptions>>;
  private selected: EntityHandle | undefined;
  hovered: GizmoHandle | undefined;
  frame: GizmoFrame | undefined;
  /** Inspectable refusal; no fabricated identity matrix for invalid targets. */
  unavailable:
    | 'target-missing'
    | 'camera-missing'
    | 'invalid-viewport'
    | 'singular-parent'
    | 'sheared-parent'
    | 'behind-camera'
    | undefined;
  private drag: Drag | undefined;
  private camera: EntityHandle | undefined;
  private width = 0;
  private height = 0;
  constructor(
    readonly world: World,
    options: GizmoOptions = {},
  ) {
    this.options = {
      mode: options.mode ?? 'translate',
      space: options.space ?? 'world',
      size: options.size ?? 110,
      snap: options.snap ?? 0,
    };
  }
  get target(): EntityHandle | undefined {
    return this.selected;
  }
  get dragging(): boolean {
    return this.drag !== undefined;
  }
  attach(target: EntityHandle | undefined): void {
    this.cancel();
    this.selected = target;
    this.hovered = undefined;
    this.frame = undefined;
  }
  configure(options: GizmoOptions): void {
    this.cancel();
    Object.assign(this.options, options);
    this.hovered = undefined;
    this.frame = undefined;
  }
  private pose(): Pose | undefined {
    if (this.target === undefined) return undefined;
    const t = this.world.get(this.target, Transform);
    if (!t.ok) return undefined;
    return {
      pos: tuple(t.value.pos),
      quat: [
        t.value.quat[0] as number,
        t.value.quat[1] as number,
        t.value.quat[2] as number,
        t.value.quat[3] as number,
      ],
      scale: tuple(t.value.scale),
    };
  }
  private parent(): { inverse: mat4.Mat4; rotation: quat.Quat } | undefined {
    const m = mat4.create();
    if (this.target !== undefined) {
      const parent = this.world.get(this.target, ChildOf);
      if (parent.ok && parent.value.parent !== null) {
        const global = this.world.get(parent.value.parent, GlobalTransform);
        if (!global.ok) {
          this.unavailable = 'target-missing';
          return undefined;
        }
        m.set(global.value.world);
      }
    }
    const columns: V3[] = [
      tuple(m),
      [m[4] as number, m[5] as number, m[6] as number],
      [m[8] as number, m[9] as number, m[10] as number],
    ];
    if (columns.some((c) => Math.hypot(...c) < 1e-7) || !Array.from(m).every(Number.isFinite)) {
      this.unavailable = 'singular-parent';
      return undefined;
    }
    const n = columns.map(norm);
    if (
      Math.abs(dot(n[0] as V3, n[1] as V3)) +
        Math.abs(dot(n[1] as V3, n[2] as V3)) +
        Math.abs(dot(n[0] as V3, n[2] as V3)) >
      1e-4
    ) {
      this.unavailable = 'sheared-parent';
      return undefined;
    }
    const inverse = mat4.create(),
      rotation = quat.create();
    mat4.invert(inverse, m);
    mat4.decompose(vec3.create(), rotation, vec3.create(), m);
    return { inverse, rotation };
  }
  /** Call after current Scene propagation, before presentation / pointer input. */
  update(camera: EntityHandle, width: number, height: number): GizmoFrame | undefined {
    this.frame = undefined;
    this.unavailable = undefined;
    this.camera = camera;
    this.width = width;
    this.height = height;
    const pose = this.pose();
    const global =
      this.target === undefined ? undefined : this.world.get(this.target, GlobalTransform);
    if (!pose || !global?.ok) {
      this.unavailable = 'target-missing';
      this.drag = undefined;
      return undefined;
    }
    if (
      ![width, height, this.options.size].every((n) => Number.isFinite(n) && n > 0) ||
      !Number.isFinite(this.options.snap) ||
      this.options.snap < 0
    ) {
      this.unavailable = 'invalid-viewport';
      return undefined;
    }
    const cam = this.world.get(camera, Camera),
      cg = this.world.get(camera, GlobalTransform);
    if (!cam.ok || !cg.ok) {
      this.unavailable = 'camera-missing';
      return undefined;
    }
    const parent = this.parent();
    if (!parent) return undefined;
    const view = mat4.create(),
      projection = mat4.create(),
      vp = mat4.create();
    mat4.invert(view, cg.value.world);
    const orthographic = cameraProjectionFromF32(cam.value.projection) === 'orthographic';
    if (orthographic)
      mat4.orthographicReverseZ(
        projection,
        cam.value.left,
        cam.value.right,
        cam.value.top,
        cam.value.bottom,
        cam.value.near,
        cam.value.far,
      );
    else
      mat4.perspectiveReverseZ(
        projection,
        cam.value.fov,
        cam.value.aspect,
        cam.value.near,
        cam.value.far,
      );
    mat4.multiply(vp, projection, view);
    const origin: V3 = [
      global.value.world[12] as number,
      global.value.world[13] as number,
      global.value.world[14] as number,
    ];
    const depth = -transform(view, origin)[2];
    if (depth <= cam.value.near || depth >= cam.value.far) {
      this.unavailable = 'behind-camera';
      return undefined;
    }
    const orientation = quat.identity(quat.create());
    if (this.options.space === 'local' || this.options.mode === 'scale')
      quat.multiply(orientation, parent.rotation, pose.quat);
    const axes = UNIT.map((a) => tuple(quat.transformVec3(vec3.create(), orientation, a))) as [
      V3,
      V3,
      V3,
    ];
    const eye = orthographic
      ? norm([
          cg.value.world[8] as number,
          cg.value.world[9] as number,
          cg.value.world[10] as number,
        ])
      : norm(
          sub(
            [
              cg.value.world[12] as number,
              cg.value.world[13] as number,
              cg.value.world[14] as number,
            ],
            origin,
          ),
        );
    const radius =
      ((this.options.size * 2) / (height * (projection[5] as number))) * (orthographic ? 1 : depth);
    const project = (p: V3): V3 => {
      const ndc = transform(vp, p);
      return [((ndc[0] + 1) * width) / 2, ((1 - ndc[1]) * height) / 2, ndc[2]];
    };
    const visible: GizmoHandle[] = [];
    for (let i = 0; i < 3; i++)
      if (
        this.options.mode === 'rotate'
          ? Math.abs(dot(axes[i] as V3, eye)) > 0.15
          : Math.abs(dot(axes[i] as V3, eye)) < 0.97
      )
        visible.push(AXES[i] as 'X' | 'Y' | 'Z');
    if (this.options.mode === 'translate')
      for (const pair of PAIRS) {
        const ix = indices(pair);
        if (
          Math.abs(dot(cross(axes[ix[0] as number] as V3, axes[ix[1] as number] as V3), eye)) > 0.2
        )
          visible.push(pair);
      }
    if (this.options.mode !== 'rotate') visible.push('XYZ');
    this.frame = {
      origin,
      axes,
      orientation,
      radius,
      eye,
      up: norm([
        cg.value.world[4] as number,
        cg.value.world[5] as number,
        cg.value.world[6] as number,
      ]),
      visible,
      project,
    };
    return this.frame;
  }
  hitTest(x: number, y: number): GizmoHandle | undefined {
    const f = this.frame;
    if (
      !f ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x > this.width ||
      y > this.height
    )
      return undefined;
    let best = 9,
      hit: GizmoHandle | undefined;
    const center = f.project(f.origin);
    if (f.visible.includes('XYZ') && Math.hypot(x - center[0], y - center[1]) < 9) return 'XYZ';
    for (const h of f.visible) {
      if (h === 'XYZ') continue;
      const ix = indices(h);
      if (ix.length === 2) {
        const r = this.ray(x, y);
        const normal = cross(f.axes[ix[0] as number] as V3, f.axes[ix[1] as number] as V3);
        const p = r ? plane(r, f.origin, normal) : undefined;
        if (p) {
          const d = mul(sub(p, f.origin), 1 / f.radius);
          const a = dot(d, f.axes[ix[0] as number] as V3),
            b = dot(d, f.axes[ix[1] as number] as V3);
          if (a > 0.22 && a < 0.46 && b > 0.22 && b < 0.46) return h;
        }
      } else if (this.options.mode === 'rotate') {
        const i = ix[0] as number,
          u = f.axes[(i + 1) % 3] as V3,
          v = f.axes[(i + 2) % 3] as V3;
        let previous = f.project(add(f.origin, mul(u, f.radius)));
        for (let j = 1; j <= 64; j++) {
          const angle = (j * Math.PI) / 32;
          const next = f.project(
            add(f.origin, mul(add(mul(u, Math.cos(angle)), mul(v, Math.sin(angle))), f.radius)),
          );
          const d = segmentDistance(x, y, previous, next);
          if (d < best) {
            best = d;
            hit = h;
          }
          previous = next;
        }
      } else {
        const a = f.project(add(f.origin, mul(f.axes[ix[0] as number] as V3, f.radius * 0.18)));
        const b = f.project(add(f.origin, mul(f.axes[ix[0] as number] as V3, f.radius)));
        const d = segmentDistance(x, y, a, b);
        if (d < best) {
          best = d;
          hit = h;
        }
      }
    }
    return hit;
  }
  hover(x: number, y: number): GizmoHandle | undefined {
    if (!this.drag) this.hovered = this.hitTest(x, y);
    return this.hovered;
  }
  private ray(x: number, y: number) {
    return this.camera === undefined || !Number.isFinite(x) || !Number.isFinite(y)
      ? undefined
      : viewportToWorld(this.world, this.camera, x, y, this.width, this.height);
  }
  begin(x: number, y: number): boolean {
    if (this.drag) return false;
    const f = this.frame,
      pose = this.pose(),
      h = this.hitTest(x, y),
      parent = this.parent(),
      r = this.ray(x, y);
    if (!f || !pose || !h || !parent || !r) return false;
    const ix = indices(h);
    const axis = f.axes[ix[0] as number] as V3;
    const normal =
      this.options.mode === 'rotate'
        ? axis
        : ix.length === 2
          ? norm(cross(axis, f.axes[ix[1] as number] as V3))
          : ix.length === 3
            ? f.eye
            : norm(sub(f.eye, mul(axis, dot(f.eye, axis))));
    const start = plane(r, f.origin, normal);
    if (!start) return false;
    this.drag = {
      frame: f,
      handle: h,
      mode: this.options.mode,
      snap: this.options.snap,
      pose,
      parentInverse: parent.inverse,
      parentRotation: parent.rotation,
      normal,
      start,
      previousAngle: 0,
      angle: 0,
    };
    this.hovered = h;
    return true;
  }
  move(x: number, y: number): boolean {
    const d = this.drag,
      r = this.ray(x, y);
    if (!d || !r || !this.frame || !this.pose()) return false;
    const p = plane(r, d.frame.origin, d.normal);
    if (!p) return false;
    const ix = indices(d.handle),
      delta = sub(p, d.start),
      f = d.frame;
    if (d.mode === 'translate') {
      let offset: V3 = [0, 0, 0];
      for (const i of ix)
        offset = add(offset, mul(f.axes[i] as V3, snapped(dot(delta, f.axes[i] as V3), d.snap)));
      const local = transform(d.parentInverse, add(f.origin, offset));
      this.world.set(this.target as EntityHandle, Transform, { pos: local }).unwrap();
    } else if (d.mode === 'scale') {
      const scale = [...d.pose.scale];
      const uniform = dot(delta, f.up) / f.radius;
      for (const i of ix) {
        const factor = 1 + (ix.length === 3 ? uniform : dot(delta, f.axes[i] as V3) / f.radius);
        const s = snapped((d.pose.scale[i] as number) * factor, d.snap);
        scale[i] = Math.abs(s) < 0.001 ? (s < 0 ? -0.001 : 0.001) : s;
      }
      this.world.set(this.target as EntityHandle, Transform, { scale }).unwrap();
    } else {
      const a = norm(sub(d.start, f.origin)),
        b = norm(sub(p, f.origin));
      if (Math.hypot(...sub(p, f.origin)) < f.radius * 0.05) return false;
      const angle = Math.atan2(dot(d.normal, cross(a, b)), dot(a, b));
      let step = angle - d.previousAngle;
      if (step > Math.PI) step -= 2 * Math.PI;
      if (step < -Math.PI) step += 2 * Math.PI;
      d.angle += step;
      d.previousAngle = angle;
      const inverse = quat.create();
      quat.conjugate(inverse, d.parentRotation);
      const axis = quat.transformVec3(vec3.create(), inverse, d.normal),
        rotation = quat.create(),
        out = quat.create();
      quat.fromAxisAngle(rotation, axis, snapped(d.angle, d.snap));
      quat.multiply(out, rotation, d.pose.quat);
      quat.normalize(out, out);
      this.world.set(this.target as EntityHandle, Transform, { quat: out }).unwrap();
    }
    return true;
  }
  commit(): void {
    this.drag = undefined;
  }
  cancel(): void {
    const d = this.drag;
    this.drag = undefined;
    if (d && this.target !== undefined && this.pose())
      this.world.set(this.target, Transform, { ...d.pose }).unwrap();
  }
}
