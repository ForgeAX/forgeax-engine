import type { ManifestEntry } from '@forgeax/engine-types';
import type {
  PostProcessReadEntry,
  PostProcessShaderEntry,
} from '../../fullscreen-post-process-pass';
import type { DepthOfFieldInspection } from '../../inspection-types';
import { DEPTH_OF_FIELD_POST_PROCESS_IDS } from './depth-of-field-feature';

export interface DepthOfFieldShaderSources {
  readonly singleSample?: string;
  readonly multisampled?: string;
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
  'forgeax.dof.coc': ['scene-color', 'scene-temporal', DEPTH_READ],
  'forgeax.dof.prefilter': ['scene-color', 'dof-coc', DEPTH_READ],
  'forgeax.dof.prefilter.metadata': ['scene-color', 'scene-temporal', 'dof-coc', DEPTH_READ],
  'forgeax.dof.gather': [
    'dof-prefilter-near',
    'scene-temporal',
    'dof-coc',
    'dof-near-metadata',
    'dof-far-metadata',
    'dof-prefilter-far',
    'scene-color',
    DEPTH_READ,
  ],
  'forgeax.dof.composite': [
    'scene-color',
    'scene-temporal',
    'dof-coc',
    'dof-near',
    'dof-far',
    'dof-background',
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
    source: string,
    suffix: DepthOfFieldVariantSuffix,
  ): void => {
    const id = `${baseId}${suffix}`;
    renderSystem.registerBuiltinPostProcess(id, {
      source,
      params: { byteSize: 64, defaultValue: new Uint8Array(64) },
      reads: DEPTH_OF_FIELD_READS[baseId],
    });
  };
  if (entries.singleSample !== undefined) {
    for (const id of DEPTH_OF_FIELD_POST_PROCESS_IDS) register(id, entries.singleSample, '');
  }
  if (entries.multisampled !== undefined) {
    for (const id of DEPTH_OF_FIELD_POST_PROCESS_IDS) register(id, entries.multisampled, '.msaa');
  }
}

/** Prewarm both DoF shader variants before publishing renderer readiness. */
export async function prewarmDepthOfField(
  manifestEntries: readonly ManifestEntry[],
  prewarm: (entry: ManifestEntry | undefined, id: string) => Promise<void>,
  register: (entries: DepthOfFieldShaderSources) => void,
): Promise<void> {
  let singleSample: ManifestEntry | undefined;
  let multisampled: ManifestEntry | undefined;
  for (const entry of manifestEntries) {
    if (!entry.wgsl.includes('DepthOfFieldParams')) continue;
    if (entry.wgsl.includes('texture_depth_multisampled_2d')) {
      multisampled ??= entry;
    } else {
      singleSample ??= entry;
    }
  }
  for (const id of DEPTH_OF_FIELD_POST_PROCESS_IDS) await prewarm(singleSample, id);
  for (const id of DEPTH_OF_FIELD_POST_PROCESS_IDS) await prewarm(multisampled, `${id}.msaa`);
  register({
    ...(singleSample === undefined ? {} : { singleSample: singleSample.wgsl }),
    ...(multisampled === undefined ? {} : { multisampled: multisampled.wgsl }),
  });
}
