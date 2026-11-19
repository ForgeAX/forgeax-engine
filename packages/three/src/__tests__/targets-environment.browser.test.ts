import * as THREE from '@forgeax/engine/three';
import type {
  Renderer as NativeRenderer,
  RenderTarget as NativeTarget,
} from '@forgeax/engine-render';
import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { saveBrowserBytes, saveBrowserEvidence } from './browser-evidence.fixture';
import { browserRendererFixture, displayPixels, readyFrames, SIZE } from './render.fixture';

const rendererOf = browserRendererFixture();
const center = (bytes: Uint8Array) =>
  Array.from(
    bytes.subarray((SIZE * (SIZE / 2) + SIZE / 2) * 4, (SIZE * (SIZE / 2) + SIZE / 2) * 4 + 4),
  );
async function saveTape(name: string, bytes: Uint8Array) {
  await saveBrowserBytes(`${name}.rhitape`, bytes);
}
function camera() {
  const value = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  value.position.z = 5;
  return value;
}

it('writes HDR offscreen, resolves MSAA, samples in order, clears, resizes and readmits disposal', {
  timeout: 120000,
}, async () => {
  const renderer = rendererOf();
  await renderer.init();
  const target = new THREE.RenderTarget(32, 32, {
    type: THREE.HalfFloatType,
    samples: 4,
    generateMipmaps: false,
  });
  const source = new THREE.Scene(),
    view = camera();
  const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.5, 0.75) });
  const sourceMesh = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), material);
  source.add(sourceMesh);
  const scene = new THREE.Scene();
  scene.add(
    new THREE.Mesh(
      new THREE.PlaneGeometry(8, 8),
      new THREE.MeshBasicMaterial({ map: target.texture }),
    ),
  );
  const events: string[] = [];
  source.onBeforeRender = (_renderer, _scene, _camera, selected) => {
    expect(selected).toBe(target);
    events.push('source-before');
  };
  source.onAfterRender = () => {
    events.push('source-after');
  };
  scene.onBeforeRender = () => {
    events.push('display-before');
  };
  try {
    renderer.setRenderTarget(target);
    const abandoned = renderer.renderAsync(source, view);
    renderer.setRenderTarget(null);
    await expect(abandoned).rejects.toMatchObject({ code: 'three-invalid-value' });
    renderer.setRenderTarget(target);
    const recorder = Reflect.get(renderer, 'recorder') as RecorderAttachment;
    const failureCapture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    try {
      await renderer.renderAsync(source, view);
    } catch (error) {
      await commands.writeFile(
        'artifacts/three-compat/target-pending.json',
        JSON.stringify(renderer.inspect(), null, 2),
      );
      throw error;
    } finally {
      (await recorder.frameBoundary()).unwrap();
      const captured = await failureCapture;
      if (captured.ok) await saveTape('target-initial', captured.value.bytes);
    }
    renderer.setRenderTarget(null);
    await readyFrames(renderer, scene, view, 60);
    expect(events.slice(0, 3)).toEqual(['source-before', 'source-after', 'display-before']);
    const first = await renderer.captureFrame(scene, view);
    await saveBrowserEvidence('target-write-sample-msaa', first);
    const pixel = center(displayPixels(first));
    expect(pixel[0]).toBeGreaterThan(125);
    expect(pixel[0]).toBeLessThan(145);
    expect(pixel[1]).toBeGreaterThan(178);
    expect(pixel[2]).toBeGreaterThan(215);
    renderer.setRenderTarget(target);
    renderer.setClearColor(new THREE.Color(2, 0.125, 0.25), 1);
    await renderer.clearAsync(true, false, false);
    const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 32, 32);
    expect(raw).toBeInstanceOf(Uint16Array);
    expect(THREE.DataUtils.fromHalfFloat(raw[0] ?? 0)).toBeCloseTo(2, 3);
    expect(THREE.DataUtils.fromHalfFloat(raw[1] ?? 0)).toBeCloseTo(0.125, 3);
    // Write through the facade's actual capture graph; native observation exposes mip 1
    // without broadening r187's mip-0-only facade readback signature.
    const runtime = Reflect.get(renderer, 'runtime') as {
      native: NativeRenderer;
      targets: { target(value: THREE.RenderTarget): NativeTarget };
    };
    const requested = runtime.native.requestTargetReadback(runtime.targets.target(target), {
      mipLevel: 1,
    });
    if (!requested.ok) throw requested.error;
    renderer.setRenderTarget(target, 0, 1);
    const mipTape = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await renderer.renderAsync(source, view);
    (await recorder.frameBoundary()).unwrap();
    const capturedMip = await mipTape;
    if (!capturedMip.ok) throw capturedMip.error;
    await saveTape('target-mip1-msaa', capturedMip.value.bytes);
    const mipReceipt = renderer.inspect().receipt;
    if (mipReceipt === undefined) throw new Error('missing mip receipt');
    const observedMip = await runtime.native.observe(mipReceipt, {
      include: ['target-readbacks'],
      targetReadbacks: [requested.value],
    });
    if (!observedMip.ok) throw observedMip.error;
    const mipImage = observedMip.value.targetReadbacks?.[0];
    if (mipImage === undefined) throw new Error('missing mip readback');
    const mipBytes = new DataView(
      mipImage.bytes.buffer,
      mipImage.bytes.byteOffset,
      mipImage.bytes.byteLength,
    );
    const mipPixel = [0, 1, 2].map((lane) =>
      THREE.DataUtils.fromHalfFloat(
        mipBytes.getUint16(8 * mipImage.bytesPerRow + 8 * 8 + lane * 2, true),
      ),
    );
    [0.25, 0.5, 0.75].forEach((value, index) => {
      expect(mipPixel[index]).toBeCloseTo(value, 2);
    });
    await commands.writeFile(
      'artifacts/three-compat/target-mip1-msaa.json',
      JSON.stringify({ pixel: mipPixel, expected: [0.25, 0.5, 0.75] }),
    );
    renderer.setRenderTarget(target, 0, 0);
    target.setSize(16, 16);
    await renderer.renderAsync(source, view);
    target.dispose();
    await renderer.renderAsync(source, view);
    renderer.setRenderTarget(null);
    await readyFrames(renderer, scene, view);
    const final = await renderer.captureFrame(scene, view);
    await saveBrowserEvidence('target-resize-dispose-sample', final);
    expect(center(displayPixels(final))).toEqual(pixel);
    source.remove(sourceMesh);
    for (const [y, color] of [
      [2, 0xff0000],
      [-2, 0x0000ff],
    ] as const) {
      const half = new THREE.Mesh(
        new THREE.PlaneGeometry(8, 4),
        new THREE.MeshBasicMaterial({ color }),
      );
      half.position.y = y;
      source.add(half);
    }
    renderer.setRenderTarget(target);
    await renderer.renderAsync(source, view);
    renderer.setRenderTarget(null);
    await readyFrames(renderer, scene, view);
    const oriented = await renderer.captureFrame(scene, view);
    await saveBrowserEvidence('target-uv-orientation', oriented);
    const pixels = displayPixels(oriented),
      top = (SIZE * 32 + 64) * 4,
      bottom = (SIZE * 96 + 64) * 4;
    expect(pixels[top]).toBeGreaterThan(pixels[bottom] ?? 0);
    expect(pixels[top + 2]).toBeLessThan(pixels[bottom + 2] ?? 0);
  } finally {
    renderer.setRenderTarget(null);
    target.dispose();
  }
});

it('captures all six directional cube faces and consumes filtered radiance in real PBR for two bounces', {
  timeout: 120000,
}, async () => {
  const renderer = rendererOf();
  await renderer.init();
  const cube = new THREE.CubeRenderTarget(32, {
    type: THREE.HalfFloatType,
    generateMipmaps: false,
  });
  const probe = new THREE.CubeCamera(0.1, 30, cube);
  const source = new THREE.Scene();
  source.add(probe);
  const directions = [
    [-1, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff];
  directions.forEach((direction, index) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(3, 3, 3),
      new THREE.MeshBasicMaterial({ color: colors[index] ?? 0 }),
    );
    mesh.position.set((direction[0] ?? 0) * 5, (direction[1] ?? 0) * 5, (direction[2] ?? 0) * 5);
    source.add(mesh);
  });
  try {
    await renderer.captureCubeAsync(probe, source);
    for (let face = 0; face < 6; face++) {
      const raw = await renderer.readRenderTargetPixelsAsync(cube, 0, 0, 32, 32, 0, face);
      const at = (32 * 16 + 16) * 4;
      const expected = new THREE.Color(colors[face]);
      [expected.r, expected.g, expected.b].forEach((value, lane) => {
        expect(THREE.DataUtils.fromHalfFloat(raw[at + lane] ?? 0)).toBeCloseTo(value, 2);
      });
    }
    const scene = new THREE.Scene(),
      view = camera();
    scene.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(1.5, 32, 16),
        new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.3 }),
      ),
    );
    await readyFrames(renderer, scene, view);
    const dark = center(displayPixels(await renderer.captureFrame(scene, view)));
    scene.environment = cube.texture;
    await readyFrames(renderer, scene, view, 60);
    const lit = await renderer.captureFrame(scene, view);
    await saveBrowserEvidence('cube-native-ibl-pbr', lit);
    expect(
      center(displayPixels(lit))
        .slice(0, 3)
        .reduce((a, b) => a + b, 0),
    ).toBeGreaterThan(dark.slice(0, 3).reduce((a, b) => a + b, 0) + 30);
    source.environment = cube.texture;
    const bounceReceiver = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 8),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }),
    );
    bounceReceiver.position.z = 2;
    source.add(bounceReceiver);
    await renderer.captureCubeAsync(probe, source);
    const secondFace = await renderer.readRenderTargetPixelsAsync(cube, 0, 0, 32, 32, 0, 4);
    // The first +Z center was pure magenta; this PBR receiver acquired green from the first environment.
    expect(THREE.DataUtils.fromHalfFloat(secondFace[(32 * 16 + 16) * 4 + 1] ?? 0)).toBeGreaterThan(
      0.01,
    );
    await readyFrames(renderer, scene, view);
    await saveBrowserEvidence(
      'cube-native-ibl-second-bounce',
      await renderer.captureFrame(scene, view),
    );
    probe.activeMipmapLevel = 1;
    await expect(renderer.captureCubeAsync(probe, source)).rejects.toMatchObject({
      code: 'three-unsupported',
    });
  } finally {
    renderer.setRenderTarget(null);
    cube.dispose();
  }
});
