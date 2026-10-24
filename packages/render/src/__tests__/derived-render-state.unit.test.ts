import type { MaterialRenderState } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { derivedRenderState } from '../material-render-state';
import { oitAccumulateRenderState } from '../oit/eligibility';
import { renderStateHash } from '../pipeline-spec';
import { geometryRenderStateForPass } from '../record/main-pass-geometry';
import { geometryRenderStateForTopology } from '../record/main-pass-material';

describe('derived render states', () => {
  it('returns one stable identity per authored state and derivation', () => {
    const authored: MaterialRenderState = { cullMode: 'back', depthWriteEnabled: true };
    const temporal = geometryRenderStateForPass(authored, 'temporal');
    expect(geometryRenderStateForPass(authored, 'temporal')).toBe(temporal);
    expect(temporal).toEqual({
      cullMode: 'back',
      colorWriteMask: 15,
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
    });
    const coverage = geometryRenderStateForPass(authored, 'temporal', true);
    expect(coverage).not.toBe(temporal);
    expect(coverage?.depthWriteEnabled).toBe(true);
    expect(geometryRenderStateForPass(authored, 'forward')).toBe(authored);
    expect(geometryRenderStateForTopology('line-list', authored)).toBe(
      geometryRenderStateForTopology('line-list', authored),
    );
    expect(oitAccumulateRenderState(authored)).toBe(oitAccumulateRenderState(authored));
    expect(oitAccumulateRenderState(undefined)).toBe(oitAccumulateRenderState(undefined));
    // Stable identities keep the identity-keyed hash cache warm.
    expect(renderStateHash(temporal)).toBe(
      renderStateHash(geometryRenderStateForPass(authored, 'temporal')),
    );
  });

  it('re-derives after an in-place authored edit', () => {
    const authored: MaterialRenderState = { cullMode: 'back' };
    let calls = 0;
    const derive = (state: MaterialRenderState | undefined) => {
      calls += 1;
      return { ...state, depthWriteEnabled: false };
    };
    const first = derivedRenderState(authored, 'test', derive);
    expect(derivedRenderState(authored, 'test', derive)).toBe(first);
    (authored as { cullMode?: string }).cullMode = 'none';
    const second = derivedRenderState(authored, 'test', derive);
    expect(second).not.toBe(first);
    expect(second.cullMode).toBe('none');
    (authored as { depthBias?: number }).depthBias = 2;
    expect(derivedRenderState(authored, 'test', derive)).not.toBe(second);
    expect(calls).toBe(3);
  });
});
