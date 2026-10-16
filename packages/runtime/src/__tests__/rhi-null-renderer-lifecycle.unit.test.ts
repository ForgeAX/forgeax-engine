import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { requireRenderer } from './renderer-test-utils';

function canvas(): HTMLCanvasElement {
  return { width: 800, height: 600, getContext: () => null } as unknown as HTMLCanvasElement;
}

const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`;

describe('RhiNull renderer lifecycle', () => {
  it('reports ready inspection without an asynchronous ready property', async () => {
    const renderer = await requireRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    expect(renderer.inspect().state).toBe('alive');
    expect(renderer).not.toHaveProperty('ready');
    renderer.dispose();
  });

  it('uses releaseSurface and restoreSurface as Result boundaries', async () => {
    const renderer = await requireRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    const released = renderer.releaseSurface();
    expect(released.ok).toBe(true);
    expect(renderer.inspect().surface).toBe('released');
    const restored = renderer.restoreSurface();
    expect(restored.ok).toBe(true);
    expect(renderer.inspect().surface).toBe('available');
    renderer.dispose();
  });

  it('attaches, updates, draws, and rejects a frame after disposal', async () => {
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
    renderer.dispose();
    expect(renderer.inspect().state).toBe('disposed');
    expect(
      renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      }).ok,
    ).toBe(false);
  });
});
