import { type EntityHandle, Update, type World } from '@forgeax/engine-ecs';
import {
  FRAME_START_SCAN_SYSTEM_NAME,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputSnapshot,
} from '@forgeax/engine-input';
import { quat } from '@forgeax/engine-math';
import type { CameraExposure } from '@forgeax/engine-render';
import {
  CAMERA_EXPOSURE_MODE_AUTO,
  CAMERA_EXPOSURE_MODE_MANUAL,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  cameraExposureFromColumns,
  getActiveCamera,
  MeshFilter,
  type RenderSceneBounds,
  setActiveCamera,
  validateCameraExposure,
} from '@forgeax/engine-render';
import { Children, GlobalTransform, Name, Transform } from '@forgeax/engine-scene';

export interface AppObservation {
  readonly worldIdentity: string;
  readonly executionReport: () => unknown;
  readonly camera: { readonly get: () => unknown; readonly set: (value: unknown) => unknown };
  readonly find: (value: { readonly name?: string; readonly limit?: number }) => unknown;
  readonly focus: (value: unknown) => Promise<unknown>;
  /** Re-assert the observation camera after all World systems and before draw. */
  readonly prepareFrame: () => void;
  /** Return control to the game camera and remove the transient observation camera. */
  readonly release: () => void;
}

/** Apply the shared Engine pointer-look rotation to an observation transform. */
export function rotateObservationCamera(
  current: ArrayLike<number>,
  movementX: number,
  movementY: number,
): ReturnType<typeof quat.create> {
  const orientation = quat.rotateAxis(quat.create(), current, [0, 1, 0], -movementX * 0.003);
  quat.rotateAxis(orientation, orientation, [1, 0, 0], -movementY * 0.003);
  return orientation;
}

function finiteVector(value: unknown, length: number): number[] | undefined {
  if (!Array.isArray(value) || value.length < length) return undefined;
  const vector = value.slice(0, length).map(Number);
  return vector.every(Number.isFinite) ? vector : undefined;
}

function jsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? String(value) : value;
  }
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, seen));
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const next = jsonValue(entry, seen);
      return next === undefined || typeof next === 'function' ? [] : [[key, next]];
    }),
  );
}

export function createAppObservation(
  world: World,
  renderer: {
    bounds(
      world: World,
      entity: number,
    ): RenderSceneBounds | undefined | Promise<RenderSceneBounds | undefined>;
  },
  execution: { readonly report: () => unknown },
): AppObservation {
  const observationSystem = 'app-observation-camera-ownership';
  const firstCameraEntity = (): EntityHandle | undefined => {
    const cameras = world.query({ with: [Camera, Transform] }).unwrap();
    for (const row of cameras) return row.entity as EntityHandle;
    return undefined;
  };
  const resolveGameCameraEntity = (): EntityHandle | undefined => {
    const active = getActiveCamera(world)?.entity as EntityHandle | undefined;
    if (active !== undefined && world.get(active, Camera).ok && world.get(active, Transform).ok) {
      return active;
    }
    // Rendering already falls back to the first camera when ActiveCamera is
    // absent. Observation must use the same rule so authored scene cameras
    // remain inspectable without a separate runtime selection resource.
    return firstCameraEntity();
  };
  let observationEntity: EntityHandle | undefined;
  let gameCameraEntity: EntityHandle | undefined;
  let ownershipInstalled = false;
  const rememberGameCamera = () => {
    const active = getActiveCamera(world)?.entity as EntityHandle | undefined;
    if (
      active !== undefined &&
      active !== observationEntity &&
      world.get(active, Camera).ok &&
      world.get(active, Transform).ok
    )
      gameCameraEntity = active;
  };

  const cameraValue = (entity: EntityHandle): Record<string, unknown> => {
    const value = world.get(entity, Camera);
    if (!value.ok) throw new Error('live-camera-invalid-entity: entity has no Camera');
    const json = jsonValue(value.value);
    if (json === null || typeof json !== 'object' || Array.isArray(json))
      throw new Error('live-camera-invalid-entity: Camera data is not serializable');
    return json as Record<string, unknown>;
  };

  const transformValue = (entity: EntityHandle): Record<string, unknown> => {
    const value = world.get(entity, Transform);
    if (!value.ok) throw new Error('live-camera-invalid-entity: entity has no Transform');
    return {
      pos: Array.from(value.value.pos),
      quat: Array.from(value.value.quat),
      scale: Array.from(value.value.scale),
    };
  };

  /**
   * Observation owns a runtime-only camera entity. Game camera entities are
   * never written by CLI or pointer controls; the last active game camera is
   * restored when the observation lease is released.
   */
  const acquire = (source: EntityHandle): EntityHandle => {
    if (!world.get(source, Camera).ok || !world.get(source, Transform).ok) {
      throw new Error('live-camera-invalid-entity: entity does not carry Camera and Transform');
    }
    installOwnershipSystem();
    if (observationEntity === undefined) gameCameraEntity = source;
    if (observationEntity !== undefined) {
      if (observationEntity !== source) {
        world.set(observationEntity, Camera, cameraValue(source) as never).unwrap();
        world.set(observationEntity, Transform, transformValue(source) as never).unwrap();
      }
      setActiveCamera(world, observationEntity);
      return observationEntity;
    }
    observationEntity = world
      .spawn(
        { component: Camera, data: cameraValue(source) as never },
        { component: Transform, data: transformValue(source) as never },
      )
      .unwrap();
    setActiveCamera(world, observationEntity);
    return observationEntity;
  };

  const release = (): void => {
    if (observationEntity === undefined) return;
    rememberGameCamera();
    const current = observationEntity;
    observationEntity = undefined;
    if (current !== undefined) world.despawn(current).unwrap();
    const next =
      gameCameraEntity !== undefined && world.get(gameCameraEntity, Camera).ok
        ? gameCameraEntity
        : firstCameraEntity();
    if (next !== undefined) setActiveCamera(world, next);
    gameCameraEntity = undefined;
    if (ownershipInstalled) {
      world.removeSystem(Update, observationSystem);
      ownershipInstalled = false;
    }
  };

  // A game camera system may select its own camera every frame. Re-assert the
  // explicit observation handoff after the frozen input snapshot is produced,
  // and remove this lease-owned system when control returns to the game.
  function installOwnershipSystem(): void {
    if (ownershipInstalled) return;
    world
      .addSystem(Update, {
        name: observationSystem,
        queries: [],
        after: [FRAME_START_SCAN_SYSTEM_NAME],
        fn: () => {
          const active = observationEntity;
          if (active === undefined) return;
          rememberGameCamera();
          const snapshot = world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)
            ? world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)
            : undefined;
          if (snapshot?.mouse.pointerLocked) {
            const transform = world.get(active, Transform);
            if (transform.ok) {
              const { x, y } = snapshot.mouse.movementDelta;
              const orientation = rotateObservationCamera(transform.value.quat, x, y);
              world.set(active, Transform, { quat: orientation }).unwrap();
            }
          }
          setActiveCamera(world, active);
        },
      })
      .unwrap();
    ownershipInstalled = true;
  }

  const cameraState = (): {
    readonly entity: number;
    readonly control: 'game' | 'observer';
    readonly transform: unknown;
    readonly camera: unknown;
    readonly lens: unknown;
    readonly exposure: CameraExposure;
  } => {
    const active = resolveGameCameraEntity();
    if (active === undefined)
      throw new Error('live-camera-unavailable: no active camera is selected');
    const entity = active as EntityHandle;
    const camera = world.get(entity, Camera);
    const transform = world.get(entity, Transform);
    if (!camera.ok || !transform.ok)
      throw new Error('live-camera-unavailable: active entity is not a camera');
    const lens = {
      projection:
        camera.value.projection === CAMERA_PROJECTION_ORTHOGRAPHIC ? 'orthographic' : 'perspective',
      fov: camera.value.fov,
      aspect: camera.value.aspect,
      near: camera.value.near,
      far: camera.value.far,
      left: camera.value.left,
      right: camera.value.right,
      bottom: camera.value.bottom,
      top: camera.value.top,
    } as const;
    return {
      entity: active,
      control: active === observationEntity ? 'observer' : 'game',
      camera: jsonValue(camera.value),
      lens,
      exposure: cameraExposureFromColumns(camera.value),
      transform: {
        pos: Array.from(transform.value.pos),
        quat: Array.from(transform.value.quat),
        scale: Array.from(transform.value.scale),
      },
    };
  };
  const setCamera = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object')
      throw new TypeError('camera.set expects an object');
    const candidate = value as {
      readonly entity?: unknown;
      readonly position?: unknown;
      readonly target?: unknown;
      readonly up?: unknown;
      readonly rotation?: unknown;
      readonly quat?: unknown;
      readonly transform?: unknown;
      readonly lens?: unknown;
      readonly exposure?: unknown;
    };
    const entity =
      candidate.entity === undefined
        ? (observationEntity ?? resolveGameCameraEntity())
        : (candidate.entity as EntityHandle);
    if (entity === undefined)
      throw new Error('live-camera-unavailable: no active camera is selected');
    if (!Number.isSafeInteger(entity)) throw new TypeError('camera.set expects an integer entity');
    if (!world.get(entity, Camera).ok || !world.get(entity, Transform).ok) {
      throw new Error('live-camera-invalid-entity: entity does not carry Camera and Transform');
    }
    const transform =
      candidate.transform !== null && typeof candidate.transform === 'object'
        ? (candidate.transform as {
            readonly pos?: unknown;
            readonly quat?: unknown;
            readonly scale?: unknown;
          })
        : undefined;
    const lens =
      candidate.lens !== null && typeof candidate.lens === 'object'
        ? (candidate.lens as Record<string, unknown>)
        : undefined;
    const projectionValue = lens?.projection;
    const projection =
      projectionValue === 'perspective' || projectionValue === CAMERA_PROJECTION_PERSPECTIVE
        ? CAMERA_PROJECTION_PERSPECTIVE
        : projectionValue === 'orthographic' || projectionValue === CAMERA_PROJECTION_ORTHOGRAPHIC
          ? CAMERA_PROJECTION_ORTHOGRAPHIC
          : undefined;
    if (projectionValue !== undefined && projection === undefined)
      throw new TypeError("camera.set lens.projection expects 'perspective' or 'orthographic'");
    const cameraFields = [
      'fov',
      'aspect',
      'near',
      'far',
      'left',
      'right',
      'bottom',
      'top',
    ] as const;
    const cameraPatch: Record<string, unknown> = {};
    for (const field of cameraFields) {
      const value = lens?.[field];
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isFinite(value))
          throw new TypeError(`camera.set lens.${field} expects a finite number`);
        cameraPatch[field] = value;
      }
    }
    if (cameraPatch.aspect !== undefined && (cameraPatch.aspect as number) <= 0)
      throw new TypeError('camera.set lens.aspect expects a positive number');
    if (cameraPatch.near !== undefined && (cameraPatch.near as number) <= 0)
      throw new TypeError('camera.set lens.near expects a positive number');
    if (cameraPatch.far !== undefined && (cameraPatch.far as number) <= 0)
      throw new TypeError('camera.set lens.far expects a positive number');
    if (candidate.exposure !== undefined) {
      const exposure = validateCameraExposure(candidate.exposure as CameraExposure);
      if (exposure.kind === 'manual') {
        Object.assign(cameraPatch, {
          exposureMode: CAMERA_EXPOSURE_MODE_MANUAL,
          exposure: exposure.multiplier,
          compensationEv: 0,
          rangeEv: new Float32Array([-8, 8]),
          rates: new Float32Array([3, 1]),
        });
      } else {
        Object.assign(cameraPatch, {
          exposureMode: CAMERA_EXPOSURE_MODE_AUTO,
          exposure: exposure.fallback,
          compensationEv: exposure.compensationEv,
          rangeEv: new Float32Array(exposure.rangeEv),
          rates: new Float32Array(exposure.rates),
        });
      }
    }
    const observed = acquire(entity);
    if (projection !== undefined || Object.keys(cameraPatch).length > 0) {
      world
        .set(observed, Camera, {
          ...(projection === undefined ? {} : { projection }),
          ...cameraPatch,
        } as never)
        .unwrap();
    }
    const position =
      finiteVector(candidate.position, 3) ??
      finiteVector(transform?.pos, 3) ??
      Array.from(world.get(observed, Transform).unwrap().pos);
    const target = finiteVector(candidate.target, 3);
    const up = finiteVector(candidate.up, 3);
    const directRotation =
      finiteVector(transform?.quat, 4) ??
      finiteVector(candidate.rotation, 4) ??
      finiteVector(candidate.quat, 4);
    const orientation =
      directRotation ??
      (position !== undefined && target !== undefined
        ? quat.fromLookAt(
            quat.create(),
            position as [number, number, number],
            target as [number, number, number],
            (up ?? [0, 1, 0]) as [number, number, number],
          )
        : undefined);
    const scale = finiteVector(transform?.scale, 3);
    if (position !== undefined || orientation !== undefined || scale !== undefined) {
      world
        .set(observed, Transform, {
          ...(position === undefined ? {} : { pos: position as [number, number, number] }),
          ...(orientation === undefined ? {} : { quat: orientation }),
          ...(scale === undefined ? {} : { scale: scale as [number, number, number] }),
        })
        .unwrap();
    }
    return cameraState();
  };
  return {
    worldIdentity: world.identity,
    executionReport: () => execution.report(),
    camera: { get: cameraState, set: setCamera },
    find({ name, limit = 20 }) {
      const matches: { entity: number; name: string; position: number[] }[] = [];
      const bound = Math.max(1, Math.min(100, limit));
      const query = world.query({ read: [Name, GlobalTransform] }).unwrap();
      for (const row of query) {
        const value = row.get(Name).value;
        if (name !== undefined && !value.toLowerCase().includes(name.toLowerCase())) continue;
        if (matches.length === bound) return { matches, truncated: true };
        matches.push({
          entity: row.entity,
          name: value,
          position: Array.from(row.get(GlobalTransform).world).slice(12, 15),
        });
      }
      return { matches, truncated: false };
    },
    prepareFrame() {
      if (observationEntity !== undefined) {
        rememberGameCamera();
        setActiveCamera(world, observationEntity);
      }
    },
    async focus(value) {
      if (value === null || typeof value !== 'object')
        throw new TypeError('focus expects an object');
      const candidate = value as {
        readonly name?: string;
        readonly entity?: unknown;
        readonly camera?: unknown;
        readonly distance?: unknown;
        readonly target?: unknown;
        readonly up?: unknown;
        readonly position?: unknown;
      };
      let entity = candidate.entity as EntityHandle | undefined;
      if (candidate.name !== undefined) {
        if (entity !== undefined) throw new TypeError('focus expects either name or entity');
        for (const row of world.query({ read: [Name], with: [Transform] }).unwrap()) {
          if (row.get(Name).value !== candidate.name) continue;
          if (entity !== undefined)
            throw new Error(
              'live-target-ambiguous: multiple entities have this name; use find and an exact reference',
            );
          entity = row.entity;
        }
        if (entity === undefined)
          throw new Error('live-target-not-found: no entity has this exact name; use find');
      }
      if (!Number.isSafeInteger(entity))
        throw new TypeError('focus expects an exact name or entity');
      const target = world.get(entity as EntityHandle, GlobalTransform);
      if (!target.ok) throw new Error('live-focus-invalid-entity: target has no Transform');
      const cameraEntity = Number.isSafeInteger(candidate.camera)
        ? (candidate.camera as EntityHandle)
        : resolveGameCameraEntity();
      if (cameraEntity === undefined)
        throw new Error('live-camera-unavailable: no active camera is selected');
      if (!world.get(cameraEntity, Camera).ok || !world.get(cameraEntity, Transform).ok)
        throw new Error('live-camera-invalid-entity: selected entity has no Camera');
      const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      const pending = [entity as EntityHandle],
        visited = new Set<EntityHandle>();
      let hasBounds = false;
      while (pending.length > 0) {
        const child = pending.pop();
        if (child === undefined) break;
        if (visited.has(child)) continue;
        visited.add(child);
        const bounds = await renderer.bounds(world, child);
        if (bounds !== undefined) {
          for (const axis of [0, 1, 2] as const) {
            min[axis] = Math.min(min[axis] ?? Infinity, bounds.min[axis]);
            max[axis] = Math.max(max[axis] ?? -Infinity, bounds.max[axis]);
          }
          hasBounds = true;
        } else if (world.get(child, MeshFilter).ok) {
          throw new Error(
            'live-focus-bounds-unavailable: wait for the selected mesh to be extracted by the renderer',
          );
        }
        const children = world.get(child, Children);
        if (children.ok)
          for (const next of children.value.entities) pending.push(next as EntityHandle);
      }
      const center = hasBounds
        ? min.map((lo, axis) => (lo + (max[axis] ?? -Infinity)) / 2)
        : Array.from(target.value.world).slice(12, 15);
      const targetPosition = finiteVector(candidate.target, 3) ?? center;
      const radius = hasBounds
        ? Math.hypot(...min.map((lo, axis) => ((max[axis] ?? -Infinity) - lo) / 2)) +
          Math.hypot(...center.map((v, axis) => v - (targetPosition[axis] ?? 0)))
        : 0;
      const camera = world.get(cameraEntity, Camera).unwrap();
      const orthographic = camera.projection === CAMERA_PROJECTION_ORTHOGRAPHIC;
      let fittedDistance = 5;
      if (hasBounds) {
        if (
          !(camera.aspect > 0) ||
          !Number.isFinite(camera.aspect) ||
          (!orthographic && !(camera.fov > 0 && camera.fov < Math.PI))
        ) {
          throw new Error(
            'live-camera-invalid-projection: bounds framing requires a valid aspect and projection',
          );
        }
        const halfFov = Math.min(
          camera.fov / 2,
          Math.atan(Math.tan(camera.fov / 2) * camera.aspect),
        );
        fittedDistance = orthographic
          ? radius * 2 + Math.max(0.01, camera.near)
          : Math.max(0.01, (radius * 1.1) / Math.sin(halfFov), radius + camera.near);
      }
      const distance =
        typeof candidate.distance === 'number' && Number.isFinite(candidate.distance)
          ? Math.max(0.01, candidate.distance)
          : fittedDistance;
      const observed = acquire(cameraEntity);
      if (hasBounds) {
        const halfHeight = Math.max(0.01, (radius * 1.1) / Math.min(1, camera.aspect));
        world
          .set(observed, Camera, {
            near: Math.min(camera.near, Math.max(0.001, distance - radius)),
            far: Math.max(camera.far, distance + radius * 1.1 + 0.01),
            ...(orthographic
              ? {
                  left: -halfHeight * camera.aspect,
                  right: halfHeight * camera.aspect,
                  bottom: -halfHeight,
                  top: halfHeight,
                }
              : {}),
          })
          .unwrap();
      }
      const position =
        finiteVector(candidate.position, 3) ??
        ([targetPosition[0] ?? 0, targetPosition[1] ?? 0, (targetPosition[2] ?? 0) + distance] as [
          number,
          number,
          number,
        ]);
      const up = finiteVector(candidate.up, 3) ?? [0, 1, 0];
      const orientation = quat.fromLookAt(
        quat.create(),
        position,
        targetPosition as [number, number, number],
        up as [number, number, number],
      );
      world.set(observed, Transform, { pos: position, quat: orientation }).unwrap();
      return { ...cameraState(), pivot: [...targetPosition] };
    },
    release,
  };
}
