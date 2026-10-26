import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  BLOOM_ENABLED,
  Camera,
  DirectionalLight,
  Fog,
  FogModeValue,
  GradientSky,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  TONEMAP_ACES_FILMIC,
  TONEMAP_NONE,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { testAssets } from './helpers/runtime-assets';

// A GradientSky drawn through the real renderer, read back from the encoded
// surface (display-referred) or the HDR scene target (scene-referred), and
// compared with the documented law: mix(horizon, zenith | ground, |h|^exponent),
// a light-coloured sun disc toward -DirectionalLight.direction, glow, and the
// Fog colour at and below the horizon fading out by fogBlend.

type Rgb = readonly [number, number, number];
const SIZE = 64;
const FOV = Math.PI / 2;
const SKY = {
  zenith: [0.05, 0.2, 0.7] as Rgb,
  horizon: [0.9, 0.6, 0.3] as Rgb,
  ground: [0.15, 0.25, 0.1] as Rgb,
  exponent: 0.8,
  sunSize: 0.06,
  sunGlow: 0.4,
  fogBlend: 0.4,
};
// A three-stop dusk: orange -> rose -> violet, the middle stop 0.3 up.
const THREE_STOP = { mid: [0.7, 0.2, 0.35] as Rgb, midHeight: 0.3 };
const SUN_PIXEL = [48, 14] as const;
const LIGHT_COLOR: Rgb = [1, 0.8, 0.6];
const FOG_COLOR: Rgb = [0.4, 0.45, 0.5];

function rayAt(px: number, py: number): Rgb {
  const t = Math.tan(FOV / 2);
  const x = ((px + 0.5) / (SIZE / 2) - 1) * t;
  const y = (1 - (py + 0.5) / (SIZE / 2)) * t;
  const length = Math.hypot(x, y, 1);
  return [x / length, y / length, -1 / length];
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb =>
  [0, 1, 2].map((i) => (a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * t) as unknown as Rgb;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

function skyBase(h: number, stops: typeof THREE_STOP | undefined): Rgb {
  if (stops !== undefined && h >= 0) {
    const m = stops.midHeight;
    return h < m
      ? mix(SKY.horizon, stops.mid, (h / m) ** SKY.exponent)
      : mix(stops.mid, SKY.zenith, ((h - m) / (1 - m)) ** SKY.exponent);
  }
  return mix(
    SKY.horizon,
    h >= 0 ? SKY.zenith : SKY.ground,
    Math.min(Math.abs(h), 1) ** SKY.exponent,
  );
}

function expectedSky(
  dir: Rgb,
  disc: Rgb,
  fog: { color: Rgb; opacity: number } | undefined,
  stops?: typeof THREE_STOP,
): Rgb {
  const h = dir[1];
  const sun = rayAt(...SUN_PIXEL);
  let color = skyBase(h, stops);
  const angle = Math.acos(Math.min(1, dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2]));
  const hue = LIGHT_COLOR.map((v) => v / Math.max(...LIGHT_COLOR)) as unknown as Rgb;
  color = mix(color, hue, Math.min(SKY.sunGlow * Math.exp(-angle / (SKY.sunSize * 8)), 1));
  if (fog !== undefined)
    color = mix(color, fog.color, fog.opacity * (1 - smoothstep(0, SKY.fogBlend, h)));
  // The disc is drawn over the fog and sets behind the horizon.
  const cover =
    (1 - smoothstep(SKY.sunSize * 0.85, SKY.sunSize, angle)) * smoothstep(-0.002, 0.002, h);
  return mix(color, disc, cover);
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

const encode = (linear: number) => {
  const c = Math.min(Math.max(linear, 0), 1);
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
};

interface Scenario {
  readonly renderPath: 'forward' | 'deferred';
  readonly toneMapped: boolean;
  readonly tonemap: number;
  readonly fog: boolean;
  readonly stops?: typeof THREE_STOP;
  /** Camera bloom; the readback domain defaults to the sky's own. */
  readonly bloom?: boolean;
  readonly domain?: 'linear-hdr' | 'final-display';
}

async function renderSky(scenario: Scenario) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  const host = await constructRuntimeRendererHost(canvas);
  if (!host.ok) throw host.error;
  const { renderer } = host.value;
  const errors: unknown[] = [];
  const stop = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World();
  const assets = testAssets(world);
  const sun = rayAt(...SUN_PIXEL);
  const material = assets
    .create(Materials.standard({ baseColor: [0, 0, 0, 1], emissive: [1, 0, 0] }))
    .unwrap();
  const box = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  world
    .spawn(
      // A red box low on the left: the sky must never replace geometry.
      { component: Transform, data: { pos: [-2, -1.5, -3] } },
      { component: MeshFilter, data: { assetHandle: box } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          ...perspective({ fov: FOV, aspect: 1, near: 0.1, far: 100 }),
          tonemap: scenario.tonemap,
          exposure: 1.6,
          ...(scenario.bloom
            ? { bloom: BLOOM_ENABLED, bloomThreshold: 1, bloomIntensity: 0.8 }
            : {}),
          // Replaced by the sky; an opaque clear must not hide a display sky.
          clearColor: [1, 0, 1, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn(
      {
        component: GradientSky,
        data: { ...SKY, ...scenario.stops, toneMapped: scenario.toneMapped },
      },
      {
        component: DirectionalLight,
        data: { direction: sun.map((v) => -v), color: LIGHT_COLOR, intensity: 2 },
      },
    )
    .unwrap();
  if (scenario.fog)
    world
      .spawn({
        component: Fog,
        data: { color: FOG_COLOR, mode: FogModeValue.linear, near: 1, far: 3, maxOpacity: 0.9 },
      })
      .unwrap();
  const lease = value(renderer.attach(world));
  const domain = scenario.domain ?? (scenario.toneMapped ? 'linear-hdr' : 'final-display');
  try {
    const profile = renderer.setProfile({
      ...renderer.inspect().profile,
      renderPath: scenario.renderPath,
      ssao: false,
    });
    if (!profile.ok) throw profile.error;
    let receipt: Awaited<ReturnType<typeof drawReadyFrame>> | undefined;
    for (let frame = 0; frame < 60; frame++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      receipt = await drawReadyFrame(
        renderer,
        { leases: [lease], camera: { lease }, environment: { lease } },
        frame === 59 ? [domain] : undefined,
      );
    }
    if (receipt === undefined) throw new Error('GradientSky frame did not complete');
    const observed = value(await renderer.observe(receipt, { include: [domain] }));
    const observation = observed.observations?.find((value) => value.domain === domain);
    if (observation === undefined) throw new Error(`${domain} readback is missing`);
    expect(errors).toEqual([]);
    const { bytes, metadata } = observation;
    const bgra = metadata.format.startsWith('bgra');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (domain === 'final-display') await saveEvidence(scenario, bytes, metadata.bytesPerRow, bgra);
    // RGB plus alpha: HDR channels, or encoded 0-255 display bytes.
    return (px: number, py: number): readonly [number, number, number, number] => {
      if (domain === 'linear-hdr') {
        const offset = py * metadata.bytesPerRow + px * 8;
        return [0, 1, 2, 3].map((c) =>
          halfFloat.f16ToF32(view.getUint16(offset + c * 2, true)),
        ) as unknown as readonly [number, number, number, number];
      }
      const offset = py * metadata.bytesPerRow + px * 4;
      const [a = 0, g = 0, b = 0, alpha = 0] = bytes.subarray(offset, offset + 4);
      return bgra ? [b, g, a, alpha] : [a, g, b, alpha];
    };
  } finally {
    stop();
    lease.dispose();
    value(await renderer.dispose());
    canvas.remove();
  }
}

/** The encoded frame as a PNG under artifacts/, for visual review. */
async function saveEvidence(scenario: Scenario, bytes: Uint8Array, stride: number, bgra: boolean) {
  const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const source = y * stride + x * 4;
      const target = (y * SIZE + x) * 4;
      rgba[target] = bytes[source + (bgra ? 2 : 0)] ?? 0;
      rgba[target + 1] = bytes[source + 1] ?? 0;
      rgba[target + 2] = bytes[source + (bgra ? 0 : 2)] ?? 0;
      rgba[target + 3] = 255;
    }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  canvas.getContext('2d')?.putImageData(new ImageData(rgba, SIZE, SIZE), 0, 0);
  const name = `${scenario.renderPath}-${scenario.fog ? 'fog' : 'clear'}${scenario.stops ? '-three-stop' : ''}`;
  const png = canvas.toDataURL('image/png').split(',')[1] ?? '';
  await commands.writeFile(`artifacts/gradient-sky/${name}.png`, png, 'base64');
}

// Top centre (zenith side), upper and lower rows, below the horizon, near the sun.
const SAMPLES = [
  [32, 2],
  [10, 20],
  [32, 30],
  [32, 34],
  [56, 44],
  [32, 62],
  [40, 14],
] as const;

it.each([
  'forward',
  'deferred',
] as const)('shows the display-referred gradient and sun disc exactly as authored under ACES (%s)', {
  timeout: 180_000,
}, async (renderPath) => {
  const pixel = await renderSky({
    renderPath,
    toneMapped: false,
    tonemap: TONEMAP_ACES_FILMIC,
    fog: false,
  });
  const hue = LIGHT_COLOR.map((v) => (v / Math.max(...LIGHT_COLOR) + 1) / 2) as unknown as Rgb;
  for (const [px, py] of [...SAMPLES, SUN_PIXEL]) {
    const expected = expectedSky(rayAt(px, py), hue, undefined).map(encode);
    const actual = pixel(px, py);
    for (let c = 0; c < 3; c++)
      expect(Math.abs((actual[c] ?? 0) - (expected[c] ?? 0)), `${px},${py}[${c}]`).toBeLessThan(
        2.5,
      );
  }
  // The disc is the light hue at the sun pixel and absent on the far side.
  expect(pixel(...SUN_PIXEL)[0]).toBeGreaterThan(250);
  expect(pixel(16, SUN_PIXEL[1])[0]).toBeLessThan(200);
  // Geometry keeps its own tone-mapped shading: the red box, not the sky.
  const [r, g, b] = pixel(10, 52);
  expect(r).toBeGreaterThan(150);
  expect(r).toBeGreaterThan(2 * Math.max(g, b));
});

it('fades the display sky into the displayed Fog colour at and below the horizon', {
  timeout: 180_000,
}, async () => {
  const pixel = await renderSky({
    renderPath: 'forward',
    toneMapped: false,
    tonemap: TONEMAP_NONE,
    fog: true,
  });
  const hue = LIGHT_COLOR.map((v) => (v / Math.max(...LIGHT_COLOR) + 1) / 2) as unknown as Rgb;
  for (const [px, py] of SAMPLES) {
    const expected = expectedSky(rayAt(px, py), hue, { color: FOG_COLOR, opacity: 0.9 }).map(
      encode,
    );
    const actual = pixel(px, py);
    for (let c = 0; c < 3; c++)
      expect(Math.abs((actual[c] ?? 0) - (expected[c] ?? 0)), `${px},${py}[${c}]`).toBeLessThan(
        2.5,
      );
  }
  // Below the horizon the sky is the fog colour at the Fog's maxOpacity.
  const ground = expectedSky(rayAt(32, 62), hue, undefined);
  const fogged = pixel(32, 62);
  for (let c = 0; c < 3; c++) {
    const want = encode(0.9 * (FOG_COLOR[c] ?? 0) + 0.1 * (ground[c] ?? 0));
    expect(Math.abs((fogged[c] ?? 0) - want)).toBeLessThan(2.5);
  }
});

it('renders the toneMapped sky as HDR scene radiance with an intensity-scaled sun disc', {
  timeout: 180_000,
}, async () => {
  const pixel = await renderSky({
    renderPath: 'forward',
    toneMapped: true,
    tonemap: TONEMAP_ACES_FILMIC,
    fog: false,
  });
  const disc = LIGHT_COLOR.map((v) => (v / Math.max(...LIGHT_COLOR)) * 2 * 4) as unknown as Rgb;
  for (const [px, py] of [...SAMPLES, SUN_PIXEL]) {
    const expected = expectedSky(rayAt(px, py), disc, undefined);
    const actual = pixel(px, py);
    for (let c = 0; c < 3; c++)
      expect(actual[c] ?? 0, `${px},${py}[${c}]`).toBeCloseTo(expected[c] ?? 0, 1);
  }
  expect(pixel(...SUN_PIXEL)[0]).toBeGreaterThan(7);
});

it('blends horizon -> mid -> zenith when the middle stop is set', {
  timeout: 180_000,
}, async () => {
  const pixel = await renderSky({
    renderPath: 'forward',
    toneMapped: false,
    tonemap: TONEMAP_ACES_FILMIC,
    fog: false,
    stops: THREE_STOP,
  });
  const hue = LIGHT_COLOR.map((v) => (v / Math.max(...LIGHT_COLOR) + 1) / 2) as unknown as Rgb;
  for (const [px, py] of [...SAMPLES, [32, 24], [32, 18], [32, 10]] as const) {
    const expected = expectedSky(rayAt(px, py), hue, undefined, THREE_STOP).map(encode);
    const actual = pixel(px, py);
    for (let c = 0; c < 3; c++)
      expect(Math.abs((actual[c] ?? 0) - (expected[c] ?? 0)), `${px},${py}[${c}]`).toBeLessThan(
        2.5,
      );
  }
  // Near the middle stop the sky is the rose mid colour, not the two-stop mauve blend.
  const near = rayAt(32, 18);
  const twoStop = expectedSky(near, hue, undefined).map(encode);
  expect(Math.abs((pixel(32, 18)[1] ?? 0) - (twoStop[1] ?? 0))).toBeGreaterThan(10);
});

it('adds a blooming display sun disc to the HDR scene and shows its glow over the sky', {
  timeout: 180_000,
}, async () => {
  const base = {
    renderPath: 'forward',
    toneMapped: false,
    tonemap: TONEMAP_ACES_FILMIC,
    fog: false,
  } as const;
  // The HDR scene holds the disc as scene radiance (hue * intensity * 4) with
  // transparent alpha, so bloom spreads it and the display sky still fills it.
  const hdr = await renderSky({ ...base, bloom: true, domain: 'linear-hdr' });
  const [r, , , alpha] = hdr(...SUN_PIXEL);
  expect(r).toBeGreaterThan(4);
  expect(alpha).toBe(0);
  // Without bloom the HDR background holds nothing: the display sky stays as authored.
  const plain = await renderSky({ ...base, domain: 'linear-hdr' });
  expect(plain(...SUN_PIXEL)[0]).toBe(0);
  // Displayed: a pixel just outside the disc is brighter with bloom (the halo).
  const lit = await renderSky({ ...base, bloom: true });
  const unlit = await renderSky(base);
  const halo = [SUN_PIXEL[0] - 4, SUN_PIXEL[1] + 3] as const;
  const sum = (p: readonly number[]) => (p[0] ?? 0) + (p[1] ?? 0) + (p[2] ?? 0);
  expect(sum(lit(...halo))).toBeGreaterThan(sum(unlit(...halo)) + 20);
  // The glow falls off with distance from the disc, like the bloom of its reflection.
  const gain = (px: number, py: number) => sum(lit(px, py)) - sum(unlit(px, py));
  expect(gain(...halo)).toBeGreaterThan(2 * gain(10, 20));
});
