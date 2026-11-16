import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { readMutationEpoch } from '@forgeax/engine-ecs/projection';
import { Children, GlobalTransform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  PointLight,
  RectAreaLight,
  SpotLight,
} from '../../components';
import type { OutlineSnapshot } from '../../components/outline';
import { worldRenderResources } from '../../publication/resource-scope';
import type { RenderFeaturePlanContext } from '../plan';
import type { RenderFeatureExtractContext } from '../types';
import {
  helperBoxCorners,
  helperBoxLines,
  helperDirectionLines,
  helperSphereLines,
  transformHelperPoint,
} from './geometry';
import {
  type CapturedEditorAssistancePrimitive,
  EDITOR_ASSISTANCE_LIMITS,
  type EditorAssistanceDepth,
  type EditorAssistanceInput,
  type EditorAssistanceMeshVersion,
  type EditorAssistanceOptions,
  type EditorAssistancePrimitive,
  type EditorAssistanceVector,
  readEditorAssistanceSource,
} from './state';

export interface EditorAssistanceSourceFrame {
  readonly sourceIdentity: string;
  readonly sourceMutationEpoch: number;
  readonly revision: number;
  readonly camera: EntityHandle | undefined;
  readonly outline: OutlineSnapshot | undefined;
  readonly primitives: readonly CapturedEditorAssistancePrimitive[];
  readonly meshes: readonly EditorAssistanceMeshVersion[];
  readonly truncated: boolean;
}
const CAMERA_COLOR = [0.35, 0.65, 1, 1] as const;
const LIGHT_COLOR = [1, 0.85, 0.25, 1] as const;
const BOUNDS_COLOR = [0.3, 1, 0.45, 1] as const;

type AppendPrimitive = (row: EditorAssistancePrimitive) => void;
type LightComponent =
  | typeof DirectionalLight
  | typeof PointLight
  | typeof SpotLight
  | typeof RectAreaLight;

interface CameraDiagramRow {
  readonly entity: EntityHandle;
  readonly transform: ArrayLike<number>;
  readonly near: number;
  readonly far: number;
  readonly aspect: number;
  readonly fov: number;
  readonly projection: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly top: number;
}

function selectedEntityClosure(world: World, input: EditorAssistanceInput) {
  const selected = new Set<EntityHandle>();
  const pending = [...input.selected, ...(input.hovered === undefined ? [] : [input.hovered])];
  let truncated = false;
  while (pending.length > 0) {
    const entity = pending.pop() as EntityHandle;
    if (selected.has(entity) || !world.componentsOf(entity).ok) continue;
    if (selected.size >= EDITOR_ASSISTANCE_LIMITS.selection) {
      truncated = true;
      break;
    }
    selected.add(entity);
    const children = world.get(entity, Children);
    if (children.ok)
      for (const child of children.value.entities) pending.push(child as EntityHandle);
  }
  return { selected, truncated };
}

function appendCameraDiagrams(
  world: World,
  options: EditorAssistanceOptions,
  camera: EntityHandle | undefined,
  append: AppendPrimitive,
) {
  if (options.icons || options.cameraFrusta) {
    const query = world.query({ read: [Camera, GlobalTransform] }).unwrap();
    for (const span of query.spans().unwrap()) {
      const entities = span.entities;
      const cameras = span.get(Camera);
      const transforms = span.get(GlobalTransform).world;
      for (let row = 0; row < span.length; row += 1) {
        const entity = entities[row] as EntityHandle;
        if (entity === camera) continue;
        const transformOffset = row * 16;
        appendCameraRow(
          {
            entity,
            transform: transforms.subarray(transformOffset, transformOffset + 16),
            near: cameras.near[row] ?? 0,
            far: cameras.far[row] ?? 0,
            aspect: cameras.aspect[row] ?? 0,
            fov: cameras.fov[row] ?? 0,
            projection: cameras.projection[row] ?? 0,
            left: cameras.left[row] ?? 0,
            right: cameras.right[row] ?? 0,
            bottom: cameras.bottom[row] ?? 0,
            top: cameras.top[row] ?? 0,
          },
          options,
          append,
        );
      }
    }
  }
}

function appendCameraRow(
  row: CameraDiagramRow,
  options: EditorAssistanceOptions,
  append: AppendPrimitive,
) {
  const position: EditorAssistanceVector = [
    row.transform[12] ?? 0,
    row.transform[13] ?? 0,
    row.transform[14] ?? 0,
  ];
  if (options.icons)
    append({
      kind: 'icon',
      icon: 'camera',
      position,
      pixels: 24,
      depth: options.depth,
      color: CAMERA_COLOR,
      action: { kind: 'entity', entity: row.entity },
    });
  if (options.cameraFrusta && validCameraFrustum(row)) appendCameraFrustum(row, options, append);
}

function validCameraFrustum(row: CameraDiagramRow): boolean {
  return (
    [row.near, row.far, row.aspect, row.fov].every(Number.isFinite) &&
    row.near > 0 &&
    row.far > row.near
  );
}

function appendCameraFrustum(
  row: CameraDiagramRow,
  options: EditorAssistanceOptions,
  append: AppendPrimitive,
) {
  const corners = Array.from({ length: 8 }, (_, index): EditorAssistanceVector => {
    const z = index & 4 ? row.far : row.near;
    const h = Math.tan(row.fov / 2) * z;
    const point: EditorAssistanceVector =
      row.projection === 1
        ? [index & 1 ? row.right : row.left, index & 2 ? row.top : row.bottom, -z]
        : [(index & 1 ? 1 : -1) * h * row.aspect, (index & 2 ? 1 : -1) * h, -z];
    return transformHelperPoint(row.transform, point);
  });
  for (const line of helperBoxLines(corners, CAMERA_COLOR, options.depth)) append(line);
}

function appendLightDiagrams(
  world: World,
  options: EditorAssistanceOptions,
  append: AppendPrimitive,
) {
  if (options.icons || options.lightRanges) {
    for (const component of [DirectionalLight, PointLight, SpotLight, RectAreaLight] as const) {
      const query = world.query({ with: [component], read: [GlobalTransform] }).unwrap();
      for (const span of query.spans().unwrap()) {
        const entities = span.entities;
        const transforms = span.get(GlobalTransform).world;
        for (let row = 0; row < span.length; row += 1) {
          const entity = entities[row] as EntityHandle;
          const transformOffset = row * 16;
          const transform = transforms.subarray(transformOffset, transformOffset + 16);
          const position: EditorAssistanceVector = [
            transforms[transformOffset + 12] ?? 0,
            transforms[transformOffset + 13] ?? 0,
            transforms[transformOffset + 14] ?? 0,
          ];
          if (options.icons)
            append({
              kind: 'icon',
              icon: 'light',
              position,
              pixels: 24,
              depth: options.depth,
              color: LIGHT_COLOR,
              action: { kind: 'entity', entity },
            });
          if (!options.lightRanges) continue;
          appendLightRange(world, entity, component, transform, position, options, append);
        }
      }
    }
  }
}

function appendLightRange(
  world: World,
  entity: EntityHandle,
  component: LightComponent,
  transform: ArrayLike<number>,
  position: EditorAssistanceVector,
  options: EditorAssistanceOptions,
  append: AppendPrimitive,
) {
  if (component === PointLight) {
    const light = world.get(entity, PointLight).unwrap();
    for (const line of helperSphereLines(position, light.range, LIGHT_COLOR, options.depth))
      append(line);
  } else if (component === SpotLight) {
    const light = world.get(entity, SpotLight).unwrap();
    const length = Number.isFinite(light.range) ? light.range : 1;
    for (const line of helperDirectionLines(
      position,
      light.direction,
      length,
      Number.isFinite(light.range) ? (light.outerConeDeg * Math.PI) / 180 : undefined,
      LIGHT_COLOR,
      options.depth,
    ))
      append(line);
  } else if (component === DirectionalLight) {
    const light = world.get(entity, DirectionalLight).unwrap();
    for (const line of helperDirectionLines(
      position,
      light.direction,
      1,
      undefined,
      LIGHT_COLOR,
      options.depth,
    ))
      append(line);
  } else if (component === RectAreaLight) {
    const light = world.get(entity, RectAreaLight).unwrap();
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([x, y]) =>
      transformHelperPoint(transform, [
        ((x ?? 0) * light.width) / 2,
        ((y ?? 0) * light.height) / 2,
        0,
      ]),
    );
    for (let i = 0; i < 4; i++)
      append({
        kind: 'line',
        start: corners[i] as EditorAssistanceVector,
        end: corners[(i + 1) % 4] as EditorAssistanceVector,
        color: LIGHT_COLOR,
        depth: options.depth,
      });
    for (const line of helperDirectionLines(
      position,
      [-(transform[8] ?? 0), -(transform[9] ?? 0), -(transform[10] ?? 1)],
      Number.isFinite(light.range) ? light.range : 1,
      undefined,
      LIGHT_COLOR,
      options.depth,
    ))
      append(line);
  }
}

function appendSelectedGeometry(
  world: World,
  selected: ReadonlySet<EntityHandle>,
  options: EditorAssistanceOptions,
  primitives: readonly CapturedEditorAssistancePrimitive[],
  append: AppendPrimitive,
) {
  const resources = worldRenderResources(world);
  if (options.bounds || options.collision)
    for (const entity of selected) {
      const mesh = world.get(entity, MeshFilter),
        transform = world.get(entity, GlobalTransform);
      if (!mesh.ok || !transform.ok) continue;
      const asset = resources.resolveAsset(mesh.value.assetHandle);
      if (!asset.ok || asset.value.kind !== 'mesh') continue;
      if (options.bounds && asset.value.aabb !== undefined)
        for (const line of helperBoxLines(
          helperBoxCorners(asset.value.aabb, transform.value.world),
          BOUNDS_COLOR,
          options.depth,
        ))
          append(line);
      if (options.collision && asset.value.collision !== undefined) {
        appendCollisionGeometry(
          asset.value.collision,
          transform.value.world,
          options.depth,
          primitives,
          append,
        );
      }
    }
}

function appendCollisionGeometry(
  collision: NonNullable<MeshAsset['collision']>,
  transform: ArrayLike<number>,
  depth: EditorAssistanceDepth,
  primitives: readonly CapturedEditorAssistancePrimitive[],
  append: AppendPrimitive,
) {
  const point = (index: number): EditorAssistanceVector =>
    transformHelperPoint(transform, [
      collision.positions[index * 3] ?? 0,
      collision.positions[index * 3 + 1] ?? 0,
      collision.positions[index * 3 + 2] ?? 0,
    ]);
  for (
    let i = 0;
    i + 2 < collision.indices.length && primitives.length < EDITOR_ASSISTANCE_LIMITS.primitives;
    i += 3
  ) {
    const triangle = [collision.indices[i], collision.indices[i + 1], collision.indices[i + 2]];
    for (let edge = 0; edge < 3; edge++)
      append({
        kind: 'line',
        start: point(triangle[edge] ?? 0),
        end: point(triangle[(edge + 1) % 3] ?? 0),
        color: BOUNDS_COLOR,
        depth: depth,
      });
  }
}

/** Runs once in the source realm. Disabled games allocate no assistance frame. */
export function extractEditorAssistance(
  context: RenderFeatureExtractContext,
): EditorAssistanceSourceFrame | undefined {
  const { world } = context;
  const input = readEditorAssistanceSource(world);
  if (input === undefined) return undefined;
  const camera =
    input.options.camera ??
    (context.views.find((view) => view.render)?.selectedCamera?.entityKey as
      | EntityHandle
      | undefined);
  const selection = selectedEntityClosure(world, input);
  const selected = selection.selected;
  let truncated = selection.truncated;
  const primitives: CapturedEditorAssistancePrimitive[] = [];
  let icons = 0;
  const append = (row: EditorAssistancePrimitive) => {
    if (
      primitives.length >= EDITOR_ASSISTANCE_LIMITS.primitives ||
      (row.kind === 'icon' && icons >= EDITOR_ASSISTANCE_LIMITS.icons)
    ) {
      truncated = true;
      return;
    }
    if (row.action !== undefined && !world.componentsOf(row.action.entity).ok) return;
    primitives.push(row);
    if (row.kind === 'icon') icons++;
  };
  // Manipulators and explicit user geometry retain priority over optional diagrams.
  for (const row of input.primitives) append(row);
  appendCameraDiagrams(world, input.options, camera, append);
  appendLightDiagrams(world, input.options, append);
  appendSelectedGeometry(world, selected, input.options, primitives, append);
  if (selected.size === 0 && primitives.length === 0) return undefined;
  const referenced = new Set(
    primitives.flatMap((row) => (row.kind === 'mesh' ? [`${row.mesh}:${row.meshRevision}`] : [])),
  );
  const seen = new Set<string>();
  const meshes = input.meshes.flatMap((mesh) => {
    const key = `${mesh.handle}:${mesh.revision}`;
    if (!referenced.has(key) || seen.has(key)) return [];
    seen.add(key);
    if (
      context.referenceAssetVersion !== undefined &&
      mesh.revision !== undefined &&
      mesh.value !== undefined
    ) {
      context.referenceAssetVersion({
        handle: mesh.handle,
        revision: mesh.revision,
        value: mesh.value,
      });
      return [{ handle: mesh.handle, revision: mesh.revision }];
    }
    return [mesh];
  });
  return Object.freeze({
    sourceIdentity: world.identity,
    sourceMutationEpoch: readMutationEpoch(world),
    revision: input.revision,
    camera,
    outline:
      selected.size === 0
        ? undefined
        : Object.freeze({ ...input.outline, entities: Object.freeze([...selected]) }),
    primitives: Object.freeze(primitives),
    meshes: Object.freeze(meshes),
    truncated,
  });
}

/** Both delivery paths resolve the exact contribution version; local delivery borrows its fixed value. */
export function resolveEditorAssistanceMesh(
  mesh: EditorAssistanceMeshVersion,
  context: Pick<RenderFeaturePlanContext, 'resolveAsset'>,
) {
  if (mesh.value !== undefined) return mesh.value;
  if (mesh.revision === undefined) return undefined;
  const value = context.resolveAsset?.(mesh.handle, mesh.revision);
  return value?.ok && value.value.kind === 'mesh' ? value.value : undefined;
}
