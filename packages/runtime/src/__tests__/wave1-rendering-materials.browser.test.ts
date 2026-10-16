import { createWorldContext, FixedTime, World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createMeshBuilder } from '@forgeax/engine-geometry';
import {
  Atmosphere,
  type FrameReceipt,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  type RenderInspection,
  type RenderWorldLease,
  VolumetricFog,
} from '@forgeax/engine-render';
import { propagateTransforms, scenePlugin, Transform } from '@forgeax/engine-scene';
import type { MeshAsset, TextureAsset, VertexAttributeMap } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import {
  createWave1RenderingRecipe,
  WAVE1_ATMOSPHERE_PRESET,
} from '../../../../scripts/dev-verify/wave1-rendering/recipe';
import { createRenderer } from '../createRenderer';

interface ScreenshotPixels {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

interface PixelStats {
  readonly nonBlackPixels: number;
  readonly meanLuma: number;
  readonly channelTotals: readonly [number, number, number];
}

interface PixelDelta {
  readonly changedPixels: number;
  readonly meanAbsoluteChannelDelta: number;
  readonly maxChannelDelta: number;
}

interface FrameSample {
  readonly receipt: FrameReceipt;
  readonly pixels: ScreenshotPixels;
  readonly inspection: RenderInspection;
  readonly observedIncludes: readonly ('timings' | 'draws' | 'bindings' | 'target-readbacks')[];
}

const ARTIFACT_ROOT = '../../../../artifacts/wave1-rendering/';

async function screenshotPixels(
  canvas: HTMLCanvasElement,
  label: string,
): Promise<ScreenshotPixels> {
  const shot = await page.elementLocator(canvas).screenshot({
    path: `${ARTIFACT_ROOT}wave1-materials-${label}.png`,
    base64: true,
  });
  const base64 = typeof shot === 'string' ? shot : shot.base64;
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = surface.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    bitmap.close();
    throw new Error('wave1-rendering materials: screenshot pixel context unavailable');
  }
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return {
    width: image.width,
    height: image.height,
    pixels: new Uint8Array(image.data),
  };
}

function pixelStats(readback: ScreenshotPixels): PixelStats {
  let nonBlackPixels = 0;
  let lumaTotal = 0;
  let redTotal = 0;
  let greenTotal = 0;
  let blueTotal = 0;
  for (let offset = 0; offset < readback.pixels.length; offset += 4) {
    const red = readback.pixels[offset] ?? 0;
    const green = readback.pixels[offset + 1] ?? 0;
    const blue = readback.pixels[offset + 2] ?? 0;
    if (red + green + blue > 3) nonBlackPixels += 1;
    lumaTotal += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    redTotal += red;
    greenTotal += green;
    blueTotal += blue;
  }
  const pixelCount = Math.max(1, readback.width * readback.height);
  return {
    nonBlackPixels,
    meanLuma: lumaTotal / pixelCount,
    channelTotals: [redTotal, greenTotal, blueTotal],
  };
}

function pixelDelta(left: ScreenshotPixels, right: ScreenshotPixels): PixelDelta {
  if (left.width !== right.width || left.height !== right.height) {
    return {
      changedPixels: Math.max(left.width * left.height, right.width * right.height),
      meanAbsoluteChannelDelta: 255,
      maxChannelDelta: 255,
    };
  }
  let changedPixels = 0;
  let absoluteDelta = 0;
  let maxChannelDelta = 0;
  for (let offset = 0; offset < left.pixels.length; offset += 4) {
    let changed = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(
        (left.pixels[offset + channel] ?? 0) - (right.pixels[offset + channel] ?? 0),
      );
      if (delta > 0) changed = true;
      absoluteDelta += delta;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    if (changed) changedPixels += 1;
  }
  return {
    changedPixels,
    meanAbsoluteChannelDelta: absoluteDelta / Math.max(1, left.width * left.height * 3),
    maxChannelDelta,
  };
}

function channelTotalsInRegion(
  readback: ScreenshotPixels,
  centerX: number,
  centerY: number,
  halfWidth: number,
  halfHeight: number,
): readonly [number, number, number] {
  const x0 = Math.max(0, Math.floor((centerX - halfWidth) * readback.width));
  const y0 = Math.max(0, Math.floor((centerY - halfHeight) * readback.height));
  const x1 = Math.min(readback.width, Math.ceil((centerX + halfWidth) * readback.width));
  const y1 = Math.min(readback.height, Math.ceil((centerY + halfHeight) * readback.height));
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * readback.width + x) * 4;
      red += readback.pixels[offset] ?? 0;
      green += readback.pixels[offset + 1] ?? 0;
      blue += readback.pixels[offset + 2] ?? 0;
    }
  }
  return [red, green, blue];
}

function passNamesContain(inspection: RenderInspection, expected: readonly string[]): boolean {
  return expected.every((name) => inspection.perFramePassNames.includes(name));
}

async function submitFrame(
  world: World,
  renderer: Renderer,
  lease: RenderWorldLease,
  canvas: HTMLCanvasElement,
  label: string,
): Promise<FrameSample> {
  propagateTransforms(world).unwrap();
  const drawn = renderer.draw({
    leases: [lease],
    camera: { lease },
    environment: { lease },
    fixedStep: world.getResource(FixedTime).tick,
  });
  if (!drawn.ok) throw drawn.error;
  const receipt = drawn.value;
  const completed = await receipt.completed;
  if (!completed.ok) throw completed.error;
  const observation = await renderer.observe(receipt, {
    include: ['draws', 'bindings'],
  });
  if (!observation.ok) throw observation.error;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const pixels = await screenshotPixels(canvas, label);
  const inspection = renderer.inspect();
  // biome-ignore lint/suspicious/noConsole: this test emits real browser GPU evidence.
  console.info(
    '[wave1-rendering:materials]',
    JSON.stringify({
      label,
      receipt: {
        frameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        completed: true,
      },
      pixel: pixelStats(pixels),
      passNames: inspection.perFramePassNames,
      volume: inspection.volumetricFog,
      bloom: inspection.bloom,
      observedIncludes: observation.value.include,
    }),
  );
  return { receipt, pixels, inspection, observedIncludes: observation.value.include };
}

function createCanonicalBox(withVertexColor: boolean): MeshAsset {
  const box = createBoxGeometry(1.8, 1.8, 0.6).unwrap();
  const position = box.attributes.position;
  const normal = box.attributes.normal;
  const uv = box.attributes.uv;
  const tangent = box.attributes.tangent;
  if (
    !(position instanceof Float32Array) ||
    !(normal instanceof Float32Array) ||
    !(uv instanceof Float32Array) ||
    !(tangent instanceof Float32Array) ||
    box.indices === undefined
  ) {
    throw new Error('wave1-rendering materials: canonical box attributes unavailable');
  }
  const attributes: VertexAttributeMap = {
    position,
    normal,
    uv,
    tangent,
    ...(withVertexColor ? { color: new Float32Array((position.length / 3) * 4).fill(1) } : {}),
  };
  const built = createMeshBuilder({
    attributes,
    indices: box.indices,
    submeshes: [
      {
        indexOffset: 0,
        indexCount: box.indices.length,
        vertexCount: position.length / 3,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'surface' }],
  }).build();
  if (!built.ok) throw built.error;
  return built.value;
}

function createDensity(): TextureAsset {
  const size = 8;
  return {
    kind: 'texture',
    shape: {
      viewDimension: '3d',
      extent: { width: size, height: size, depth: size },
    },
    format: 'r8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(size * size * size).fill(96),
  };
}

function noLightScene(recipe: ReturnType<typeof createWave1RenderingRecipe>): void {
  recipe.destroy(recipe.entities.wall);
  recipe.destroy(recipe.entities.floor);
  recipe.destroy(recipe.entities.roof);
  recipe.destroy(recipe.entities.sun);
  recipe.destroy(recipe.entities.skylight);
  recipe.destroy(recipe.entities.localLight);
}

async function createCanvas(width = 256, height = 256): Promise<HTMLCanvasElement> {
  if (!navigator.gpu) throw new Error('WebGPU is required for Wave1 material regressions');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  document.body.append(canvas);
  return canvas;
}

it('proves emissive intensity and color pattern with every scene light off', async () => {
  const canvas = await createCanvas();
  const rendererResult = await createRenderer(
    canvas,
    {},
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!rendererResult.ok) throw rendererResult.error;
  const renderer = rendererResult.value;
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const recipe = createWave1RenderingRecipe(world, { aspect: 1 });
  const lowIntensity = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0, 0, 0, 1],
      metallic: 0,
      roughness: 0.5,
      emissive: [1, 0.1, 0.01],
      emissiveIntensity: 0.45,
    }),
  );
  const highIntensity = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0, 0, 0, 1],
      metallic: 0,
      roughness: 0.5,
      emissive: [1, 0.1, 0.01],
      emissiveIntensity: 2.5,
    }),
  );
  const errors: string[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error.code);
  });
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  try {
    noLightScene(recipe);
    world
      .set(recipe.entities.screen, MeshRenderer, {
        materials: [lowIntensity, lowIntensity, lowIntensity],
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    const low = await submitFrame(world, renderer, attached.value, canvas, 'emissive-low');
    expect(low.inspection.bloom.enabled).toBe(false);
    expect(low.inspection.bloom.graphStatus).toBe('empty');
    expect(pixelStats(low.pixels).nonBlackPixels).toBeGreaterThan(0);

    world
      .set(recipe.entities.screen, MeshRenderer, {
        materials: [highIntensity, highIntensity, highIntensity],
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    const high = await submitFrame(world, renderer, attached.value, canvas, 'emissive-high');
    expect(pixelDelta(low.pixels, high.pixels).changedPixels).toBeGreaterThan(0);
    expect(pixelStats(high.pixels).meanLuma).toBeGreaterThan(pixelStats(low.pixels).meanLuma);
    expect(pixelStats(high.pixels).nonBlackPixels).toBeGreaterThan(0);

    world
      .set(recipe.entities.screen, MeshRenderer, {
        materials: [
          recipe.assets.emissiveAmber,
          recipe.assets.emissiveBlue,
          recipe.assets.emissiveGold,
        ],
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    const pattern = await submitFrame(world, renderer, attached.value, canvas, 'emissive-pattern');
    world
      .set(recipe.entities.screen, MeshRenderer, {
        materials: [
          recipe.assets.emissiveBlue,
          recipe.assets.emissiveGold,
          recipe.assets.emissiveAmber,
        ],
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    const rotatedPattern = await submitFrame(
      world,
      renderer,
      attached.value,
      canvas,
      'emissive-pattern-rotated',
    );
    expect(pixelDelta(pattern.pixels, rotatedPattern.pixels).changedPixels).toBeGreaterThan(0);
    const left = channelTotalsInRegion(pattern.pixels, 0.43, 0.5, 0.045, 0.16);
    const center = channelTotalsInRegion(pattern.pixels, 0.5, 0.5, 0.045, 0.16);
    expect(left[0]).toBeGreaterThan(left[2]);
    expect(center[2]).toBeGreaterThan(center[0]);
    expect(errors).toEqual([]);
    // biome-ignore lint/suspicious/noConsole: this test emits bounded acceptance evidence.
    console.info(
      '[wave1-rendering:materials] emissive-acceptance',
      JSON.stringify({
        bloom: pattern.inspection.bloom,
        low: pixelStats(low.pixels),
        high: pixelStats(high.pixels),
        pattern: pixelStats(pattern.pixels),
        rotatedPattern: pixelStats(rotatedPattern.pixels),
        patternDelta: pixelDelta(pattern.pixels, rotatedPattern.pixels),
      }),
    );
  } finally {
    unsubscribe();
    await renderer.dispose();
    world.sharedRefs.release(lowIntensity).unwrap();
    world.sharedRefs.release(highIntensity).unwrap();
    recipe.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 120000);

it('matches a canonical box without color to the same box with white vertex color', async () => {
  const canvas = await createCanvas();
  const rendererResult = await createRenderer(
    canvas,
    {},
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!rendererResult.ok) throw rendererResult.error;
  const renderer = rendererResult.value;
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const recipe = createWave1RenderingRecipe(world, { aspect: 1 });
  const material = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0, 0, 0, 1],
      metallic: 0,
      roughness: 0.5,
      emissive: [0.08, 0.55, 1],
      emissiveIntensity: 2,
    }),
  );
  const noColorMesh = world.allocSharedRef('MeshAsset', createCanonicalBox(false));
  const whiteColorMesh = world.allocSharedRef('MeshAsset', createCanonicalBox(true));
  const errors: string[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error.code);
  });
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const entity = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: noColorMesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  try {
    noLightScene(recipe);
    world.update(1 / 60).unwrap();
    const noColor = await submitFrame(world, renderer, attached.value, canvas, 'box-no-color');
    expect(pixelStats(noColor.pixels).nonBlackPixels).toBeGreaterThan(0);

    world.set(entity, MeshFilter, { assetHandle: whiteColorMesh }).unwrap();
    world.update(1 / 60).unwrap();
    const whiteColor = await submitFrame(
      world,
      renderer,
      attached.value,
      canvas,
      'box-white-color',
    );
    expect(pixelDelta(noColor.pixels, whiteColor.pixels)).toEqual({
      changedPixels: 0,
      meanAbsoluteChannelDelta: 0,
      maxChannelDelta: 0,
    });
    expect(errors).toEqual([]);
    // biome-ignore lint/suspicious/noConsole: this test emits bounded acceptance evidence.
    console.info(
      '[wave1-rendering:materials] vertex-color-acceptance',
      JSON.stringify({
        noColor: pixelStats(noColor.pixels),
        whiteColor: pixelStats(whiteColor.pixels),
        delta: pixelDelta(noColor.pixels, whiteColor.pixels),
      }),
    );
  } finally {
    world.despawn(entity).unwrap();
    unsubscribe();
    await renderer.dispose();
    world.sharedRefs.release(material).unwrap();
    world.sharedRefs.release(noColorMesh).unwrap();
    world.sharedRefs.release(whiteColorMesh).unwrap();
    recipe.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 120000);

it('runs the bounded VolumetricFog air layer independently from Atmosphere', async () => {
  const canvas = await createCanvas();
  const rendererResult = await createRenderer(
    canvas,
    {},
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!rendererResult.ok) throw rendererResult.error;
  const renderer = rendererResult.value;
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const recipe = createWave1RenderingRecipe(world, {
    aspect: 1,
    includeAtmosphere: true,
  });
  const density = world.allocSharedRef('TextureAsset', createDensity());
  const fogEntity = world
    .spawn({
      component: VolumetricFog,
      data: {
        light: recipe.entities.sun,
        density,
        boundsMin: [-8, -4, -2],
        boundsMax: [8, 4, 6],
        extinction: [0.22, 0.22, 0.22],
        albedo: [0.75, 0.75, 0.75],
        emission: [0, 0, 0],
        anisotropy: 0,
        maxDistance: 30,
      },
    })
    .unwrap();
  const errors: string[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error.code);
  });
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  let fogPresent = true;
  try {
    world.update(1 / 60).unwrap();
    const both = await submitFrame(world, renderer, attached.value, canvas, 'air-both-on');
    expect(both.inspection.volumetricFog?.status).toBe('available');
    expect(
      passNamesContain(both.inspection, [
        'atmosphere-background',
        'volume-inject',
        'volume-integrate',
        'volume-temporal',
        'volume-composite',
      ]),
    ).toBe(true);
    expect(both.observedIncludes).toEqual(['draws', 'bindings']);

    const atmosphere = recipe.entities.atmosphere;
    if (atmosphere === undefined) {
      throw new Error('wave1-rendering materials: Atmosphere fixture entity missing');
    }
    world.removeComponent(atmosphere, Atmosphere).unwrap();
    world.update(1 / 60).unwrap();
    const fogOnly = await submitFrame(
      world,
      renderer,
      attached.value,
      canvas,
      'air-atmosphere-off',
    );
    expect(fogOnly.inspection.volumetricFog?.status).toBe('available');
    expect(fogOnly.inspection.perFramePassNames).not.toContain('atmosphere-background');
    expect(fogOnly.inspection.perFramePassNames).toContain('volume-composite');
    expect(fogOnly.observedIncludes).toEqual(['draws', 'bindings']);
    expect(pixelDelta(both.pixels, fogOnly.pixels).changedPixels).toBeGreaterThan(0);

    world.removeComponent(fogEntity, VolumetricFog).unwrap();
    fogPresent = false;
    world.update(1 / 60).unwrap();
    const clear = await submitFrame(world, renderer, attached.value, canvas, 'air-volume-off');
    expect(clear.inspection.volumetricFog?.status).toBe('off');
    expect(clear.inspection.perFramePassNames).not.toContain('volume-inject');
    expect(clear.observedIncludes).toEqual(['draws', 'bindings']);
    expect(pixelDelta(fogOnly.pixels, clear.pixels).changedPixels).toBeGreaterThan(0);

    world
      .addComponent(atmosphere, {
        component: Atmosphere,
        data: WAVE1_ATMOSPHERE_PRESET,
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    const atmosphereOnly = await submitFrame(
      world,
      renderer,
      attached.value,
      canvas,
      'air-atmosphere-only',
    );
    expect(atmosphereOnly.inspection.volumetricFog?.status).toBe('off');
    expect(atmosphereOnly.inspection.perFramePassNames).toContain('atmosphere-background');
    expect(atmosphereOnly.inspection.perFramePassNames).not.toContain('volume-composite');
    expect(atmosphereOnly.observedIncludes).toEqual(['draws', 'bindings']);
    expect(pixelDelta(clear.pixels, atmosphereOnly.pixels).changedPixels).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    // biome-ignore lint/suspicious/noConsole: this test emits bounded acceptance evidence.
    console.info(
      '[wave1-rendering:materials] air-layer-acceptance',
      JSON.stringify({
        both: {
          volume: both.inspection.volumetricFog,
          passes: both.inspection.perFramePassNames,
          pixel: pixelStats(both.pixels),
        },
        fogOnly: {
          volume: fogOnly.inspection.volumetricFog,
          passes: fogOnly.inspection.perFramePassNames,
          pixel: pixelStats(fogOnly.pixels),
        },
        clear: {
          volume: clear.inspection.volumetricFog,
          passes: clear.inspection.perFramePassNames,
          pixel: pixelStats(clear.pixels),
        },
        atmosphereOnly: {
          volume: atmosphereOnly.inspection.volumetricFog,
          passes: atmosphereOnly.inspection.perFramePassNames,
          pixel: pixelStats(atmosphereOnly.pixels),
        },
      }),
    );
  } finally {
    if (fogPresent) world.despawn(fogEntity).unwrap();
    world.sharedRefs.release(density).unwrap();
    unsubscribe();
    await renderer.dispose();
    recipe.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 120000);
