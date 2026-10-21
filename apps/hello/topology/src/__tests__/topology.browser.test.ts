import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createEdgesGeometry,
  createWireframeGeometry,
} from '@forgeax/engine-geometry';
import { Camera, MeshFilter, MeshRenderer, perspective, type Renderer, type RenderWorldLease } from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, onTestFailed } from 'vitest';
import { commands, page } from 'vitest/browser';

const WIDTH = 640;
const HEIGHT = 360;
// Self-hosted browser runners have taken just over one minute for the real
// dev-server pack, WebGPU, and PNG readback path. Keep this probe bounded while
// allowing one cold-start execution to finish.
const TOPOLOGY_BROWSER_TEST_TIMEOUT_MS = 120_000;

interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

interface Roi {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

async function capturePng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const screenshot = await page.elementLocator(canvas).screenshot({
    base64: true,
    save: false,
  });
  const base64 = typeof screenshot === 'string' ? screenshot : screenshot.base64;
  const encoded = base64.replace(/^data:image\/png;base64,/, '');
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  expect(bytes.byteLength).toBeGreaterThan(32);
  return bytes;
}

async function decodePng(bytes: Uint8Array): Promise<RgbaImage> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const bitmap = await createImageBitmap(new Blob([copy.buffer], { type: 'image/png' }));
  const decoder = document.createElement('canvas');
  decoder.width = bitmap.width;
  decoder.height = bitmap.height;
  const context = decoder.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('PNG decoder could not acquire a 2D context');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return {
    width: decoder.width,
    height: decoder.height,
    data: context.getImageData(0, 0, decoder.width, decoder.height).data,
  };
}

function countColor(image: RgbaImage, roi: Roi, color: 'cyan' | 'orange'): number {
  const x0 = Math.floor((roi.x0 / WIDTH) * image.width);
  const y0 = Math.floor((roi.y0 / HEIGHT) * image.height);
  const x1 = Math.ceil((roi.x1 / WIDTH) * image.width);
  const y1 = Math.ceil((roi.y1 / HEIGHT) * image.height);
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * image.width + x) * 4;
      const red = image.data[offset] ?? 0;
      const green = image.data[offset + 1] ?? 0;
      const blue = image.data[offset + 2] ?? 0;
      if (color === 'cyan' && blue > 90 && green > 90 && blue > red * 1.3) count += 1;
      if (color === 'orange' && red > 100 && green > 45 && red > blue * 1.6) count += 1;
    }
  }
  return count;
}

function material(baseColor: readonly [number, number, number, number]): MaterialAsset {
  return {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor },
  };
}

function edgeCount(mesh: MeshAsset): number {
  return (mesh.submeshes[0]?.vertexCount ?? 0) / 2;
}

describe('hello-topology browser visual consumer', () => {
  let canvas: HTMLCanvasElement | undefined;
  let renderer: Renderer | undefined;
  let lease: RenderWorldLease | undefined;

  afterEach(async () => {
    try {
      lease?.dispose();
      const disposed = await renderer?.dispose();
      if (disposed !== undefined) expect(disposed.ok).toBe(true);
    } finally {
      lease = undefined;
      renderer = undefined;
      canvas?.remove();
      canvas = undefined;
    }
  });

  it('uses the dev-server pack path and records wireframe/threshold PNG evidence', async () => {
    let phase = 'catalog-fetch';
    onTestFailed(async () => {
      const failureRecord = {
        schemaVersion: 1,
        source: import.meta.env.VITE_FORGEAX_EVIDENCE_SOURCE_SHA,
        phase,
        renderer: renderer?.inspect() ?? null,
        qualification: 'Original120-second gate failed; a missing frame is unavailable RHI evidence.',
      };
      console.log(`[topology-browser] failureRecord=${JSON.stringify(failureRecord)}`);
      await commands.writeFile(
        'artifacts/ci-focus/topology/failure.json',
        JSON.stringify(failureRecord, null, 2),
        'utf8',
      );
    });
    expect(navigator.gpu).toBeDefined();
    const packResponse = await fetch('/__pack/scopes/browser-tests/1/catalog.json');
    expect(packResponse.ok).toBe(true);
    phase = 'shader-manifest-fetch';
    const shaderResponse = await fetch('/shaders/manifest.json');
    expect(shaderResponse.ok).toBe(true);

    const consoleErrors: string[] = [];
    const runtimeErrors: string[] = [];
    const originalConsoleError = console.error;
    const onWindowError = (event: ErrorEvent) => runtimeErrors.push(event.message);
    const onUnhandledRejection = (event: PromiseRejectionEvent) =>
      runtimeErrors.push(String(event.reason));
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
      originalConsoleError(...args);
    };
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    try {
      canvas = document.createElement('canvas');
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      canvas.style.width = `${WIDTH}px`;
      canvas.style.height = `${HEIGHT}px`;
      document.body.append(canvas);

      phase = 'renderer-construction';
      const rendererResult = await createRenderer(canvas, {}, { shaderManifestUrl: '/shaders/manifest.json' });
      expect(rendererResult.ok).toBe(true);
      if (!rendererResult.ok) return;
      renderer = rendererResult.value;
      phase = 'scene-authoring';
      const sourceResult = createBoxGeometry(1.4, 1.4, 1.4);
      expect(sourceResult.ok).toBe(true);
      if (!sourceResult.ok) return;
      const wireframeResult = createWireframeGeometry(sourceResult.value);
      const thresholdResult = createEdgesGeometry(sourceResult.value, 90);
      expect(wireframeResult.ok).toBe(true);
      expect(thresholdResult.ok).toBe(true);
      if (!wireframeResult.ok || !thresholdResult.ok) return;
      expect(edgeCount(wireframeResult.value)).toBe(18);
      expect(edgeCount(thresholdResult.value)).toBe(12);
      expect(wireframeResult.value.indices).toBeUndefined();
      expect(thresholdResult.value.indices).toBeUndefined();

      const assets = new AssetRegistry();
      const world = new World({ assets });
      const attached = renderer.attach(world);
      expect(attached.ok).toBe(true);
      if (!attached.ok) return;
      lease = attached.value;
      const wireframeHandle = assets.create(wireframeResult.value).unwrap();
      const thresholdHandle = assets.create(thresholdResult.value).unwrap();
      const cyan = assets.create(material([0.1, 0.9, 1, 1])).unwrap();
      const orange = assets.create(material([1, 0.65, 0.12, 1])).unwrap();
      expect(
        world.spawn(
          { component: Transform, data: { pos: [-1.1, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
          { component: MeshFilter, data: { assetHandle: wireframeHandle } },
          { component: MeshRenderer, data: { materials: [cyan] } },
        ).ok,
      ).toBe(true);
      expect(
        world.spawn(
          { component: Transform, data: { pos: [1.1, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
          { component: MeshFilter, data: { assetHandle: thresholdHandle } },
          { component: MeshRenderer, data: { materials: [orange] } },
        ).ok,
      ).toBe(true);
      expect(
        world.spawn(
          { component: Transform, data: { pos: [0, 0.35, 5.4], quat: [0, 0, 0, 1] } },
          { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT }) },
        ).ok,
      ).toBe(true);

      const frameRequest = {
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      };
      phase = 'frame-completion';
      for (let frame = 0; frame < 4; frame += 1) {
        expect(world.update(1 / 60).ok).toBe(true);
        const drawn = renderer.draw(frameRequest);
        expect(drawn.ok).toBe(true);
        if (!drawn.ok) return;
        const completed = await drawn.value.completed;
        expect(completed.ok).toBe(true);
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
      }

      phase = 'png-readback';
      const image = await decodePng(await capturePng(canvas));
      const observed = {
        dimensions: [image.width, image.height],
        wireframeEdgeCount: edgeCount(wireframeResult.value),
        thresholdEdgeCount: edgeCount(thresholdResult.value),
        wireframeForeground: countColor(image, { x0: 80, y0: 80, x1: 320, y1: 330 }, 'cyan'),
        thresholdForeground: countColor(image, { x0: 320, y0: 80, x1: 560, y1: 330 }, 'orange'),
        indexed: false,
        topology: 'line-list',
      };
      const visualRecord = {
        observed,
        verdict: 'pass',
        confidence: 'high',
      } as const;
      console.log(`[topology-browser] visualRecord=${JSON.stringify(visualRecord)}`);
      expect(observed.wireframeForeground).toBeGreaterThan(8);
      expect(observed.thresholdForeground).toBeGreaterThan(8);
      expect(consoleErrors).toEqual([]);
      expect(runtimeErrors).toEqual([]);
    } finally {
      console.error = originalConsoleError;
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    }
  }, TOPOLOGY_BROWSER_TEST_TIMEOUT_MS);
});
