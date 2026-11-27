import { RhiError } from '@forgeax/engine-rhi';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import type {
  MaterialProgramAbi,
  MaterialProgramSystemInputs,
  ShaderEntryPointReads,
} from '@forgeax/engine-types';

export interface MaterialProgramInputs {
  readonly gbuffer?: MaterialProgramAbi['gbuffer'];
  readonly forwardFog?: 'height-vertex/1';
  readonly entryPoints: readonly ShaderEntryPointReads[];
  readonly systemInputs?: MaterialProgramSystemInputs;
}

/** Keep actual compiled reads paired with certification from that same artifact. */
export function materialProgramInputs(artifact: {
  readonly program: {
    readonly entryPoints?: readonly ShaderEntryPointReads[] | undefined;
    readonly forwardFog?: 'height-vertex/1' | undefined;
  };
  readonly receipt?: MaterialProgramAbi | undefined;
}): MaterialProgramInputs | undefined {
  const entryPoints = artifact.program.entryPoints ?? artifact.receipt?.entryPoints;
  if (entryPoints === undefined) return undefined;
  const systemInputs = artifact.receipt?.systemInputs;
  const forwardFog = artifact.program.forwardFog ?? artifact.receipt?.forwardFog;
  const gbuffer = artifact.receipt?.gbuffer;
  return Object.freeze({
    entryPoints,
    ...(gbuffer === undefined ? {} : { gbuffer }),
    ...(systemInputs === undefined ? {} : { systemInputs }),
    ...(forwardFog === undefined ? {} : { forwardFog }),
  });
}

export function materialProgramInputsForArtifact(
  shaderRegistry: ShaderRegistry,
  key: string,
): MaterialProgramInputs | undefined {
  if (shaderRegistry.isSourceBackedMaterialArtifact(key)) {
    const declaration = shaderRegistry.materialArtifactDeclaration(key);
    if (declaration?.kind === 'source')
      return materialProgramInputs({ program: declaration, receipt: declaration.receipt });
  }
  const artifact = shaderRegistry.materialArtifact(key);
  return artifact === undefined ? undefined : materialProgramInputs(artifact);
}

export function waterProgramEntryPoints(
  inputs: MaterialProgramInputs | undefined,
): readonly ShaderEntryPointReads[] | undefined {
  return inputs?.systemInputs?.water === 'water-frame/3' ? inputs.entryPoints : undefined;
}

/** Old writer artifacts cannot enter a graph whose attachments use v2. */
export function requireStandardGBufferReceipt(
  receipt: MaterialProgramAbi | undefined,
  compact = false,
): void {
  const required = compact ? 'standard-gbuffer/4' : 'standard-gbuffer/2';
  const published = compact ? receipt?.compactGbuffer : receipt?.gbuffer;
  if (published === required) return;
  throw new RhiError({
    code: 'shader-compile-failed',
    expected: `a producer-certified ${required} writer`,
    hint: `Re-cook the material with this Engine; received GBuffer contract ${published ?? 'missing'}.`,
  });
}
