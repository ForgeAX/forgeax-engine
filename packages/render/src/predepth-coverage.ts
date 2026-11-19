import type {
  MaterialProgramAbi,
  MaterialRenderState,
  ShaderEntryPointReads,
} from '@forgeax/engine-types';

/** Logical depth-pass entry; older stock templates retain their AO coverage entry. */
export const PREDEPTH_FRAGMENT_ENTRY = 'fs_depth_masked';

type DepthProgram = {
  readonly receipt?: Pick<MaterialProgramAbi, 'positionBounds' | 'sceneDepth'>;
  readonly program: { readonly entryPoints?: readonly ShaderEntryPointReads[] };
  readonly fragmentEntry?: string;
};

export function predepthFragmentEntry(artifact: DepthProgram): string {
  return artifact.program.entryPoints?.some(
    (entry) => entry.stage === 'fragment' && entry.name === PREDEPTH_FRAGMENT_ENTRY,
  )
    ? PREDEPTH_FRAGMENT_ENTRY
    : 'fs_ao_input';
}

/** Same stock position/Surface coverage, with no duplicated depth/mask/storage effects. */
export function predepthCoversMaterial(
  artifact: DepthProgram | undefined,
  state: MaterialRenderState | undefined,
): boolean {
  if (
    (artifact?.fragmentEntry !== undefined &&
      artifact.fragmentEntry !== 'fs_main' &&
      artifact.fragmentEntry !== 'fs_opaque' &&
      artifact.fragmentEntry !== 'fs_forward_screen') ||
    artifact?.receipt?.positionBounds !== 'standard-input' ||
    artifact.receipt.sceneDepth !== undefined ||
    state?.depthWriteEnabled === false ||
    ((state?.depthCompare ?? 'less') !== 'less' && state?.depthCompare !== 'less-equal') ||
    state?.blend !== undefined ||
    state?.outputs?.some((output) => output.blend !== undefined) === true ||
    state?.stencil !== undefined ||
    state?.alphaToCoverageEnabled === true
  )
    return false;
  const entries = artifact.program.entryPoints;
  const pureCoverage = (name: string) => {
    const effects = entries?.find(
      (entry) => entry.stage === 'fragment' && entry.name === name,
    )?.effects;
    return (
      effects !== undefined &&
      !effects.writesDepth &&
      !effects.writesSampleMask &&
      !effects.writesStorage
    );
  };
  return (
    pureCoverage(predepthFragmentEntry(artifact)) &&
    pureCoverage(artifact.fragmentEntry ?? 'fs_main') &&
    // A normal-demanding single-sample primary uses this same Surface entry.
    (!entries?.some((entry) => entry.name === 'fs_ao_input') || pureCoverage('fs_ao_input'))
  );
}
