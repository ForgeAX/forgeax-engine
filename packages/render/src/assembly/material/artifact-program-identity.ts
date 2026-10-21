import type { MaterialShaderArtifact } from '@forgeax/engine-shader';

/** Program bytes and their selected registry specialization both participate in cache identity. */
export function materialArtifactProgramIdentity(artifact: MaterialShaderArtifact): string {
  return JSON.stringify([artifact.program.identity, artifact.specializationKey ?? null]);
}

export function sameMaterialArtifactProgram(
  left: MaterialShaderArtifact,
  right: MaterialShaderArtifact,
): boolean {
  return (
    left.program.identity === right.program.identity &&
    left.specializationKey === right.specializationKey
  );
}
