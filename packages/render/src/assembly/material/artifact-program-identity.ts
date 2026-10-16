import type { MaterialShaderArtifact } from '@forgeax/engine-shader';

export function materialArtifactProgramIdentity(artifact: MaterialShaderArtifact): string {
  return artifact.specializationKey === undefined
    ? artifact.program.identity
    : `specialization:${artifact.specializationKey}`;
}

/** Compare the existing program identity without constructing its specialization prefix. */
export function sameMaterialArtifactProgram(
  left: MaterialShaderArtifact,
  right: MaterialShaderArtifact,
): boolean {
  const leftSpecialized = left.specializationKey !== undefined;
  const leftIdentity = leftSpecialized ? String(left.specializationKey) : left.program.identity;
  const rightSpecialized = right.specializationKey !== undefined;
  const rightIdentity = rightSpecialized ? String(right.specializationKey) : right.program.identity;
  if (leftSpecialized === rightSpecialized) return leftIdentity === rightIdentity;
  const program = leftSpecialized ? rightIdentity : leftIdentity;
  const specialization = leftSpecialized ? leftIdentity : rightIdentity;
  // Preserve the original string identity equality for raw/custom artifacts too.
  const prefix = 'specialization:';
  const key = String(specialization);
  return (
    program !== undefined &&
    program.length === prefix.length + key.length &&
    program.startsWith(prefix) &&
    program.endsWith(key)
  );
}
