import { World } from '@forgeax/engine-ecs';
import { Camera, CameraView, type Renderer } from '@forgeax/engine-render';
import type { RhiInstance } from '@forgeax/engine-rhi';
import { expect } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { createDisplayP3Scene, pixelAt } from './display-p3.fixture';

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error), { cause: result.error });
  return result.value;
}

export async function readUiFrame(
  renderer: Renderer,
  world: World | null,
  width = 64,
  height = width,
) {
  const lease = world === null ? null : value(renderer.attach(world));
  if (renderer.requestObservation === undefined) throw new Error('observation unavailable');
  value(renderer.requestObservation(['final-display']));
  world?.update(1 / 60).unwrap();
  const receipt = value(
    renderer.draw({
      ...(lease === null
        ? { leases: [] as const, camera: null, environment: null }
        : { leases: [lease], camera: { lease }, environment: { lease } }),
      sampleTimeSeconds: 1,
    }),
  );
  value(await receipt.completed);
  const observation = value(
    await renderer.observe(receipt, { include: ['final-display'] }),
  ).observations?.find((item) => item.domain === 'final-display');
  if (observation?.domain !== 'final-display') throw new Error('Final UI image was not captured');
  expect(observation.metadata.width).toBe(width);
  expect(observation.metadata.height).toBe(height);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = y * observation.metadata.bytesPerRow + x * 4;
      const dst = (y * width + x) * 4;
      rgba.set(observation.bytes.subarray(src, src + 4), dst);
      if (observation.metadata.format?.startsWith('bgra')) {
        [rgba[dst], rgba[dst + 2]] = [rgba[dst + 2] ?? 0, rgba[dst] ?? 0];
      }
    }
  }
  return { receipt, rgba };
}

export function uiPixels(): Uint8Array {
  const pixels = new Uint8Array(64 * 64 * 4);
  for (let y = 8; y < 24; y++) {
    for (let x = 8; x < 24; x++) pixels.set([128, 0, 0, 128], (y * 64 + x) * 4);
    for (let x = 40; x < 56; x++) pixels.set([255, 255, 255, 255], (y * 64 + x) * 4);
  }
  return pixels;
}

/** The real Renderer transitions from UI-only to 3D without another device or loop. */
export async function verifyCpuUiComposition(
  canvas: unknown,
  manifestUrl: string,
  save: (name: string, pixels: Uint8Array) => void | Promise<void>,
  rhi?: RhiInstance,
  cameraViews = false,
) {
  let releaseManifest!: () => void;
  const deferred = new Promise<void>((resolve) => {
    releaseManifest = resolve;
  });
  let dirty: Uint8Array | null = uiPixels();
  let painted = 0;
  let submissions = 0;
  const errors: unknown[] = [];
  const host = value(
    await constructRuntimeRendererHost(
      canvas,
      {
        ...(rhi === undefined ? {} : { rhi }),
        ui: {
          kind: 'rgba',
          paint(_time, width, height) {
            expect([width, height]).toEqual([64, 64]);
            painted += 1;
            const pixels = dirty;
            dirty = null;
            return pixels;
          },
        },
        rhiInstrumentation: {
          beforeSubmit: () => {
            submissions += 1;
            return undefined;
          },
        },
      },
      {
        shaderManifestUrl: manifestUrl,
        readShaderManifest: async (url) => {
          await deferred;
          return (await fetch(url)).text();
        },
      },
    ),
  );
  const renderer = host.renderer;
  const boot = new World();
  const unlisten = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  let scene: ReturnType<typeof createDisplayP3Scene> | undefined;
  try {
    const loading = await readUiFrame(renderer, boot);
    expect(loading.receipt.presentation).toBe('pending');
    expect(pixelAt(loading.rgba, [16, 16])).toEqual([128, 0, 0]);
    expect(pixelAt(loading.rgba, [48, 16])).toEqual([255, 255, 255]);
    await save('loading', loading.rgba);
    const cached = await readUiFrame(renderer, boot);
    expect(cached.rgba).toEqual(loading.rgba);
    expect(submissions).toBe(2);
    releaseManifest();
    value(await host.initialization);
    // Shader readiness precedes asynchronous root activation in native Hosts.
    // An explicit scene-free frame must keep Loading alive across that gap.
    const activating = await readUiFrame(renderer, null);
    expect(activating.receipt.presentation).toBe('pending');
    expect(activating.rgba).toEqual(loading.rgba);
    expect(activating.receipt.barrelDistortion).toBeUndefined();
    await save('scene-activating', activating.rgba);
    dirty = new Uint8Array(64 * 64 * 4);
    scene = createDisplayP3Scene(renderer, errors);
    if (cameraViews) {
      const camera = [...scene.world.query({ with: [Camera] }).unwrap()][0]?.entity;
      if (camera === undefined) throw new Error('CPU UI scene requires a Camera');
      scene.world.addComponent(camera, { component: CameraView, data: {} }).unwrap();
    }
    for (let i = 0; i < 60; i++) value(await (await scene.draw()).completed);
    const before = await readUiFrame(renderer, scene.world);
    expect(before.receipt.presentation).toBe('ready');
    await save('scene', before.rgba);
    dirty = uiPixels();
    const original = dirty;
    const after = await readUiFrame(renderer, scene.world);
    expect(after.receipt.presentation).toBe('ready');
    const beforePixel = pixelAt(before.rgba, [16, 16]);
    const afterPixel = pixelAt(after.rgba, [16, 16]);
    const expected = beforePixel.map((v, i) =>
      Math.round(v * (1 - 128 / 255) + (i === 0 ? 128 : 0)),
    );
    for (let i = 0; i < 3; i++)
      expect(
        Math.abs((afterPixel[i] ?? Number.NaN) - (expected[i] ?? Number.NaN)),
      ).toBeLessThanOrEqual(1);
    expect(pixelAt(after.rgba, [48, 16])).toEqual([255, 255, 255]);
    expect(pixelAt(after.rgba, [48, 48])).toEqual(pixelAt(before.rgba, [48, 48]));
    await save('scene-with-ui', after.rgba);
    original.fill(0);
    const retained = await readUiFrame(renderer, scene.world);
    expect(retained.rgba).toEqual(after.rgba);
    expect(errors).toEqual([]);
    // Retiring a failed scene keeps Fatal/Reload on the same live surface,
    // without carrying the last submitted scene's display context.
    const retired = await readUiFrame(renderer, null);
    expect(retired.receipt.presentation).toBe('pending');
    expect(retired.receipt.barrelDistortion).toBeUndefined();
    expect(retired.rgba).toEqual(loading.rgba);
    expect(painted).toBe(67);
    expect(submissions).toBe(67);
    // Returning to a camera-free World preserves UI composition and normal completion.
    const cameraFree = await readUiFrame(renderer, boot);
    expect(cameraFree.receipt.presentation).toBe('ready');
    expect(cameraFree.rgba).toEqual(loading.rgba);
    expect(errors).toEqual([]);
  } catch (cause) {
    throw new Error(`CPU UI composition failed: ${JSON.stringify(errors)}`, { cause });
  } finally {
    releaseManifest();
    scene?.dispose();
    unlisten();
    value(await renderer.dispose());
  }
}

export async function verifyCpuUiFailure(
  canvas: unknown,
  save: (name: string, pixels: Uint8Array) => void | Promise<void>,
) {
  let rejectManifest!: (cause: unknown) => void;
  const deferred = new Promise<string>((_resolve, reject) => {
    rejectManifest = reject;
  });
  let dirty: Uint8Array | null = uiPixels();
  const host = value(
    await constructRuntimeRendererHost(
      canvas,
      {
        ui: {
          kind: 'rgba',
          paint() {
            const pixels = dirty;
            dirty = null;
            return pixels;
          },
        },
      },
      { shaderManifestUrl: '/delayed-failure.json', readShaderManifest: () => deferred },
    ),
  );
  const world = new World();
  try {
    expect((await readUiFrame(host.renderer, world)).receipt.presentation).toBe('pending');
    rejectManifest(new Error('Deliberate game manifest failure'));
    expect((await host.initialization).ok).toBe(false);
    dirty = uiPixels();
    for (let i = 0; i < dirty.length; i += 4) if (dirty[i + 3]) dirty[i + 1] = dirty[i] ?? 0;
    const fatal = await readUiFrame(host.renderer, world);
    expect(fatal.receipt.presentation).toBe('pending');
    expect(pixelAt(fatal.rgba, [16, 16])).toEqual([128, 128, 0]);
    expect(host.renderer.state()).toBe('alive');
    await save('initialization-failed-ui', fatal.rgba);
  } finally {
    rejectManifest(new Error('disposed'));
    value(await host.renderer.dispose());
  }
}
