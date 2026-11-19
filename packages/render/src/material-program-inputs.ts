import { RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type {
  MaterialProgramAbi,
  MaterialProgramSystemInputs,
  ShaderEntryPointReads,
} from '@forgeax/engine-types';

export interface MaterialProgramInputs {
  readonly forwardFog?: 'height-vertex/1';
  readonly entryPoints: readonly ShaderEntryPointReads[];
  readonly systemInputs?: MaterialProgramSystemInputs;
}

/** Keep actual compiled reads paired with certification from that same artifact. */
export function materialProgramInputs(
  artifact: Pick<MaterialShaderArtifact, 'program'> & {
    readonly receipt?: MaterialProgramAbi | undefined;
  },
): MaterialProgramInputs | undefined {
  const entryPoints = artifact.program.entryPoints;
  if (entryPoints === undefined) return undefined;
  const systemInputs = artifact.receipt?.systemInputs;
  const forwardFog = artifact.program.forwardFog ?? artifact.receipt?.forwardFog;
  return Object.freeze({
    entryPoints,
    ...(systemInputs === undefined ? {} : { systemInputs }),
    ...(forwardFog === undefined ? {} : { forwardFog }),
  });
}

export function waterProgramEntryPoints(
  inputs: MaterialProgramInputs | undefined,
): readonly ShaderEntryPointReads[] | undefined {
  return inputs?.systemInputs?.water === 'water-frame/3' ? inputs.entryPoints : undefined;
}

/** Old writer artifacts cannot enter a graph whose attachments use v2. */
export function requireStandardGBufferReceipt(receipt: MaterialProgramAbi | undefined): void {
  if (receipt?.gbuffer === 'standard-gbuffer/2') return;
  throw new RhiError({
    code: 'shader-compile-failed',
    expected: 'a producer-certified standard-gbuffer/2 writer',
    hint: `Re-cook the material with this Engine; received GBuffer contract ${receipt?.gbuffer ?? 'missing'}.`,
  });
}
