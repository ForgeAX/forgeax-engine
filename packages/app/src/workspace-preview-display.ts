import type { EntityHandle } from '@forgeax/engine-ecs';
import { createWireframeGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { disposePluginFiber, type Plugin } from '@forgeax/engine-plugin';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import type { App } from './types';
import {
  EngineWorkspaceError,
  type EngineWorkspacePreview,
  type EngineWorkspacePreviewDisplay,
} from './workspace';
import { workspaceMeshTriangles } from './workspace-asset-facts';

type Display = NonNullable<EngineWorkspacePreview['display']>;
type Options = { readonly mesh: MeshAsset; readonly entity: EntityHandle };
declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    engineWorkspacePreviewDisplay?: Display;
  }
}

function wireframe(mesh: MeshAsset): MeshAsset {
  const triangles: number[] = [];
  workspaceMeshTriangles(mesh, (a, b, c) => {
    triangles.push(a, b, c);
  });
  return createWireframeGeometry({
    ...mesh,
    indices: new Uint32Array(triangles),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: triangles.length,
        vertexCount: (mesh.attributes.position?.byteLength ?? 0) / 12,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
  }).unwrap();
}

function boundsMesh(aabb: readonly number[]): MeshAsset {
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++)
    for (let axis = 0; axis < 3; axis++)
      positions[i * 3 + axis] = Number(aabb[axis + ((i >> axis) & 1) * 3]);
  const edges: number[] = [];
  for (let i = 0; i < 8; i++)
    for (let axis = 0; axis < 3; axis++) if (!(i & (1 << axis))) edges.push(i, i | (1 << axis));
  // Match Geometry's wireframe carrier layout for the shared unlit preview material.
  const attributes = {
    position: positions,
    normal: new Float32Array(24),
    uv: new Float32Array(16),
    tangent: new Float32Array(32),
  };
  const packed = packInterleavedVertexAttributes(attributes, 8).unwrap();
  return {
    kind: 'mesh',
    vertices: packed.vertices,
    attributes,
    indices: new Uint32Array(edges),
    aabb: new Float32Array(aabb),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: edges.length,
        vertexCount: 8,
        topology: 'line-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Bounds' }],
  };
}

/** Native child of the exact preview App; all generated geometry stays in this realm. */
export const workspaceMeshDisplayPlugin: Plugin.Object<Options> = {
  name: 'forgeax:workspace-mesh-display',
  inject: ['world', 'assets'],
  provide: ['engineWorkspacePreviewDisplay'],
  apply(ctx, { mesh, entity }) {
    const world = ctx.world;
    const assets = ctx.assets;
    if (!assets) throw new TypeError('Preview display requires the runtime asset owner');
    const originalFilter = { ...world.get(entity, MeshFilter).unwrap() };
    const originalRenderer = {
      ...world.get(entity, MeshRenderer).unwrap(),
      materials: Array.from(world.get(entity, MeshRenderer).unwrap().materials),
    };
    const transform = world.get(entity, Transform).unwrap();
    const placement = {
      pos: Array.from(transform.pos),
      quat: Array.from(transform.quat),
      scale: Array.from(transform.scale),
    };
    const handles: number[] = [];
    const overlays = new Map<string, EntityHandle>();
    const carriers = new Map<
      string,
      { mesh: AssetHandle<'mesh'>; material: AssetHandle<'material'> }
    >();
    let available = true;
    let state: EngineWorkspacePreviewDisplay = {
      mode: 'material',
      collision: false,
      bounds: false,
      capabilities: {
        wireframe:
          (mesh.attributes.position instanceof Float32Array ||
            mesh.attributes.position instanceof ArrayBuffer) &&
          mesh.submeshes.every(
            (section) =>
              section.topology === 'triangle-list' || section.topology === 'triangle-strip',
          ),
        collision: mesh.collision !== undefined,
        bounds: mesh.aabb !== undefined && Array.from(mesh.aabb).every(Number.isFinite),
      },
    };
    const assertAvailable = () => {
      if (!available)
        throw new EngineWorkspaceError(
          'engine-workspace-capability-unavailable',
          'A live preview display plugin',
        );
    };
    ctx.effect(() => () => {
      available = false;
      if (world.get(entity, MeshFilter).ok) {
        world.set(entity, MeshFilter, originalFilter).unwrap();
        world.set(entity, MeshRenderer, originalRenderer).unwrap();
      }
      for (const overlay of overlays.values())
        if (world.get(overlay, MeshFilter).ok) world.despawn(overlay).unwrap();
      for (const handle of handles.reverse()) assets.release(handle).unwrap();
    });
    assets.retain(originalFilter.assetHandle, 'mesh').unwrap();
    handles.push(originalFilter.assetHandle);
    for (const handle of originalRenderer.materials)
      if (handle) {
        assets.retain(handle, 'material').unwrap();
        handles.push(handle);
      }
    const carrier = (
      key: string,
      build: () => MeshAsset,
      color: [number, number, number, number],
    ) => {
      const existing = carriers.get(key);
      if (existing) return existing;
      const geometry = build();
      const geometryRef = assets.create(geometry).unwrap();
      handles.push(geometryRef);
      const material = assets.create(Materials.unlit(color)).unwrap();
      handles.push(material);
      const value = { mesh: geometryRef, material };
      carriers.set(key, value);
      return value;
    };
    const overlay = (key: string, show: boolean, value?: ReturnType<typeof carrier>) => {
      const current = overlays.get(key);
      if (!show && current) {
        world.despawn(current).unwrap();
        overlays.delete(key);
      }
      if (show && !current && value)
        overlays.set(
          key,
          world
            .spawn(
              { component: Transform, data: placement },
              { component: MeshFilter, data: { assetHandle: value.mesh } },
              { component: MeshRenderer, data: { materials: [value.material] } },
            )
            .unwrap(),
        );
    };
    ctx.provide('engineWorkspacePreviewDisplay', {
      get(options) {
        options?.signal?.throwIfAborted();
        assertAvailable();
        return structuredClone(state);
      },
      set(input, options) {
        options?.signal?.throwIfAborted();
        assertAvailable();
        const next = {
          mode: input.mode === undefined ? state.mode : input.mode,
          collision: input.collision === undefined ? state.collision : input.collision,
          bounds: input.bounds === undefined ? state.bounds : input.bounds,
        };
        if (next.mode !== 'material' && next.mode !== 'wireframe')
          throw new TypeError('Display mode must be material or wireframe');
        if (typeof next.collision !== 'boolean' || typeof next.bounds !== 'boolean')
          throw new TypeError('Display overlays require booleans');
        for (const key of ['wireframe', 'collision', 'bounds'] as const)
          if (
            (key === 'wireframe' ? next.mode === 'wireframe' : next[key]) &&
            !state.capabilities[key]
          )
            throw new EngineWorkspaceError(
              'engine-workspace-capability-unavailable',
              `Preview ${key} data`,
            );
        // Prepare resources before changing the visible subject or overlay state.
        const lines =
          next.mode === 'wireframe'
            ? carrier('wireframe', () => wireframe(mesh), [0.85, 0.9, 1, 1])
            : undefined;
        const collision = next.collision
          ? carrier('collision', () => {
              const data = mesh.collision;
              if (!data)
                throw new EngineWorkspaceError(
                  'engine-workspace-capability-unavailable',
                  'An existing collision attachment',
                );
              return wireframe({
                kind: 'mesh',
                vertices: data.positions,
                attributes: { position: data.positions },
                indices: data.indices,
                submeshes: [
                  {
                    indexOffset: 0,
                    indexCount: data.indices.length,
                    vertexCount: data.positions.length / 3,
                    topology: 'triangle-list',
                    materialSlot: 0,
                  },
                ],
                materialSlots: [{ slotName: 'Collision' }],
              });
            }, [0.1, 1, 0.35, 1])
          : undefined;
        const bounds = next.bounds
          ? carrier('bounds', () => {
              if (!mesh.aabb)
                throw new EngineWorkspaceError(
                  'engine-workspace-capability-unavailable',
                  'An existing mesh AABB',
                );
              return boundsMesh(Array.from(mesh.aabb));
            }, [1, 0.65, 0.05, 1])
          : undefined;
        world
          .set(entity, MeshFilter, lines ? { assetHandle: lines.mesh } : originalFilter)
          .unwrap();
        world
          .set(
            entity,
            MeshRenderer,
            lines ? { ...originalRenderer, materials: [lines.material] } : originalRenderer,
          )
          .unwrap();
        overlay('collision', next.collision, collision);
        overlay('bounds', next.bounds, bounds);
        state = { ...next, capabilities: state.capabilities };
        return structuredClone(state);
      },
    });
  },
};

export async function createWorkspaceMeshDisplay(app: App, mesh: MeshAsset, entity: EntityHandle) {
  const scope = app.pluginContext.isolate('engineWorkspacePreviewDisplay');
  const fiber = scope.plugin(workspaceMeshDisplayPlugin, { mesh, entity });
  await fiber.await();
  const display = fiber.ctx.get('engineWorkspacePreviewDisplay');
  if (!display)
    throw new EngineWorkspaceError(
      'engine-workspace-capability-unavailable',
      'The preview display service',
    );
  return {
    display,
    async close() {
      const result = await disposePluginFiber(fiber);
      if (result.cleanup !== 'completed')
        throw new EngineWorkspaceError(
          'engine-workspace-plugin-cleanup-failed',
          'Preview display cleanup to finish',
        );
    },
  };
}
