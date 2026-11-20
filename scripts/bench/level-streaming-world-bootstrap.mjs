import { defineSystem, Time, Update } from '../../packages/ecs/dist/index.mjs';
import { createBoxGeometry, createCylinderGeometry } from '../../packages/geometry/dist/index.mjs';
import { INPUT_SNAPSHOT_RESOURCE_KEY } from '../../packages/input/dist/index.mjs';
import { vec3 } from '../../packages/math/dist/index.mjs';
import physics3d, { RapierPhysicsWorld3D } from '../../packages/physics-rapier3d/dist/index.mjs';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  ShadowParticipation,
  Skylight,
} from '../../packages/render/dist/index.mjs';
import { ChildOf, Transform } from '../../packages/scene/dist/index.mjs';
import {
  cellAt,
  cellMeters,
  cells,
  distanceToCell,
  groundHeight,
  landscapeRibbon,
  roadX,
  start,
  streamingRadius,
  terrainMesh,
  worldEdge,
} from './fixtures/level-streaming-landscape.mjs';
import { registerBenchmarkVocabulary } from './level-streaming-world.mjs';

const maximumSpeed = 120 / 3.6;
const box = (x, y, z) => createBoxGeometry(x, y, z).unwrap();
const bound = (position) => Math.max(-worldEdge + 1, Math.min(worldEdge - 1, position));

function landscape(world, assets) {
  const owned = [];
  const asset = (value) => {
    const handle = assets.create(value).unwrap();
    owned.push(handle);
    return handle;
  };
  const paint = (baseColor) => asset(Materials.standard({ baseColor, roughness: 0.85 }));
  const draw = (shape, material, data, parent) =>
    world
      .spawn(
        { component: Transform, data },
        { component: MeshFilter, data: { assetHandle: shape } },
        { component: MeshRenderer, data: { materials: [material] } },
        { component: ShadowParticipation, data: { cast: parent !== undefined, receive: true } },
        ...(parent === undefined ? [] : [{ component: ChildOf, data: { parent } }]),
      )
      .unwrap();
  try {
    draw(asset(terrainMesh()), paint('#ffffff'), { pos: [-worldEdge, 0, -worldEdge] });
    draw(asset(landscapeRibbon('road')), paint('#515857'), {});
    draw(asset(landscapeRibbon('marks')), paint('#eeddb0'), {});
    draw(asset(landscapeRibbon('water')), asset(Materials.unlit('#3e7f91')), {});
    const car = world.spawn({ component: Transform, data: {} }).unwrap();
    const orange = paint('#c36e36');
    const dark = paint('#364a51');
    const cream = paint('#edd3a5');
    draw(asset(box(3.45, 1.42, 5.6)), orange, { pos: [0, 1.6, 0] }, car);
    draw(asset(box(3.14, 1.43, 2.55)), dark, { pos: [0, 2.92, -0.85] }, car);
    draw(asset(box(3.48, 0.28, 2.8)), cream, { pos: [0, 3.66, -0.85] }, car);
    draw(asset(box(3.45, 0.26, 0.25)), cream, { pos: [0, 1.15, 2.84] }, car);
    const wheel = asset(createCylinderGeometry(0.75, 0.75, 0.46, 12).unwrap());
    for (const x of [-1.73, 1.73]) {
      for (const z of [-1.72, 1.72])
        draw(wheel, dark, { pos: [x, 0.75, z], quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }, car);
    }
    world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [-0.44, -0.72, -0.53],
          color: [1, 0.94, 0.82],
          intensity: 2.2,
          castShadow: false,
        },
      })
      .unwrap();
    world
      .spawn({
        component: Skylight,
        data: { color: [0.78, 0.87, 1], groundColor: [0.54, 0.5, 0.42], intensity: 0.67 },
      })
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: {} },
        {
          component: Camera,
          data: {
            fov: 0.98,
            aspect: 16 / 9,
            near: 0.8,
            far: 6500,
            clearColor: [0.41, 0.64, 0.76, 1],
          },
        },
      )
      .unwrap();
    return (x, z, heading) => {
      const y = groundHeight(x, z);
      const camX = x - Math.sin(heading) * 41;
      const camZ = z + Math.cos(heading) * 41;
      const camY = Math.max(y + 24, groundHeight(camX, camZ) + 10);
      const pitch = -Math.atan2(camY - y - 4, 62) / 2;
      const dx = Math.sin(pitch),
        dw = Math.cos(pitch);
      const s = Math.sin(-heading / 2),
        c = Math.cos(-heading / 2);
      world.set(car, Transform, { pos: [x, y + 0.18, z], quat: [0, s, 0, c] }).unwrap();
      world
        .set(camera, Transform, {
          pos: [camX, camY, camZ],
          quat: [dx * c, dw * s, -dx * s, dw * c],
        })
        .unwrap();
    };
  } finally {
    for (const handle of owned) assets.release(handle).unwrap();
  }
}

function lookahead(x, z, heading, cruise, entering, count) {
  const current = cellAt(x, z);
  const ahead = entering === current ? [] : [entering];
  for (let distance = 24; distance <= cellMeters * 1.5 && ahead.length < count; distance += 24) {
    const nextZ = z - Math.cos(heading) * distance;
    const nextX = cruise ? roadX(nextZ) : x + Math.sin(heading) * distance;
    const next = cellAt(nextX, nextZ);
    if (next !== undefined && next !== current && !ahead.includes(next)) ahead.push(next);
  }
  return ahead;
}

function streamCells({ assets, physics, levelCandidates, manifest, notify }) {
  const live = new Map();
  const loaded = new Set();
  const retired = new Set();
  const origin = vec3.create();
  const down = vec3.create(0, -1, 0);
  let failure;
  let reading;
  let disposed = false;
  const ground = (id) => {
    const cell = cells[id];
    origin[0] = cell.x + cellMeters / 2;
    origin[1] = 600;
    origin[2] = cell.z + cellMeters / 2;
    return physics.raycast(origin, down, 700);
  };
  const request = async (id) => {
    const controller = new AbortController();
    const slot = { controller, target: 'prepared', phase: 'loading' };
    live.set(id, slot);
    reading = slot;
    try {
      const source = (
        await assets.load(manifest[id].rootGuid, 'scene', { signal: controller.signal })
      ).unwrap();
      if (controller.signal.aborted) {
        assets.release(source).unwrap();
        return;
      }
      slot.source = source;
      slot.level = levelCandidates.create(source).unwrap();
    } catch (error) {
      if (!controller.signal.aborted) failure = error;
    } finally {
      if (controller.signal.aborted && !slot.level) live.delete(id);
      reading = undefined;
    }
  };
  const seek = (slot, target) => {
    if (!slot.level) {
      if (target === 'unloaded') slot.controller.abort();
      return;
    }
    if (slot.target === target || slot.target === 'unloaded') return;
    slot.level.target(target).unwrap();
    slot.target = target;
  };
  const reconcileCell = (id, slot, x, z) => {
    const read = slot.level?.inspect();
    if (read?.failure || read?.cleanupFailure) throw read.failure ?? read.cleanupFailure;
    if (read?.phase === 'retired') {
      if (ground(id)) throw Error(`Retired cell ${id} still has its collision surface`);
      assets.release(slot.source).unwrap();
      live.delete(id);
      retired.add(id);
      notify({ kind: 'cell', id, phase: 'retired', collision: false });
      return;
    }
    if (read && read.phase !== slot.phase) {
      slot.phase = read.phase;
      if (read.phase === 'active') {
        if (!read.renderSelection || !ground(id))
          throw Error(`Active cell ${id} lacks a completed picture or collision surface`);
        loaded.add(id);
        retired.delete(id);
        notify({
          kind: 'cell',
          id,
          phase: 'active',
          collision: true,
          picture: read.renderSelection,
        });
      }
    }
    const distance = distanceToCell(x, z, id);
    if (distance > streamingRadius.retire) seek(slot, 'unloaded');
    else if (distance <= streamingRadius.visible && read?.phase === 'prepared' && read.current)
      seek(slot, 'active');
    else if (distance > streamingRadius.visible + 96 && slot.target === 'active')
      seek(slot, 'prepared');
  };
  return {
    update(x, z, current, ahead) {
      if (failure) throw failure;
      for (const [id, slot] of live) reconcileCell(id, slot, x, z);
      if (!reading && !disposed) {
        const priority = !live.has(current) ? current : ahead.find((id) => !live.has(id));
        if (priority !== undefined && distanceToCell(x, z, priority) <= streamingRadius.prepare) {
          void request(priority);
        } else if (
          ![...live.values()].some(
            (slot) => slot.target === 'prepared' && slot.phase !== 'prepared',
          )
        ) {
          let nearest;
          let best = streamingRadius.prepare;
          for (const { id } of cells) {
            if (live.has(id)) continue;
            const distance = distanceToCell(x, z, id);
            if (distance < best) {
              nearest = id;
              best = distance;
            }
          }
          if (nearest !== undefined) void request(nearest);
        }
      }
    },
    active: (id) => live.get(id)?.phase === 'active',
    snapshot: () => ({
      live: [...live].map(([id, slot]) => ({ id, phase: slot.phase, target: slot.target })),
      visited: loaded.size,
      retired: [...retired],
    }),
    dispose() {
      disposed = true;
      for (const slot of live.values()) {
        slot.controller.abort();
        if (slot.source) assets.release(slot.source).unwrap();
      }
    },
  };
}

function planDrive(out, x, z, yaw, dt, cruise, drive, steering, keys) {
  const speed = cruise
    ? maximumSpeed
    : drive > 0
      ? keys?.downCode('ShiftLeft')
        ? maximumSpeed
        : 90 / 3.6
      : drive * (24 / 3.6);
  const heading = cruise
    ? Math.atan2(roadX(z - 8) - roadX(z), 8)
    : yaw + steering * (Math.abs(speed) > 0 ? 0.84 : 0.52) * dt;
  let nextZ = bound(z - Math.cos(heading) * speed * dt);
  let nextX = bound(cruise ? roadX(nextZ) : x + Math.sin(heading) * speed * dt);
  const step = Math.hypot(nextX - x, nextZ - z);
  const limit = Math.abs(speed) * dt;
  if (step > limit) {
    nextX = x + ((nextX - x) * limit) / step;
    nextZ = z + ((nextZ - z) * limit) / step;
  }
  out.speed = speed;
  out.heading = heading;
  out.nextX = nextX;
  out.nextZ = nextZ;
}

function driveFailure(error) {
  const causes = [];
  let cause = error.cause;
  while (cause != null && causes.length < 5) {
    causes.push(cause.stack ?? cause.message ?? String(cause));
    cause = cause.cause;
  }
  return {
    kind: 'failed',
    message: error.stack ?? String(error),
    reason: causes.join('\n'),
  };
}

export default function pineBasin(input) {
  return {
    plugins: [
      physics3d,
      {
        name: 'pine-basin',
        inject: ['world', 'assets', 'physics', 'executionBootstrapHost'],
        apply({ world, assets, physics, executionBootstrapHost }) {
          const { port, levelCandidates } = executionBootstrapHost;
          if (!(physics instanceof RapierPhysicsWorld3D) || !port || !levelCandidates)
            throw Error('Pine Basin requires the Engine Worker Level and Physics owners');
          registerBenchmarkVocabulary(world);
          const notify = (message) => port.postMessage(message);
          const place = landscape(world, assets);
          const stream = streamCells({
            assets,
            physics,
            levelCandidates,
            manifest: input.manifest,
            notify,
          });
          let x = roadX(start.z);
          let z = start.z;
          let yaw = Math.atan2(roadX(z - 8) - x, 8);
          let distance = 0;
          let cruise = false;
          let streaming = false;
          let paused = false;
          const drivePlan = { speed: 0, heading: 0, nextX: 0, nextZ: 0 };
          let nextReport = 0;
          let failed = false;
          place(x, z, yaw);
          port.onmessage = ({ data }) => {
            if (data.kind === 'start-streaming') streaming = true;
            if (data.kind === 'cruise') cruise = data.enabled;
          };
          world
            .addSystem(
              Update,
              defineSystem({
                name: 'pine-basin-drive',
                queries: [],
                fn: () => {
                  if (failed) return;
                  try {
                    const keys = world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)
                      ? world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY).keyboard
                      : undefined;
                    const key = (a, b) => Number(Boolean(keys?.downCode(a) || keys?.downCode(b)));
                    const drive = key('KeyW', 'ArrowUp') - key('KeyS', 'ArrowDown');
                    const steering = key('KeyD', 'ArrowRight') - key('KeyA', 'ArrowLeft');
                    if (drive || steering || z <= -worldEdge + 1) cruise = false;
                    const time = world.getResource(Time);
                    const dt = time.delta;
                    planDrive(drivePlan, x, z, yaw, dt, cruise, drive, steering, keys);
                    const { speed, heading, nextX, nextZ } = drivePlan;
                    const current = cellAt(x, z);
                    const entering = cellAt(nextX, nextZ);
                    const direction = heading + (speed < 0 ? Math.PI : 0);
                    const ahead = lookahead(x, z, direction, cruise, entering, speed === 0 ? 1 : 2);
                    if (streaming) stream.update(x, z, current, ahead);
                    paused = speed !== 0 && !stream.active(entering);
                    const movedX = paused ? x : nextX;
                    const movedZ = paused ? z : nextZ;
                    const travelled = Math.hypot(movedX - x, movedZ - z);
                    if (x !== movedX || z !== movedZ || yaw !== heading) {
                      distance += travelled;
                      x = movedX;
                      z = movedZ;
                      yaw = heading;
                      place(x, z, yaw);
                    }
                    if (time.elapsed >= nextReport) {
                      nextReport = time.elapsed + 0.15;
                      notify({
                        kind: 'position',
                        x,
                        z,
                        yaw,
                        distance,
                        speedKph: dt > 0 ? (travelled / dt) * 3.6 : 0,
                        current: cellAt(x, z),
                        cruise,
                        paused,
                        ...stream.snapshot(),
                      });
                    }
                  } catch (error) {
                    failed = true;
                    notify(driveFailure(error));
                  }
                },
              }),
            )
            .unwrap();
          return () => {
            port.onmessage = null;
            stream.dispose();
          };
        },
      },
    ],
  };
}
