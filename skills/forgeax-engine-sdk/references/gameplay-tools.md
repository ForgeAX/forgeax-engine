# Gameplay tools: character, input, follow pose, dynamic body, orthographic camera

Engine pieces the game composes; rules, camera framing and UI are the game's own. The
character is a kinematic body with a capsule `Collider` and `CharacterController`, moved once
per fixed step with `moveAndSlide` (it writes `Transform` and `grounded`; spawn at rest height,
not inside the ground). Keyboard state comes from the `InputSnapshot` resource. A camera that
follows a body reads the interpolated presentation pose after `FixedUpdate` and before transform
propagation. Dynamic bodies are owned by the physics step: never write their `Transform` per
frame. The Host updates `aspect` only for perspective cameras; read
`gameHost.drawingBufferSize()` to refit an orthographic one. Project state reaches tests through
`gameHost.gameProjection.registerRead` (`forgeax-engine-cli`). Add `physicsPlugin('rapier-3d')`
from `@forgeax/engine/physics` with `ctx.plugin` before using bodies.

```ts file=assets/play/tools.ts
import { FixedTime, FixedUpdate, Update, type EntityHandle, type World } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { quat, vec3 } from '@forgeax/engine/math';
import { CharacterController, Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue,
  type PhysicsWorld } from '@forgeax/engine/physics';
import { Camera, CAMERA_PROJECTION_ORTHOGRAPHIC } from '@forgeax/engine/render';
import { PROPAGATE_TRANSFORMS_SYSTEM, readPresentationWorldMatrix, Transform } from '@forgeax/engine/scene';

/** Kinematic capsule character; `halfHeight` and `radius` set the rest height (radius + halfHeight + offset). */
export function spawnCharacter(world: World, pos: [number, number, number]) {
  return world.spawn(
    { component: Transform, data: { pos } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
    { component: Collider, data: { shape: ColliderShapeValue.capsule, radius: 0.5, halfHeight: 0.5 } },
    { component: CharacterController, data: { snapToGroundDist: 0.3 } },
  ).unwrap();
}

/** Move once per fixed step, between the backend sync and the physics step. */
export function installCharacterMove(world: World, body: EntityHandle, speed: number) {
  world.addSystem(FixedUpdate, {
    name: 'tools-character-move', after: ['physicsSyncBackend'], before: ['physicsStepSimulation'], queries: [],
    fn() {
      if (!world.hasResource('PhysicsWorld')) return;
      const physics = world.getResource<PhysicsWorld>('PhysicsWorld');
      if (!physics.hasBody(body)) return;
      const dt = world.getResource(FixedTime).delta;
      const keys = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY).keyboard;
      const x = Number(keys.downCode('KeyD')) - Number(keys.downCode('KeyA'));
      const grounded = world.get(body, CharacterController).unwrap().grounded === true;
      physics.moveAndSlide(body, vec3.create(x * speed * dt, grounded ? -0.01 : -0.2, 0));
    },
  }).unwrap();
  return () => world.removeSystem(FixedUpdate, 'tools-character-move').unwrap();
}

/** Aim `camera` at the interpolated pose of `target` (not the fixed-step pose). */
export function installLookAt(world: World, target: EntityHandle, camera: EntityHandle) {
  world.addSystem(Update, {
    name: 'tools-look-at', after: [FixedUpdate], before: [PROPAGATE_TRANSFORMS_SYSTEM], queries: [],
    fn() {
      const m = readPresentationWorldMatrix(world, target);
      if (m === undefined) return;
      const eye = [...world.get(camera, Transform).unwrap().pos] as [number, number, number];
      const rotation = quat.fromLookAt(quat.create(), eye, [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0], [0, 1, 0]);
      world.set(camera, Transform, { quat: rotation }).unwrap();
    },
  }).unwrap();
  return () => world.removeSystem(Update, 'tools-look-at').unwrap();
}

/** A dynamic body is moved by the physics step; the character controller pushes it on contact. */
export function spawnDynamicBody(world: World, pos: [number, number, number]) {
  return world.spawn(
    { component: Transform, data: { pos } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, mass: 1.5, linearDamping: 0.1 } },
    { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.5, 0.5, 0.5], friction: 0.6 } },
  ).unwrap();
}

/** Refit orthographic bounds to the canvas aspect; call when `drawingBufferSize()` changes. */
export function fitOrthographic(world: World, camera: EntityHandle, halfHeight: number, size: { width: number; height: number }) {
  const w = halfHeight * (size.width > 0 && size.height > 0 ? size.width / size.height : 16 / 9);
  world.set(camera, Camera, { projection: CAMERA_PROJECTION_ORTHOGRAPHIC, left: -w, right: w,
    bottom: -halfHeight, top: halfHeight, near: 0.1, far: 100 }).unwrap();
}
```

## Board / diorama camera

A board, town, garden or tabletop scene reads best like the Three.js entries: an
orthographic camera on a 45° diagonal, pitched about 35° down, with the board filling the
frame. Top-down flattens props into a grid; front-on hides the board; a far perspective
camera makes it tiny. Fit the bounds of the board's corners in camera space plus a margin,
and refit when the canvas aspect changes: the Host updates `aspect` only for perspective
cameras, so read `gameHost.drawingBufferSize()`. Pair it with the daylight preset.

```ts file=assets/play/board-camera.ts
import { Update, type EntityHandle, type World } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import { Camera, CAMERA_PROJECTION_ORTHOGRAPHIC } from '@forgeax/engine/render';
import { PROPAGATE_TRANSFORMS_SYSTEM, Transform } from '@forgeax/engine/scene';

type V3 = [number, number, number];
const YAW = Math.PI / 4, PITCH = (35 * Math.PI) / 180, MARGIN = 1.15; // margin 15% around the board

/** Aim `camera` at the box `min`..`max` and refit its orthographic bounds to the canvas aspect. */
export function installBoardCamera(world: World, camera: EntityHandle, min: V3, max: V3,
  canvasSize: () => { width: number; height: number }) {
  const center = min.map((v, i) => (v + max[i]!) / 2) as V3;
  const back: V3 = [Math.cos(PITCH) * Math.sin(YAW), Math.sin(PITCH), Math.cos(PITCH) * Math.cos(YAW)];
  const right: V3 = [Math.cos(YAW), 0, -Math.sin(YAW)]; // camera axes: back points from the board to the eye
  const up: V3 = [back[1] * right[2] - back[2] * right[1], back[2] * right[0] - back[0] * right[2],
    back[0] * right[1] - back[1] * right[0]];
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let halfW = 0, halfH = 0, radius = 0;
  for (let corner = 0; corner < 8; corner++) {
    const d = [0, 1, 2].map((i) => ((corner >> i) & 1 ? max[i]! : min[i]!) - center[i]!) as V3;
    halfW = Math.max(halfW, Math.abs(dot(d, right)));
    halfH = Math.max(halfH, Math.abs(dot(d, up)));
    radius = Math.max(radius, Math.hypot(...d));
  }
  const distance = radius * 2 + 1;
  const eye = center.map((v, i) => v + back[i]! * distance) as V3;
  world.set(camera, Transform, { pos: eye, quat: quat.fromLookAt(quat.create(), eye, center, [0, 1, 0]) }).unwrap();
  let fitted = 0;
  world.addSystem(Update, {
    name: 'play-board-camera', before: [PROPAGATE_TRANSFORMS_SYSTEM], queries: [],
    fn() {
      const { width, height } = canvasSize();
      const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
      if (aspect === fitted) return;
      fitted = aspect;
      const h = Math.max(halfH, halfW / aspect) * MARGIN, w = h * aspect; // the tighter axis fills the frame
      world.set(camera, Camera, { projection: CAMERA_PROJECTION_ORTHOGRAPHIC, left: -w, right: w, bottom: -h, top: h,
        near: 0.1, far: distance + radius * 2 }).unwrap();
    },
  }).unwrap();
  return () => world.removeSystem(Update, 'play-board-camera').unwrap();
}
```

In the engine plugin, replace `installFollowCamera` with
`yield installBoardCamera(world, camera!, [-8, 0, -6], [8, 2, 6], () => ctx.gameHost!.drawingBufferSize?.() ?? { width: 16, height: 9 });`.
