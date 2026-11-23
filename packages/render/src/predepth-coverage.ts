import type {
  MaterialProgramAbi,
  MaterialRenderState,
  ShaderEntryPointReads,
} from '@forgeax/engine-types';

/** Logical depth-pass entry; older stock templates retain their AO coverage entry. */
export const PREDEPTH_FRAGMENT_ENTRY = 'fs_depth_masked';

type DepthProgram = {
  readonly receipt?: Pick<MaterialProgramAbi, 'positionBounds' | 'sceneDepth'> | undefined;
  readonly program: { readonly entryPoints?: readonly ShaderEntryPointReads[] | undefined };
  readonly fragmentEntry?: string | undefined;
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
  if (entries === undefined) return false;
  const mainEntry = artifact.fragmentEntry ?? 'fs_main';
  let masked: boolean | undefined;
  let main: boolean | undefined;
  let ao: boolean | undefined;
  let declaresAo = false;
  for (const entry of entries) {
    if (entry.name === 'fs_ao_input') declaresAo = true;
    if (entry.stage !== 'fragment') continue;
    const { name, effects } = entry;
    if (name !== mainEntry && name !== PREDEPTH_FRAGMENT_ENTRY && name !== 'fs_ao_input') continue;
    const pure =
      effects !== undefined &&
      !effects.writesDepth &&
      !effects.writesSampleMask &&
      !effects.writesStorage;
    if (name === PREDEPTH_FRAGMENT_ENTRY) masked ??= pure;
    if (name === mainEntry) main ??= pure;
    if (name === 'fs_ao_input') ao ??= pure;
  }
  // Legacy depth templates use AO coverage. An admitted normal producer also consumes it.
  return main === true && (masked ?? ao) === true && (!declaresAo || ao === true);
}
