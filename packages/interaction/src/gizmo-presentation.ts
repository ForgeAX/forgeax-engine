import type { EntityHandle } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createCylinderGeometry,
  createTorusGeometry,
} from '@forgeax/engine-geometry';
import { quat, vec3 } from '@forgeax/engine-math';
import { Materials, MeshFilter, MeshRenderer, Visibility } from '@forgeax/engine-render';
import { Name, Transform } from '@forgeax/engine-scene';
import type {
  Handle,
  MaterialAsset,
  MaterialParameter,
  MaterialPass,
  MeshAsset,
} from '@forgeax/engine-types';
import { add, mul, type V3 } from './gizmo-math';
import type { GizmoHandle, GizmoMode, TransformGizmo } from './transform-gizmo';

const COLORS = [
  [1, 0.12, 0.09, 1],
  [0.15, 0.88, 0.3, 1],
  [0.12, 0.4, 1, 1],
  [1, 0.78, 0.06, 1],
] as const;
interface Part {
  entity: EntityHandle;
  handle: GizmoHandle;
  modes: readonly GizmoMode[];
  offset: V3;
  rotation: quat.Quat;
  color: number;
  last: string;
}
/** Retained ordinary meshes: no custom GPU pipeline, per-frame geometry, or DOM overlay. */
export function createGizmoPresentation(gizmo: TransformGizmo): { sync(): void; dispose(): void } {
  const world = gizmo.world;
  const parts: Part[] = [];
  const handles: Array<Handle<'MeshAsset' | 'MaterialAsset', 'shared'>> = [];
  const meshes = [
    createCylinderGeometry(0.018, 0.018, 0.72, 10),
    createCylinderGeometry(0, 0.07, 0.2, 12),
    createBoxGeometry(0.12, 0.12, 0.12),
    createTorusGeometry(1, 0.018, 6, 64),
    createBoxGeometry(0.24, 0.24, 0.014),
  ].map((r) => {
    const h = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', r.unwrap());
    handles.push(h);
    return h;
  });
  const materials = COLORS.map((c) => {
    const m = Materials.unlit(c, {
      queue: 4000,
      renderState: { depthCompare: 'always', depthWriteEnabled: false, cullMode: 'none' },
    });
    const h = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      parameters: m.parameters as readonly MaterialParameter[],
      values: { baseColor: c },
      passes: [m.passes?.[0] as MaterialPass],
    });
    handles.push(h);
    return h;
  });
  const addPart = (
    handle: GizmoHandle,
    modes: readonly GizmoMode[],
    mesh: number,
    offset: V3,
    rotation: quat.Quat,
    color: number,
  ) => {
    const entity = world
      .spawn(
        { component: Name, data: { value: `TransformGizmo:${handle}:${mesh}` } as never },
        { component: Transform, data: {} },
        {
          component: MeshFilter,
          data: { assetHandle: meshes[mesh] as Handle<'MeshAsset', 'shared'> },
        },
        {
          component: MeshRenderer,
          data: { materials: [materials[color] as Handle<'MaterialAsset', 'shared'>] },
        },
        { component: Visibility, data: { state: 1 } },
      )
      .unwrap();
    parts.push({ entity, handle, modes, offset, rotation, color, last: '' });
  };
  for (let i = 0; i < 3; i++) {
    const axis: V3 = i === 0 ? [1, 0, 0] : i === 1 ? [0, 1, 0] : [0, 0, 1];
    const q = quat.create();
    quat.fromUnitVectors(q, [0, 1, 0], axis);
    const h = (['X', 'Y', 'Z'] as const)[i] as 'X' | 'Y' | 'Z';
    addPart(h, ['translate', 'scale'], 0, mul(axis, 0.54), q, i);
    addPart(h, ['translate'], 1, mul(axis, 0.9), q, i);
    addPart(h, ['scale'], 2, axis, quat.identity(quat.create()), i);
    const ring = quat.create();
    quat.fromUnitVectors(ring, [0, 0, 1], axis);
    addPart(h, ['rotate'], 3, [0, 0, 0], ring, i);
  }
  for (const [h, offset, normal, c] of [
    ['XY', [0.34, 0.34, 0], [0, 0, 1], 2],
    ['YZ', [0, 0.34, 0.34], [1, 0, 0], 0],
    ['XZ', [0.34, 0, 0.34], [0, 1, 0], 1],
  ] as const) {
    const q = quat.create();
    quat.fromUnitVectors(q, [0, 0, 1], normal);
    addPart(h, ['translate'], 4, offset, q, c);
  }
  addPart('XYZ', ['translate', 'scale'], 2, [0, 0, 0], quat.identity(quat.create()), 3);
  let disposed = false;
  return {
    sync() {
      if (disposed) return;
      const f = gizmo.frame;
      for (const p of parts) {
        const visible = f?.visible.includes(p.handle) && p.modes.includes(gizmo.options.mode);
        if (!f || !visible) {
          if (p.last !== 'hidden') world.set(p.entity, Visibility, { state: 1 }).unwrap();
          p.last = 'hidden';
          continue;
        }
        const offset = quat.transformVec3(vec3.create(), f.orientation, p.offset);
        const pos = add(
          f.origin,
          mul([offset[0] as number, offset[1] as number, offset[2] as number], f.radius),
        );
        const rotation = quat.create();
        quat.multiply(rotation, f.orientation, p.rotation);
        const highlighted = gizmo.hovered === p.handle;
        const key = [...pos, ...rotation, f.radius, highlighted].join(',');
        if (key === p.last) continue;
        world
          .set(p.entity, Transform, { pos, quat: rotation, scale: [f.radius, f.radius, f.radius] })
          .unwrap();
        world.set(p.entity, Visibility, { state: 2 }).unwrap();
        world
          .set(p.entity, MeshRenderer, {
            materials: [materials[highlighted ? 3 : p.color] as Handle<'MaterialAsset', 'shared'>],
          })
          .unwrap();
        p.last = key;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gizmo.cancel();
      for (const p of parts) world.despawn(p.entity).unwrap();
      for (const h of handles) world.sharedRefs.release(h).unwrap();
    },
  };
}
