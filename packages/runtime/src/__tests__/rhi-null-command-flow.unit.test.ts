import { World } from '@forgeax/engine-ecs';
import type { Renderer, RendererEvent } from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { requireRenderer } from './renderer-test-utils';

function canvas(): HTMLCanvasElement {
  return { width: 800, height: 600, getContext: () => null } as unknown as HTMLCanvasElement;
}

const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`;

function frameRequest(lease: Parameters<Renderer['draw']>[0]['leases'][number]) {
  return { leases: [lease], camera: { lease }, environment: { lease } };
}

describe('RhiNull command flow', () => {
  it('returns the synchronous receipt after the host submits a frame', async () => {
    const renderer = await requireRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    const events: RendererEvent[] = [];
    const unsubscribe = renderer.subscribe((event) => events.push(event));
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(world.update().ok).toBe(true);

    const frame = renderer.draw(frameRequest(attached.value));
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    expect(
      events.filter(
        (event): event is Extract<RendererEvent, { kind: 'frame-submitted' }> =>
          event.kind === 'frame-submitted',
      ),
    ).toEqual([
      {
        kind: 'frame-submitted',
        frameId: frame.value.frameId,
        deviceGeneration: frame.value.deviceGeneration,
        ...(frame.value.graphGeneration === undefined
          ? {}
          : { graphGeneration: frame.value.graphGeneration }),
        receipt: frame.value,
      },
    ]);
    const submitted = events.find((event) => event.kind === 'frame-submitted');
    expect(submitted?.receipt).toBe(frame.value);
    if (submitted?.receipt === undefined)
      throw new Error('submission event did not carry its receipt');
    const observation = await renderer.observe(submitted.receipt, { include: ['timings'] });
    expect(observation.ok).toBe(true);
    if (observation.ok) expect(observation.value.frameId).toBe(frame.value.frameId);
    const completed = await frame.value.completed;
    expect(completed.ok).toBe(true);
    expect(renderer.inspect().frame.frameId).toBe(frame.value.frameId);
    unsubscribe();
    renderer.dispose();
  });

  it('observes the same receipt without exposing RHI command objects', async () => {
    const renderer = await requireRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(world.update().ok).toBe(true);
    const frame = renderer.draw(frameRequest(attached.value));
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    const observation = await renderer.observe(frame.value, {
      include: ['timings', 'draws', 'bindings'],
    });
    expect(observation.ok).toBe(true);
    if (observation.ok) expect(observation.value.frameId).toBe(frame.value.frameId);
    expect(renderer).not.toHaveProperty('device');
    expect(renderer).not.toHaveProperty('encoder');
    expect(renderer).not.toHaveProperty('queue');
    renderer.dispose();
  });
});
