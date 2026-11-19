type RecordValue = Record<string, unknown>;

const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const aliases: Readonly<Record<string, string>> = {
  'ue-water-spline/1': 'water-spline/2',
  'ue-5.8.1-water-body': 'water-body-shallow/2',
  'ue-5.8.1-river': 'river-shallow/2',
  'ue-5.8.1-niagara-fft': 'ocean-spectrum-fft/2',
};

function migrateField(value: unknown, field: string): unknown {
  if (!record(value)) return value;
  const previous = value[field];
  const current = typeof previous === 'string' ? aliases[previous] : undefined;
  return current === undefined ? value : { ...value, [field]: current };
}

/** Decode previous saved labels at asset admission; authored sources use current labels. */
export function migrateWaterPayload(value: unknown): unknown {
  if (!record(value)) return value;
  if (value.kind === 'water-body') {
    const spline = migrateField(value.spline, 'interpolationVersion');
    return spline === value.spline ? value : { ...value, spline };
  }
  if (value.kind === 'water-brush-recipe' && Array.isArray(value.orderedActors)) {
    let changed = false;
    const orderedActors = value.orderedActors.map((actor: unknown) => {
      if (!record(actor) || actor.kind !== 'island') return actor;
      const spline = migrateField(actor.spline, 'interpolationVersion');
      if (spline === actor.spline) return actor;
      changed = true;
      return { ...actor, spline };
    });
    return changed ? { ...value, orderedActors } : value;
  }
  if (value.kind === 'water-simulation-recipe' && value.system === 'water-advanced') {
    const shallowStageConfig = migrateField(value.shallowStageConfig, 'stageProfile');
    const oceanPatchConfig = migrateField(value.oceanPatchConfig, 'algorithm');
    return shallowStageConfig === value.shallowStageConfig &&
      oceanPatchConfig === value.oceanPatchConfig
      ? value
      : {
          ...value,
          ...(value.shallowStageConfig === undefined ? {} : { shallowStageConfig }),
          ...(value.oceanPatchConfig === undefined ? {} : { oceanPatchConfig }),
        };
  }
  return value;
}

/** Geometry digest v1 retains its saved projection while equivalent labels evolve. */
export function waterSplineDigestProjection<T>(spline: T): T {
  return record(spline) && spline.interpolationVersion === 'water-spline/2'
    ? ({ ...spline, interpolationVersion: 'ue-water-spline/1' } as T)
    : spline;
}
