import type { MeshAsset } from '@forgeax/engine-types';
import type { LodTopology } from '../src/lod-topology';

export interface ScaleFixture {
  readonly parts: number;
  readonly radial: number;
  readonly heightSegments: number;
}

export interface ScaleDeps {
  readonly model: typeof import('../src/model').model;
  readonly sel: typeof import('../src/selectors').sel;
  readonly lodTopologyReport: (lods: readonly MeshAsset[]) => LodTopology[];
  readonly generateMeshLods: (
    mesh: MeshAsset,
    options: unknown,
  ) => Promise<{
    readonly ok: boolean;
    readonly value: {
      readonly meshes: readonly MeshAsset[];
      readonly reports: readonly { readonly triangleCount: number }[];
    };
    readonly error: unknown;
  }>;
  readonly deriveGuid: (name: string) => unknown;
}

export interface ScaleReport {
  readonly fixture: ScaleFixture;
  readonly host: Readonly<Record<string, string | number>>;
  readonly parts: number;
  readonly faces: number;
  readonly triangles: number;
  readonly gpuVertices: number;
  readonly lodTriangles: readonly number[];
  readonly lodTopology: readonly LodTopology[];
  readonly phasesMs: {
    readonly build: number;
    readonly export: number;
    readonly lod: number;
    readonly lodTopology: number;
  };
  readonly totalMs: number;
  readonly memory: {
    readonly peakRssMb: number;
    readonly peakHeapUsedMb: number;
    readonly gcExposed: boolean;
  };
  readonly extrapolation: {
    readonly model: string;
    readonly targetTriangles: number;
    readonly factor: number;
    readonly phasesMs: Readonly<Record<string, number>>;
  };
}

export const FIXTURES: Readonly<Record<'tiny' | 'f1', ScaleFixture>>;
export const F1_TARGET_TRIANGLES: number;
export function runScale(
  deps: ScaleDeps,
  fixture: ScaleFixture,
  targetTriangles?: number,
): Promise<ScaleReport>;
