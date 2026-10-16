export const TRANSPARENCY_POST_VISUAL_ARTIFACTS = [
  'forgeax-final',
  'three-primary-final',
  'diff-roi',
] as const;

export interface TransparencyPostVisualArtifact {
  readonly kind: (typeof TRANSPARENCY_POST_VISUAL_ARTIFACTS)[number];
  readonly caseId: string;
  readonly adapterId: string;
  readonly pipelineId: 'standard';
  readonly frameId: number;
  readonly rawHash: string;
}

export function checkTransparencyPostVisualProvenance(
  artifacts: readonly TransparencyPostVisualArtifact[],
): boolean {
  return TRANSPARENCY_POST_VISUAL_ARTIFACTS.every((kind) => {
    const artifact = artifacts.find((entry) => entry.kind === kind);
    return artifact !== undefined
      && artifact.caseId.length > 0
      && artifact.adapterId.length > 0
      && Number.isInteger(artifact.frameId)
      && /^[0-9a-f]{8,}$/.test(artifact.rawHash);
  });
}
