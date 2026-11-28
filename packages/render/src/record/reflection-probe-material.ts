import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import type { ReflectionProbeTable, ReflectionProbeTableRow } from '../reflection/gpu-table';
import type { ReflectionProbeSelectionResult } from '../reflection/projection';
import type { ReflectionProbeRecordState } from './render-context';

/** The receiver keeps the same diffuse sky and binds its selected specular environment. */
export function reflectionProbeResources(
  fallback: SkylightBindGroupResources,
  probe: Required<Pick<ReflectionProbeTableRow, 'filteredView' | 'sampler' | 'uniformBuffer'>>,
): SkylightBindGroupResources {
  return {
    ...fallback,
    prefilterView: probe.filteredView,
    prefilterSampler: probe.sampler,
    intensityBuffer: probe.uniformBuffer,
  };
}

function selectedProbeIndex(
  selection: ReflectionProbeSelectionResult | undefined,
  table: ReflectionProbeTable,
): number | undefined {
  return selection?.kind === 'probe'
    ? table.cpuIndexByPrimitive(String(selection.entityKey))
    : undefined;
}

/** Conservative frame demand: resident probes without a selected receiver need no lighting coverage. */
export function referencedReflectionProbeIndices(
  probes: Pick<ReflectionProbeRecordState, 'table' | 'selections'>,
): ReadonlySet<number> {
  const indices = new Set<number>();
  for (const selection of probes.selections.values()) {
    const index = selectedProbeIndex(selection, probes.table);
    if (index !== undefined) indices.add(index);
  }
  return indices;
}

/** GPU resource classes and actual CPU draws resolve the same reflection resources. */
export function reflectionProbeMaterial(
  probes: Pick<ReflectionProbeRecordState, 'table' | 'selections'>,
  skylight: SkylightBindGroupResources,
  resourceClass: string | undefined,
  entityKey?: number,
): { readonly resources: SkylightBindGroupResources; readonly probeIndex: number } | undefined {
  let index: number | undefined;
  if (resourceClass?.startsWith('probe:')) {
    index = Number(resourceClass.slice(6));
  } else if (entityKey !== undefined) {
    index = selectedProbeIndex(probes.selections.get(String(entityKey)), probes.table);
  }
  if (index === undefined || !Number.isSafeInteger(index) || index < 0) return undefined;
  const row = readyProbeRow(probes.table, index);
  if (row === undefined) return undefined;
  return {
    resources: reflectionProbeResources(skylight, row),
    probeIndex: row.index,
  };
}

type ReadyProbeRow = ReflectionProbeTableRow &
  Required<Pick<ReflectionProbeTableRow, 'filteredView' | 'sampler' | 'uniformBuffer'>>;

function readyProbeRow(table: ReflectionProbeTable, index: number): ReadyProbeRow | undefined {
  // The table owner publishes sorted, possibly sparse indices.
  const rows = table.rows;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((rows[middle]?.index ?? Number.POSITIVE_INFINITY) < index) low = middle + 1;
    else high = middle;
  }
  const row = rows[low];
  return row?.index === index &&
    row.filteredView !== undefined &&
    row.sampler !== undefined &&
    row.uniformBuffer !== undefined
    ? (row as ReadyProbeRow)
    : undefined;
}

/** Topology needs only the first usable receiver, so it never builds a second probe roster. */
export function hasReferencedReadyProbe(
  probes: Pick<ReflectionProbeRecordState, 'table' | 'selections'> | undefined,
): boolean {
  if (probes === undefined || probes.table.rows.length === 0) return false;
  for (const selection of probes.selections.values()) {
    const index = selectedProbeIndex(selection, probes.table);
    if (index !== undefined && readyProbeRow(probes.table, index) !== undefined) return true;
  }
  return false;
}
