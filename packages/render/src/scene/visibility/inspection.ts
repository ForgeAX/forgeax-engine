/** Detached, bounded LOD/occlusion facts for renderer inspection consumers. */

export const LOD_OCCLUSION_INSPECTION_SCHEMA = 'forgeax::lod-occlusion-inspection::v3' as const;
export const LOD_OCCLUSION_INSPECTION_MAX_BYTES = 16 * 1024;
const MAX_INSPECTION_SAMPLES = 64;

export interface LodOcclusionInspectionSample {
  readonly primitiveSlot: number;
  readonly level: number;
  readonly visible: boolean;
}

export interface LodOcclusionInspectionRow {
  readonly root: { readonly guid: string; readonly sourceKey: string };
  readonly view: {
    readonly attachmentId: string;
    readonly cameraEntity: number;
    readonly viewRole: 'main' | 'shadow' | 'reflection' | 'probe';
    readonly viewGeneration: number;
  };
  readonly slot: { readonly primitiveSlot: number; readonly slotGeneration: number };
  readonly generation: number;
  readonly count: {
    readonly candidates: number;
    readonly visible: number;
    readonly occluded: number;
  };
  readonly lodHistogram: readonly { readonly level: number; readonly count: number }[];
  readonly samples: readonly LodOcclusionInspectionSample[];
}

export interface LodOcclusionInspectionSubmit {
  readonly frameId: number;
  readonly build: string;
  readonly deviceGeneration: number;
}

/**
 * Per-World attribution is only authoritative when the renderer publishes
 * the GPU facts from the same submit that owns the parent inspection.  The
 * normal projection path remains useful diagnostics, but it must not be used
 * as evidence for a World-reorder or per-World LOD claim.
 */
export type LodOcclusionWorldAttribution =
  | { readonly status: 'unavailable'; readonly reason: 'projection-only' }
  | { readonly status: 'same-submit'; readonly submit: LodOcclusionInspectionSubmit };

export interface LodOcclusionWorldInspection {
  readonly attachmentId: string;
  readonly rows: readonly LodOcclusionInspectionRow[];
  readonly attribution: LodOcclusionWorldAttribution;
}

export interface LodOcclusionInspection extends LodOcclusionInspectionRow {
  readonly schema: typeof LOD_OCCLUSION_INSPECTION_SCHEMA;
  /** Atomic identity for the submit that produced every row below. */
  readonly submit: LodOcclusionInspectionSubmit;
  /** Stable attachment identity; array order is never an attribution key. */
  readonly worlds: readonly LodOcclusionWorldInspection[];
}

export type LodOcclusionInspectionInput = Omit<
  LodOcclusionInspection,
  'schema' | 'submit' | 'worlds'
> & {
  readonly submit?: LodOcclusionInspectionSubmit;
  readonly worlds?: readonly LodOcclusionWorldInspectionInput[];
};

export type LodOcclusionWorldInspectionInput = Omit<LodOcclusionWorldInspection, 'attribution'> & {
  readonly attribution?: LodOcclusionWorldAttribution;
};

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function copySamples(
  samples: readonly LodOcclusionInspectionSample[],
): readonly LodOcclusionInspectionSample[] {
  return Object.freeze(
    [...samples]
      .sort((left, right) => left.primitiveSlot - right.primitiveSlot)
      .slice(0, MAX_INSPECTION_SAMPLES)
      .map((sample) =>
        Object.freeze({
          primitiveSlot: nonNegativeInteger('sample.primitiveSlot', sample.primitiveSlot),
          level: nonNegativeInteger('sample.level', sample.level),
          visible: sample.visible,
        }),
      ),
  );
}

function copyWorldAttribution(
  attribution: LodOcclusionWorldAttribution | undefined,
): LodOcclusionWorldAttribution {
  if (attribution === undefined) {
    return Object.freeze({ status: 'unavailable', reason: 'projection-only' });
  }
  if (attribution.status === 'same-submit') {
    if (typeof attribution.submit.build !== 'string' || attribution.submit.build.length === 0) {
      throw new Error('world.attribution.submit.build must be a non-empty string');
    }
    nonNegativeInteger('world.attribution.submit.frameId', attribution.submit.frameId);
    nonNegativeInteger(
      'world.attribution.submit.deviceGeneration',
      attribution.submit.deviceGeneration,
    );
    return Object.freeze({
      status: 'same-submit',
      submit: Object.freeze({ ...attribution.submit }),
    });
  }
  if (attribution.status !== 'unavailable' || attribution.reason !== 'projection-only') {
    throw new Error('world.attribution must declare same-submit or projection-only');
  }
  return Object.freeze({ status: 'unavailable', reason: 'projection-only' });
}

function copyRow(row: LodOcclusionInspectionRow): LodOcclusionInspectionRow {
  for (const [name, value] of Object.entries({
    generation: row.generation,
    candidates: row.count.candidates,
    visible: row.count.visible,
    occluded: row.count.occluded,
  }))
    nonNegativeInteger(`inspection.${name}`, value);
  if (
    row.view.cameraEntity < 0 ||
    row.view.viewGeneration < 0 ||
    row.slot.primitiveSlot < 0 ||
    row.slot.slotGeneration < 0
  ) {
    throw new Error('inspection identity values must be non-negative');
  }
  return Object.freeze({
    root: Object.freeze({ ...row.root }),
    view: Object.freeze({ ...row.view }),
    slot: Object.freeze({ ...row.slot }),
    generation: row.generation,
    count: Object.freeze({ ...row.count }),
    lodHistogram: Object.freeze(
      row.lodHistogram.map((histogram) =>
        Object.freeze({
          level: nonNegativeInteger('histogram.level', histogram.level),
          count: nonNegativeInteger('histogram.count', histogram.count),
        }),
      ),
    ),
    samples: copySamples(row.samples),
  });
}

function copyWorlds(
  worlds: readonly LodOcclusionWorldInspectionInput[] | undefined,
  fallback: LodOcclusionInspectionRow,
): readonly LodOcclusionWorldInspection[] {
  const source = worlds ?? [{ attachmentId: fallback.view.attachmentId, rows: [fallback] }];
  return Object.freeze(
    source.map((world) =>
      Object.freeze({
        attachmentId: world.attachmentId,
        rows: Object.freeze(world.rows.map((row) => copyRow(row))),
        attribution: copyWorldAttribution(world.attribution),
      }),
    ),
  );
}

export function inspectLodOcclusion(input: LodOcclusionInspectionInput): LodOcclusionInspection {
  const row = copyRow(input);
  const submit = input.submit ?? {
    frameId: input.generation,
    build: 'unknown',
    deviceGeneration: 0,
  };
  nonNegativeInteger('inspection.submit.frameId', submit.frameId);
  nonNegativeInteger('inspection.submit.deviceGeneration', submit.deviceGeneration);
  if (typeof submit.build !== 'string' || submit.build.length === 0) {
    throw new Error('inspection.submit.build must be a non-empty string');
  }
  const worlds = copyWorlds(input.worlds, row);
  for (const world of worlds) {
    if (
      world.attribution.status === 'same-submit' &&
      (world.attribution.submit.frameId !== submit.frameId ||
        world.attribution.submit.build !== submit.build ||
        world.attribution.submit.deviceGeneration !== submit.deviceGeneration)
    ) {
      throw new Error('world attribution must reference the parent inspection submit');
    }
  }
  const inspection: LodOcclusionInspection = Object.freeze({
    schema: LOD_OCCLUSION_INSPECTION_SCHEMA,
    ...row,
    submit: Object.freeze({ ...submit }),
    worlds,
  });
  if (JSON.stringify(inspection).length > LOD_OCCLUSION_INSPECTION_MAX_BYTES) {
    throw new Error(`LOD occlusion inspection exceeds ${LOD_OCCLUSION_INSPECTION_MAX_BYTES} bytes`);
  }
  return inspection;
}

export function serializeLodOcclusionInspection(inspection: LodOcclusionInspection): string {
  const serialized = JSON.stringify(inspection);
  if (serialized.length > LOD_OCCLUSION_INSPECTION_MAX_BYTES) {
    throw new Error(`LOD occlusion inspection exceeds ${LOD_OCCLUSION_INSPECTION_MAX_BYTES} bytes`);
  }
  return serialized;
}
