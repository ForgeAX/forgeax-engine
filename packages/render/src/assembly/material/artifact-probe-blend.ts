import type { MaterialShaderArtifact } from '@forgeax/engine-shader';

export function requiresProbeBlendRecord(artifact: MaterialShaderArtifact): boolean {
  return artifact.program.probeBlendRecordRequired;
}
