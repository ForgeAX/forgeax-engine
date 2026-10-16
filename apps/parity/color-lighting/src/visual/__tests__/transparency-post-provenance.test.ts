import { describe, expect, it } from 'vitest';
import {
  checkTransparencyPostVisualProvenance,
  type TransparencyPostVisualArtifact,
} from '../transparency-post-provenance';

const artifacts: readonly TransparencyPostVisualArtifact[] = [
  { kind: 'forgeax-final', caseId: 'transparent-ldr-urp', adapterId: 'forgeax-webgpu', pipelineId: 'standard', frameId: 4, rawHash: '0123456789abcdef' },
  { kind: 'three-primary-final', caseId: 'transparent-ldr-urp', adapterId: 'three-r184-webgpu', pipelineId: 'standard', frameId: 4, rawHash: 'fedcba9876543210' },
  { kind: 'diff-roi', caseId: 'transparent-ldr-urp', adapterId: 'parity-diff', pipelineId: 'standard', frameId: 4, rawHash: '0011223344556677' },
];

describe('transparency post visual provenance', () => {
  it('locates final, primary, and ROI artifacts independently', () => {
    expect(checkTransparencyPostVisualProvenance(artifacts)).toBe(true);
    expect(checkTransparencyPostVisualProvenance(artifacts.slice(0, 2))).toBe(false);
  });
});
