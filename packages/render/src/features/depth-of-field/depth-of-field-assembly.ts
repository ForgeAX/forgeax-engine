import { isShaderTemplateManifestRow } from '@forgeax/engine-shader';
import type { ManifestEntry } from '@forgeax/engine-types';
import { deferredPostProcessEntry } from '../../assembly/deferred-post-process-entry';
import type {
  PostProcessReadEntry,
  PostProcessShaderEntry,
} from '../../fullscreen-post-process-pass';
import type { DepthOfFieldInspection } from '../../inspection-types';
import {
  DEPTH_OF_FIELD_DEPTH_POST_PROCESS_IDS,
  DEPTH_OF_FIELD_POST_PROCESS_IDS,
} from './depth-of-field-feature';

interface DepthOfFieldShaderSources {
  readonly singleSample?: string | (() => string);
  readonly multisampled?: string | (() => string);
}

export function dofInspection(inspection: DepthOfFieldInspection | undefined): {
  readonly depthOfField?: DepthOfFieldInspection;
} {
  return inspection === undefined ? {} : { depthOfField: Object.freeze(inspection) };
}

type DepthOfFieldRead = string | PostProcessReadEntry;
type DepthOfFieldPostProcessId = (typeof DEPTH_OF_FIELD_POST_PROCESS_IDS)[number];
type DepthOfFieldVariantSuffix = '' | '.msaa';
type DepthOfFieldRegistrar = {
  readonly registerBuiltinPostProcess: (id: string, entry: PostProcessShaderEntry) => unknown;
};

const DEPTH_READ: PostProcessReadEntry = { key: 'scene-depth', sampleType: 'depth' };
const DEPTH_OF_FIELD_READS: Readonly<
  Record<DepthOfFieldPostProcessId, readonly DepthOfFieldRead[]>
> = {
  'forgeax.dof.coc': ['scene-color', DEPTH_READ],
  'forgeax.dof.tiles': [],
  'forgeax.dof.prefilter': ['scene-color', 'dof-coc', 'dof-tile-influence', DEPTH_READ],
  'forgeax.dof.gather': [
    'dof-prefilter-near',
    'dof-coc',
    'dof-near-metadata',
    'dof-far-metadata',
    'dof-prefilter-far',
    'scene-color',
    'dof-tile-influence',
    DEPTH_READ,
  ],
  'forgeax.dof.composite': [
    'scene-color',
    'dof-coc',
    'dof-near',
    'dof-far',
    'dof-background',
    'dof-tile-influence',
    DEPTH_READ,
  ],
};

/** Register all DoF graph declarations against the active RenderSystem. */
export function registerDepthOfFieldBuiltins(
  renderSystem: DepthOfFieldRegistrar,
  entries: DepthOfFieldShaderSources,
): void {
  const register = (
    baseId: DepthOfFieldPostProcessId,
    source: string | (() => string),
    suffix: DepthOfFieldVariantSuffix,
  ): void => {
    const id = `${baseId}${suffix}`;
    const descriptor = {
      params: { byteSize: 64, defaultValue: new Uint8Array(64) },
      reads: DEPTH_OF_FIELD_READS[baseId],
    };
    renderSystem.registerBuiltinPostProcess(
      id,
      typeof source === 'string'
        ? { ...descriptor, source }
        : deferredPostProcessEntry(descriptor, source),
    );
  };
  if (entries.singleSample !== undefined) {
    for (const id of DEPTH_OF_FIELD_POST_PROCESS_IDS) register(id, entries.singleSample, '');
  }
  if (entries.multisampled !== undefined) {
    for (const id of DEPTH_OF_FIELD_DEPTH_POST_PROCESS_IDS)
      register(id, entries.multisampled, '.msaa');
  }
}

/** Publish both attachment variants, optionally prewarming backends that require it. */
export async function prepareDepthOfFieldBuiltins(
  manifestEntries: readonly ManifestEntry[],
  prewarm: ((entry: ManifestEntry | undefined, id: string) => Promise<void>) | undefined,
  register: (entries: DepthOfFieldShaderSources) => void,
): Promise<void> {
  let singleSample: ManifestEntry | undefined;
  let multisampled: ManifestEntry | undefined;
  for (const entry of manifestEntries) {
    if (isShaderTemplateManifestRow(entry)) {
      if (entry.identifier === 'forgeax_view::depth_of_field') singleSample ??= entry;
      if (entry.identifier === 'forgeax_view::depth_of_field_msaa') multisampled ??= entry;
      continue;
    }
    if (!entry.wgsl.includes('DepthOfFieldParams')) continue;
    if (entry.wgsl.includes('texture_depth_multisampled_2d')) {
      multisampled ??= entry;
    } else {
      singleSample ??= entry;
    }
  }
  // Each attachment topology shares one shader module across all DoF passes.
  if (prewarm !== undefined) {
    await prewarm(singleSample, 'forgeax.dof');
    await prewarm(multisampled, 'forgeax.dof.msaa');
  }
  const single = singleSample,
    multi = multisampled;
  register({
    ...(single === undefined ? {} : { singleSample: () => single.wgsl }),
    ...(multi === undefined ? {} : { multisampled: () => multi.wgsl }),
  });
}
