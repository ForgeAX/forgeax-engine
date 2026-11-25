import {
  materialDepthCoversEntry,
  materialDepthFragmentEntry,
  PREDEPTH_FRAGMENT_ENTRY,
} from '@forgeax/engine-shader';
import type {
  MaterialProgramAbi,
  MaterialRenderState,
  ShaderEntryPointReads,
} from '@forgeax/engine-types';

export { PREDEPTH_FRAGMENT_ENTRY } from '@forgeax/engine-shader';

type DepthProgram = {
  readonly receipt?: Pick<MaterialProgramAbi, 'positionBounds' | 'sceneDepth'> | undefined;
  readonly program: { readonly entryPoints?: readonly ShaderEntryPointReads[] | undefined };
  readonly fragmentEntry?: string | undefined;
};

export function predepthFragmentEntry(artifact: DepthProgram): string {
  return materialDepthFragmentEntry(artifact.program);
}

/** Same stock position/Surface coverage, with no duplicated depth/mask/storage effects. */
export function predepthCoversMaterial(
  artifact: DepthProgram | undefined,
  state: MaterialRenderState | undefined,
): boolean {
  if (
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
  if (predepthFragmentEntry(artifact) !== PREDEPTH_FRAGMENT_ENTRY) return false;
  return materialDepthCoversEntry(artifact.program, artifact.fragmentEntry ?? 'fs_main');
}
