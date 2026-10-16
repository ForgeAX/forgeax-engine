import { World } from '@forgeax/engine-ecs';
import type { FrameReceipt } from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { requireRenderer } from './renderer-test-utils';

function canvas(): HTMLCanvasElement {
  return { width: 64, height: 64, getContext: () => null } as unknown as HTMLCanvasElement;
}

const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`;

describe('renderer recovery and receipt contract', () => {
  it('returns a structured not-needed result while inspection is healthy', async () => {
    const renderer = await requireRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    expect(renderer.inspect().state).toBe('alive');
    const result = await renderer.recover();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('renderer-state-invalid');
      expect(result.error.hint.length).toBeGreaterThan(0);
    }
    expect(renderer.inspect().state).toBe('alive');
    await renderer.dispose();
  });

  it('observes only a receipt from the current frame generation', async () => {
    const renderer = await requireRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(world.update().ok).toBe(true);
    const frame = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    const receipt: FrameReceipt = frame.value;
    expect(world.update().ok).toBe(true);
    const nextFrame = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(nextFrame.ok).toBe(true);
    const observed = await renderer.observe(receipt, { include: ['draws', 'bindings'] });
    expect(observed.ok).toBe(true);
    if (observed.ok) expect(observed.value.frameId).toBe(receipt.frameId);
    await renderer.dispose();
  });

  it('does not recover a disposed renderer or reopen a second frame path', async () => {
    const renderer = await requireRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    renderer.dispose();
    expect(renderer.inspect().state).toBe('disposed');
    const result = await renderer.recover();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('renderer-state-invalid');
  });
});
