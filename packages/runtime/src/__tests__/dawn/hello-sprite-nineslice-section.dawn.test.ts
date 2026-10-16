import { shaderManifestUrl } from '../shader-manifest-url.fixture';
// hello-sprite-nineslice-section.dawn.test.ts -- feat-20260527-sprite-nineslice
// M3 / w14. dawn-node pixel-readback fixture asserting that the sprite 9-slice
// vertex-shader path treats `sliceMode=0` (stretch) and `sliceMode=1` (tile)
// distinctly. The fixture is BASELINE-FREE: no committed reference PNG. The
// falsifiable predicate is "stretch frame middle pixel != tile frame middle
// pixel" (i.e. the two modes produce visibly different mid-band geometry +
// UV mapping).
//
// Why baseline-free (charter P5):
//   - The forgeax-engine-assets submodule path is not initialised in every
//     worktree; depending on a pinned PNG would couple this dawn fixture to
//     the submodule update protocol and inflate verify cost.
//   - The shader behaviour difference is sharp: pre-w15 the shader IGNORES
//     `material.slicesAndMode` entirely (legacy `pos_local = (uv - pivot) *
//     size` runs unconditionally), so the two scenes are byte-identical and
//     the predicate fails RED. Post-w15 the vs_main 9-region map routes
//     stretch and tile through different UV anchors (tile outputs uv > 1
//     which the sampler.addressMode='repeat' wraps; plan-strategy §D-4),
//     so the middle-band pixels diverge and the predicate flips GREEN.
//
// Plan anchors:
//   - plan-strategy §5.1 M3 TDD red-then-green: w14 lands red (this file)
//     before w15 turns vs_main green.
//   - plan-strategy §D-4: tile path is sampler.addressMode='repeat' driven
//     -- the sprite pipeline's renderer-owned default sampler supplies the
//     repeat address mode, so the material contract does not carry a sampler
//     value of its own.
//   - requirements §AC-07: stretch + tile dual-mode pixel parity.
//   - requirements §AC-02: single sprite pipeline / single fragment entry --
//     the fixture binds two sprite entities through the SAME pipeline, no
//     `forgeax::sprite-nineslice` shader id leak.
//
// feat-20260625-refactor-sprite-as-transparent-mesh M4 / w16 — touched
// only the MaterialAsset literal: pass-side `transparent: true` flag
// (M2 / w6) + UBO-aligned `slicesAndMode` vec4 in values (M3 / w11).
// The mid-band divergence predicate is invariant under the F-4 unit-quad
// resize: both stretch and tile entities render at the same Transform.
// scale[xy] under unit-quad, so the rendered pixel sets remain pairwise
// comparable across the F-4 commit. AC-13 perf declaration: this fixture
// asserts only a byte-distance threshold > 16; perf is not bounded here.
//
// Two `it()` blocks render two single-entity scenes through the SAME engine
// (cheap shared-device path mirrors sprite-nineslice-mesh-bind.dawn.test.ts).
// Each scene captures the rendered RGBA, then the comparator across the two
// captured byte arrays asserts mid-band divergence.

import { AssetRegistry, HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../../renderer-host';
import { drawPublished } from '../draw-published';

const WIDTH = 64;
const HEIGHT = 64;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

// Windows Dawn first-touch construction for the two renderer/readback probes
// can exceed Vitest's project-wide 30-second timeout while still completing
// well inside the nightly platform budget. Keep this owner-specific gate
// bounded so a valid cold-start probe is not retried as a false failure.
const SPRITE_NINESLICE_DAWN_TEST_TIMEOUT_MS = 120_000;

// Distinctive 4x4 texture: corners RED (cells (0,0)/(3,0)/(0,3)/(3,3)),
// remaining cells BLUE. With slices=[0.25,0.25,0.25,0.25] in atlas-uv space
// the 4 corners line up with the 4 corner texels -- making the central band
// (uv in [0.25, 0.75]) entirely BLUE so the mid-band stretch vs tile
// divergence is mediated by uv > 1 wrapping (tile re-enters BLUE territory
// the same way stretch does for THIS texture choice; the divergence comes
// from the *position* mapping, not the colour). The predicate asserts that
// the rendered byte arrays for the two scenes differ in pixel-byte sum --
// when w15 lands, the middle-band positions remap (tile vs stretch take
// different pos_anchor curves) so the rendered pixels differ at row/col
// boundaries even with identical samples (anti-aliasing on the 4x4 grid
// boundary lines paints distinguishable edges).
function makeCornerCheckerTexture(): TextureAsset {
  const side = 4;
  const bytes = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const off = (y * side + x) * 4;
      const isCorner = (x === 0 || x === side - 1) && (y === 0 || y === side - 1);
      bytes[off + 0] = isCorner ? 255 : 0;
      bytes[off + 1] = 0;
      bytes[off + 2] = isCorner ? 0 : 255;
      bytes[off + 3] = 255;
    }
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: side, height: side } },
    format: 'rgba8unorm-srgb',
    colorSpace: 'srgb',
    mips: { kind: 'none' },
    data: bytes,
  };
}

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);

interface CapturedFrame {
  bytes: Uint8Array;
  bytesPerRow: number;
}

async function renderOneFrame(opts: {
  sliceMode: 0 | 1;
  scaleX: number;
  scaleY: number;
}): Promise<{ frame: CapturedFrame; errors: unknown[] }> {
  const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
  if (!dawnAvailable) {
    throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');
  }

  let sharedDevice: GPUDevice | undefined;
  const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
    globalThis.navigator.gpu,
  );
  globalThis.navigator.gpu.requestAdapter = async (a) => {
    const rawAdapter = await originalRequestAdapter(a);
    if (rawAdapter === null) return rawAdapter;
    const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
    rawAdapter.requestDevice = async (desc) => {
      const dev = await originalRequestDevice(desc);
      if (sharedDevice === undefined) sharedDevice = dev;
      return dev;
    };
    return rawAdapter;
  };

  let renderTarget: GPUTexture | undefined;
  const ensureRenderTarget = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
    if (renderTarget !== undefined) return renderTarget;
    renderTarget = device.createTexture({
      size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
      format,
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
      viewFormats: ['rgba8unorm-srgb'],
    });
    return renderTarget;
  };
  const mockCanvas = {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
          ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
        },
        unconfigure() {},
        getCurrentTexture(): GPUTexture {
          if (renderTarget === undefined) {
            if (sharedDevice === undefined)
              throw new Error('render target requested before device captured');
            return ensureRenderTarget(sharedDevice, 'rgba8unorm');
          }
          return renderTarget;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;

  let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>>;
  try {
    host = await constructRuntimeRendererHost(
      mockCanvas,
      {},
      {
        shaderManifestUrl: ENGINE_MANIFEST_URL,
      },
    );
  } finally {
    globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
  }
  expect(host.ok).toBe(true);
  if (!host.ok) throw host.error;
  const { renderer, assets } = host.value;
  expect(renderer.inspect().state).toBe('alive');
  expect(assets).toBeInstanceOf(AssetRegistry);

  const world = new World();

  const texAsset = makeCornerCheckerTexture();
  const texHandle = world.allocSharedRef<'TextureAsset', TextureAsset>('TextureAsset', texAsset);
  // D-4 explicit constraint: tile mode uses the sprite pipeline's shared
  // renderer-owned repeat sampler, so vertex-shader-emitted uv > 1 wraps via
  // the hardware sampler. Both scenes use that same configuration; the only
  // material-level difference is `sliceMode`.
  const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Sprite',
        program: { module: 'forgeax::sprite' },
        renderState: {
          ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
          queue: 3000,
          tags: { LightMode: 'Forward' },
        },
      },
    ],
    parameters: [
      { name: 'colorTint', type: 'color', default: [1, 1, 1, 1] },
      { name: 'region', type: 'vec4', default: [0, 0, 1, 1] },
      { name: 'pivotAndSize', type: 'vec4', default: [0.5, 0.5, 1, 1] },
      { name: 'slicesAndMode', type: 'vec4', default: [0, 0, 0, 0] },
      { name: 'baseColorTexture', type: 'texture', optional: true },
    ],
    values: {
      // feat-20260625 M3 / w11 (D-4): UBO-aligned field names. The
      // extract-stage backwards-compat fold (render-system-extract.ts
      // L2344) keeps the legacy `slices` + `sliceMode` split working for
      // unmigrated demos, but new tests declare the UBO-aligned
      // `slicesAndMode` vec4 directly: `.xyz` = [left, top, right] in UV,
      // `.w` carries the sliceMode sentinel (>=0 stretch, <0 tile).
      baseColorTexture: { texture: texHandle as unknown as never },
      slicesAndMode: [0.25, 0.25, 0.25, opts.sliceMode === 1 ? -0.25 : 0.25],
    },
  });

  const errors: unknown[] = [];
  renderer.subscribe((event) => {
    if (event.kind !== 'error') return;
    errors.push(event.error);
  });

  // ASYMMETRIC scale: x=4*y. Under uniform 9-slice mapping the corners stay
  // square so the central band is highly stretched; without 9-slice (legacy
  // path) the entire quad stretches as one. The asymmetry amplifies the
  // mid-band pixel divergence between the two modes after w15 lands.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 0],
        quat: [0, 0, 0, 1],
        scale: [opts.scaleX, opts.scaleY, 1],
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [matHandle] } },
  );
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 3],
        quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    },
    {
      component: Camera,
      data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 },
    },
  );

  const drawn = drawPublished(renderer, world);
  expect(drawn.ok).toBe(true);
  if (sharedDevice === undefined) throw new Error('device not captured');
  await sharedDevice.queue.onSubmittedWorkDone();

  const bytesPerPixel = 4;
  const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  const readbackBuffer = sharedDevice.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
  });
  if (renderTarget === undefined) throw new Error('renderTarget unset');
  const enc = sharedDevice.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  sharedDevice.queue.submit([enc.finish()]);
  await readbackBuffer.mapAsync(MAP_MODE_READ);
  const mapped = readbackBuffer.getMappedRange();
  const bytes = new Uint8Array(mapped.slice(0));
  readbackBuffer.unmap();
  readbackBuffer.destroy();

  return { frame: { bytes, bytesPerRow }, errors };
}

// Squared L2 distance between two captured frames over the central horizontal
// band (rows [HEIGHT*0.25, HEIGHT*0.75], all columns). Returns the sum of
// per-channel squared deltas in byte-space, divided by sample count to give
// an average. The predicate is "stretch and tile diverge in the centre band":
// pre-w15 the value is ~0 (frames byte-identical save for stochastic alpha
// blend rounding); post-w15 the value rises sharply because the mid-band
// pos_anchor mapping diverges between modes.
function midBandDistance(a: CapturedFrame, b: CapturedFrame): number {
  expect(a.bytesPerRow).toBe(b.bytesPerRow);
  const yStart = Math.floor(HEIGHT * 0.25);
  const yEnd = Math.ceil(HEIGHT * 0.75);
  let sum = 0;
  let count = 0;
  for (let y = yStart; y < yEnd; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const off = y * a.bytesPerRow + x * 4;
      const ar = a.bytes[off + 0] ?? 0;
      const ag = a.bytes[off + 1] ?? 0;
      const ab = a.bytes[off + 2] ?? 0;
      const br = b.bytes[off + 0] ?? 0;
      const bg = b.bytes[off + 1] ?? 0;
      const bb = b.bytes[off + 2] ?? 0;
      sum += (ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2;
      count += 3;
    }
  }
  return sum / count;
}

describe('feat-20260527-sprite-nineslice w14 dawn smoke (stretch vs tile divergence)', () => {
  it(
    'stretch + tile sprite frames diverge in the mid-band after w15 (red until w15 lands)',
    {
      timeout: SPRITE_NINESLICE_DAWN_TEST_TIMEOUT_MS,
    },
    async () => {
      // Asymmetric scale: x=4 vs y=1. With slices=[0.25,0.25,0.25,0.25] and the
      // 4x4 corner-checker texture, the post-w15 9-slice path keeps corner
      // zones at fixed world dimensions while the legacy pre-w15 path stretches
      // the entire quad linearly -- so post-w15 the rendered pixels in the
      // x-band differ between modes; pre-w15 the two scenes are byte-identical.
      const stretch = await renderOneFrame({ sliceMode: 0, scaleX: 4, scaleY: 1 });
      const tile = await renderOneFrame({ sliceMode: 1, scaleX: 4, scaleY: 1 });

      expect(stretch.errors).toEqual([]);
      expect(tile.errors).toEqual([]);

      const dist = midBandDistance(stretch.frame, tile.frame);

      // RED (pre-w15): the shader ignores `material.slicesAndMode` so both
      //   frames are byte-identical save for stochastic alpha-blend rounding;
      //   `dist` is < 1.0 and the assertion below FAILS.
      // GREEN (post-w15): vs_main routes stretch vs tile through different
      //   anchor-grid mappings; mid-band pixels differ noticeably; `dist`
      //   crosses 16 (i.e. roughly 4 byte-channel delta squared per channel
      //   averaged across the mid-band sample window).
      //
      // The threshold 16 is chosen so noise (rounding from premultiplied alpha
      // blend in srgb encoding) does not false-positive RED -> GREEN, while a
      // genuine 9-region remap easily clears it (mid-band re-routes hundreds
      // of pixels by tens of byte units each).
      expect(dist).toBeGreaterThan(16);
    },
    SPRITE_NINESLICE_DAWN_TEST_TIMEOUT_MS,
  );
});
