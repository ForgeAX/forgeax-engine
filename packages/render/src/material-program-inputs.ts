import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type {
  MaterialProgramAbi,
  MaterialProgramSystemInputs,
  ShaderEntryPointReads,
} from '@forgeax/engine-types';

export interface MaterialProgramInputs {
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
  return Object.freeze({ entryPoints, ...(systemInputs === undefined ? {} : { systemInputs }) });
}

export function waterProgramEntryPoints(
  inputs: MaterialProgramInputs | undefined,
): readonly ShaderEntryPointReads[] | undefined {
  return inputs?.systemInputs?.water === 'water-frame/3' ? inputs.entryPoints : undefined;
}
