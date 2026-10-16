import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { constructRendererHost } from '../../../render/src/construct-renderer';
import {
  frameRequest,
  preparedFeature,
  preparedManifest,
  preparedWorld,
} from './render-feature-prepared-graphics.fixture';

function canvas(): HTMLCanvasElement {
  return { width: 64, height: 64, getContext: () => null } as unknown as HTMLCanvasElement;
}

describe('prepared graphics Standard host integration', () => {
  it('records prepared work through RendererOptions.features and returns a receipt', async () => {
    const host = await constructRendererHost(
      canvas(),
      { rhi, features: [preparedFeature('synthetic.prepared')] },
      { shaderManifestUrl: preparedManifest },
    );
    expect(host.ok).toBe(true);
    if (!host.ok) return;
    const world = preparedWorld();
    const attached = host.value.renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(world.update().ok).toBe(true);
    const frame = host.value.renderer.draw(frameRequest(attached.value));
    expect(frame.ok).toBe(true);
    if (frame.ok) {
      const observed = await host.value.renderer.observe(frame.value, { include: ['draws'] });
      expect(observed.ok).toBe(true);
    }
    expect(host.value.renderer.inspect().state).toBe('alive');
    host.value.renderer.dispose();
  });

  it('keeps empty prepared work out of the frame without a registration call', async () => {
    const host = await constructRendererHost(
      canvas(),
      { rhi, features: [preparedFeature('synthetic.empty', 'empty')] },
      { shaderManifestUrl: preparedManifest },
    );
    expect(host.ok).toBe(true);
    if (!host.ok) return;
    const world = new World();
    const attached = host.value.renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(world.update().ok).toBe(true);
    expect(host.value.renderer.draw(frameRequest(attached.value)).ok).toBe(true);
    host.value.renderer.dispose();
  });
});
