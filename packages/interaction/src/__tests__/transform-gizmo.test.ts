import { World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { Camera, orthographic, perspective } from '@forgeax/engine-render';
import {
  ChildOf,
  GlobalTransform,
  Name,
  propagateTransforms,
  Transform,
} from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { add, mul, type V3 } from '../gizmo-math';
import { createGizmoPresentation } from '../gizmo-presentation';
import { TransformGizmo } from '../transform-gizmo';

function fixture() {
  const world = new World(),
    q = quat.create();
  quat.fromLookAt(q, [4, 3, 6], [0, 0, 0], [0, 1, 0]);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [4, 3, 6], quat: q } },
      {
        component: Camera,
        data: perspective({ fov: Math.PI / 4, aspect: 1.25, autoAspect: false }),
      },
    )
    .unwrap();
  const parent = world.spawn({ component: Transform, data: {} }).unwrap();
  const target = world
    .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent } })
    .unwrap();
  const gizmo = new TransformGizmo(world);
  gizmo.attach(target);
  const update = () => {
    propagateTransforms(world).unwrap();
    return gizmo.update(camera, 800, 640) as import('..').GizmoFrame;
  };
  update();
  return {
    world,
    camera,
    parent,
    target,
    gizmo,
    update,
    pose: () => world.get(target, Transform).unwrap(),
  };
}
const pixel = (f: NonNullable<TransformGizmo['frame']>, point: V3): [number, number] => {
  const p = f.project(point);
  return [p[0], p[1]];
};
describe('TransformGizmo real Scene/Picking path', () => {
  it('axis and plane translation constrain motion, repeat without drift, cancel and commit', () => {
    const t = fixture(),
      f = t.update(),
      start = add(f.origin, mul(f.axes[0], f.radius * 0.75));
    expect(t.gizmo.begin(...pixel(f, start))).toBe(true);
    const end = add(start, mul(f.axes[0], 0.5));
    expect(t.gizmo.move(...pixel(f, end))).toBe(true);
    t.gizmo.move(...pixel(f, end));
    expect(t.pose().pos[0]).toBeCloseTo(0.5, 4);
    expect(t.pose().pos[1]).toBeCloseTo(0, 4);
    expect(t.pose().pos[2]).toBeCloseTo(0, 4);
    t.gizmo.cancel();
    expect(Array.from(t.pose().pos)).toEqual([0, 0, 0]);
    const plane = add(
      f.origin,
      add(mul(f.axes[0], f.radius * 0.34), mul(f.axes[1], f.radius * 0.34)),
    );
    expect(t.gizmo.hitTest(...pixel(f, plane))).toBe('XY');
    expect(t.gizmo.begin(...pixel(f, plane))).toBe(true);
    t.gizmo.move(...pixel(f, add(plane, [0.2, 0.3, 0])));
    t.gizmo.commit();
    expect(t.pose().pos[0]).toBeCloseTo(0.2, 4);
    expect(t.pose().pos[1]).toBeCloseTo(0.3, 4);
    expect(t.pose().pos[2]).toBeCloseTo(0, 4);
  });
  it('world translation accounts for rotated nonuniform parent; local axes and snapping', () => {
    const t = fixture(),
      q = quat.create();
    quat.fromAxisAngle(q, [0, 0, 1], Math.PI / 2);
    t.world.set(t.parent, Transform, { pos: [1, 2, 0], quat: q, scale: [2, 3, 1] }).unwrap();
    const f = t.update(),
      start = add(f.origin, mul(f.axes[0], f.radius * 0.7));
    t.gizmo.configure({ snap: 0.25 });
    t.update();
    expect(t.gizmo.begin(...pixel(f, start))).toBe(true);
    t.gizmo.move(...pixel(f, add(start, [0.41, 0, 0])));
    t.gizmo.commit();
    t.update();
    const m = t.world.get(t.target, GlobalTransform).unwrap().world;
    expect(m[12]).toBeCloseTo(1.5, 4);
    expect(m[13]).toBeCloseTo(2, 4);
    t.gizmo.configure({ space: 'local' });
    const local = t.update();
    expect(local.axes[0][1]).toBeCloseTo(1, 4);
  });
  it('rotation uses signed angles, snap, normalized quaternion and continuous crossing of pi', () => {
    const t = fixture();
    t.gizmo.configure({ mode: 'rotate', snap: Math.PI / 12 });
    const f = t.update();
    const p = (angle: number) =>
      add(
        f.origin,
        mul(add(mul(f.axes[0], Math.cos(angle)), mul(f.axes[1], Math.sin(angle))), f.radius),
      );
    const start = 0.35;
    expect(t.gizmo.hitTest(...pixel(f, p(start)))).toBe('Z');
    expect(t.gizmo.begin(...pixel(f, p(start)))).toBe(true);
    for (let a = start + 0.2; a < start + Math.PI * 2 + 0.45; a += 0.2)
      expect(t.gizmo.move(...pixel(f, p(a)))).toBe(true);
    const out = t.pose().quat;
    expect(Math.hypot(...Array.from(out))).toBeCloseTo(1, 5);
    expect(Math.abs(out[2] as number)).toBeGreaterThan(0.1);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(0, 5);
    t.gizmo.cancel();
    expect(Array.from(t.pose().quat)).toEqual([0, 0, 0, 1]);
  });
  it('local axis and uniform scaling preserve untouched axes and avoid zero scale', () => {
    const t = fixture();
    t.gizmo.configure({ mode: 'scale' });
    const f = t.update(),
      start = add(f.origin, mul(f.axes[0], f.radius));
    expect(t.gizmo.begin(...pixel(f, start))).toBe(true);
    t.gizmo.move(...pixel(f, add(start, mul(f.axes[0], f.radius * 0.5))));
    t.gizmo.commit();
    expect(t.pose().scale[0]).toBeCloseTo(1.5, 4);
    expect(t.pose().scale[1]).toBeCloseTo(1, 5);
    const center = pixel(f, f.origin);
    expect(t.gizmo.begin(...center)).toBe(true);
    t.gizmo.move(...pixel(f, add(f.origin, mul(f.up, f.radius * 0.5))));
    t.gizmo.commit();
    expect(t.pose().scale[0]).toBeCloseTo(2.25, 4);
    expect(t.pose().scale[2]).toBeCloseTo(1.5, 4);
  });
  it.each([0, 1, 2])('constrains translation and scale on axis %i with a frozen pose', (axis) => {
    const t = fixture();
    const f = t.update(),
      start = add(f.origin, mul(f.axes[axis] as V3, f.radius * 0.7));
    expect(t.gizmo.hitTest(...pixel(f, start))).toBe((['X', 'Y', 'Z'] as const)[axis]);
    expect(t.gizmo.begin(...pixel(f, start))).toBe(true);
    t.gizmo.move(...pixel(f, add(start, mul(f.axes[axis] as V3, 0.4))));
    t.gizmo.commit();
    for (let i = 0; i < 3; i++) expect(t.pose().pos[i]).toBeCloseTo(i === axis ? 0.4 : 0, 4);
    t.world.set(t.target, Transform, { pos: [0, 0, 0] }).unwrap();
    t.gizmo.configure({ mode: 'scale', snap: 0.25 });
    const sf = t.update(),
      tip = add(sf.origin, mul(sf.axes[axis] as V3, sf.radius));
    expect(t.gizmo.begin(...pixel(sf, tip))).toBe(true);
    t.gizmo.move(...pixel(sf, add(tip, mul(sf.axes[axis] as V3, sf.radius * 0.4))));
    t.gizmo.commit();
    for (let i = 0; i < 3; i++) expect(t.pose().scale[i]).toBeCloseTo(i === axis ? 1.5 : 1, 4);
    t.update();
    expect(t.gizmo.begin(...pixel(sf, tip))).toBe(true);
    t.gizmo.move(...pixel(sf, add(tip, mul(sf.axes[axis] as V3, -sf.radius))));
    expect(Math.abs(t.pose().scale[axis] as number)).toBeCloseTo(0.001, 6);
  });
  it('perspective and orthographic sizes remain stable across camera distances', () => {
    const t = fixture(),
      f = t.update(),
      a = f.project(add(f.origin, mul(f.up, f.radius))),
      b = f.project(f.origin);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(110, 3);
    t.world.set(t.camera, Transform, { pos: [8, 6, 12] }).unwrap();
    const far = t.update();
    expect(far.radius / f.radius).toBeCloseTo(2, 4);
    t.world
      .set(t.camera, Camera, orthographic({ left: -5, right: 5, top: 4, bottom: -4 }))
      .unwrap();
    const ortho = t.update();
    t.world.set(t.camera, Transform, { pos: [4, 3, 6] }).unwrap();
    expect(t.update().radius).toBeCloseTo(ortho.radius, 5);
  });
  it('presentation rotations are unit quaternions and retain distinct ring planes', () => {
    const t = fixture();
    t.gizmo.configure({ mode: 'rotate' });
    t.update();
    const view = createGizmoPresentation(t.gizmo);
    view.sync();
    const rings = Array.from(t.world.query({ read: [Name, Transform] }).unwrap(), (row) => ({
      name: row.get(Name).value,
      q: Array.from(row.get(Transform).quat),
    })).filter((row) => row.name.endsWith(':3'));
    expect(rings).toHaveLength(3);
    const normals = rings.map((row) => {
      expect(Math.hypot(...row.q)).toBeCloseTo(1, 5);
      return Array.from(
        quat.transformVec3(
          new Float32Array(3) as Parameters<typeof quat.transformVec3>[0],
          row.q,
          [0, 0, 1],
        ),
      );
    });
    expect(normals[0]?.[0]).toBeCloseTo(1, 5);
    expect(normals[1]?.[1]).toBeCloseTo(1, 5);
    expect(normals[2]?.[2]).toBeCloseTo(1, 5);
    view.dispose();
  });
  it('rejects degenerate inputs and stale targets; presentation dispose is idempotent', () => {
    const t = fixture(),
      view = createGizmoPresentation(t.gizmo),
      count = t.world.inspect().entityCount;
    view.sync();
    view.sync();
    expect(t.world.inspect().entityCount).toBe(count);
    expect(t.gizmo.update(t.camera, 0, 640)).toBeUndefined();
    expect(t.gizmo.begin(0, 0)).toBe(false);
    t.world.set(t.parent, Transform, { scale: [0, 1, 1] }).unwrap();
    expect(t.update()).toBeUndefined();
    expect(t.gizmo.unavailable).toBe('singular-parent');
    t.world.despawn(t.target).unwrap();
    expect(t.update()).toBeUndefined();
    expect(t.gizmo.unavailable).toBe('target-missing');
    view.dispose();
    view.dispose();
    expect(t.world.inspect().entityCount).toBe(2);
  });
});
