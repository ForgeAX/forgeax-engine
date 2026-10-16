// renderer.browser.test.ts - vitest browser project (AC-05) RHI/engine
// API integration test.
//
// Trigger: root vitest.config.ts `browser` project (`*.browser.test.ts`
// glob). Environment: playwright provider chromium instance (v4 form:
// provider: playwright() factory + instances:[{browser:'chromium'}]).
//
// Scope (M2.4 / w11 acceptanceCheck):
//   (a) `createRenderer({ canvas })` constructs the WebGPU pipeline
//   (b) `draw(world)` records 1 frame
//   (c) assert `renderer.inspect().capabilities.backendKind === 'webgpu'`
//       (the WebGPU path is active; charter proposition 5 consistent
//       abstraction)
//
// Note: v4 imports go through `vitest/browser` (not the v3
// `@vitest/browser/context`). Inside the browser, chromium must launch
// with the WebGPU flag (CI injects via ci.yml; on local dev without the
// flag this case will skip / fail - in a fully-equipped CI environment
// this case PASSES, AC-05 is delivered).

import { World } from '@forgeax/engine-ecs';
import { Camera, type Renderer, type RendererEvent } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { afterEach, describe, expect, it } from 'vitest';

import { createRenderer } from '../src/createRenderer';

describe('renderer.browser - WebGPU path RHI contract (AC-05)', () => {
  let canvas: HTMLCanvasElement | undefined;
  let renderer: Renderer | undefined;

  afterEach(async () => {
    await renderer?.dispose();
    canvas?.remove();
    renderer = undefined;
    canvas = undefined;
  });

  it('createRenderer({ canvas }) takes the WebGPU path and can draw 1 frame', async () => {
    // (a) prepare a real canvas (vitest browser project runs inside
    // chromium with full DOM API).
    canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    document.body.appendChild(canvas);

    // pre-check: navigator.gpu must be available inside chromium. If it
    // is not (chromium flags missing / old version), this test fails with
    // an explicit reason (charter proposition 4 explicit failure: silent
    // fallback to webgl2 must not turn AC-05 into a false green).
    if (typeof navigator.gpu === 'undefined') {
      throw new Error(
        "[renderer.browser] code: 'webgpu-unavailable'; hint: WebGPU is not enabled in this browser; ci.yml injects via chrome stable channel + --enable-unsafe-webgpu --enable-features=Vulkan; on local dev use chrome --enable-unsafe-webgpu",
      );
    }

    // The maintained Browser producer serves the real Standard shader closure,
    // including the output transform used when a camera is added.
    const created = await createRenderer(
      canvas,
      {},
      { shaderManifestUrl: '/shaders/manifest.json' },
    );
    if (!created.ok) throw created.error;
    renderer = created.value;

    // (c) inspect the bounded capability POD; backend is not a second public
    // Renderer field.
    expect(renderer.inspect().capabilities.backendKind).toBe('webgpu');

    // A camera-free World is an ordinary clear-only frame.
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    world.update(1 / 60).unwrap();
    const events: RendererEvent[] = [];
    const unsubscribe = renderer.subscribe((event) => events.push(event));
    const drawn = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    expect(drawn.value.presentation).toBe('ready');
    expect((await drawn.value.completed).ok).toBe(true);
    expect(events.filter((event) => event.kind === 'error')).toEqual([]);
    const camera = world.spawn({ component: Transform }, { component: Camera });
    const draw = async () => {
      world.update(1 / 60).unwrap();
      const result = created.value.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      expect((await result.value.completed).ok).toBe(true);
    };
    await draw();
    world.despawn(camera);
    for (let frame = 0; frame < 60; frame++) await draw();
    expect(events.filter((event) => event.kind === 'error')).toEqual([]);
    unsubscribe();
    expect(events.some((event) => event.kind === 'frame-submitted')).toBe(true);
    expect(renderer.inspect().perFramePassNames).not.toContain('output-transform');
  });
});
