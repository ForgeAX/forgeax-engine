import type { Buffer, Sampler, TextureView } from '@forgeax/engine-rhi';

export interface ReflectionProbeTableRow {
  readonly primitiveKey?: string;
  readonly index: number;
  readonly worldId: number;
  readonly entityKey: number;
  readonly center: readonly [number, number, number];
  readonly halfExtents: readonly [number, number, number];
  readonly intensity: number;
  readonly generation: number;
  /** Renderer-owned filtered cube used by the Standard material lane. */
  readonly filteredView?: TextureView;
  /** Renderer-owned sampler paired with filteredView. */
  readonly sampler?: Sampler;
  /** Per-probe uniform payload; keeps MaterialAsset ABI unchanged. */
  readonly uniformBuffer?: Buffer;
}

export interface ReflectionProbeTable {
  readonly rows: readonly ReflectionProbeTableRow[];
  readonly cpuIndexByPrimitive: (primitiveKey: string) => number | undefined;
  readonly gpuIndexByPrimitive: (primitiveKey: string) => number | undefined;
}

export function buildReflectionProbeTable(
  rows: readonly ReflectionProbeTableRow[],
): ReflectionProbeTable {
  const ordered = rows.slice().sort((a, b) => a.index - b.index);
  const indices = new Map<string, number>();
  for (const row of ordered) {
    if (row.primitiveKey !== undefined) indices.set(row.primitiveKey, row.index);
  }
  const indexFor = (primitiveKey: string): number | undefined => indices.get(primitiveKey);
  return {
    rows: Object.freeze(ordered),
    cpuIndexByPrimitive: indexFor,
    gpuIndexByPrimitive: indexFor,
  };
}

export function reflectionProbeTableBytes(table: ReflectionProbeTable): number {
  return table.rows.length * 48;
}
