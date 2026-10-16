import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { constructRendererHost } from '../../../render/src/construct-renderer';
import { createRenderer } from '../createRenderer';
import { EngineEnvironmentError } from '../errors/environment';

function canvas(): HTMLCanvasElement {
  return { width: 64, height: 64, getContext: () => null } as unknown as HTMLCanvasElement;
}

const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`;

function frameRequest(lease: Parameters<Renderer['draw']>[0]['leases'][number]) {
  return { leases: [lease], camera: { lease }, environment: { lease } };
}

describe('runtime renderer host assembly', () => {
  it('returns assets beside the lease-only Renderer surface', async () => {
    const host = await constructRendererHost(canvas(), { rhi }, { shaderManifestUrl: manifest });
    expect(host.ok).toBe(true);
    if (!host.ok) return;
    expect(host.value.assets.inspect()).toBeDefined();
    const world = new World();
    const attached = host.value.renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(world.update().ok).toBe(true);
    const frame = host.value.renderer.draw(frameRequest(attached.value));
    expect(frame.ok).toBe(true);
    if (frame.ok) {
      const observed = await host.value.renderer.observe(frame.value, { include: ['timings'] });
      expect(observed.ok).toBe(true);
    }
    host.value.renderer.dispose();
  });

  it('repeats null-device assembly and frame observation without device loss', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const host = await constructRendererHost(canvas(), { rhi }, { shaderManifestUrl: manifest });
      expect(host.ok).toBe(true);
      if (!host.ok) continue;
      const world = new World();
      const attached = host.value.renderer.attach(world);
      expect(attached.ok).toBe(true);
      if (!attached.ok) {
        host.value.renderer.dispose();
        continue;
      }
      expect(world.update().ok).toBe(true);
      const frame = host.value.renderer.draw(frameRequest(attached.value));
      expect(frame.ok).toBe(true);
      if (frame.ok) {
        expect((await host.value.renderer.observe(frame.value, { include: ['timings'] })).ok).toBe(
          true,
        );
      }
      host.value.renderer.dispose();
    }
  });

  it('keeps runtime construction errors structured', async () => {
    const result = await createRenderer(canvas(), { rhi: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(EngineEnvironmentError);
  });

  it('does not add removed backend or readiness properties', async () => {
    const result = await createRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const renderer = result.value;
    expect(renderer).not.toHaveProperty('backend');
    expect(renderer).not.toHaveProperty('ready');
    expect(renderer).not.toHaveProperty('assets');
    renderer.dispose();
  });
});
