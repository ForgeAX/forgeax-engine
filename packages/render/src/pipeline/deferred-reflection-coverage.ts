import type { RhiLimits, TextureView } from '@forgeax/engine-rhi';
import type { ShaderReflection } from '@forgeax/engine-types';
import { buildPbrViewBglEntries } from '../pbr-pipeline';
import { referencedReflectionProbeIndices } from '../record/reflection-probe-material';
import type { PipelineState, ReflectionProbeRecordState } from '../record/render-context';
import type { ReflectionProbeTableRow } from '../reflection/gpu-table';
import { DEFAULT_REFLECTION_PROBE_LIMITS } from '../reflection/projection';

export const DEFERRED_REFLECTION_MAX_PROBE_INDEX = 254;
export const DEFERRED_REFLECTION_OVERFLOW_VERTEX = 'vs_standard_deferred_reflection_overflow';

export function deferredReflectionOverflowEntry(hasFallback: boolean, compact = false) {
  if (compact)
    return hasFallback
      ? 'fs_standard_deferred_compact_reflections_overflow'
      : 'fs_standard_deferred_compact_overflow';
  return hasFallback
    ? 'fs_standard_deferred_reflections_overflow'
    : 'fs_standard_deferred_reflection_overflow';
}

export function deferredReflectionArrayEntry(fragmentEntry: string, count: 1 | 2) {
  return `${fragmentEntry}_array_${count === 1 ? 'single' : 'dual'}`;
}

const SKY_FLOATS = 16;
const PROBE_FLOATS = 8;
export const DEFERRED_REFLECTION_TABLE_BYTES =
  (SKY_FLOATS + DEFAULT_REFLECTION_PROBE_LIMITS.maxProbes * PROBE_FLOATS) *
  Float32Array.BYTES_PER_ELEMENT;

export interface DeferredReflectionArrays {
  readonly views: readonly [TextureView] | readonly [TextureView, TextureView];
  readonly overflow: readonly { readonly view: TextureView; readonly sizeClass: number }[];
  readonly data: Float32Array;
}

type ReadyProbe = ReflectionProbeTableRow &
  Required<Pick<ReflectionProbeTableRow, 'filteredView' | 'sampler' | 'uniformBuffer'>>;

export function referencedDeferredProbes(probes: ReflectionProbeRecordState | undefined) {
  if (probes === undefined || probes.table.rows.length === 0) return [];
  const referenced = referencedReflectionProbeIndices(probes);
  return probes.table.rows.filter(
    (row): row is ReadyProbe =>
      referenced.has(row.index) &&
      row.filteredView !== undefined &&
      row.sampler !== undefined &&
      row.uniformBuffer !== undefined,
  );
}

/** Count the actual shared view layout as well as the reflected entry's array bindings. */
export function resolveDeferredReflectionArrayBudget(
  limits: RhiLimits,
  state: PipelineState,
  reflection: ShaderReflection,
  fragmentEntry: string,
  clustered: boolean,
  usesLut: boolean,
  hasFallback: boolean,
  compact = false,
): 0 | 1 | 2 {
  if (
    (limits.maxUniformBufferBindingSize ?? 0) < DEFERRED_REFLECTION_TABLE_BYTES ||
    reflection.boundGlobals.find(({ group, binding }) => group === 3 && binding === 3)?.span !==
      DEFERRED_REFLECTION_TABLE_BYTES
  )
    return 0;
  // The bounded overflow vertex and fragment also identify this address layout.
  // Older cooked modules retain standalone Deferred until they are rebuilt.
  const vertex = reflection.entryPoints?.find(
    ({ name }) => name === DEFERRED_REFLECTION_OVERFLOW_VERTEX,
  );
  const overflow = reflection.entryPoints?.find(
    ({ name }) => name === deferredReflectionOverflowEntry(hasFallback, compact),
  );
  if (
    vertex?.stage !== 'vertex' ||
    !vertex.bindings.some(({ group, binding }) => group === 3 && binding === 3) ||
    overflow?.stage !== 'fragment' ||
    !overflow.bindings.some(({ group, binding }) => group === 3 && binding === 1)
  )
    return 0;
  const view = buildPbrViewBglEntries({
    storageBuffer: state.device.caps.storageBuffer,
    atmosphere: state.atmosphereAvailable === true,
    extendedLighting: state.extendedLightingAvailable ?? true,
    projectorAvailable: state.projectorAvailable !== false,
  });
  const vertexUniforms = view.filter(
    (entry) => (entry.visibility & 1) !== 0 && entry.buffer?.type === 'uniform',
  ).length;
  const fragmentView = view.filter((entry) => (entry.visibility & 2) !== 0);
  // GBuffer (4), scene depth, AO, receiver geometry, irradiance, DFG and sky.
  // This layout leaves the standalone PMREM slot unused for both array entries.
  const viewTextures = fragmentView.filter((entry) => entry.texture !== undefined).length;
  const fixedTextures = viewTextures + 10 + Number(usesLut);
  const fixedUniforms =
    fragmentView.filter((entry) => entry.buffer?.type === 'uniform').length + 2 + Number(clustered);
  // Samplers and storage buffers are exactly the same as the already admitted
  // standalone lighting layout. The table adds a single uniform binding.
  if (Math.max(vertexUniforms, fixedUniforms) + 1 > (limits.maxUniformBuffersPerShaderStage ?? 0))
    return 0;
  for (const count of [2, 1] as const) {
    const entry = reflection.entryPoints?.find(
      ({ name }) => name === deferredReflectionArrayEntry(fragmentEntry, count),
    );
    if (
      entry?.stage !== 'fragment' ||
      !entry.bindings.some(({ group, binding }) => group === 3 && binding === 3)
    )
      continue;
    const sampled = reflection.boundGlobals.filter(
      (resource) =>
        resource.group !== 0 &&
        resource.textureClass === 'sampled' &&
        entry.bindings.some(
          ({ group, binding }) => group === resource.group && binding === resource.binding,
        ),
    );
    const arrays = sampled.filter(
      ({ group, viewDimension }) => group === 3 && viewDimension === '2d-array',
    );
    const textures = Math.max(fixedTextures + count, viewTextures + sampled.length);
    if (arrays.length === count && textures <= (limits.maxSampledTexturesPerShaderStage ?? 0))
      return count;
  }
  return 0;
}

export function prepareDeferredReflectionArrays(
  rows: readonly ReadyProbe[],
  budget: 0 | 1 | 2,
): DeferredReflectionArrays | undefined {
  if (budget === 0 || rows.length === 0) return undefined;
  const classes: NonNullable<ReflectionProbeTableRow['pmremArray']>[] = [];
  const first = rows[0]?.pmremArray;
  if (first === undefined) return undefined;
  const sky = first.diffusePayload;
  if (sky.length !== SKY_FLOATS) return undefined;
  const addresses: number[] = [];
  for (const row of rows) {
    const pmrem = row.pmremArray;
    if (
      pmrem === undefined ||
      row.index < 0 ||
      row.index >= DEFAULT_REFLECTION_PROBE_LIMITS.maxProbes ||
      pmrem.layer < 0 ||
      pmrem.layer >= pmrem.capacity ||
      // The shared lanes must be identical except for the standalone env index.
      pmrem.diffusePayload.length !== SKY_FLOATS ||
      pmrem.diffusePayload.some((value, index) => index !== 3 && value !== sky[index])
    )
      return undefined;
    let index = classes.findIndex((candidate) => candidate.key === pmrem.key);
    if (index < 0) {
      index = classes.length;
      classes.push(pmrem);
    } else if (
      classes[index]?.view !== pmrem.view ||
      classes[index]?.generation !== pmrem.generation
    ) {
      // Never combine an old layer address with its replacement array.
      return undefined;
    }
    // WGSL uses one box-projection bit and four class bits (at most 16 probes).
    addresses.push(pmrem.layer * 32 + index * 2 + Number(row.boxProjection === true));
  }
  const data = new Float32Array(DEFERRED_REFLECTION_TABLE_BYTES / Float32Array.BYTES_PER_ELEMENT);
  data.set(sky);
  for (const [i, row] of rows.entries()) {
    const offset = SKY_FLOATS + row.index * PROBE_FLOATS;
    data.set(row.center, offset);
    data[offset + 3] = -(Math.max(0, row.intensity) + 1);
    data.set(row.halfExtents, offset + 4);
    data[offset + 7] = addresses[i] ?? 0;
  }
  const second = budget === 2 ? classes[1] : undefined;
  const views =
    second === undefined ? ([first.view] as const) : ([first.view, second.view] as const);
  const overflow = classes.slice(views.length).map(({ view }, index) => ({
    view,
    sizeClass: views.length + index,
  }));
  return { data, views, overflow };
}
