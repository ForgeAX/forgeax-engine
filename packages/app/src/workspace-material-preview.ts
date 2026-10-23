import type { EntityHandle } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createCylinderGeometry,
  createPlaneGeometry,
  createSphereGeometry,
} from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import { disposePluginFiber, type Plugin } from '@forgeax/engine-plugin';
import { MeshFilter } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { App } from './types';
import { EngineWorkspaceError } from './workspace';

export type MaterialPreviewMesh = 'sphere' | 'cylinder' | 'plane' | 'cube';
export interface MaterialPreviewState {
  readonly mesh: MaterialPreviewMesh;
  readonly rotation: readonly number[];
  readonly center: readonly number[];
  readonly radius: number;
}
export interface MaterialPreviewControl {
  get(): MaterialPreviewState | Promise<MaterialPreviewState>;
  set(mesh: MaterialPreviewMesh): MaterialPreviewState | Promise<MaterialPreviewState>;
  rotate(input: {
    readonly yaw: number;
    readonly pitch: number;
  }): MaterialPreviewState | Promise<MaterialPreviewState>;
  reset(): MaterialPreviewState | Promise<MaterialPreviewState>;
}
declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    engineWorkspaceMaterialPreview?: MaterialPreviewControl;
  }
}

function geometry(mesh: MaterialPreviewMesh) {
  switch (mesh) {
    case 'sphere':
      return createSphereGeometry(1, 32, 24).unwrap();
    case 'cylinder':
      return createCylinderGeometry(Math.SQRT1_2, Math.SQRT1_2, Math.SQRT2, 32, 1).unwrap();
    case 'plane':
      return createPlaneGeometry(Math.SQRT2, Math.SQRT2).unwrap();
    case 'cube':
      return createBoxGeometry(2 / Math.sqrt(3), 2 / Math.sqrt(3), 2 / Math.sqrt(3)).unwrap();
    default:
      throw new TypeError('Material preview mesh must be sphere, cylinder, plane or cube');
  }
}

/** One native child of a material preview; the authored material is never mutated. */
export const workspaceMaterialPreviewPlugin: Plugin.Object<{ readonly entity: EntityHandle }> = {
  name: 'forgeax:workspace-material-preview',
  inject: ['world', 'assets'],
  provide: ['engineWorkspaceMaterialPreview'],
  apply(ctx, { entity }) {
    const world = ctx.world,
      assets = ctx.assets;
    if (!assets) throw new TypeError('Material preview requires the runtime asset owner');
    const originalFilter = { ...world.get(entity, MeshFilter).unwrap() };
    const original = Array.from(world.get(entity, Transform).unwrap().quat);
    const center = Array.from(world.get(entity, Transform).unwrap().pos);
    const handle = assets.create(geometry('sphere')).unwrap();
    assets.retain(originalFilter.assetHandle, 'mesh').unwrap();
    let available = true;
    let mesh: MaterialPreviewMesh = 'sphere';
    ctx.effect(() => () => {
      available = false;
      if (world.get(entity, MeshFilter).ok) world.set(entity, MeshFilter, originalFilter).unwrap();
      if (world.get(entity, Transform).ok)
        world.set(entity, Transform, { quat: original }).unwrap();
      assets.release(handle).unwrap();
      assets.release(originalFilter.assetHandle).unwrap();
    });
    world.set(entity, MeshFilter, { assetHandle: handle }).unwrap();
    const get = (): MaterialPreviewState => {
      if (!available)
        throw new EngineWorkspaceError(
          'engine-workspace-capability-unavailable',
          'A live material preview plugin',
        );
      return {
        mesh,
        rotation: Array.from(world.get(entity, Transform).unwrap().quat),
        center: [...center],
        radius: 1,
      };
    };
    ctx.provide('engineWorkspaceMaterialPreview', {
      get,
      set(next) {
        get();
        if (next !== mesh) {
          assets.replace(handle, geometry(next)).unwrap();
          mesh = next;
        }
        return get();
      },
      rotate({ yaw, pitch }) {
        get();
        if (![yaw, pitch].every((value) => typeof value === 'number' && Number.isFinite(value)))
          throw new TypeError('Material rotation requires finite yaw and pitch in radians');
        const transform = world.get(entity, Transform).unwrap();
        const rotation = quat.rotateAxis(quat.create(), transform.quat, [0, 1, 0], yaw);
        quat.rotateAxis(rotation, rotation, [1, 0, 0], pitch);
        world.set(entity, Transform, { quat: Array.from(rotation) }).unwrap();
        return get();
      },
      reset() {
        get();
        world.set(entity, Transform, { quat: original }).unwrap();
        return get();
      },
    });
  },
};

export async function createWorkspaceMaterialPreview(app: App, entity: EntityHandle) {
  const scope = app.pluginContext.isolate('engineWorkspaceMaterialPreview');
  const fiber = scope.plugin(workspaceMaterialPreviewPlugin, { entity });
  await fiber.await();
  const material = fiber.ctx.get('engineWorkspaceMaterialPreview');
  if (!material)
    throw new EngineWorkspaceError(
      'engine-workspace-capability-unavailable',
      'The material preview service',
    );
  return {
    material,
    async close() {
      const result = await disposePluginFiber(fiber);
      if (result.cleanup !== 'completed')
        throw new EngineWorkspaceError(
          'engine-workspace-plugin-cleanup-failed',
          'Material preview cleanup to finish',
        );
    },
  };
}
