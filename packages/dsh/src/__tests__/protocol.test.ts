import { describe, expect, it } from 'vitest';

import {
  FEDERATION_PROTOCOL_VERSION,
  isEnginePreviewRequest,
  isEnginePreviewStatus,
  isFederationStatus,
} from '../protocol';

describe('federation POD protocol', () => {
  it('accepts only the closed preview request union', () => {
    expect(
      isEnginePreviewRequest({
        protocol: FEDERATION_PROTOCOL_VERSION,
        kind: 'forgeax-engine-poll',
      }),
    ).toBe(true);
    expect(
      isEnginePreviewRequest({
        protocol: FEDERATION_PROTOCOL_VERSION,
        kind: 'forgeax-engine-control',
        action: 'toggle',
      }),
    ).toBe(true);
    expect(
      isEnginePreviewRequest({
        protocol: FEDERATION_PROTOCOL_VERSION + 1,
        kind: 'forgeax-engine-poll',
      }),
    ).toBe(false);
  });

  it('rejects incomplete status projections', () => {
    expect(
      isEnginePreviewStatus({
        protocol: FEDERATION_PROTOCOL_VERSION,
        kind: 'forgeax-engine-status',
        binding: 'external',
        ready: true,
        frameId: 2,
        tick: 2,
        state: 1,
      }),
    ).toBe(true);
    expect(isEnginePreviewStatus({ ready: true })).toBe(false);
    expect(
      isFederationStatus({
        protocol: FEDERATION_PROTOCOL_VERSION,
        identity: 'fixture',
        ready: true,
        realm: 'dsh',
        capabilities: [],
        leases: 0,
        engine: { binding: 'embedded', ready: true, frameId: 1, tick: 1, state: 0 },
      }),
    ).toBe(true);
    expect(
      isFederationStatus({
        protocol: FEDERATION_PROTOCOL_VERSION,
        identity: 'fixture',
        ready: true,
        realm: 'dsh',
        capabilities: ['lease'],
        leases: 0,
        engine: { binding: 'external', ready: true },
      }),
    ).toBe(false);
  });
});
