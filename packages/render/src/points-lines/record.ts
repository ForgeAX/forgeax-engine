import { LineCapValue } from '../components/lines';
import type { PointsLinesExpandedGeometry } from './expansion-cache';
import type { PointsLinesPreparedSnapshot, PointsLinesStyle } from './snapshot';

export const POINTS_LINES_MATERIAL_SHADER_ID = 'forgeax::points-lines';

/**
 * Round caps select a separate fragment entry so butt lines and points run
 * without the per-fragment end test (undefined keeps the default `fs_main`).
 */
export function pointsLinesFragmentEntry(
  style: PointsLinesStyle | undefined,
): 'fs_round' | undefined {
  return style?.kind === 'lines' && style.cap === LineCapValue.round ? 'fs_round' : undefined;
}

export type PointsLinesLane = 'direct' | 'clustered' | 'cpu-webgl2';
export type PointsLinesBackend = 'webgpu' | 'wgpu-webgl2' | 'null';

export interface PointsLinesLaneContract {
  readonly lane: PointsLinesLane;
  readonly backend: PointsLinesBackend;
  readonly authoring: 'shared';
  readonly evidence: 'runtime' | 'structural-only';
  readonly material: {
    readonly source: 'material';
    readonly shaderId: typeof POINTS_LINES_MATERIAL_SHADER_ID;
    readonly shadingModel: 'unlit';
    readonly clusteredLighting: false;
    readonly lit: false;
  };
  readonly graph: {
    readonly additionalAttachments: 0;
    readonly additionalPasses: 0;
  };
  readonly shadowDrawCount: 0;
  readonly capabilities: {
    readonly compute: false;
    readonly storage: false;
    readonly indirect: false;
  };
}

export interface PointsLinesRecordPlan
  extends Pick<PointsLinesLaneContract, 'lane' | 'backend' | 'shadowDrawCount' | 'graph'>,
    Pick<PointsLinesPreparedSnapshot, 'meshGeneration' | 'materialGeneration'> {
  readonly materialShaderId: typeof POINTS_LINES_MATERIAL_SHADER_ID;
  readonly component: 'Points' | 'Lines';
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly drawCount: 0 | 1;
  /** Raster margin in the style's own width units (pixels or world). */
  readonly conservativeMargin: number;
}

/**
 * Describes the shared lane boundary without selecting a backend in authoring.
 * Every lane uses CPU-uploaded triangle expansion; capability flags therefore
 * stay false, including on WebGPU, and the graph remains the existing pass.
 */
export function createPointsLinesLaneContract(
  lane: PointsLinesLane,
  backend: PointsLinesBackend,
): PointsLinesLaneContract {
  return {
    lane,
    backend,
    authoring: 'shared',
    evidence: backend === 'null' ? 'structural-only' : 'runtime',
    material: {
      source: 'material',
      shaderId: POINTS_LINES_MATERIAL_SHADER_ID,
      shadingModel: 'unlit',
      clusteredLighting: false,
      lit: false,
    },
    graph: { additionalAttachments: 0, additionalPasses: 0 },
    shadowDrawCount: 0,
    capabilities: { compute: false, storage: false, indirect: false },
  };
}

/**
 * Turns one retained expansion into the bounded draw facts consumed by the
 * existing record pass. The shader expands one quad per point or segment,
 * so the limits are exactly four vertices and six indices per primitive.
 */
export function createPointsLinesRecordPlan(
  snapshot: PointsLinesPreparedSnapshot,
  geometry: PointsLinesExpandedGeometry,
  contract: PointsLinesLaneContract,
): PointsLinesRecordPlan {
  const primitiveCount = geometry.pointCount + geometry.segmentCount;
  const visible = snapshot.visible && primitiveCount > 0;
  const conservativeMargin =
    snapshot.style?.kind === 'points'
      ? snapshot.style.sizePx * 0.5
      : (snapshot.style?.width ?? 0) * 2;
  return {
    lane: contract.lane,
    backend: contract.backend,
    materialShaderId: POINTS_LINES_MATERIAL_SHADER_ID,
    component: geometry.component,
    meshGeneration: snapshot.meshGeneration,
    materialGeneration: snapshot.materialGeneration,
    vertexCount: primitiveCount * 4,
    indexCount: primitiveCount * 6,
    drawCount: visible ? 1 : 0,
    shadowDrawCount: 0,
    conservativeMargin,
    graph: contract.graph,
  };
}

interface PointsLinesLaneAdapter {
  readonly contract: PointsLinesLaneContract;
  createRecordPlan(
    snapshot: PointsLinesPreparedSnapshot,
    geometry: PointsLinesExpandedGeometry,
  ): PointsLinesRecordPlan;
}

export function createPointsLinesLaneAdapter(
  lane: PointsLinesLane,
  backend: PointsLinesBackend,
): PointsLinesLaneAdapter {
  const contract = createPointsLinesLaneContract(lane, backend);
  return {
    contract,
    createRecordPlan: (snapshot, geometry) =>
      createPointsLinesRecordPlan(snapshot, geometry, contract),
  };
}
