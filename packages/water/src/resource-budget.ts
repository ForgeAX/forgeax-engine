import { err, ok, type Result } from '@forgeax/engine-types';

export type WaterBudgetResource = Readonly<{
  key: string;
  feature:
    | 'water-info'
    | 'scene-copy'
    | 'prepass'
    | 'ssr'
    | 'water-mesh'
    | 'fluid'
    | 'advanced'
    | 'ocean';
  deviceGeneration: number;
  graphResourceVersion: string;
  copies: number;
  lastUseFence: number | null;
  state: 'candidate' | 'active' | 'retiring';
}> &
  (
    | Readonly<{
        kind: 'texture';
        format: keyof typeof FORMAT_BYTES;
        width: number;
        height: number;
        layers: number;
        mips: number;
        samples: 1 | 4;
      }>
    | Readonly<{ kind: 'buffer'; size: number; alignment: number }>
  );

export type WaterBudgetError = Readonly<{
  code: 'water-budget-invalid';
  expected: string;
  hint: string;
  detail: Readonly<{ key: string; field: string }>;
}>;
const FORMAT_BYTES = {
  rgba16float: 8,
  rgba32float: 16,
  rgba32uint: 16,
  rg16float: 4,
  r16float: 2,
  r32float: 4,
  depth32float: 4,
  'depth32float-stencil8': 8,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
} as const;

function textureDescriptorBytes(
  resource: Extract<WaterBudgetResource, { kind: 'texture' }>,
  fail: (key: string, field: string) => Result<never, WaterBudgetError>,
): Result<number, WaterBudgetError> {
  let bytes = 0;
  if (!(resource.format in FORMAT_BYTES)) return fail(resource.key, 'format');
  if (resource.mips > 1 + Math.floor(Math.log2(Math.max(resource.width, resource.height))))
    return fail(resource.key, 'mips');
  if (resource.samples !== 1 && resource.samples !== 4) return fail(resource.key, 'samples');
  if (resource.samples > 1 && resource.mips !== 1) return fail(resource.key, 'multisample-mips');
  for (let mip = 0; mip < resource.mips; mip++)
    bytes +=
      Math.max(1, Math.floor(resource.width / 2 ** mip)) *
      Math.max(1, Math.floor(resource.height / 2 ** mip)) *
      resource.layers *
      FORMAT_BYTES[resource.format] *
      resource.samples;
  return ok(bytes);
}

/** Logical descriptor bytes, including concurrent generations. Resolve/history are explicit rows. */
export function estimateWaterResourceBudget(resources: readonly WaterBudgetResource[]): Result<
  Readonly<{
    unit: 'logical-descriptor-bytes';
    physicalVram: 'unmeasured';
    gpuMilliseconds: 'unmeasured';
    activeBytes: number;
    candidateBytes: number;
    retiringBytes: number;
    concurrentBytes: number;
    resources: readonly Readonly<{ resource: WaterBudgetResource; bytes: number }>[];
  }>,
  WaterBudgetError
> {
  const rows: { resource: WaterBudgetResource; bytes: number }[] = [];
  const keys = new Set<string>();
  const fail = (key: string, field: string) =>
    err({
      code: 'water-budget-invalid',
      expected: 'unique versioned resources with finite safe positive descriptor values',
      hint: 'include every physical copy and pending last-use fence; report unknown owner bytes separately',
      detail: { key, field },
    } as const);
  for (const resource of resources) {
    if (keys.has(resource.key)) return fail(resource.key, 'key');
    keys.add(resource.key);
    if (!resource.graphResourceVersion) return fail(resource.key, 'graphResourceVersion');
    if (!Number.isSafeInteger(resource.deviceGeneration) || resource.deviceGeneration < 0)
      return fail(resource.key, 'deviceGeneration');
    const values =
      resource.kind === 'texture'
        ? [
            resource.width,
            resource.height,
            resource.layers,
            resource.mips,
            resource.samples,
            resource.copies,
          ]
        : [resource.size, resource.alignment, resource.copies];
    if (values.some((value) => !Number.isSafeInteger(value) || value <= 0))
      return fail(resource.key, 'descriptor');
    if (
      resource.lastUseFence !== null &&
      (!Number.isSafeInteger(resource.lastUseFence) || resource.lastUseFence < 0)
    )
      return fail(resource.key, 'lastUseFence');
    if (resource.state === 'retiring' && resource.lastUseFence === null)
      return fail(resource.key, 'lastUseFence');
    let bytes: number;
    if (resource.kind === 'buffer')
      bytes = Math.ceil(resource.size / resource.alignment) * resource.alignment;
    else {
      const measured = textureDescriptorBytes(resource, fail);
      if (!measured.ok) return measured;
      bytes = measured.value;
    }
    bytes *= resource.copies;
    if (!Number.isSafeInteger(bytes)) return fail(resource.key, 'bytes');
    rows.push({ resource, bytes });
  }
  const sum = (state: WaterBudgetResource['state']) =>
    rows.reduce((total, row) => total + (row.resource.state === state ? row.bytes : 0), 0);
  const activeBytes = sum('active'),
    candidateBytes = sum('candidate'),
    retiringBytes = sum('retiring'),
    concurrentBytes = activeBytes + candidateBytes + retiringBytes;
  if (!Number.isSafeInteger(concurrentBytes)) return fail('total', 'bytes');
  return ok({
    unit: 'logical-descriptor-bytes',
    physicalVram: 'unmeasured',
    gpuMilliseconds: 'unmeasured',
    activeBytes,
    candidateBytes,
    retiringBytes,
    concurrentBytes,
    resources: rows,
  });
}

export interface WaterQualityThresholds {
  readonly lowerBytes: number;
  readonly upperBytes: number;
  readonly consecutiveFrames: number;
}
/** Explicit measured budget policy; no assumed hardware limit or one-frame oscillation. */
export class WaterQualityBudgetPolicy {
  #over = 0;
  #under = 0;
  constructor(readonly thresholds: WaterQualityThresholds) {
    if (
      !Number.isSafeInteger(thresholds.lowerBytes) ||
      thresholds.lowerBytes < 0 ||
      !Number.isSafeInteger(thresholds.upperBytes) ||
      thresholds.upperBytes <= thresholds.lowerBytes ||
      !Number.isSafeInteger(thresholds.consecutiveFrames) ||
      thresholds.consecutiveFrames < 1
    )
      throw new RangeError('Invalid explicit Water quality thresholds');
  }
  observe(bytes: number): 'hold' | 'lower-quality' | 'raise-quality' {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      this.#over = 0;
      this.#under = 0;
      return 'hold';
    }
    this.#over = bytes > this.thresholds.upperBytes ? this.#over + 1 : 0;
    this.#under = bytes < this.thresholds.lowerBytes ? this.#under + 1 : 0;
    if (this.#over >= this.thresholds.consecutiveFrames) {
      this.#over = 0;
      return 'lower-quality';
    }
    if (this.#under >= this.thresholds.consecutiveFrames) {
      this.#under = 0;
      return 'raise-quality';
    }
    return 'hold';
  }
}
