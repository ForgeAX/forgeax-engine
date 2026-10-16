import { describe, expect, it } from 'vitest';
import { createLightingEvidenceHooks } from '../evidence-hooks';

describe('lighting evidence hooks', () => {
  it('binds headed capture responsibility to the orchestrator', () => {
    expect(createLightingEvidenceHooks('probe', 'product-head')).toEqual({
      schemaVersion: 'lighting-demo-evidence-hooks-v1',
      browserGlobal: 'window.__forgeaxLightingDemo',
      exactProductHead: 'product-head',
      mode: 'probe',
      canvases: { product: 'demo', reference: 'three-reference' },
      screenshot: { status: 'not-captured', owner: 'orchestrator', captureAfter: 'ready', readback: 'headed-orchestrator-only' },
    });
  });
});
