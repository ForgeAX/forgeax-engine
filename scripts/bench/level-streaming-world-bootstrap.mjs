import { createWorldStreaming } from '../../packages/app/dist/index.mjs';
import { runtimeAssets } from '../../packages/assets-runtime/dist/internal.mjs';
import { defineSystem, FixedUpdate, Time, Update } from '../../packages/ecs/dist/index.mjs';
import { createBoxGeometry, createCylinderGeometry } from '../../packages/geometry/dist/index.mjs';
import { INPUT_SNAPSHOT_RESOURCE_KEY } from '../../packages/input/dist/index.mjs';
import { quat, vec3 } from '../../packages/math/dist/index.mjs';
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
import { skinningPlugin } from '../../packages/skinning/dist/index.mjs';
import {
  cellAt,
  cellMeters,
  cells,
  groundHeight,
  landscapeRibbon,
  roadX,
  start,
  streamingRadius,
  terrainMesh,
  worldEdge,
} from './fixtures/level-streaming-landscape.mjs';
import { createWildlife } from './fixtures/pine-basin-wildlife-runtime.mjs';
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
    const place = (x, z, heading) => {
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
    return {
      place,
      focus({ x, y, z }) {
        const eye = [x + 5.6, y + 3.1, z + 5.2];
        world
          .set(camera, Transform, {
            pos: eye,
            quat: quat.fromLookAt(quat.create(), eye, [x, y + 1.25, z], [0, 1, 0]),
          })
          .unwrap();
      },
    };
  } finally {
    for (const handle of owned) assets.release(handle).unwrap();
  }
}

function* basinMetadata(manifest) {
  for (const { id, collision, proxy, west, east } of manifest) {
    const { x, z } = cells[id];
    const bounds = { minX: x, minZ: z, maxX: x + cellMeters, maxZ: z + cellMeters };
    const visualBounds = {
      minX: x - 48,
      minZ: z - 48,
      maxX: x + cellMeters + 48,
      maxZ: z + cellMeters + 48,
    };
    yield { key: `${id}/collision`, scene: collision, bounds, role: 'collision' };
    const group = String(id);
    yield {
      key: `${id}/proxy`,
      scene: proxy,
      bounds: visualBounds,
      role: 'visual',
      layer: 'scenery',
      replacement: { group, role: 'proxy' },
    };
    for (const [key, scene] of [
      ['west', west],
      ['east', east],
    ])
      yield {
        key: `${id}/${key}`,
        scene,
        bounds: visualBounds,
        role: 'visual',
        layer: 'scenery',
        replacement: { group, role: 'detail' },
      };
  }
}

function streamCells({ assets, physics, levels, manifest, notify }) {
  const stream = createWorldStreaming(levels, {
    grid: { cellSize: cellMeters, pageSize: 2, originX: -worldEdge, originZ: -worldEdge },
    cells: basinMetadata(manifest),
    buildUnitsPerStep: 24,
    simultaneousPreparations: 2,
  }).unwrap();
  const visited = new Set();
  const retired = new Set();
  let active = new Set();
  const origin = vec3.create();
  const down = vec3.create(0, -1, 0);
  const hasGround = (x, z) => {
    origin[0] = x;
    origin[1] = 600;
    origin[2] = z;
    return physics.raycast(origin, down, 700) !== undefined;
  };
  const activeAt = (x, z) =>
    stream.inspectCell(`${cellAt(x, z)}/collision`)?.collisionAccepted === true && hasGround(x, z);
  const observe = () => {
    const snapshot = stream.inspect();
    if (snapshot.failures.length > 0) throw snapshot.failures[0];
    const live = [];
    const next = new Set();
    for (const { key, phase, target, failure } of snapshot.active) {
      if (failure) throw failure;
      if (!key.endsWith('/collision')) continue;
      const id = Number(key.split('/')[0]);
      live.push({ id, phase, target });
      if (phase !== 'active') continue;
      const { x, z } = cells[id];
      if (!hasGround(x + cellMeters / 2, z + cellMeters / 2))
        throw Error(`Missing collision in Cell ${id}`);
      next.add(id);
      if (!active.has(id)) {
        visited.add(id);
        retired.delete(id);
        notify({ kind: 'cell', id, phase: 'active', collision: true });
      }
    }
    for (const id of active) {
      if (live.some((cell) => cell.id === id)) {
        next.add(id);
        continue;
      }
      const { x, z } = cells[id];
      if (hasGround(x + cellMeters / 2, z + cellMeters / 2))
        throw Error(`Retired Cell ${id} still collides`);
      retired.add(id);
      notify({ kind: 'cell', id, phase: 'retired', collision: false });
    }
    active = next;
    return {
      live,
      visited: visited.size,
      retired: [...retired],
      index: snapshot.index,
      started: snapshot.started,
      released: snapshot.retired,
      residents: snapshot.active.length,
      bytes: runtimeAssets(assets).inspect().bytes,
      visual: snapshot.active.filter(({ key }) => !key.endsWith('/collision')),
    };
  };
  return {
    update(x, z, heading, speed, destination) {
      stream
        .setSource('vehicle', {
          x,
          z,
          prepareRadius: streamingRadius.prepare,
          activeRadius: streamingRadius.visible,
          detailRadius: 360,
          hysteresis: streamingRadius.retire - streamingRadius.prepare,
        })
        .unwrap();
      stream
        .setSource('road-ahead', {
          x: x + Math.sin(heading) * speed * 5,
          z: z - Math.cos(heading) * speed * 5,
          prepareRadius: 96,
          activeRadius: 48,
          roleFilter: 'collision',
          priority: 2048,
        })
        .unwrap();
      stream
        .setSource(
          'destination',
          destination === undefined
            ? undefined
            : {
                ...destination,
                prepareRadius: 32,
                activeRadius: 6,
                roleFilter: 'collision',
                priority: 4096,
              },
        )
        .unwrap();
      stream.step().unwrap();
    },
    activeAt,
    ready(destination) {
      return (
        stream.inspectEntry('destination', destination).state === 'ready' &&
        activeAt(destination.x, destination.z)
      );
    },
    tookOver(destination) {
      return stream.inspectEntry('vehicle', destination).state === 'ready';
    },
    setLayer: (enabled) => stream.setLayer('scenery', enabled),
    snapshot: observe,
    dispose: () => stream.close(),
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
    ? Math.atan2(roadX(z - 8 * cruise) - roadX(z), 8 * cruise)
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

function readDrivingInput(world) {
  const keys = world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)
    ? world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY).keyboard
    : undefined;
  const key = (a, b) => Number(Boolean(keys?.downCode(a) || keys?.downCode(b)));
  return {
    keys,
    drive: key('KeyW', 'ArrowUp') - key('KeyS', 'ArrowDown'),
    steering: key('KeyD', 'ArrowRight') - key('KeyA', 'ArrowLeft'),
  };
}

function stopCruise(cruise, z, drive, steering) {
  return (
    drive !== 0 ||
    steering !== 0 ||
    (cruise > 0 && z <= -worldEdge + 1) ||
    (cruise < 0 && z >= worldEdge - 1)
  );
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
      skinningPlugin(),
      {
        name: 'pine-basin',
        inject: ['world', 'assets', 'physics', 'levels', 'executionBootstrapHost'],
        apply({ world, assets, physics, levels, executionBootstrapHost }) {
          const { port } = executionBootstrapHost;
          if (!(physics instanceof RapierPhysicsWorld3D) || !port)
            throw Error('Pine Basin requires the Engine Worker Level and Physics owners');
          registerBenchmarkVocabulary(world);
          const notify = (message) => port.postMessage(message);
          const view = landscape(world, assets);
          const place = (x, z, yaw) => {
            if (!focused) view.place(x, z, yaw);
          };
          const onFailure = (error) => {
            failed = true;
            notify(driveFailure(error));
          };
          const wildlife = createWildlife(world, assets, input.wildlife.scene, onFailure);
          const stream = streamCells({
            assets,
            physics,
            levels,
            manifest: input.manifest,
            notify,
          });
          let x = roadX(start.z);
          let z = start.z;
          let yaw = Math.atan2(roadX(z - 8) - x, 8);
          let distance = 0;
          let cruise = 0;
          let streaming = false;
          let destination;
          let arrivalHold;
          let teleports = 0;
          let paused = false;
          const drivePlan = { speed: 0, heading: 0, nextX: 0, nextZ: 0 };
          let nextReport = 0;
          let failed = false;
          let focused = false;
          place(x, z, yaw);
          port.onmessage = ({ data }) => {
            if (data.kind === 'start-streaming') {
              streaming = true;
              wildlife.start();
            }
            if (data.kind === 'focus-wildlife') {
              const position = wildlife.focus(data.enabled);
              focused = data.enabled && position !== undefined;
              if (focused) view.focus(position);
              else place(x, z, yaw);
            }
            if (data.kind === 'cruise') cruise = data.enabled ? 1 : 0;
            if (data.kind === 'cruise-direction') cruise = data.direction === -1 ? -1 : 0;
            if (data.kind === 'scenery') stream.setLayer(data.enabled);
            if (data.kind === 'teleport') {
              cruise = 0;
              const requestedZ = bound(data.z);
              destination = { x: roadX(requestedZ), z: requestedZ };
            }
          };
          const teleport = defineSystem({
            name: 'pine-basin-teleport',
            queries: [],
            fn: () => {
              if (destination === undefined || !stream.ready(destination)) return;
              x = destination.x;
              z = destination.z;
              yaw = Math.atan2(roadX(z - 8) - x, 8);
              arrivalHold = destination;
              destination = undefined;
              teleports++;
              place(x, z, yaw);
            },
          });
          world.addSystem(FixedUpdate, teleport).unwrap();
          const driver = defineSystem({
            name: 'pine-basin-drive',
            queries: [],
            fn: () => {
              if (failed) return;
              try {
                const { keys, drive, steering } = readDrivingInput(world);
                if (stopCruise(cruise, z, drive, steering)) cruise = 0;
                const time = world.getResource(Time);
                const dt = time.delta;
                wildlife.update(dt);
                planDrive(drivePlan, x, z, yaw, dt, cruise, drive, steering, keys);
                const { speed, heading, nextX, nextZ } = drivePlan;
                if (streaming) {
                  stream.update(x, z, heading, speed, destination ?? arrivalHold);
                  if (arrivalHold !== undefined && stream.tookOver(arrivalHold))
                    arrivalHold = undefined;
                }
                paused = speed !== 0 && !stream.activeAt(nextX, nextZ);
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
                    cruise: cruise !== 0,
                    paused,
                    teleportPending: destination !== undefined,
                    teleports,
                    wildlife: wildlife.inspect(),
                    ...stream.snapshot(),
                  });
                }
              } catch (error) {
                onFailure(error);
              }
            },
          });
          world.addSystem(Update, driver).unwrap();
          return () => {
            port.onmessage = null;
            world.removeSystem(Update, driver).unwrap();
            world.removeSystem(FixedUpdate, teleport).unwrap();
            stream.dispose();
            wildlife.dispose();
          };
        },
      },
    ],
  };
}
