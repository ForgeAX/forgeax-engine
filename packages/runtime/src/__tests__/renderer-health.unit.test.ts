import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import type { HealthReason, HealthSnapshot } from '../../../render/src/lifecycle';
import { requireRenderer } from './renderer-test-utils';

function canvas(): HTMLCanvasElement {
  return { width: 64, height: 64, getContext: () => null } as unknown as HTMLCanvasElement;
}

const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`;

describe('renderer inspection and recovery contract', () => {
  it('keeps health vocabulary closed for inspection consumers', () => {
    function describeReason(reason: HealthReason): string {
      switch (reason) {
        case 'alive':
          return 'alive';
        case 'device-lost':
          return 'device-lost';
        case 'internal-fault':
          return 'internal-fault';
      }
    }

    const snapshot: HealthSnapshot = { reason: 'alive', recoverable: false };
    expect(describeReason(snapshot.reason)).toBe('alive');
  });

  it('uses inspect for the public ready state and recover for an explicit retry', async () => {
    const renderer = await requireRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    expect(renderer.inspect().state).toBe('alive');
    const recovery = await renderer.recover();
    expect(recovery.ok).toBe(false);
    if (!recovery.ok) expect(recovery.error.code).toBe('renderer-state-invalid');
    await renderer.dispose();
  });

  it('does not expose the removed health or device getters', async () => {
    const renderer = await requireRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    expect(renderer).not.toHaveProperty('health');
    expect(renderer).not.toHaveProperty('device');
    expect(renderer).not.toHaveProperty('ready');
    renderer.dispose();
  });
});
