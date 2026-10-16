import { describe, expect, it } from 'vitest';
import { validateVisualEvidence, type VisualEvidenceIndex } from '../../coverage/build-status-index';

function artifact(kind: 'forgeax-final' | 'three-primary-final' | 'diff-roi', caseId = 'tone-ramp') {
  return {
    kind,
    url: `artifact://color-lighting/${kind}`,
    path: `report/color-lighting/${kind}.png`,
    caseId,
    width: 64,
    height: 64,
    background: [0, 0, 0, 0] as const,
    frameId: 12,
    rawHash: `${kind.replaceAll('-', '')}12345678`,
    expected: 'same case framing, size, and background',
    observed: 'the required capture is framed and readable',
    verdict: 'pass' as const,
    confidence: 'high' as const,
  };
}

function validEvidence(): VisualEvidenceIndex {
  return {
    caseId: 'tone-ramp',
    width: 64,
    height: 64,
    background: [0, 0, 0, 0],
    framing: 'orthographic-center',
    artifacts: [artifact('forgeax-final'), artifact('three-primary-final'), artifact('diff-roi')],
  };
}

describe('visual evidence provenance', () => {
  it('locates Forge, Three, and diff artifacts from one case identity', () => {
    expect(validateVisualEvidence(validEvidence())).toEqual({ ok: true });
  });

  it.each([
    ['wrong case', { artifacts: [artifact('forgeax-final'), artifact('three-primary-final', 'other-case'), artifact('diff-roi')] }],
    ['wrong size', { artifacts: [artifact('forgeax-final'), { ...artifact('three-primary-final'), width: 32 }, artifact('diff-roi')] }],
    ['wrong background', { artifacts: [artifact('forgeax-final'), { ...artifact('three-primary-final'), background: [1, 0, 0, 1] }, artifact('diff-roi')] }],
  ] satisfies readonly [string, Partial<VisualEvidenceIndex>][])('%s fails provenance validation', (_label, override) => {
    const result = validateVisualEvidence({ ...validEvidence(), ...override });

    expect(result.ok).toBe(false);
  });

  it('requires structured visual observations for every artifact', () => {
    const input = validEvidence();
    input.artifacts[2]!.observed = '';

    expect(validateVisualEvidence(input).ok).toBe(false);
  });
});
