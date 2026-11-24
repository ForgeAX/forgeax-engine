import { meshFromInterleaved } from '@forgeax/engine-geometry';
import { AssetError, err, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import { differenceD, FillRule, intersectD, type PathsD, unionD } from 'clipper2-ts';
import type { Vec2, Vec3 } from './contracts.js';
import { requireWaterValue } from './required-value.js';
import type { WaterMeshLayoutReceipt } from './water-mesh-abi.js';
import {
  createWaterMeshLayoutReceipt,
  WATER_MESH_INSTANCE_LAYOUT,
  WATER_MESH_INSTANCE_STRIDE_BYTES,
} from './water-mesh-abi.js';
import {
  MAX_WATER_MESH_TEMPLATE_INDICES,
  MAX_WATER_MESH_TEMPLATE_SET_INDICES,
  MAX_WATER_MESH_TEMPLATE_SET_VERTICES,
  MAX_WATER_MESH_TEMPLATE_VERTICES,
  MAX_WATER_MESH_TESSELLATION_FACTOR,
  MAX_WATER_MESH_TREE_NODES,
} from './water-mesh-budget.js';
import {
  buildWaterMeshContinuity,
  type WaterMeshContinuitySupport,
} from './water-mesh-continuity.js';
import { WATER_WAVE_LWC_TILE_LENGTH_M } from './waves.js';

export type { WaterMeshLayoutReceipt } from './water-mesh-abi.js';
export { WATER_MESH_INSTANCE_LAYOUT_HASH } from './water-mesh-abi.js';
export type WaterMeshPolygon = Readonly<{
  outer: readonly Vec2[];
  holes?: readonly (readonly Vec2[])[];
}>;
export type WaterMeshBodyInput = Readonly<{
  guid: string;
  generation: number;
  type: 'river' | 'lake' | 'ocean' | 'custom';
  visible: boolean;
  affectsWaterMesh: boolean;
  priority: number;
  materialKey: string;
  transitionContinuity?: Readonly<{ centerXZ: Vec2; reachM: number; blendWidthM: number }>;
  transitionTo?: 'lake' | 'ocean';
  transitionMaterialKey?: string;
  transitionMaterials?: Readonly<Partial<Record<'lake' | 'ocean', string>>>;
  insertionOrder?: number;
  densityKey?: number;
  /** Precise world XZ phase origin used to pack per-tile body-relative offsets. */
  waveOriginXZ: Vec2;
  baseHeightM: number;
  maxWaveHeightM: number;
  worldYBounds?: readonly [number, number];
  polygon?: WaterMeshPolygon;
  /** Even-odd union of projected override-mesh rings for Custom opt-in. */
  polygonRings?: readonly (readonly Vec2[])[];
}>;
export type WaterMeshBuildInput = Readonly<{
  zoneGuid: string;
  zoneGeneration: number;
  originXZ: Vec2;
  extentM: Vec2;
  tileSizeM: number;
  tessellationFactor: number;
  lodScale: number;
  /** GPU near occupancy keeps the shared static eight-quad far product. */
  nearMesh?: 'gpu';
  far?: Readonly<{
    extentM: Vec2;
    /** Accepted far inner boundary; the Zone owner selects fixed Zone or opt-in view window. */
    innerBoundsXZ?: Readonly<{ minM: Vec2; maxM: Vec2 }>;
    materialKey?: string;
    ownerGuid?: string;
    waterLevelM?: number;
    /** Opt-in local view windows join their waves to the Ocean mean plane. */
  }>;
  bodies: readonly WaterMeshBodyInput[];
}>;
export type WaterMeshFrustumPlane = Readonly<{
  normal: Vec3;
  distance: number;
}>;
export type WaterMeshViewInput = Readonly<{
  viewId: string;
  observerM: Vec3;
  frustumPlanes?: readonly WaterMeshFrustumPlane[];
  waterInfoBoundsXZ?: Readonly<{
    minM: Vec2;
    maxM: Vec2;
  }>;
  occluded?: (
    bounds: Readonly<{
      minM: Vec3;
      maxM: Vec3;
    }>,
  ) => boolean;
}>;
export type WaterMeshTileInstance = Readonly<{
  originXZ: Vec2;
  /** Observer XZ relative to originXZ, computed before f32 upload for per-vertex LOD distance. */
  cameraRelativeXZ: Vec2;
  waveOriginOffsetXZ: Vec2;
  /** Tile-local meter rings after exact body/tile clipping; even-odd fill preserves holes. */
  coverageRings?: readonly (readonly Vec2[])[];
  sizeM: number;
  extentXZ: Vec2;
  ownerGuid: string;
  ownerGeneration: number;
  ownerRenderIndex: number;
  /** One-based view-local transition row; zero means this tile has no transition. */
  transitionRenderIndex: number;
  transitionBodyGuid?: string;
  transitionBodyGeneration?: number;
  priorityU16: number;
  yMinM: number;
  yMaxM: number;
  waterYM: number;
  fullyCovered: boolean;
  materialKey: string;
  densityKey: number;
  densityIndex: number;
  lod0: number;
  lod1: number;
  maxMorphLod: number;
  lodScaleM: number;
  heightMorph01: number;
  shouldMorph: boolean;
  canMorphTwice: boolean;
  quadsPerEdge: number;
  far: boolean;
  /** Accepted near bounds adjoining an emitted same-owner flat far ring: -X,+X,-Z,+Z. */
  flatFarBoundaryMask: number;
  continuitySupport?: WaterMeshContinuitySupport;
}>;
export type WaterMeshBucket = Readonly<{
  materialKey: string;
  densityKey: number;
  densityIndex: number;
  instances: readonly WaterMeshTileInstance[];
  mesh: MeshAsset;
  vertexCount: number;
  indexCount: number;
  ownerDraws: readonly WaterMeshOwnerDraw[];
}>;
export type WaterMeshOwnerDraw = Readonly<{
  drawKey: string;
  ownerGuid: string;
  ownerGeneration: number;
  instances: readonly WaterMeshTileInstance[];
  instanceBytes: Uint8Array;
  coverageBytes: Uint8Array;
  layout: WaterMeshLayoutReceipt;
  mesh: MeshAsset;
  vertexCount: number;
  indexCount: number;
}>;
export type WaterMeshViewReceipt = Readonly<{
  zoneGuid: string;
  zoneGeneration: number;
  viewId: string;
  treeDepth: number;
  leafCount: number;
  visibleLeafCount: number;
  selectedTileCount: number;
  farInstanceCount: number;
  buckets: readonly WaterMeshBucket[];
  instances: readonly WaterMeshTileInstance[];
  instanceBytes: Uint8Array;
  coverageBytes: Uint8Array;
  layout: WaterMeshLayoutReceipt;
}>;
type Node = {
  x: number;
  z: number;
  size: number;
  extentXZ: Vec2;
  depth: number;
  children?: Node[];
  owner?: WaterMeshBodyInput;
  transition?: WaterMeshBodyInput;
  transitionMaterialKey?: string;
  layers?: readonly Candidate[];
  full: boolean;
};
type Candidate = {
  owner: WaterMeshBodyInput;
  transition?: WaterMeshBodyInput;
  transitionMaterialKey?: string;
  layers?: readonly Candidate[];
};
function fail(expected: string, detail: unknown): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-invalid-value',
      expected,
      hint: 'repair the WaterZone mesh inputs and rebuild the view',
      detail: { field: 'water-mesh', got: detail },
    }),
  );
}
const finite2 = (value: Vec2) => value.length === 2 && value.every(Number.isFinite);
const finite3 = (value: Vec3) => value.length === 3 && value.every(Number.isFinite);
const cross = (a: Vec2, b: Vec2, p: Vec2) =>
  (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
function inside(ring: readonly Vec2[], p: Vec2): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = requireWaterValue(ring[i]),
      b = requireWaterValue(ring[j]);
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      result = !result;
  }
  return result;
}
function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    Math.abs(cross(a, b, p)) < 1e-9 &&
    p[0] >= Math.min(a[0], b[0]) - 1e-9 &&
    p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    p[1] >= Math.min(a[1], b[1]) - 1e-9 &&
    p[1] <= Math.max(a[1], b[1]) + 1e-9
  );
}
function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const ab1 = cross(a, b, c),
    ab2 = cross(a, b, d),
    cd1 = cross(c, d, a),
    cd2 = cross(c, d, b);
  return (
    (ab1 === 0 && onSegment(a, b, c)) ||
    (ab2 === 0 && onSegment(a, b, d)) ||
    (cd1 === 0 && onSegment(c, d, a)) ||
    (cd2 === 0 && onSegment(c, d, b)) ||
    (ab1 > 0 !== ab2 > 0 && cd1 > 0 !== cd2 > 0)
  );
}
function polygonIntersectsBox(
  polygon: WaterMeshPolygon,
  x: number,
  z: number,
  width: number,
  depth: number,
): boolean {
  const corners: Vec2[] = [
    [x, z],
    [x + width, z],
    [x + width, z + depth],
    [x, z + depth],
  ];
  const rings = [polygon.outer, ...(polygon.holes ?? [])];
  if (
    corners.some(
      (point) =>
        inside(polygon.outer, point) && !(polygon.holes ?? []).some((hole) => inside(hole, point)),
    )
  )
    return true;
  if (
    rings.some((ring) =>
      ring.some(
        (point) => point[0] >= x && point[0] <= x + width && point[1] >= z && point[1] <= z + depth,
      ),
    )
  )
    return true;
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++)
      for (let edge = 0; edge < 4; edge++) {
        if (
          segmentsIntersect(
            requireWaterValue(ring[i]),
            requireWaterValue(ring[(i + 1) % ring.length]),
            requireWaterValue(corners[edge]),
            requireWaterValue(corners[(edge + 1) % 4]),
          )
        )
          return true;
      }
  return false;
}
function polygonCoversBox(
  polygon: WaterMeshPolygon,
  x: number,
  z: number,
  width: number,
  depth: number,
): boolean {
  const corners: Vec2[] = [
    [x, z],
    [x + width, z],
    [x + width, z + depth],
    [x, z + depth],
  ];
  if (
    !corners.every(
      (point) =>
        inside(polygon.outer, point) && !(polygon.holes ?? []).some((hole) => inside(hole, point)),
    )
  )
    return false;
  if (
    (polygon.holes ?? []).some((hole) =>
      hole.some(
        (point) => point[0] >= x && point[0] <= x + width && point[1] >= z && point[1] <= z + depth,
      ),
    )
  )
    return false;
  const rings = [polygon.outer, ...(polygon.holes ?? [])];
  return !rings.some((ring) =>
    ring.some((point, i) => {
      for (let edge = 0; edge < 4; edge++)
        if (
          segmentsIntersect(
            point,
            requireWaterValue(ring[(i + 1) % ring.length]),
            requireWaterValue(corners[edge]),
            requireWaterValue(corners[(edge + 1) % 4]),
          )
        )
          return true;
      return false;
    }),
  );
}
function bodyIntersects(
  body: WaterMeshBodyInput,
  x: number,
  z: number,
  width: number,
  depth: number,
): boolean {
  if (body.polygonRings)
    return body.polygonRings.some((outer) => polygonIntersectsBox({ outer }, x, z, width, depth));
  if (!body.polygon) return false;
  return polygonIntersectsBox(body.polygon, x, z, width, depth);
}
function bodyCovers(
  body: WaterMeshBodyInput,
  x: number,
  z: number,
  width: number,
  depth: number,
): boolean {
  if (body.polygonRings) return false;
  if (!body.polygon) return false;
  return polygonCoversBox(body.polygon, x, z, width, depth);
}
function transitionMaterial(
  body: WaterMeshBodyInput,
  target: 'lake' | 'ocean',
): string | undefined {
  return (
    body.transitionMaterials?.[target] ??
    (body.transitionTo === target ? body.transitionMaterialKey : undefined)
  );
}
function effectivePriority(body: WaterMeshBodyInput): number {
  const transitionBand =
    body.type === 'river' &&
    (transitionMaterial(body, 'lake') !== undefined ||
      transitionMaterial(body, 'ocean') !== undefined);
  return body.priority + (transitionBand ? 16384 : 0);
}
function highestPriority(bodies: readonly WaterMeshBodyInput[]): WaterMeshBodyInput | undefined {
  let selected: WaterMeshBodyInput | undefined;
  let selectedOrder = -Infinity;
  for (let index = 0; index < bodies.length; index++) {
    const candidate = requireWaterValue(bodies[index]);
    const order = candidate.insertionOrder ?? index;
    if (
      selected === undefined ||
      effectivePriority(candidate) > effectivePriority(selected) ||
      (effectivePriority(candidate) === effectivePriority(selected) && order >= selectedOrder)
    ) {
      selected = candidate;
      selectedOrder = order;
    }
  }
  return selected;
}
function selectCandidate(
  bodies: readonly WaterMeshBodyInput[],
  x: number,
  z: number,
  width: number,
  depth: number,
): Candidate | undefined {
  const candidates = bodies.filter(
    (body) => body.visible && body.affectsWaterMesh && bodyIntersects(body, x, z, width, depth),
  );
  const tile: Node = {
    x,
    z,
    size: Math.max(width, depth),
    extentXZ: [width, depth],
    depth: 0,
    full: false,
  };
  const pathsByBody = new Map<WaterMeshBodyInput, PathsD>();
  const pathsFor = (body: WaterMeshBodyInput): PathsD => {
    let paths = pathsByBody.get(body);
    if (paths === undefined) {
      paths = clipBodyToTile(body, tile);
      pathsByBody.set(body, paths);
    }
    return paths;
  };
  const order = (body: WaterMeshBodyInput) => body.insertionOrder ?? bodies.indexOf(body);
  const ordered = [...candidates].sort(
    (a, b) => effectivePriority(b) - effectivePriority(a) || order(b) - order(a),
  );
  const layers = ordered.map((owner): Candidate => {
    if (owner.type !== 'river') return { owner };
    const targets = (['lake', 'ocean'] as const).filter(
      (target) => transitionMaterial(owner, target) !== undefined,
    );
    const ownerPaths = pathsFor(owner);
    const transition = highestPriority(
      candidates.filter(
        (body) =>
          targets.includes(body.type as 'lake' | 'ocean') &&
          intersectD(ownerPaths, pathsFor(body), FillRule.EvenOdd, 6).length > 0,
      ),
    );
    if (transition === undefined) return { owner };
    const transitionMaterialKey = transitionMaterial(owner, transition.type as 'lake' | 'ocean');
    return {
      owner,
      transition,
      ...(transitionMaterialKey === undefined ? {} : { transitionMaterialKey }),
    };
  });
  return layers[0] === undefined ? undefined : { ...layers[0], layers: Object.freeze(layers) };
}
function allSameCandidate(children: readonly Node[]): boolean {
  const first = children[0];
  const sameLayers = (node: Node) =>
    JSON.stringify(
      (node.layers ?? []).map((layer) => [
        layer.owner.guid,
        layer.owner.generation,
        layer.owner.materialKey,
        layer.owner.densityKey,
        layer.transition?.guid,
        layer.transition?.generation,
        layer.transitionMaterialKey,
      ]),
    );
  return (
    !!first?.owner &&
    children.every((child) => child.full && sameLayers(child) === sameLayers(first))
  );
}
function subdivideNode(
  node: Node,
  maxDepth: number,
  bodies: readonly WaterMeshBodyInput[],
  bounds: Readonly<{
    min: Vec2;
    max: Vec2;
  }>,
): void {
  if (node.children || node.depth >= maxDepth) return;
  const half = node.size / 2;
  node.children = [
    createNode(node.x, node.z, half, node.depth + 1, maxDepth, bodies, bounds),
    createNode(node.x + half, node.z, half, node.depth + 1, maxDepth, bodies, bounds),
    createNode(node.x, node.z + half, half, node.depth + 1, maxDepth, bodies, bounds),
    createNode(node.x + half, node.z + half, half, node.depth + 1, maxDepth, bodies, bounds),
  ];
  if (allSameCandidate(node.children)) node.full = true;
}
function createNode(
  x: number,
  z: number,
  size: number,
  depth: number,
  maxDepth: number,
  bodies: readonly WaterMeshBodyInput[],
  bounds: Readonly<{
    min: Vec2;
    max: Vec2;
  }>,
): Node {
  const extentXZ: Vec2 = [
    Math.max(0, Math.min(x + size, bounds.max[0]) - x),
    Math.max(0, Math.min(z + size, bounds.max[1]) - z),
  ];
  const node: Node = { x, z, size, extentXZ, depth, full: false };
  if (extentXZ[0] <= 0 || extentXZ[1] <= 0) return node;
  const candidate = selectCandidate(bodies, x, z, extentXZ[0], extentXZ[1]);
  if (!candidate) return node;
  node.owner = candidate.owner;
  if (candidate.transition !== undefined) node.transition = candidate.transition;
  if (candidate.transitionMaterialKey !== undefined)
    node.transitionMaterialKey = candidate.transitionMaterialKey;
  if (candidate.layers !== undefined) node.layers = candidate.layers;
  node.full =
    bodyCovers(candidate.owner, x, z, extentXZ[0], extentXZ[1]) &&
    (!candidate.transition || bodyCovers(candidate.transition, x, z, extentXZ[0], extentXZ[1]));
  if (depth < maxDepth && !node.full) subdivideNode(node, maxDepth, bodies, bounds);
  return node;
}
function intersectsAabb(
  bounds: Readonly<{
    minM: Vec3;
    maxM: Vec3;
  }>,
  plane: WaterMeshFrustumPlane,
): boolean {
  const p: Vec3 = [
    plane.normal[0] >= 0 ? bounds.maxM[0] : bounds.minM[0],
    plane.normal[1] >= 0 ? bounds.maxM[1] : bounds.minM[1],
    plane.normal[2] >= 0 ? bounds.maxM[2] : bounds.minM[2],
  ];
  return (
    plane.normal[0] * p[0] + plane.normal[1] * p[1] + plane.normal[2] * p[2] + plane.distance >= 0
  );
}
function viewIntersects(
  view: WaterMeshViewInput,
  x: number,
  z: number,
  size: number,
  yMin: number,
  yMax: number,
): boolean {
  if (
    view.waterInfoBoundsXZ &&
    (x + size < view.waterInfoBoundsXZ.minM[0] ||
      x > view.waterInfoBoundsXZ.maxM[0] ||
      z + size < view.waterInfoBoundsXZ.minM[1] ||
      z > view.waterInfoBoundsXZ.maxM[1])
  )
    return false;
  const bounds = {
    minM: [x, yMin, z] satisfies Vec3,
    maxM: [x + size, yMax, z + size] satisfies Vec3,
  };
  if (view.frustumPlanes?.some((plane) => !intersectsAabb(bounds, plane))) return false;
  return !view.occluded?.(bounds);
}
function bodyYBounds(body: WaterMeshBodyInput): readonly [number, number] {
  return (
    body.worldYBounds ?? [
      body.baseHeightM - body.maxWaveHeightM,
      body.baseHeightM + body.maxWaveHeightM,
    ]
  );
}
function layersForNode(node: Node): readonly Candidate[] {
  return (
    node.layers ??
    (node.owner === undefined
      ? []
      : [
          {
            owner: node.owner,
            ...(node.transition === undefined ? {} : { transition: node.transition }),
            ...(node.transitionMaterialKey === undefined
              ? {}
              : { transitionMaterialKey: node.transitionMaterialKey }),
          },
        ])
  );
}
function layerYBounds(layer: Candidate): readonly [number, number] {
  const ownerBounds = bodyYBounds(layer.owner);
  if (layer.transition === undefined) return ownerBounds;
  const transitionBounds = bodyYBounds(layer.transition);
  return [
    Math.min(ownerBounds[0], transitionBounds[0]),
    Math.max(ownerBounds[1], transitionBounds[1]),
  ];
}
function nodeLayerYBounds(node: Node): readonly [number, number] | undefined {
  const layers = layersForNode(node);
  if (layers.length === 0) return undefined;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const layer of layers) {
    const bounds = layerYBounds(layer);
    minimum = Math.min(minimum, bounds[0]);
    maximum = Math.max(maximum, bounds[1]);
  }
  return [minimum, maximum];
}
function layerViewIntersects(view: WaterMeshViewInput, node: Node, layer: Candidate): boolean {
  return viewIntersects(view, node.x, node.z, node.size, ...layerYBounds(layer));
}
function nodeViewIntersects(view: WaterMeshViewInput, node: Node): boolean {
  const bounds = nodeLayerYBounds(node);
  return bounds !== undefined && viewIntersects(view, node.x, node.z, node.size, ...bounds);
}
function heightLod(observerY: number, waterY: number, scale: number, max: number): number {
  const d = Math.max(Math.abs(observerY - waterY) / scale - 2, 0) * 2;
  if (d <= 0) return 0;
  return Math.max(0, Math.min(max, Math.log2(d)));
}
function heightMorphForLowestLod(lod: Readonly<{ logicalLod: number; height: number }>): number {
  return lod.logicalLod === Math.floor(lod.height) ? lod.height - Math.floor(lod.height) : 0;
}
function chooseLod(
  node: Node,
  waterY: number,
  view: WaterMeshViewInput,
  leafSize: number,
  lodScale: number,
  treeDepth: number,
  rootOriginXZ: Vec2,
  maxLod: number,
): Readonly<{
  lod: number;
  logicalLod: number;
  height: number;
}> {
  const scale = leafSize * Math.max(lodScale, 0.5);
  const height = heightLod(view.observerM[1], waterY, scale, maxLod);
  const dx = Math.max(node.x - view.observerM[0], 0, view.observerM[0] - node.x - node.size);
  const dz = Math.max(node.z - view.observerM[2], 0, view.observerM[2] - node.z - node.size);
  const distance = Math.hypot(dx, dz) / scale;
  const distanceLod = distance <= 1 ? 0 : Math.log2(distance);
  const spatialLod = treeDepth - node.depth;
  let logicalLod = maxLod;
  for (let level = spatialLod; level <= maxLod; level++) {
    if (level < Math.floor(height)) continue;
    const size = leafSize * 2 ** level;
    const x = rootOriginXZ[0] + Math.floor((node.x - rootOriginXZ[0]) / size) * size;
    const z = rootOriginXZ[1] + Math.floor((node.z - rootOriginXZ[1]) / size) * size;
    const ancestorDx = Math.max(x - view.observerM[0], 0, view.observerM[0] - x - size);
    const ancestorDz = Math.max(z - view.observerM[2], 0, view.observerM[2] - z - size);
    if (Math.hypot(ancestorDx, ancestorDz) <= 2 ** (level + 1) * scale) {
      logicalLod = level;
      break;
    }
  }
  return {
    lod: Math.min(maxLod, Math.max(height, distanceLod)),
    logicalLod,
    height,
  };
}
function chooseLayerLod(
  node: Node,
  layer: Candidate,
  view: WaterMeshViewInput,
  leafSize: number,
  lodScale: number,
  treeDepth: number,
  rootOriginXZ: Vec2,
  maxLod: number,
): Readonly<{
  lod: number;
  logicalLod: number;
  height: number;
}> {
  const ownerLod = chooseLod(
    node,
    layer.owner.baseHeightM,
    view,
    leafSize,
    lodScale,
    treeDepth,
    rootOriginXZ,
    maxLod,
  );
  if (layer.transition === undefined) return ownerLod;
  const transitionLod = chooseLod(
    node,
    layer.transition.baseHeightM,
    view,
    leafSize,
    lodScale,
    treeDepth,
    rootOriginXZ,
    maxLod,
  );
  // Both disjoint transition regions share one tile density; use the finer surface's LOD.
  const finer =
    transitionLod.logicalLod < ownerLod.logicalLod ||
    (transitionLod.logicalLod === ownerLod.logicalLod && transitionLod.lod < ownerLod.lod)
      ? transitionLod
      : ownerLod;
  return { ...finer, lod: Math.min(ownerLod.lod, transitionLod.lod) };
}
function tileInstance(
  node: Node,
  lod: number,
  treeDepth: number,
  renderIndices: ReadonlyMap<string, number>,
  materialKey = requireWaterValue(node.owner).materialKey,
  far = false,
  extentXZ: Vec2 = [node.size, node.size],
  tessellationFactor = treeDepth,
  lodScaleM = 1,
  heightMorph01 = 0,
  coverageRings?: readonly (readonly Vec2[])[],
  cameraRelativeXZ: Vec2 = [0, 0],
): WaterMeshTileInstance {
  const owner = requireWaterValue(node.owner);
  const transitionBody = !far && node.transition !== undefined ? node.transition : undefined;
  const surface = transitionBody ?? owner;
  const spatialLod = treeDepth - node.depth;
  const lod0 = far ? treeDepth : Math.max(spatialLod, Math.floor(lod));
  const densityCount = Math.max(1, Math.min(tessellationFactor, treeDepth - spatialLod + 1));
  const densityIndex = far ? 0 : Math.min(lod0 - spatialLod, densityCount - 1);
  // Partial leaves must share the same terminal lattice as their larger neighbors.
  const maxMorphLod = Math.max(lod0, Math.min(treeDepth, Math.max(0, tessellationFactor - 1)));
  const waterYM = surface.baseHeightM - (far ? surface.maxWaveHeightM : 0);
  const ownerBounds = bodyYBounds(owner);
  const surfaceBounds = transitionBody === undefined ? ownerBounds : bodyYBounds(transitionBody);
  const yMinM = Math.min(ownerBounds[0], surfaceBounds[0]);
  const yMaxM = Math.max(ownerBounds[1], surfaceBounds[1]);
  const wrap = (value: number) =>
    value -
    Math.floor((value + WATER_WAVE_LWC_TILE_LENGTH_M * 0.5) / WATER_WAVE_LWC_TILE_LENGTH_M) *
      WATER_WAVE_LWC_TILE_LENGTH_M;
  return Object.freeze({
    originXZ: [node.x, node.z] satisfies Vec2,
    cameraRelativeXZ,
    waveOriginOffsetXZ: [
      wrap(node.x - surface.waveOriginXZ[0]),
      wrap(node.z - surface.waveOriginXZ[1]),
    ] satisfies Vec2,
    sizeM: Math.max(...extentXZ),
    extentXZ,
    ownerGuid: owner.guid,
    ownerGeneration: owner.generation,
    ownerRenderIndex: renderIndices.get(owner.guid) ?? 0,
    transitionRenderIndex: transitionBody ? (renderIndices.get(transitionBody.guid) ?? 0) : 0,
    ...(transitionBody === undefined
      ? {}
      : {
          transitionBodyGuid: transitionBody.guid,
          transitionBodyGeneration: transitionBody.generation,
        }),
    priorityU16: Math.max(0, Math.min(65535, Math.round(effectivePriority(owner) + 32768))),
    yMinM,
    yMaxM,
    waterYM,
    fullyCovered: node.full,
    materialKey,
    ...(coverageRings === undefined ? {} : { coverageRings }),
    densityKey: owner.densityKey ?? 0,
    densityIndex,
    lod0,
    lod1: Math.min(lod0 + 1, treeDepth),
    maxMorphLod,
    lodScaleM,
    heightMorph01,
    shouldMorph: !far && lod0 < maxMorphLod,
    canMorphTwice: !far && lod0 + 1 < maxMorphLod,
    quadsPerEdge: far ? 1 : Math.max(2, 2 ** Math.max(0, tessellationFactor - densityIndex)),
    far,
    flatFarBoundaryMask: 0,
  });
}

export function waterMeshFlatFarBoundaryMask(
  instances: readonly WaterMeshTileInstance[],
  ownerGuid: string,
  ownerGeneration: number,
  waterYM: number,
  nearBounds: Readonly<{ minM: Vec2; maxM: Vec2 }>,
): number {
  let mask = 0;
  for (const tile of instances) {
    if (
      !tile.far ||
      tile.ownerGuid !== ownerGuid ||
      tile.ownerGeneration !== ownerGeneration ||
      Math.fround(tile.waterYM) !== Math.fround(waterYM)
    )
      continue;
    for (const axis of [0, 1] as const) {
      const other = axis === 0 ? 1 : 0;
      if (
        tile.originXZ[other] > nearBounds.minM[other] ||
        tile.originXZ[other] + tile.extentXZ[other] < nearBounds.maxM[other]
      )
        continue;
      if (
        Math.fround(tile.originXZ[axis] + tile.extentXZ[axis]) ===
        Math.fround(nearBounds.minM[axis])
      )
        mask |= 1 << (axis * 2);
      if (Math.fround(tile.originXZ[axis]) === Math.fround(nearBounds.maxM[axis]))
        mask |= 2 << (axis * 2);
    }
  }
  return mask;
}
function clipBodyToTile(body: WaterMeshBodyInput, node: Node): PathsD {
  const rect = [
    { x: 0, y: 0 },
    { x: node.extentXZ[0], y: 0 },
    { x: node.extentXZ[0], y: node.extentXZ[1] },
    { x: 0, y: node.extentXZ[1] },
  ];
  let paths: PathsD;
  if (body.polygonRings) {
    paths = body.polygonRings.map((ring) =>
      ring.map(([x, z]) => ({ x: x - node.x, y: z - node.z })),
    );
  } else if (body.polygon) {
    paths = [body.polygon.outer, ...(body.polygon.holes ?? [])].map((ring) =>
      ring.map(([x, z]) => ({ x: x - node.x, y: z - node.z })),
    );
  } else return [];
  return paths.length ? intersectD(paths, [rect], FillRule.EvenOdd, 6) : [];
}
function localCoverageRings(paths: PathsD): readonly (readonly Vec2[])[] {
  return Object.freeze(
    paths
      .filter((path) => path.length >= 3)
      .map((path) => Object.freeze(path.map((point) => [point.x, point.y] satisfies Vec2))),
  );
}
export function waterMeshGridTemplate(
  tessellationFactor: number,
  densityIndex: number,
  far: boolean,
): Result<
  Readonly<{
    mesh: MeshAsset;
    vertexCount: number;
    indexCount: number;
  }>,
  AssetError
> {
  const quadsPerEdge = far ? 1 : Math.max(2, 2 ** Math.max(0, tessellationFactor - densityIndex));
  const vertexCount = (quadsPerEdge + 1) ** 2,
    indexCount = quadsPerEdge ** 2 * 6;
  if (
    !Number.isSafeInteger(vertexCount) ||
    !Number.isSafeInteger(indexCount) ||
    vertexCount > MAX_WATER_MESH_TEMPLATE_VERTICES ||
    indexCount > MAX_WATER_MESH_TEMPLATE_INDICES
  )
    return fail('WaterMesh grid template within the vertex/index allocation budget', {
      tessellationFactor,
      densityIndex,
      quadsPerEdge,
      vertexCount,
      indexCount,
    });
  const floats: number[] = [],
    indices: number[] = [];
  for (let row = 0; row <= quadsPerEdge; row++)
    for (let column = 0; column <= quadsPerEdge; column++)
      floats.push(
        column / quadsPerEdge,
        0,
        row / quadsPerEdge,
        0,
        1,
        0,
        column / quadsPerEdge,
        row / quadsPerEdge,
      );
  for (let row = 0; row < quadsPerEdge; row++)
    for (let column = 0; column < quadsPerEdge; column++) {
      const a = row * (quadsPerEdge + 1) + column,
        b = a + 1,
        c = a + quadsPerEdge + 1,
        d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  const mesh = meshFromInterleaved(new Float32Array(floats), new Uint32Array(indices));
  return mesh.ok ? ok({ mesh: mesh.value, vertexCount, indexCount }) : mesh;
}
function serialize(
  instances: readonly WaterMeshTileInstance[],
  materialKeys: readonly string[],
  densityKeys: readonly number[],
): {
  bytes: Uint8Array;
  coverageBytes: Uint8Array;
  receipt: WaterMeshLayoutReceipt;
} {
  let coverageWordCount = 0;
  for (const item of instances) {
    const rings = item.far ? undefined : item.coverageRings;
    if (!rings?.length) continue;
    coverageWordCount += 1 + rings.length;
    for (const ring of rings) coverageWordCount += ring.length * 2;
  }
  for (const item of instances)
    if (item.continuitySupport) coverageWordCount += 2 + item.continuitySupport.weights.length;
  if (
    !Number.isSafeInteger(coverageWordCount) ||
    instances.length * 24 + coverageWordCount > 0x0fff_ffff
  )
    throw new RangeError('WaterMesh continuity support exceeds the versioned 28-bit word window');
  const bytes = new Uint8Array(instances.length * WATER_MESH_INSTANCE_STRIDE_BYTES),
    data = new DataView(bytes.buffer),
    coverageBytes = new Uint8Array(coverageWordCount * 4),
    coverageView = new DataView(coverageBytes.buffer);
  let coverageWord = 0;
  const offsets = WATER_MESH_INSTANCE_LAYOUT.offsets;
  const materialIndex = new Map(materialKeys.map((key, index) => [key, index])),
    densityIndex = new Map(densityKeys.map((key, index) => [key, index]));
  instances.forEach((item, index) => {
    const offset = index * WATER_MESH_INSTANCE_STRIDE_BYTES;
    data.setFloat32(offset + offsets.originX, item.originXZ[0], true);
    data.setFloat32(offset + offsets.originZ, item.originXZ[1], true);
    data.setFloat32(offset + offsets.extentX, item.extentXZ[0], true);
    data.setFloat32(offset + offsets.extentZ, item.extentXZ[1], true);
    data.setFloat32(offset + offsets.waterYM, item.waterYM, true);
    data.setFloat32(offset + offsets.yMinM, item.yMinM, true);
    data.setFloat32(offset + offsets.yMaxM, item.yMaxM, true);
    data.setUint32(offset + offsets.ownerRenderIndex, item.ownerRenderIndex, true);
    data.setUint32(offset + offsets.transitionWaveIndexPlusOne, item.transitionRenderIndex, true);
    data.setUint32(offset + offsets.lod0, item.lod0, true);
    data.setUint32(offset + offsets.lod1, item.lod1, true);
    data.setUint32(offset + offsets.maxMorphLod, item.maxMorphLod, true);
    data.setUint32(offset + offsets.flatFarBoundaryMask, item.flatFarBoundaryMask, true);
    data.setFloat32(offset + offsets.lodScaleM, item.lodScaleM, true);
    data.setUint32(offset + offsets.materialBucket, materialIndex.get(item.materialKey) ?? 0, true);
    data.setUint32(offset + offsets.densityBucket, densityIndex.get(item.densityKey) ?? 0, true);
    data.setUint16(offset + offsets.priorityU16, item.priorityU16, true);
    data.setUint16(
      offset + offsets.flags,
      (item.far ? 1 : 0) |
        (item.shouldMorph ? 2 : 0) |
        (item.canMorphTwice ? 4 : 0) |
        (Math.round(item.heightMorph01 * 8191) << 3),
      true,
    );
    data.setUint32(offset + offsets.quadsPerEdge, item.quadsPerEdge, true);
    data.setFloat32(offset + offsets.waveOriginOffsetX, item.waveOriginOffsetXZ[0], true);
    data.setFloat32(offset + offsets.waveOriginOffsetZ, item.waveOriginOffsetXZ[1], true);
    data.setFloat32(offset + offsets.cameraRelativeX, item.cameraRelativeXZ[0], true);
    data.setFloat32(offset + offsets.cameraRelativeZ, item.cameraRelativeXZ[1], true);
    const rings = item.far ? undefined : item.coverageRings;
    if (rings?.length) {
      data.setUint32(
        offset + offsets.coverageWordOffset,
        instances.length * (WATER_MESH_INSTANCE_STRIDE_BYTES / 4) + coverageWord,
        true,
      );
      data.setUint32(offset + offsets.coverageRingCount, rings.length, true);
      coverageView.setUint32(coverageWord++ * 4, rings.length, true);
      for (const ring of rings) coverageView.setUint32(coverageWord++ * 4, ring.length, true);
      for (const ring of rings)
        for (const point of ring) {
          coverageView.setFloat32(coverageWord++ * 4, point[0], true);
          coverageView.setFloat32(coverageWord++ * 4, point[1], true);
        }
    }
    const support = item.continuitySupport;
    if (support) {
      const wordOffset = instances.length * (WATER_MESH_INSTANCE_STRIDE_BYTES / 4) + coverageWord;
      const packedSupport = (wordOffset * 16) | item.flatFarBoundaryMask;
      if (packedSupport >>> 0 === 0x57474d31)
        throw new RangeError(
          'WaterMesh support offset collides with the reserved GPU header marker',
        );
      data.setUint32(offset + offsets.flatFarBoundaryMask, packedSupport, true);
      coverageView.setUint32(coverageWord++ * 4, 0x57434e31, true);
      coverageView.setUint32(coverageWord++ * 4, support.weights.length, true);
      for (const weight of support.weights)
        coverageView.setFloat32(coverageWord++ * 4, weight, true);
    }
  });
  return {
    bytes,
    coverageBytes,
    receipt: createWaterMeshLayoutReceipt(bytes, coverageBytes),
  };
}
function invalidWaterMeshBodyIdentity(body: WaterMeshBodyInput): boolean {
  return Boolean(
    !body.guid ||
      !Number.isInteger(body.generation) ||
      !Number.isInteger(body.priority) ||
      body.priority < -8192 ||
      body.priority > 8191 ||
      (body.insertionOrder !== undefined &&
        (!Number.isSafeInteger(body.insertionOrder) || body.insertionOrder < 0)) ||
      !finite2(body.waveOriginXZ) ||
      !Number.isFinite(body.baseHeightM) ||
      !Number.isFinite(body.maxWaveHeightM) ||
      body.maxWaveHeightM < 0 ||
      (body.worldYBounds &&
        (body.worldYBounds.length !== 2 ||
          !body.worldYBounds.every(Number.isFinite) ||
          body.worldYBounds[0] > body.worldYBounds[1])) ||
      !body.materialKey,
  );
}
function invalidWaterMeshBodyGeometry(body: WaterMeshBodyInput): boolean {
  return Boolean(
    (body.type === 'river' && body.polygon === undefined) ||
      (body.polygon &&
        (body.polygon.outer.length < 3 ||
          body.polygon.outer.some((point) => !finite2(point)) ||
          body.polygon.holes?.some(
            (ring) => ring.length < 3 || ring.some((point) => !finite2(point)),
          ))) ||
      (body.polygonRings !== undefined &&
        (body.type !== 'custom' ||
          body.polygon !== undefined ||
          body.polygonRings.length === 0 ||
          body.polygonRings.some(
            (ring) => ring.length < 3 || ring.some((point) => !finite2(point)),
          ))),
  );
}
function invalidWaterMeshBody(body: WaterMeshBodyInput): boolean {
  return (
    invalidWaterMeshBodyIdentity(body) ||
    invalidWaterMeshBodyGeometry(body) ||
    (body.transitionContinuity !== undefined &&
      (body.type !== 'river' ||
        !finite2(body.transitionContinuity.centerXZ) ||
        !Number.isFinite(body.transitionContinuity.reachM) ||
        !Number.isFinite(body.transitionContinuity.blendWidthM) ||
        body.transitionContinuity.blendWidthM <= 0 ||
        body.transitionContinuity.reachM <= body.transitionContinuity.blendWidthM))
  );
}
function invalidWaterMeshDimensions(input: WaterMeshBuildInput, view: WaterMeshViewInput): boolean {
  return (
    !input.zoneGuid ||
    !Number.isInteger(input.zoneGeneration) ||
    input.zoneGeneration < 0 ||
    !finite2(input.originXZ) ||
    !finite2(input.extentM) ||
    input.extentM.some((value) => value <= 0) ||
    !Number.isFinite(input.tileSizeM) ||
    input.tileSizeM <= 0 ||
    !Number.isInteger(input.tessellationFactor) ||
    input.tessellationFactor < 0 ||
    input.tessellationFactor > MAX_WATER_MESH_TESSELLATION_FACTOR ||
    !Number.isFinite(input.lodScale) ||
    !finite3(view.observerM)
  );
}
function invalidWaterMeshFarInput(input: WaterMeshBuildInput): boolean {
  return Boolean(
    input.far &&
      (!finite2(input.far.extentM) ||
        input.far.extentM.some((value) => value <= 0) ||
        (input.far.ownerGuid === undefined) !== (input.far.waterLevelM === undefined) ||
        (input.far.waterLevelM !== undefined && !Number.isFinite(input.far.waterLevelM)) ||
        (input.far.ownerGuid !== undefined && input.far.ownerGuid.length === 0)),
  );
}
function prepareWaterMeshDomain(input: WaterMeshBuildInput, view: WaterMeshViewInput) {
  if (invalidWaterMeshDimensions(input, view))
    return fail(
      'valid WaterMesh Zone and view dimensions in meters with TessellationFactor in [0, 8]',
      { input, view },
    );
  const lodScaleM = input.tileSizeM * Math.max(input.lodScale, 0.5);
  if (!Number.isFinite(lodScaleM) || lodScaleM <= 0)
    return fail('finite positive WaterMesh LOD scale in meters', {
      tileSizeM: input.tileSizeM,
      lodScale: input.lodScale,
    });
  const requiredTilesX = Math.ceil(input.extentM[0] / input.tileSizeM),
    requiredTilesZ = Math.ceil(input.extentM[1] / input.tileSizeM);
  if (
    !Number.isSafeInteger(requiredTilesX) ||
    !Number.isSafeInteger(requiredTilesZ) ||
    requiredTilesX <= 0 ||
    requiredTilesZ <= 0
  )
    return fail('WaterMesh extent/tile ratios within safe integer tile counts', {
      requiredTilesX,
      requiredTilesZ,
      extentM: input.extentM,
      tileSizeM: input.tileSizeM,
    });
  const halfTilesX = 2 ** Math.ceil(Math.log2(Math.max(1, requiredTilesX / 2)));
  const halfTilesZ = 2 ** Math.ceil(Math.log2(Math.max(1, requiredTilesZ / 2)));
  const dimension = Math.max(halfTilesX, halfTilesZ) * 2;
  const treeDepth = Math.log2(dimension);
  const maximumTreeNodes = (4 ** (treeDepth + 1) - 1) / 3;
  if (
    !Number.isSafeInteger(dimension) ||
    !Number.isSafeInteger(maximumTreeNodes) ||
    maximumTreeNodes > MAX_WATER_MESH_TREE_NODES
  )
    return fail(`WaterMesh quadtree within ${MAX_WATER_MESH_TREE_NODES} worst-case nodes`, {
      requiredTilesX,
      requiredTilesZ,
      tileDimension: dimension,
      treeDepth,
      dimension,
      maximumTreeNodes,
      nodeBudget: MAX_WATER_MESH_TREE_NODES,
    });
  const fullResolutionQuads = Math.max(2, 2 ** input.tessellationFactor);
  const fullResolutionVertices = (fullResolutionQuads + 1) ** 2,
    fullResolutionIndices = fullResolutionQuads ** 2 * 6;
  if (
    !Number.isSafeInteger(fullResolutionVertices) ||
    !Number.isSafeInteger(fullResolutionIndices) ||
    fullResolutionVertices > MAX_WATER_MESH_TEMPLATE_VERTICES ||
    fullResolutionIndices > MAX_WATER_MESH_TEMPLATE_INDICES
  )
    return fail(
      'full-resolution WaterMesh grid template within the vertex/index allocation budget',
      {
        tessellationFactor: input.tessellationFactor,
        quadsPerEdge: fullResolutionQuads,
        vertexCount: fullResolutionVertices,
        indexCount: fullResolutionIndices,
      },
    );
  if (invalidWaterMeshFarInput(input))
    return fail(
      'valid far extents and a paired explicit no-Ocean far owner and water level',
      input.far,
    );
  if (input.bodies.some((body) => invalidWaterMeshBody(body)))
    return fail(
      'generation-bound body geometry, finite WaterMesh rings, waveOriginXZ and integer priority in the WaterBody range [-8192, 8191]',
      input.bodies,
    );

  return ok({ lodScaleM, halfTilesX, halfTilesZ, dimension, treeDepth });
}
type WaterMeshBuildState = {
  root?: Node;
  paths: WeakMap<Node, Map<WaterMeshBodyInput, PathsD>>;
  templates: Map<string, Readonly<{ mesh: MeshAsset; vertexCount: number; indexCount: number }>>;
};
const meshBuildState = (): WaterMeshBuildState => ({ paths: new WeakMap(), templates: new Map() });

/** Owns immutable geometry preparation while each view still selects and packs its current LOD. */
export class WaterMeshViewBuilder {
  readonly #input: WaterMeshBuildInput;
  readonly #state = meshBuildState();

  constructor(input: WaterMeshBuildInput) {
    this.#input = structuredClone(input);
  }

  build(view: WaterMeshViewInput): Result<WaterMeshViewReceipt, AssetError> {
    return buildWaterMeshViewWithState(this.#input, view, this.#state);
  }
}

export function buildWaterMeshView(
  input: WaterMeshBuildInput,
  view: WaterMeshViewInput,
): Result<WaterMeshViewReceipt, AssetError> {
  return buildWaterMeshViewWithState(input, view, meshBuildState());
}

function buildWaterMeshViewWithState(
  input: WaterMeshBuildInput,
  view: WaterMeshViewInput,
  state: WaterMeshBuildState,
): Result<WaterMeshViewReceipt, AssetError> {
  const domain = prepareWaterMeshDomain(input, view);
  if (!domain.ok) return domain;
  const { lodScaleM, halfTilesX, halfTilesZ, dimension, treeDepth } = domain.value;
  const active = input.bodies.filter((body) => body.visible && body.affectsWaterMesh);
  if (input.nearMesh === 'gpu' && active.some((body) => body.transitionContinuity !== undefined))
    return fail(
      'terminal continuity support from the CPU WaterMesh producer; GPU traversal does not publish this optional payload',
      input.nearMesh,
    );
  const renderIndices = new Map(
    [...new Set(active.map((body) => body.guid))].sort().map((guid, index) => [guid, index + 1]),
  );
  const prepareBounds = () => {
    const worldSize = dimension * input.tileSizeM;
    const zoneBounds = {
      min: input.originXZ,
      max: [
        input.originXZ[0] + input.extentM[0],
        input.originXZ[1] + input.extentM[1],
      ] satisfies Vec2,
    };
    const snappedCenter = [
      Math.round((input.originXZ[0] + input.extentM[0] * 0.5) / input.tileSizeM) * input.tileSizeM,
      Math.round((input.originXZ[1] + input.extentM[1] * 0.5) / input.tileSizeM) * input.tileSizeM,
    ] satisfies Vec2;
    const bounds = {
      min: [
        snappedCenter[0] - halfTilesX * input.tileSizeM,
        snappedCenter[1] - halfTilesZ * input.tileSizeM,
      ] satisfies Vec2,
      max: [
        snappedCenter[0] + halfTilesX * input.tileSizeM,
        snappedCenter[1] + halfTilesZ * input.tileSizeM,
      ] satisfies Vec2,
    };
    if (
      !Number.isFinite(worldSize) ||
      !zoneBounds.max.every(Number.isFinite) ||
      !bounds.min.every(Number.isFinite) ||
      !bounds.max.every(Number.isFinite)
    )
      return fail('finite WaterMesh quadtree world extent', {
        dimension,
        tileSizeM: input.tileSizeM,
        originXZ: input.originXZ,
        extentM: input.extentM,
      });

    return ok({ worldSize, zoneBounds, bounds });
  };
  const preparedBounds = prepareBounds();
  if (!preparedBounds.ok) return preparedBounds;
  const { worldSize, zoneBounds, bounds } = preparedBounds.value;
  const maxLod = treeDepth;
  const selectNearMesh = () => {
    if (input.nearMesh !== 'gpu' && state.root === undefined)
      state.root = createNode(
        bounds.min[0],
        bounds.min[1],
        worldSize,
        0,
        treeDepth,
        active,
        bounds,
      );
    const root = state.root;
    const selected: WaterMeshTileInstance[] = [];
    const emitCoverage = (
      node: Node,
      layer: Candidate,
      lod: number,
      heightMorph: number,
      rings: PathsD,
      materialKey: string,
    ): void => {
      const clippedRings = localCoverageRings(rings);
      if (clippedRings.length === 0) return;
      const drawNode: Node = { ...node, owner: layer.owner };
      delete drawNode.transition;
      delete drawNode.transitionMaterialKey;
      if (layer.transition !== undefined) drawNode.transition = layer.transition;
      if (layer.transitionMaterialKey !== undefined)
        drawNode.transitionMaterialKey = layer.transitionMaterialKey;
      selected.push(
        tileInstance(
          drawNode,
          lod,
          maxLod,
          renderIndices,
          materialKey,
          false,
          node.extentXZ,
          input.tessellationFactor,
          lodScaleM,
          heightMorph,
          clippedRings,
          [view.observerM[0] - node.x, view.observerM[2] - node.z],
        ),
      );
    };
    const traverse = (node: Node) => {
      if (!node.owner || !nodeViewIntersects(view, node)) return;
      const layers = layersForNode(node);
      const layerLods = new Map(
        layers.map((layer) => [
          layer,
          chooseLayerLod(
            node,
            layer,
            view,
            input.tileSizeM,
            input.lodScale,
            treeDepth,
            [bounds.min[0], bounds.min[1]],
            Math.min(treeDepth, Math.max(0, input.tessellationFactor - 1)),
          ),
        ]),
      );
      const needsFinerChildren = layers.some(
        (layer) =>
          layerViewIntersects(view, node, layer) &&
          requireWaterValue(layerLods.get(layer)).lod < treeDepth - node.depth,
      );
      if (node.full && needsFinerChildren && node.depth < treeDepth)
        subdivideNode(node, treeDepth, active, bounds);
      if (!node.children || (node.full && !needsFinerChildren)) {
        let claimedPaths: PathsD = [];
        let tilePaths = state.paths.get(node);
        if (tilePaths === undefined) {
          tilePaths = new Map<WaterMeshBodyInput, PathsD>();
          state.paths.set(node, tilePaths);
        }
        const cachedPaths = tilePaths;
        const pathsFor = (body: WaterMeshBodyInput): PathsD => {
          let paths = cachedPaths.get(body);
          if (paths === undefined) {
            paths = clipBodyToTile(body, node);
            cachedPaths.set(body, paths);
          }
          return paths;
        };
        for (const layer of layers) {
          if (!layerViewIntersects(view, node, layer)) continue;
          const lod = requireWaterValue(layerLods.get(layer));
          const bodyPaths = pathsFor(layer.owner);
          if (bodyPaths.length === 0) continue;
          const visiblePaths = claimedPaths.length
            ? differenceD(bodyPaths, claimedPaths, FillRule.EvenOdd, 6)
            : bodyPaths;
          if (layer.transition && layer.transitionMaterialKey) {
            const transitionPaths = pathsFor(layer.transition);
            emitCoverage(
              node,
              { owner: layer.owner },
              lod.logicalLod,
              heightMorphForLowestLod(lod),
              differenceD(visiblePaths, transitionPaths, FillRule.EvenOdd, 6),
              layer.owner.materialKey,
            );
            emitCoverage(
              node,
              layer,
              lod.logicalLod,
              heightMorphForLowestLod(lod),
              intersectD(visiblePaths, transitionPaths, FillRule.EvenOdd, 6),
              layer.transitionMaterialKey,
            );
          } else
            emitCoverage(
              node,
              { owner: layer.owner },
              lod.logicalLod,
              heightMorphForLowestLod(lod),
              visiblePaths,
              layer.owner.materialKey,
            );
          claimedPaths = claimedPaths.length
            ? unionD(claimedPaths, bodyPaths, FillRule.EvenOdd, 6)
            : bodyPaths;
        }
        return;
      }
      node.children.forEach(traverse);
    };
    if (root !== undefined) traverse(root);
    const leafNodes: Node[] = [];
    const collectLeaves = (node: Node) => {
      if (node.children && !node.full) node.children.forEach(collectLeaves);
      else if (node.owner) leafNodes.push(node);
    };
    if (root !== undefined) collectLeaves(root);
    const visible = leafNodes.filter((node) =>
      layersForNode(node).some((layer) => layerViewIntersects(view, node, layer)),
    );

    return { selected, leafNodes, visible };
  };
  const { selected, leafNodes, visible } = selectNearMesh();
  const appendFarMesh = (): Result<number, AssetError> => {
    const hasOcean = active.some((body) => body.type === 'ocean');
    const farMaterial = input.far?.materialKey;
    if (
      input.far?.ownerGuid !== undefined &&
      !hasOcean &&
      !active.some((body) => body.guid === input.far?.ownerGuid)
    )
      return fail('an active WaterMesh body matching the explicit no-Ocean far owner', {
        ownerGuid: input.far.ownerGuid,
      });
    let farInstanceCount = 0;
    const hasFarPublication = (): boolean =>
      Boolean(
        input.far &&
          farMaterial &&
          input.far.extentM[0] > 0 &&
          input.far.extentM[1] > 0 &&
          (hasOcean || (input.far.ownerGuid !== undefined && input.far.waterLevelM !== undefined)),
      );
    if (hasFarPublication() && input.far && farMaterial) {
      const inner = input.far.innerBoundsXZ;
      if (
        inner &&
        (!finite2(inner.minM) ||
          !finite2(inner.maxM) ||
          inner.minM.some((value, axis) => value >= requireWaterValue(inner.maxM[axis])))
      )
        return fail('finite ordered far-mesh inner bounds', { innerBoundsXZ: inner });
      const farBounds = inner ? { min: inner.minM, max: inner.maxM } : zoneBounds;
      const [spanX, spanZ] = input.far.extentM,
        x0 = farBounds.min[0] - spanX,
        z0 = farBounds.min[1] - spanZ,
        x1 = farBounds.max[0],
        z1 = farBounds.max[1],
        ringWidth = x1 - x0 + spanX;
      const sea = active
        .filter((body) => body.type === 'ocean')
        .sort((a, b) => b.priority - a.priority)[0];
      const owner = sea ?? active.find((body) => body.guid === input.far?.ownerGuid);
      if (owner) {
        const extents: readonly (readonly [number, number, number, number])[] = [
          [x0, z0, ringWidth, spanZ / 2],
          [x0, z0 + spanZ / 2, ringWidth, spanZ / 2],
          [x0, z1, ringWidth, spanZ / 2],
          [x0, z1 + spanZ / 2, ringWidth, spanZ / 2],
          [x0, z0 + spanZ, spanX / 2, farBounds.max[1] - farBounds.min[1]],
          [x0 + spanX / 2, z0 + spanZ, spanX / 2, farBounds.max[1] - farBounds.min[1]],
          [x1, z0 + spanZ, spanX / 2, farBounds.max[1] - farBounds.min[1]],
          [x1 + spanX / 2, z0 + spanZ, spanX / 2, farBounds.max[1] - farBounds.min[1]],
        ];
        for (const [x, z, width, depth] of extents) {
          const node: Node = {
            x,
            z,
            size: Math.max(width, depth),
            extentXZ: [width, depth],
            depth: 0,
            owner,
            full: true,
          };
          const instance = tileInstance(
            node,
            maxLod,
            maxLod,
            renderIndices,
            farMaterial,
            true,
            [width, depth],
            input.tessellationFactor,
            lodScaleM,
          );
          selected.push(
            !sea && input.far.waterLevelM !== undefined
              ? Object.freeze({
                  ...instance,
                  waterYM: input.far.waterLevelM,
                  yMinM: input.far.waterLevelM,
                  yMaxM: input.far.waterLevelM,
                })
              : instance,
          );
          farInstanceCount++;
        }
      }
    }

    return ok(farInstanceCount);
  };
  const farResult = appendFarMesh();
  if (!farResult.ok) return farResult;
  const farInstanceCount = farResult.value;
  const continuity = buildWaterMeshContinuity(selected, active);
  if (!continuity.ok) return continuity;
  for (let index = 0; index < selected.length; index++)
    selected[index] = requireWaterValue(continuity.value[index]);
  const prepareTemplateGroups = () => {
    const grouped = new Map<string, WaterMeshTileInstance[]>();
    for (const instance of selected) {
      const key = JSON.stringify([
        instance.materialKey,
        instance.densityKey,
        instance.densityIndex,
        instance.far,
      ]);
      const group = grouped.get(key) ?? [];
      group.push(instance);
      grouped.set(key, group);
    }
    const templateKeys = new Set(
      [...grouped.values()].map((instances) =>
        JSON.stringify([
          requireWaterValue(instances[0]).densityIndex,
          requireWaterValue(instances[0]).far,
        ]),
      ),
    );
    let templateVertexBudget = 0,
      templateIndexBudget = 0;
    for (const key of templateKeys) {
      const [densityIndex, far] = JSON.parse(key) as [number, boolean];
      const quads = far
        ? 1
        : Math.max(2, 2 ** Math.max(0, input.tessellationFactor - densityIndex));
      templateVertexBudget += (quads + 1) ** 2;
      templateIndexBudget += quads ** 2 * 6;
    }
    if (
      !Number.isSafeInteger(templateVertexBudget) ||
      !Number.isSafeInteger(templateIndexBudget) ||
      templateVertexBudget > MAX_WATER_MESH_TEMPLATE_SET_VERTICES ||
      templateIndexBudget > MAX_WATER_MESH_TEMPLATE_SET_INDICES
    )
      return fail('WaterMesh template set within the aggregate vertex/index allocation budget', {
        templateCount: templateKeys.size,
        templateVertexBudget,
        templateIndexBudget,
        vertexBudget: MAX_WATER_MESH_TEMPLATE_SET_VERTICES,
        indexBudget: MAX_WATER_MESH_TEMPLATE_SET_INDICES,
      });

    return ok(grouped);
  };
  const templateGroups = prepareTemplateGroups();
  if (!templateGroups.ok) return templateGroups;
  const grouped = templateGroups.value;
  const prepareOwnerBuckets = () => {
    const buckets: WaterMeshBucket[] = [];
    const templateCache = state.templates;
    for (const instances of grouped.values()) {
      const first = requireWaterValue(instances[0]);
      const far = first.far;
      const templateKey = JSON.stringify([first.densityIndex, far]);
      let template = templateCache.get(templateKey);
      if (!template) {
        const builtTemplate = waterMeshGridTemplate(
          input.tessellationFactor,
          first.densityIndex,
          far,
        );
        if (!builtTemplate.ok) return builtTemplate;
        template = builtTemplate.value;
        templateCache.set(templateKey, template);
      }
      const ownerGroups = new Map<string, WaterMeshTileInstance[]>();
      for (const instance of instances) {
        const key = JSON.stringify([instance.ownerGuid, instance.ownerGeneration]);
        const ownerInstances = ownerGroups.get(key) ?? [];
        ownerInstances.push(instance);
        ownerGroups.set(key, ownerInstances);
      }
      const ownerDraws: WaterMeshOwnerDraw[] = [];
      for (const ownerInstances of ownerGroups.values()) {
        const drawOwner = requireWaterValue(ownerInstances[0]);
        const materialKeysForDraw = [
          ...new Set(ownerInstances.map((instance) => instance.materialKey)),
        ].sort();
        const densityKeysForDraw = [
          ...new Set(ownerInstances.map((instance) => instance.densityKey)),
        ].sort((a, b) => a - b);
        const packedDraw = serialize(ownerInstances, materialKeysForDraw, densityKeysForDraw);
        const drawKey = JSON.stringify([
          drawOwner.ownerGuid,
          drawOwner.ownerGeneration,
          drawOwner.materialKey,
          drawOwner.densityKey,
          drawOwner.densityIndex,
          drawOwner.far,
        ]);
        ownerDraws.push(
          Object.freeze({
            drawKey,
            ownerGuid: drawOwner.ownerGuid,
            ownerGeneration: drawOwner.ownerGeneration,
            instances: Object.freeze(ownerInstances),
            instanceBytes: packedDraw.bytes,
            coverageBytes: packedDraw.coverageBytes,
            layout: packedDraw.receipt,
            mesh: template.mesh,
            vertexCount: template.vertexCount,
            indexCount: template.indexCount,
          }),
        );
      }
      ownerDraws.sort(
        (a, b) => a.ownerGuid.localeCompare(b.ownerGuid) || a.ownerGeneration - b.ownerGeneration,
      );
      buckets.push(
        Object.freeze({
          materialKey: first.materialKey,
          densityKey: first.densityKey,
          densityIndex: first.densityIndex,
          instances: Object.freeze(instances),
          ...template,
          ownerDraws: Object.freeze(ownerDraws),
        }),
      );
    }
    buckets.sort(
      (a, b) =>
        a.materialKey.localeCompare(b.materialKey) ||
        a.densityKey - b.densityKey ||
        a.densityIndex - b.densityIndex,
    );

    return ok(buckets);
  };
  const preparedBuckets = prepareOwnerBuckets();
  if (!preparedBuckets.ok) return preparedBuckets;
  const buckets = preparedBuckets.value;
  const allInstances = Object.freeze(buckets.flatMap((bucket) => bucket.instances));
  const materialKeys = [...new Set(allInstances.map((instance) => instance.materialKey))].sort(),
    densityKeys = [...new Set(allInstances.map((instance) => instance.densityKey))].sort(
      (a, b) => a - b,
    );
  const packed = serialize(allInstances, materialKeys, densityKeys);
  const selectedTileCount = new Set(
    allInstances
      .filter((instance) => !instance.far)
      .map((instance) => JSON.stringify([instance.originXZ, instance.extentXZ, instance.lod0])),
  ).size;
  return ok(
    Object.freeze({
      zoneGuid: input.zoneGuid,
      zoneGeneration: input.zoneGeneration,
      viewId: view.viewId,
      treeDepth,
      leafCount: leafNodes.length,
      visibleLeafCount: visible.length,
      selectedTileCount,
      farInstanceCount,
      buckets: Object.freeze(buckets),
      instances: allInstances,
      instanceBytes: packed.bytes,
      coverageBytes: packed.coverageBytes,
      layout: packed.receipt,
    }),
  );
}
