import type { EntityHandle } from '@forgeax/engine-ecs';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import { type CanvasTextureSource, PointSizeUnitsValue } from '@forgeax/engine-render';
import type {
  AssetHandle,
  ClippingOptions,
  MaterialTextureValue,
  MaterialValue,
  MeshAsset,
  ResolvedMaterialTextureCoordinates,
  SamplerAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import {
  BatchedMesh,
  BufferGeometry,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshNormalMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Object3D,
  Points,
  PointsMaterial,
  RedFormat,
  Scene,
  SkinnedMesh,
  Sprite,
  SpriteMaterial,
  Texture,
  VideoTexture,
} from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';
import { isExternalTexture } from './external-textures';
import { projectFlatNormals } from './flat-normals';
import {
  type GeometryMaterial,
  geometryValues,
  type pointContentEdit,
  projectGeometry,
} from './geometry';
import { isCollapsedInstance, projectInstanceGeometry } from './instance-geometry';
import { lineStyle } from './lines';
import {
  type MaterialSurfaceValues,
  materialTextures,
  type SupportedMaterial,
  stockMaterialParameterPatch,
  usesFlatShading,
  validateMaterial,
} from './material';
import {
  isBasicMaterial,
  isLineMaterial,
  isMatcapMaterial,
  isPhysicalMaterial,
  isPointsMaterial,
  isStandardMaterial,
} from './material-kinds';
import { admitSurfaceInput, surfaceInput, usesTransmission } from './node-inputs';
import { plainNodeMaterial } from './node-materials';
import { hasSurfaceBinding, type SurfaceInputObservation } from './node-surface';
import type { SceneBuffers, ScenePreparation } from './scene-state';
import { sameValues } from './shared-assets';
import type { CpuSkinGeometry, projectJoints } from './skinning';
import { observedData, ownSourceValue } from './source-fields';
import { textureCoordinates } from './texture';
import type { UvProjection } from './uv-projection';

const stockDrawMaterials = new Set<object>([
  MeshBasicMaterial.prototype,
  MeshStandardMaterial.prototype,
  LineBasicMaterial.prototype,
  LineDashedMaterial.prototype,
  MeshPhysicalMaterial.prototype,
  MeshNormalMaterial.prototype,
  MeshLambertMaterial.prototype,
  MeshMatcapMaterial.prototype,
  PointsMaterial.prototype,
  SpriteMaterial.prototype,
]);
export type Renderable = Mesh | Line | Points | Sprite;
export function isRenderable(object: Object3D): object is Renderable {
  return (
    object instanceof Mesh ||
    object instanceof Line ||
    object instanceof Points ||
    object instanceof Sprite
  );
}

/** One stock material's unoverridden inputs within this submission. */
export interface MaterialObservation {
  readonly source: Material;
  readonly material: SupportedMaterial;
  readonly surface: MaterialSurfaceValues | undefined;
  textures?: ReturnType<typeof materialTextures>;
  values?: readonly unknown[];
  sharedMesh?: boolean;
  untexturedMeshUses?: (readonly [MaterialUse] | undefined)[];
  published?: Map<string, PublishedMaterialUse>;
}

interface PublishedMaterialUse {
  readonly use: MaterialUse;
  readonly asset: MaterialPublication;
}

interface MaterialAddress {
  readonly source: Material;
  readonly variant: string;
  readonly shading: 0 | 1;
}

export interface MaterialDependencies {
  readonly address: MaterialAddress;
  readonly surfaceInputs?: readonly { name: string; offset: number }[] | undefined;
  readonly textures: readonly {
    readonly parameter: string;
    readonly source: Texture;
    readonly projection: TextureProjection | undefined;
    readonly canvas: CanvasTextureSource | undefined;
  }[];
}

export interface MaterialPublication {
  readonly handle: AssetHandle<'material'>;
  readonly address: MaterialAddress;
}

export function meshMaterialPublication(
  materials: readonly MaterialUse[],
  publications: ReadonlyMap<MaterialUse, MaterialPublication>,
): MeshMaterialPublication {
  const handles: AssetHandle<'material'>[] = [];
  const addresses: MaterialAddress[] = [];
  for (const use of materials) {
    const asset = publications.get(use);
    if (asset === undefined)
      throw new Error('admitted material missing its managed asset reference');
    handles.push(asset.handle);
    addresses.push(asset.address);
  }
  return { handles, addresses };
}

export interface MeshMaterialResidency {
  readonly source: Material | readonly Material[];
  readonly override: Material | null;
  readonly addresses: readonly MaterialAddress[];
}

interface MeshMaterialPublication {
  readonly handles: AssetHandle<'material'>[];
  readonly addresses: readonly MaterialAddress[];
}

export interface MaterialUse {
  readonly source: Material;
  readonly effective: SupportedMaterial;
  readonly observation?: MaterialObservation;
  variant: string;
  readonly clipping?: ClippingOptions;
  readonly shading: 0 | 1;
  skinProgram: 'unlit' | 'standard' | undefined;
  readonly coordinates: Map<Texture, ResolvedMaterialTextureCoordinates>;
}
export interface MeshGeometryPlan {
  readonly source: BufferGeometry;
  readonly variant: string;
  readonly structure: GeometryStructure;
}

interface GeometryStructure {
  readonly topology: GeometryShape['topology'];
  readonly grouped: boolean;
  readonly wireframe: boolean;
  readonly selection: readonly GeometryMaterial[];
  readonly generatedUvChannels: readonly string[];
  readonly uvValues: readonly unknown[];
  readonly flatMatcap: ReadonlySet<number>;
  readonly expanded: boolean;
  readonly instanceTint: readonly number[] | undefined;
  readonly cpuSkin: boolean;
  readonly morphColor: boolean;
  readonly shared: boolean;
}

/** One geometry variant prepared for this submission, shared by matching uses. */
export interface MeshGeometryAsset {
  readonly values: readonly unknown[];
  readonly acceptedValues: readonly unknown[] | undefined;
  readonly payload: MeshAsset | undefined;
  readonly sourceData: GeometrySourceData | undefined;
  readonly pointEdit: PointGeometryEdit | undefined;
  handle: AssetHandle<'mesh'> | undefined;
}

type PointGeometryEdit = ReturnType<typeof pointContentEdit> & {
  readonly base: readonly unknown[];
};

export interface MeshGeometryProjection {
  readonly payload: MeshAsset | undefined;
  readonly sourceData?: GeometrySourceData | undefined;
  readonly pointEdit?: PointGeometryEdit | undefined;
}

type NativeInstanceWrite =
  | { readonly kind: 'replace'; readonly transforms: Float32Array }
  | {
      readonly kind: 'patch';
      readonly ranges: readonly { readonly start: number; readonly values: Float32Array }[];
    };

export type NativeInstanceChange =
  | NativeInstanceWrite
  | { readonly kind: 'borrowed'; write?: NativeInstanceWrite };

/** Source layout only; a new sync observes material values and acquires its own leases. */
export interface OrdinaryMeshLayout {
  readonly geometry: MeshGeometryPlan;
  readonly source: Material;
  readonly variant: string;
  readonly shading: 0 | 1;
  readonly uv: UvProjection;
}

export interface MeshPlan {
  readonly geometry: MeshGeometryPlan;
  readonly asset: MeshGeometryAsset;
  shareable?: boolean;
  blended?: boolean;
  ordinaryMesh?: OrdinaryMeshLayout | undefined;
  uv?: UvProjection | undefined;
  readonly materials: readonly MaterialUse[];
  materialPublication?: MeshMaterialPublication;
  readonly instanceValues?: readonly unknown[] | undefined;
  readonly instances?: NativeInstanceChange | undefined;
  readonly nativeInstances: boolean;
  readonly morphWeights?: Float32Array | undefined;
  readonly pointStyle?: ReturnType<typeof pointStyle> | undefined;
  readonly lineStyle?: NonNullable<ReturnType<typeof lineStyle>> | undefined;
  readonly skin?:
    | ({
        skeleton: AssetHandle<'skeleton'>;
        affinePoint: boolean;
      } & (
        | { kind: 'source'; joints: readonly EntityHandle[]; variant: string }
        | {
            kind: 'projected';
            joints: ReturnType<typeof projectJoints>;
            patch?: { version: number; indices: number[] } | undefined;
          }
      ))
    | undefined;
}
/** These bindings persist while view-dependent visibility or ordering is evaluated. */
export function trackableViewDraw(
  frame: ScenePreparation,
  node: Renderable,
  plan: MeshPlan,
): boolean {
  if (frame.buffers.shadowMap?.enabled && node.castShadow) return false;
  const prototype = Object.getPrototypeOf(node);
  if (
    ![
      Mesh.prototype,
      Points.prototype,
      Line.prototype,
      LineSegments.prototype,
      Sprite.prototype,
      InstancedMesh.prototype,
    ].includes(prototype) ||
    frame.buffers.transparentSort
  )
    return false;
  const sources = Array.isArray(node.material) ? node.material : [node.material];
  return sources.every(
    (source) =>
      (stockDrawMaterials.has(Object.getPrototypeOf(source)) ||
        plainNodeMaterial(source) ||
        (hasSurfaceBinding(source) &&
          frame.buffers.nativeTransparentOrder === true &&
          prototype === Mesh.prototype &&
          !Array.isArray(node.material))) &&
      plan.materials.some((use) => use.source === source),
  );
}

export function ordinaryMeshMaterial(
  frame: ScenePreparation,
  object: Renderable,
  planes: ClippingOptions | undefined,
  admitted?: Renderable['material'],
): Material | undefined {
  const qualifies =
    planes === undefined &&
    Object.getPrototypeOf(object) === Mesh.prototype &&
    (object as Mesh).morphTargetInfluences === undefined &&
    overrideMaterial(frame.scene) === null;
  const material = qualifies
    ? (admitted ?? (ownSourceValue(object, 'material') as Renderable['material'] | undefined))
    : undefined;
  return Array.isArray(material) ? undefined : material;
}

export function reuseOrdinaryMaterial(
  frame: ScenePreparation,
  material: Material,
  geometry: BufferGeometry,
  layout: OrdinaryMeshLayout,
): MaterialObservation | undefined {
  if (
    layout.source !== material ||
    layout.geometry.source !== geometry ||
    !material.visible ||
    !ordinaryMeshSurface(material) ||
    !ordinaryGeometryReads(frame, geometry)
  )
    return undefined;
  const observation = observeMaterial(frame, material, material, false);
  if (observation === undefined) return undefined;
  if (!matchesOrdinaryMaterialLayout(frame, geometry, layout, observation.material))
    return undefined;
  return observation;
}

function matchesOrdinaryMaterialLayout(
  frame: ScenePreparation,
  geometry: BufferGeometry,
  layout: OrdinaryMeshLayout,
  effective: MaterialObservation['material'],
): boolean {
  const slot = layout.geometry.structure.selection[0];
  return !(
    slot === undefined ||
    ('wireframe' in effective && effective.wireframe) ||
    slot.vertexColors !== effective.vertexColors ||
    slot.tangentBasis !== materialTangentBasis(effective) ||
    layout.shading !== Number(usesFlatShading(effective, geometry.hasAttribute('normal'))) ||
    (isBlended(effective) ? !frame.buffers.transparent : !frame.buffers.opaque)
  );
}

export function registerOrdinaryMeshPlan(
  frame: ScenePreparation,
  plan: MeshPlan,
  geometry: BufferGeometry,
  original: Material,
  shared: Map<Material, MeshPlan> | undefined,
): void {
  const use = plan.materials[0];
  if (use?.observation === undefined || !plan.geometry.structure.shared) return;
  if (
    plan.ordinaryMesh === undefined &&
    plan.uv?.values.length === 0 &&
    plan.asset.payload?.morphTargets === undefined &&
    !plan.geometry.structure.wireframe &&
    allowsSharedMeshPlan(frame, plan, geometry)
  ) {
    plan.ordinaryMesh = {
      geometry: plan.geometry,
      source: original,
      variant: use.variant,
      shading: use.shading,
      uv: plan.uv,
    };
  }
  const byMaterial = shared ?? new Map();
  if (shared === undefined) frame.lists.sharedMeshPlans.set(geometry, byMaterial);
  byMaterial.set(original, plan);
}

export interface AssetTexturePlan {
  readonly orientation: 0 | 1;
  readonly variant: '' | 'scalar-color' | 'scalar-data';
  readonly source: Texture;
  readonly values: unknown[];
  readonly payload: TextureAsset;
  readonly sampler: SamplerAsset;
  readonly samplerValues: unknown[];
  readonly acceptedTexture: readonly unknown[] | undefined;
  readonly acceptedSampler: readonly unknown[] | undefined;
}
export interface CanvasTexturePlan {
  readonly source: Texture;
  readonly canvas: CanvasTextureSource;
  readonly sampler: SamplerAsset;
  readonly samplerValues: unknown[];
  readonly acceptedSampler: readonly unknown[] | undefined;
}
export type TexturePlan = AssetTexturePlan | CanvasTexturePlan;

export type TextureProjection = 0 | 1 | 2 | 3 | 4;
export const textureProjectionSlots = [
  [0, ''],
  [1, ''],
  [0, 'scalar-color'],
  [1, 'scalar-color'],
  [0, 'scalar-data'],
] as const;
export type TextureBuckets<T> = [
  Map<Texture, T> | undefined,
  Map<Texture, T> | undefined,
  Map<Texture, T> | undefined,
  Map<Texture, T> | undefined,
  Map<Texture, T> | undefined,
];
export type TextureBindings = TextureBuckets<MaterialTextureValue>;

export const POINT_CONTENT = { kind: 'point-content' } as const;

export type GeometrySourceData =
  | typeof POINT_CONTENT
  | {
      readonly kind: 'skin';
      readonly values: readonly unknown[];
      readonly geometry: CpuSkinGeometry;
    }
  | {
      readonly kind: 'instances';
      readonly values: readonly unknown[];
      readonly geometry: MeshAsset;
    };

/** Which source projection of a renderable's geometry this draw needs. */
export interface GeometryShape {
  readonly topology: 'point-list' | 'line-list' | 'line-strip' | 'triangle-list';
  readonly grouped: boolean;
  readonly selection: readonly GeometryMaterial[];
  readonly wireframe: boolean;
  readonly uv: UvProjection;
  readonly flatMatcap: ReadonlySet<number>;
  readonly expanded: boolean;
  readonly instanceTint: readonly number[] | undefined;
  readonly cpuSkin: boolean;
  readonly morphColor: boolean;
}

/**
 * Match upstream's cache update boundary, including frozen matrices and cameras
 * whose parent lives outside the submitted root. Do not walk/update external parents.
 */

export function recordUpload(uploadedTextures: Set<Texture>, texture: Texture): void {
  const image = texture.image as { complete?: boolean } | null | undefined;
  if (texture.version > 0 && image != null && image.complete !== false)
    uploadedTextures.add(texture);
}

export function overrideMaterial(scene: Object3D): Material | null {
  return scene instanceof Scene ? scene.overrideMaterial : null;
}

export function matchesMaterialRoster(
  scene: Object3D,
  object: Renderable,
  residency: MeshMaterialResidency | undefined,
): residency is MeshMaterialResidency {
  if (residency === undefined || residency.override !== overrideMaterial(scene)) return false;
  const source = object.material;
  return (
    residency.source === source ||
    (Array.isArray(residency.source) &&
      Array.isArray(source) &&
      sameValues(residency.source, source))
  );
}

export function sourceTopology(object: Renderable): GeometryShape['topology'] {
  if (object instanceof Points) return 'point-list';
  if (object instanceof LineSegments) return 'line-list';
  return object instanceof Line ? 'line-strip' : 'triangle-list';
}

function primitiveSize(topology: GeometryShape['topology']): number {
  if (topology === 'triangle-list') return 3;
  return topology === 'line-list' || topology === 'line-strip' ? 2 : 1;
}

/** Select each drawn material slot once, in source group order. */
export function selectMaterials(
  frame: ScenePreparation,
  object: Renderable,
  geometry: BufferGeometry,
  material: Renderable['material'],
  planes: ClippingOptions | undefined,
  coordinates: Map<Texture, ResolvedMaterialTextureCoordinates>,
  selection: GeometryMaterial[],
  list: MaterialUse[],
): void {
  const grouped = Array.isArray(material);
  const minimum = primitiveSize(sourceTopology(object));
  const available = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
  const groups = grouped ? geometry.groups : undefined;
  const count = groups?.length ?? 1;
  for (let i = 0; i < count; i++) {
    const group = groups?.[i];
    const start = group?.start ?? 0;
    if (drawnCount(geometry, start, group?.count ?? available, available) < minimum) continue;
    const slot = group?.materialIndex ?? 0;
    const original = grouped ? material[slot] : material;
    if (original === undefined || !original.visible || selection.some((item) => item.slot === slot))
      continue;
    const use = materialUse(frame, object, geometry, original, planes, coordinates);
    if (use === undefined) continue;
    selection.push({
      slot,
      vertexColors: use.effective.vertexColors,
      tangentBasis: materialTangentBasis(use.effective),
    });
    list.push(use);
  }
}

/** Only tangent-space consumers need a UV-derived frame; ordinary models share geometry. */
function materialTangentBasis(material: SupportedMaterial): 'normal' | 'uv' {
  return ('normalMap' in material && material.normalMap != null) ||
    ('bumpMap' in material && material.bumpMap != null) ||
    ('clearcoatNormalMap' in material && material.clearcoatNormalMap != null) ||
    ('anisotropyMap' in material && material.anisotropyMap != null) ||
    ('anisotropy' in material && material.anisotropy !== 0) ||
    ('normalNode' in material && material.normalNode != null) ||
    ('clearcoatNormalNode' in material && material.clearcoatNormalNode != null)
    ? 'uv'
    : 'normal';
}

export function nativeSkinMaterial(use: MaterialUse): boolean {
  return (
    !hasSurfaceBinding(use.effective) &&
    (use.skinProgram === 'unlit' ||
      (use.effective.type === 'MeshStandardMaterial' &&
        isStandardMaterial(use.effective) &&
        !isPhysicalMaterial(use.effective) &&
        use.shading === 0))
  );
}

/** Elements of one group that survive the geometry drawRange. */
function drawnCount(
  geometry: BufferGeometry,
  start: number,
  count: number,
  available: number,
): number {
  const first = Math.max(0, start, geometry.drawRange.start);
  const last = Math.min(
    available,
    start + count,
    geometry.drawRange.start + geometry.drawRange.count,
  );
  return last - first;
}

/** The validated material one slot draws with, or undefined when the requested buffers skip it. */
function materialUse(
  frame: ScenePreparation,
  object: Renderable,
  geometry: BufferGeometry,
  original: Material,
  planes: ClippingOptions | undefined,
  coordinates: Map<Texture, ResolvedMaterialTextureCoordinates>,
): MaterialUse | undefined {
  const scene = frame.scene;
  const material =
    scene instanceof Scene && original.allowOverride
      ? (scene.overrideMaterial ?? original)
      : original;
  const inheritedPosition = surfaceInput(original, 'positionNode');
  if (material !== original && inheritedPosition !== null && !('isNodeMaterial' in material))
    admitSurfaceInput(original, 'positionNode', inheritedPosition).unwrap();
  const observation = observeMaterial(frame, material, original, inheritedPosition !== null);
  const source =
    observation?.material ??
    validateMaterial(effectiveMaterial(material, original, frame.buffers)).unwrap();
  if (isBlended(source) ? !frame.buffers.transparent : !frame.buffers.opaque) return undefined;
  const shading = Number(usesFlatShading(source, geometry.hasAttribute('normal'))) as 0 | 1;
  return {
    source: material,
    effective: source,
    ...(observation === undefined ? {} : { observation }),
    shading,
    skinProgram: object instanceof SkinnedMesh && isBasicMaterial(source) ? 'unlit' : undefined,
    coordinates,
    variant: JSON.stringify([
      material === original ? '' : original.uuid,
      planes,
      object instanceof SkinnedMesh,
    ]),
    ...(planes === undefined ? {} : { clipping: planes }),
  };
}

export function observeMaterial(
  frame: ScenePreparation,
  material: Material,
  original: Material,
  inheritedPosition: boolean,
): MaterialObservation | undefined {
  const overridden = material !== original;
  const observations = overridden
    ? frame.lists.overrideObservations
    : frame.lists.materialObservations;
  const existing = observations.get(original);
  if (existing?.source === material) return existing;
  if (
    !stockMaterialInputs(material) ||
    (overridden && (inheritedPosition || !stockMaterialInputs(original)))
  )
    return undefined;
  const buffers = frame.buffers;
  const source =
    !overridden &&
    (buffers.depth || (!material.depthTest && !material.depthWrite)) &&
    (buffers.stencil || !material.stencilWrite)
      ? material
      : effectiveMaterial(material, original, buffers);
  let surface: MaterialSurfaceValues | undefined;
  const admitted = validateMaterial(source, (value) => {
    surface = value;
  }).unwrap();
  const observation = { source: material, material: admitted, surface };
  observations.set(original, observation);
  return observation;
}

/** One immutable observation per source during this frame. Authored getters stay on the
 * per-use path. Three's own Physical reflectivity property aliases IOR, which we read directly. */
function stockMaterialInputs(material: Material): boolean {
  const prototype = Object.getPrototypeOf(material);
  if (
    (!stockDrawMaterials.has(prototype) && !plainNodeMaterial(material)) ||
    hasSurfaceBinding(material)
  )
    return false;
  if (
    !hasDataProperties(
      material,
      prototype === MeshPhysicalMaterial.prototype ? 'reflectivity' : undefined,
    )
  )
    return false;
  const stock = material as SupportedMaterial;
  return (
    (!('color' in stock) || hasDataProperties(stock.color)) &&
    (!('emissive' in stock) ||
      (hasDataProperties(stock.emissive) && hasDataProperties(stock.normalScale))) &&
    (!isPhysicalMaterial(stock) ||
      (hasDataProperties(stock.clearcoatNormalScale) &&
        hasDataProperties(stock.sheenColor) &&
        hasDataProperties(stock.specularColor) &&
        hasDataProperties(stock.attenuationColor)))
  );
}

export function plainStockMaterial(material: Material): boolean {
  const prototype = Object.getPrototypeOf(material);
  return (
    (prototype === MeshBasicMaterial.prototype || prototype === MeshStandardMaterial.prototype) &&
    !hasSurfaceBinding(material)
  );
}

/** Formats with the same native binding and ordinary material value contract. */
export function ordinaryMeshSurface(material: Material): boolean {
  return (
    plainStockMaterial(material) || (!hasSurfaceBinding(material) && plainNodeMaterial(material))
  );
}

export function sameMaterialCoordinates(a: MaterialUse, b: MaterialUse): boolean {
  if (a.coordinates.size !== b.coordinates.size) return false;
  for (const [texture, left] of a.coordinates) {
    const right = b.coordinates.get(texture);
    if (left === right) continue;
    if (
      right?.set !== left.set ||
      left.transform?.rotation !== right.transform?.rotation ||
      left.transform?.offset[0] !== right.transform?.offset[0] ||
      left.transform?.offset[1] !== right.transform?.offset[1] ||
      left.transform?.scale[0] !== right.transform?.scale[0] ||
      left.transform?.scale[1] !== right.transform?.scale[1]
    )
      return false;
  }
  return true;
}

export function useTextures(use: MaterialUse): ReturnType<typeof materialTextures> {
  const observation = use.observation;
  if (observation?.textures !== undefined) return observation.textures;
  const textures = materialTextures(use.effective);
  // Preserve VideoTexture's live update at each use.
  if (observation !== undefined && !textures.some(([, texture]) => texture instanceof VideoTexture))
    observation.textures = textures;
  return textures;
}

function hasDataProperties(object: object, unread?: PropertyKey): boolean {
  for (const key of Reflect.ownKeys(object)) {
    if (key === unread) continue;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || !observedData(object, key, descriptor)) return false;
  }
  return true;
}

export function allowsSharedMeshPlan(
  frame: ScenePreparation,
  plan: MeshPlan,
  geometry: BufferGeometry,
): boolean {
  const use = plan.materials[0];
  if (use === undefined) return false;
  const observation = use.observation;
  if (observation === undefined) return false;
  return sharedMaterialReads(use, observation) && ordinaryGeometryReads(frame, geometry);
}

export function sharedMaterialReads(use: MaterialUse, observation: MaterialObservation): boolean {
  observation.sharedMesh ??=
    'color' in use.effective &&
    useTextures(use).every(
      ([, texture]) =>
        !isExternalTexture(texture) &&
        !texture.isRenderTargetTexture &&
        hasDataProperties(texture) &&
        texture.updateMatrix === Texture.prototype.updateMatrix,
    );
  return observation.sharedMesh;
}

export function ordinaryGeometryReads(frame: ScenePreparation, geometry: BufferGeometry): boolean {
  const known = frame.lists.ordinaryGeometryReads.get(geometry);
  if (known !== undefined) return known;
  const ordinary =
    geometry.getAttribute === BufferGeometry.prototype.getAttribute &&
    geometry.hasAttribute === BufferGeometry.prototype.hasAttribute &&
    hasDataProperties(geometry) &&
    hasDataProperties(geometry.drawRange);
  frame.lists.ordinaryGeometryReads.set(geometry, ordinary);
  return ordinary;
}

/** r187 inherits alpha coverage and transparency from each source draw when overriding. */
export function effectiveMaterial(
  material: Material,
  original: Material,
  buffers: SceneBuffers,
): Material {
  if (material !== original && 'isNodeMaterialInstance' in material)
    unsupported('NodeMaterialInstance scene override', material.uuid).unwrap();
  return Object.assign(
    Object.create(material),
    material === original
      ? {}
      : {
          // r187 inherits source position nodes, but keeps override rotation/scale.
          positionNode:
            surfaceInput(original, 'positionNode') ?? surfaceInput(material, 'positionNode'),
          alphaTest: original.alphaTest,
          alphaMap: 'alphaMap' in original ? original.alphaMap : null,
          transparent: isBlended(original),
        },
    buffers.depth ? {} : { depthTest: false, depthWrite: false },
    buffers.stencil ? {} : { stencilWrite: false },
  );
}

export function isBlended(material: Material): boolean {
  return material.transparent || usesTransmission(material);
}

export function isWireframe(object: Renderable, list: readonly MaterialUse[]): boolean {
  const wireframe = list.some((use) => 'wireframe' in use.effective && use.effective.wireframe);
  if (wireframe && list.some((use) => !('wireframe' in use.effective) || !use.effective.wireframe))
    unsupported(
      'Mixed solid/wireframe groups require native per-submesh line expansion',
      object.uuid,
    ).unwrap();
  return wireframe;
}

export function rejectOrderedOpaque(
  frame: ScenePreparation,
  object: Renderable,
  list: readonly MaterialUse[],
): void {
  if (
    (object.renderOrder !== 0 || (frame.lists.groupOrders.get(object) ?? 0) !== 0) &&
    object.layers.test(frame.camera.layers) &&
    list.some((use) => !isBlended(use.effective))
  ) {
    if (!frame.buffers.opaqueOrder)
      unsupported('Opaque renderOrder requires renderer-owned ordering', object.uuid).unwrap();
    frame.orderedOpaque = true;
  }
}

const scalarColorParameters: readonly string[] = [
  'baseColorTexture',
  'emissiveTexture',
  'specularColorTexture',
  'sheenColorTexture',
];
const scalarRedParameters: readonly string[] = [
  'alphaTexture',
  'bumpTexture',
  'displacementTexture',
  'occlusionTexture',
  'transmissionTexture',
  'clearcoatTexture',
  'iridescenceTexture',
];

/** Share existing orientation caches; scalar variants are created only when actually used. */
export function textureProjection(
  material: SupportedMaterial,
  parameter: string,
  texture: Texture,
): TextureProjection {
  const sphere = isMatcapMaterial(material) && parameter === 'baseColorTexture';
  if (texture.format !== RedFormat) return sphere ? 1 : 0;
  if (scalarColorParameters.includes(parameter)) return sphere ? 3 : 2;
  if (scalarRedParameters.includes(parameter)) return 0;
  return 4;
}

export function uvTextures(list: readonly MaterialUse[]): Texture[] {
  const textures: Texture[] = [];
  for (const use of list) {
    // The sphere image uses generated coordinates. Without coverage, preserve
    // the default Matcap path without enumerating or allocating texture slots.
    if (isMatcapMaterial(use.effective)) {
      if (use.effective.alphaMap != null) textures.push(use.effective.alphaMap);
      continue;
    }
    for (const [, texture] of useTextures(use)) textures.push(texture);
  }
  return textures;
}

export function flatMatcapSlots(list: readonly MaterialUse[]): Set<number> {
  return new Set(
    list.flatMap((use, slot) =>
      isMatcapMaterial(use.effective) && use.shading === 1 ? [slot] : [],
    ),
  );
}

export function matchesGeometryStructure(
  accepted: GeometryStructure,
  shape: GeometryShape,
  generatedUvChannels: readonly string[],
): boolean {
  return (
    accepted.topology === shape.topology &&
    accepted.grouped === shape.grouped &&
    accepted.wireframe === shape.wireframe &&
    accepted.expanded === shape.expanded &&
    sameValues(accepted.instanceTint ?? [], shape.instanceTint ?? []) &&
    accepted.cpuSkin === shape.cpuSkin &&
    accepted.morphColor === shape.morphColor &&
    sameFlatMatcapSlots(accepted.flatMatcap, shape.flatMatcap) &&
    sameValues(accepted.uvValues, shape.uv.values) &&
    sameValues(accepted.generatedUvChannels, generatedUvChannels) &&
    matchesGeometrySelection(accepted.selection, shape.selection)
  );
}

function sameFlatMatcapSlots(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  if (left.size !== right.size) return false;
  for (const slot of left) if (!right.has(slot)) return false;
  return true;
}

export function matchesGeometrySelection(
  accepted: readonly GeometryMaterial[],
  selection: readonly GeometryMaterial[],
): boolean {
  return (
    accepted.length === selection.length &&
    accepted.every((slot, index) => {
      const next = selection[index];
      return (
        next !== undefined &&
        slot.slot === next.slot &&
        slot.vertexColors === next.vertexColors &&
        slot.tangentBasis === next.tangentBasis
      );
    })
  );
}

export function geometryVariant(object: Renderable, shape: GeometryShape): string {
  const perObject =
    shape.expanded || shape.cpuSkin || shape.flatMatcap.size > 0 || shape.morphColor;
  return JSON.stringify([
    shape.topology,
    shape.grouped,
    shape.selection,
    perObject ? object.uuid : '',
    shape.wireframe,
    shape.uv.values,
    shape.uv.generatedChannels,
    [...shape.flatMatcap],
    shape.expanded,
    shape.instanceTint,
    shape.cpuSkin,
    shape.morphColor,
  ]);
}

export function observeGeometry(
  frame: ScenePreparation,
  geometry: BufferGeometry,
  grouped: boolean,
): readonly unknown[] {
  const observations = frame.lists.geometryInputs[grouped ? 1 : 0];
  let values = observations.get(geometry);
  if (values === undefined) {
    values = geometryValues(geometry, grouped);
    observations.set(geometry, values);
  }
  return values;
}

export function geometryCacheValues(
  frame: ScenePreparation,
  object: Renderable,
  geometry: BufferGeometry,
  shape: GeometryShape,
): readonly unknown[] {
  const source = observeGeometry(frame, geometry, shape.grouped);
  const morph =
    (shape.flatMatcap.size > 0 || shape.morphColor) && object instanceof Mesh
      ? object.morphTargetInfluences
      : undefined;
  return morph === undefined ? source : [...source, ...morph];
}

export function projectSourceMesh(
  object: Renderable,
  geometry: BufferGeometry,
  shape: GeometryShape,
  packVertices: boolean,
): MeshAsset | undefined {
  return projectGeometry(
    geometry,
    shape.grouped,
    shape.selection,
    shape.topology,
    shape.uv.attributes,
    shape.wireframe,
    sourceMorphColorWeights(object, shape.morphColor),
    packVertices,
  ).unwrap();
}

export function finishMeshGeometry(
  object: Renderable,
  shape: GeometryShape,
  base: MeshAsset | undefined,
): MeshAsset | undefined {
  if (base === undefined) return undefined;
  if (shape.expanded) base = projectInstanceGeometry(object as InstancedMesh | BatchedMesh, base);
  if (base !== undefined && shape.flatMatcap.size > 0)
    base = projectFlatNormals(
      base,
      shape.flatMatcap,
      object instanceof Mesh ? object.morphTargetInfluences : undefined,
    );
  return base;
}

export function projectLinePointMaterial(
  object: Line | Points,
  source: SupportedMaterial,
  coordinates: Map<Texture, ResolvedMaterialTextureCoordinates>,
): void {
  if (!(isLineMaterial(source) || isPointsMaterial(source)))
    unsupported('Lines/Points require their unlit material family', object.uuid).unwrap();
  if (object instanceof Line && source.vertexColors && object.geometry.hasAttribute('color'))
    unsupported('Native Lines do not transport per-vertex colors', object.uuid).unwrap();
  for (const [parameter, texture] of materialTextures(source)) {
    if (
      !(
        object instanceof Points &&
        source instanceof PointsMaterial &&
        parameter === 'baseColorTexture'
      )
    )
      unsupported(
        'Native Lines/Points do not transport source UV or point coordinates for this texture slot',
        object.uuid,
      ).unwrap();
    if (object.geometry.hasAttribute('uv'))
      unsupported(
        'PointsMaterial.map with a geometry UV needs per-point sampling',
        object.uuid,
      ).unwrap();
    const { transform } = textureCoordinates(texture).unwrap();
    // Three's sprite coordinate has its origin at the lower left. Flip the
    // generated coordinates, while sharing the original texture publication.
    const [sx, sy] = transform.scale;
    const [x, y] = transform.offset;
    coordinates.set(texture, {
      set: 0,
      transform: {
        offset: [x - Math.sin(transform.rotation) * sy, y + Math.cos(transform.rotation) * sy],
        scale: [sx, -sy],
        rotation: transform.rotation,
      },
    });
  }
}

export function pointStyle(object: Points, frame: ScenePreparation, list: readonly MaterialUse[]) {
  const source = list.find(({ effective }) => effective instanceof PointsMaterial)?.effective;
  if (!(source instanceof PointsMaterial))
    return { size: 1, sizeUnits: PointSizeUnitsValue.pixels, minPixelSize: 0 };
  if (
    list.some(
      ({ effective }) =>
        !(effective instanceof PointsMaterial) ||
        effective.size !== source.size ||
        effective.sizeAttenuation !== source.sizeAttenuation,
    )
  )
    unsupported(
      'Points material groups need the same raster size and attenuation',
      object.uuid,
    ).unwrap();
  const projection = frame.camera.projectionMatrix.elements;
  const world = source.sizeAttenuation && projection[11] === -1;
  const size = world
    ? source.size / Math.abs(projection[5])
    : source.size * (frame.buffers.pixelRatio ?? 1);
  if (!Number.isFinite(Math.fround(size)) || Math.fround(size) <= 0)
    invalid('PointsMaterial.size', source.uuid).unwrap();
  return {
    size,
    sizeUnits: world ? PointSizeUnitsValue.world : PointSizeUnitsValue.pixels,
    minPixelSize: 1,
  };
}

export function meshLineStyle(
  object: Renderable,
  payload: MeshAsset,
  list: readonly MaterialUse[],
  wireframe: boolean,
): ReturnType<typeof lineStyle> | undefined {
  if (object instanceof Line)
    return lineStyle(
      object,
      payload,
      list.map((use) => use.effective),
    );
  return wireframe ? { dashSize: 1, gapSize: 0, dashOffset: 0 } : undefined;
}

/** Use only ranges that cover a consecutive source revision with unchanged ordinal mapping. */
export function sparseInstanceTransforms(
  object: InstancedMesh,
  array: Float32Array,
  lanes: number,
  borrow: boolean,
) {
  const updates = object.instanceMatrix.updateRanges;
  if (updates.length === 0 || updates.length > 16) return undefined;
  const ranges: { start: number; end: number }[] = [];
  for (const { start, count } of updates) {
    const end = start + count;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      count <= 0 ||
      end > array.length
    )
      return undefined;
    if (start < lanes)
      ranges.push({
        start: Math.floor(start / 16) * 16,
        end: Math.min(lanes, Math.ceil(end / 16) * 16),
      });
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  if (merged.reduce((total, range) => total + range.end - range.start, 0) * 2 >= lanes)
    return undefined;
  const result = [];
  for (const { start, end } of merged) {
    const source = array.subarray(start, end);
    // Synchronous stock submissions consume this bounded source window in
    // World.setArrayRange. Callback paths keep a detached accepted snapshot.
    if (borrow) {
      result.push({ start, values: source });
    } else {
      const values = projectNativeInstanceTransforms(object, source);
      if (values.length !== end - start) return undefined;
      result.push({ start, values });
    }
  }
  return result;
}

export function projectNativeInstanceTransforms(
  object: InstancedMesh,
  source: ArrayLike<number>,
): Float32Array {
  const instances = new Float32Array(source);
  return instances.subarray(0, compactNativeInstances(object, instances, true));
}

export function compactNativeInstances(
  object: InstancedMesh,
  instances: Float32Array,
  compact: boolean,
): number {
  const position = vec3.create(),
    rotation = quat.create(),
    scale = vec3.create(),
    shear = vec3.create();
  let length = 0;
  for (let offset = 0; offset < instances.length; offset += 16) {
    if (isCollapsedInstance(instances, offset)) continue;
    const matrix = instances.subarray(offset, offset + 16);
    if (!mat4.decomposeAffine(position, rotation, scale, shear, matrix))
      invalid('InstancedMesh.instanceMatrix', object.uuid).unwrap();
    if (compact && length !== offset) instances.copyWithin(length, offset, offset + 16);
    length += 16;
  }
  return length;
}

export function instanceSourceValues(object: InstancedMesh, expanded: boolean): readonly unknown[] {
  if (
    !Number.isInteger(object.count) ||
    object.count < 0 ||
    object.count > object.instanceMatrix.count
  )
    invalid('InstancedMesh.count', object.uuid).unwrap();
  return [
    object.instanceMatrix,
    object.instanceMatrix.array,
    object.instanceMatrix.version,
    object.count,
    expanded,
  ];
}

export function projectsMorphColor(
  geometry: BufferGeometry,
  materials: readonly GeometryMaterial[],
): boolean {
  return (
    geometry.morphAttributes.color !== undefined &&
    materials.some((material) => material.vertexColors)
  );
}

export function meshMorphWeights(object: Renderable, payload: MeshAsset): Float32Array | undefined {
  if (payload.morphTargets === undefined) return undefined;
  const morphWeights = new Float32Array(
    object instanceof Mesh
      ? (object.morphTargetInfluences ??
          (object instanceof InstancedMesh
            ? Array.from({ length: payload.morphTargets.length }, () => 0)
            : []))
      : [],
  );
  if (morphWeights.length !== payload.morphTargets.length || !morphWeights.every(Number.isFinite))
    invalid('Mesh.morphTargetInfluences', object.uuid).unwrap();
  return morphWeights;
}

// Parameter name, texture and sampler identities, UV set, and five transform lanes.
const materialBindingLanes = 9;

/** Append a bound texture's identity to the submission's reused scratch buffer. */
export function appendBindingValues(
  values: unknown[],
  parameter: string,
  binding: MaterialTextureValue,
  coordinates: ResolvedMaterialTextureCoordinates | undefined,
): void {
  const transform = coordinates?.transform;
  values.push(
    parameter,
    binding.texture ?? binding.source,
    binding.sampler,
    coordinates?.set ?? 0,
    transform?.offset[0] ?? 0,
    transform?.offset[1] ?? 0,
    transform?.scale[0] ?? 1,
    transform?.scale[1] ?? 1,
    transform?.rotation ?? 0,
  );
}

export function sameBindingValues(
  previous: readonly unknown[],
  next: readonly unknown[],
  start: number,
  slot: number,
): boolean {
  const first = start + slot * materialBindingLanes;
  for (let index = first; index < first + materialBindingLanes; index++)
    if (!Object.is(previous[index], next[index])) return false;
  return true;
}

export function surfaceParameterSlots(
  expression: SurfaceInputObservation | undefined,
  baseEnd: number,
): MaterialDependencies['surfaceInputs'] {
  if (expression === undefined) return undefined;
  const inputs = Object.entries(expression.values);
  const slots: { name: string; offset: number }[] = [];
  let offset = baseEnd;
  for (const [, value] of inputs) offset -= typeof value === 'number' ? 1 : value.length;
  for (const [name, value] of inputs) {
    slots.push({ name, offset });
    offset += typeof value === 'number' ? 1 : value.length;
  }
  return slots;
}

export function materialParameterPatch(
  previous: readonly unknown[],
  next: readonly unknown[],
  baseEnd: number,
  invariantEnd: number,
  expression: SurfaceInputObservation | undefined,
): Readonly<Record<string, MaterialValue>> | undefined {
  if (expression === undefined) return stockMaterialParameterPatch(previous, next, invariantEnd);
  if (previous.length !== next.length) return undefined;
  const inputs = Object.entries(expression.values);
  const first = inputs.reduce(
    (end, [, value]) => end - (typeof value === 'number' ? 1 : value.length),
    baseEnd,
  );
  // The program key precedes the live lanes and participates in structural admission.
  for (let index = 0; index < invariantEnd; index++)
    if ((index < first || index >= baseEnd) && !Object.is(previous[index], next[index]))
      return undefined;
  const patch: Record<string, MaterialValue> = {};
  let start = first;
  for (const [name, value] of inputs) {
    const end = start + (typeof value === 'number' ? 1 : value.length);
    for (let lane = start; lane < end; lane++) {
      if (Object.is(previous[lane], next[lane])) continue;
      patch[name] = value;
      break;
    }
    start = end;
  }
  return patch;
}

export function canvasBindingSource(
  binding: MaterialTextureValue | undefined,
): CanvasTextureSource | undefined {
  const source = binding?.source;
  return source?.source === 'canvas' ? (source as CanvasTextureSource) : undefined;
}

export function sameTextureSlots(
  previous: MaterialDependencies | undefined,
  textures: ReturnType<typeof materialTextures>,
  bindings: readonly MaterialTextureValue[],
): boolean {
  return (
    textures.length > 0 &&
    previous?.textures.length === textures.length &&
    textures.every(([parameter], index) => {
      const slot = previous.textures[index];
      const binding = bindings[index];
      return (
        slot?.parameter === parameter &&
        binding !== undefined &&
        (slot.projection === undefined
          ? binding.source !== undefined
          : typeof binding.texture === 'number')
      );
    })
  );
}

export function resolveMaterialBindings(
  use: MaterialUse,
  textures: ReturnType<typeof materialTextures>,
  bindings: readonly MaterialTextureValue[],
  unchanged?: (slot: number) => boolean,
): Record<string, MaterialTextureValue> {
  const resolved: Record<string, MaterialTextureValue> = {};
  for (const [index, [parameter, texture]] of textures.entries()) {
    if (unchanged?.(index)) continue;
    const binding = bindings[index];
    if (binding === undefined) throw new Error('material texture has no binding');
    const coordinates = use.coordinates.get(texture);
    resolved[parameter] = coordinates === undefined ? binding : { ...binding, coordinates };
  }
  return resolved;
}

function sourceMorphColorWeights(
  object: Renderable,
  enabled: boolean,
): readonly number[] | undefined {
  if (!enabled) return undefined;
  if (!(object instanceof Mesh) || object instanceof InstancedMesh || object instanceof BatchedMesh)
    return unsupported(
      'Per-instance color morphs require native GPU color target channels',
      object.uuid,
    ).unwrap();
  if (object.morphTargetInfluences === undefined)
    return invalid('Mesh.morphTargetInfluences for color morphs', object.uuid).unwrap();
  return object.morphTargetInfluences;
}
