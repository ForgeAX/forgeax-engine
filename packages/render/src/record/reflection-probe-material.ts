import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import { resolveReflectionProbeBinding } from './frame-lighting';
import type { ReflectionProbeRecordState } from './render-context';

/** GPU resource classes and actual CPU draws resolve the same reflection resources. */
export function reflectionProbeMaterial(
  probes: Pick<ReflectionProbeRecordState, 'table' | 'selections'>,
  skylight: SkylightBindGroupResources,
  resourceClass: string | undefined,
  worldId?: number,
  entityKey?: number,
): { readonly resources: SkylightBindGroupResources; readonly probeIndex: number } | undefined {
  let index: number | undefined;
  if (resourceClass?.startsWith('probe:')) {
    index = Number(resourceClass.slice(6));
  } else if (entityKey !== undefined && worldId !== undefined) {
    const selection = probes.selections.get(`${worldId}:${entityKey}`);
    if (selection === undefined) return undefined;
    const binding = resolveReflectionProbeBinding(selection, probes.table);
    if (binding.useSkylight) return undefined;
    index = binding.probeIndex;
  }
  if (index === undefined || !Number.isSafeInteger(index) || index < 0) return undefined;
  // The table owner publishes sorted, possibly sparse indices.
  const rows = probes.table.rows;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((rows[middle]?.index ?? Number.POSITIVE_INFINITY) < index) low = middle + 1;
    else high = middle;
  }
  const row = rows[low];
  if (
    row?.index !== index ||
    row.filteredView === undefined ||
    row.sampler === undefined ||
    row.uniformBuffer === undefined
  )
    return undefined;
  return {
    resources: {
      irradianceView: skylight.irradianceView,
      irradianceSampler: skylight.irradianceSampler,
      prefilterView: row.filteredView,
      skylightPrefilterView: skylight.prefilterView,
      prefilterSampler: row.sampler,
      brdfLutView: skylight.brdfLutView,
      intensityBuffer: row.uniformBuffer,
    },
    probeIndex: row.index,
  };
}
