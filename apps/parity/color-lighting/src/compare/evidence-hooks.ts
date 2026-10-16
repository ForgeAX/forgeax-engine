import type { LightingReferenceMode } from './lighting-reference';

export interface LightingEvidenceHooks {
  readonly schemaVersion: 'lighting-demo-evidence-hooks-v1';
  readonly browserGlobal: 'window.__forgeaxLightingDemo';
  readonly exactProductHead: string;
  readonly mode: LightingReferenceMode;
  readonly canvases: { readonly product: 'demo'; readonly reference: 'three-reference' };
  readonly screenshot: {
    readonly status: 'not-captured';
    readonly owner: 'orchestrator';
    readonly captureAfter: 'ready';
    readonly readback: 'headed-orchestrator-only';
  };
}

export function createLightingEvidenceHooks(mode: LightingReferenceMode, exactProductHead: string): LightingEvidenceHooks {
  return {
    schemaVersion: 'lighting-demo-evidence-hooks-v1',
    browserGlobal: 'window.__forgeaxLightingDemo',
    exactProductHead,
    mode,
    canvases: { product: 'demo', reference: 'three-reference' },
    screenshot: { status: 'not-captured', owner: 'orchestrator', captureAfter: 'ready', readback: 'headed-orchestrator-only' },
  };
}
