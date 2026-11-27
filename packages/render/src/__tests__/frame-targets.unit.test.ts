import { describe, expect, it } from 'vitest';

import { graphExecutionPhase } from '../record/frame-targets';

describe('graph execution phase classification', () => {
  it('keeps SSR pass families bounded while retaining mip-level detail in the pass name', () => {
    expect(graphExecutionPhase('hzb-seed')).toBe('record/graph-execute/depth-pyramid');
    expect(graphExecutionPhase('hzb-reduce-1')).toBe('record/graph-execute/depth-pyramid');
    expect(graphExecutionPhase('hzb-reduce-9')).toBe('record/graph-execute/depth-pyramid');
    expect(graphExecutionPhase('ssr-trace')).toBe('record/graph-execute/ssr-trace');
    expect(graphExecutionPhase('ssr-reflection-mip-1')).toBe(
      'record/graph-execute/ssr-reflection-mip',
    );
    expect(graphExecutionPhase('ssr-reflection-mip-9')).toBe(
      'record/graph-execute/ssr-reflection-mip',
    );
    expect(graphExecutionPhase('ssr-compose')).toBe('record/graph-execute/ssr-compose');
  });

  it('keeps unrelated extension passes in the explicit other bucket', () => {
    expect(graphExecutionPhase('custom-post-process')).toBe('record/graph-execute/other');
  });
});
