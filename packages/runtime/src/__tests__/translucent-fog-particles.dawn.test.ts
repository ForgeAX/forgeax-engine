import { mkdirSync, writeFileSync } from 'node:fs';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack';
import type { Renderer } from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  type EncodedTape,
  type FrameModel,
  openReplay,
  type RecorderAttachment,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import {
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
} from '@forgeax/engine-vfx';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { deviceOptionsForAdapter } from '../../../render/src/assembly/device-feature-admission';
import {
  type TranslucentFogComposition,
  translucentViewOffset,
} from '../../../render/src/record/view-ubo';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import {
  PANE_PIXEL,
  rayDistance,
  readRgba,
  renderFogFrames,
  spawnFogBackdrop,
  spawnUniformFog,
  TRANSLUCENT_FOG_COLOR,
  TRANSLUCENT_FOG_PANE_DISTANCE,
  TRANSLUCENT_FOG_SIZE,
  TRANSLUCENT_FOG_WALL_COLOR,
  TRANSLUCENT_FOG_WALL_DISTANCE,
  uniformFogOpacity,
} from './translucent-fog.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
const directory = 'artifacts/translucent-fog/dawn';
const PARTICLE_ALPHA = 0.5;
const TOLERANCE = 0.03;

type Rgb = readonly [number, number, number];
const lanes = [0, 1, 2] as const;
const map = (f: (lane: 0 | 1 | 2) => number): Rgb => [f(0), f(1), f(2)];

/**
 * One billboard at the pane distance, fogged per composition. The unfogged
 * frame isolates the particle's own premultiplied contribution `P` (its shader
 * shading is not part of the fog contract), so the fogged oracle only depends
 * on the analytic fog at the particle and wall depths:
 *
 * - alpha:    P * T_p + fog * (1 - T_p) * a + wall_f * (1 - a)
 * - additive: P * T_p + wall_f  (UE fades additive toward zero, not fog color)
 *
 * The falsifier is the pre-fix result: the particle composited unfogged and
 * then fogged at the wall depth by a post pass.
 */
function oracle(blend: 'alpha' | 'additive', unfogged: Rgb) {
  const [x, y] = PANE_PIXEL;
  const tp = 1 - uniformFogOpacity(rayDistance(TRANSLUCENT_FOG_PANE_DISTANCE, x, y));
  const tw = 1 - uniformFogOpacity(rayDistance(TRANSLUCENT_FOG_WALL_DISTANCE, x, y));
  const wall = TRANSLUCENT_FOG_WALL_COLOR;
  const fog = TRANSLUCENT_FOG_COLOR;
  const wallFogged = map((c) => wall[c] * tw + fog[c] * (1 - tw));
  const cover = blend === 'alpha' ? 1 - PARTICLE_ALPHA : 1;
  const particle = map((c) => unfogged[c] - wall[c] * cover);
  const inscatter = blend === 'alpha' ? PARTICLE_ALPHA : 0;
  return {
    particle,
    expected: map((c) => particle[c] * tp + fog[c] * (1 - tp) * inscatter + wallFogged[c] * cover),
    wallDepthFogged: map((c) => unfogged[c] * tw + fog[c] * (1 - tw)),
  };
}

function expectPixel(actual: Rgb, expected: Rgb, label: string): void {
  for (const c of lanes)
    expect(
      Math.abs(actual[c] - expected[c]),
      `${label}: ${JSON.stringify({ actual, expected })}`,
    ).toBeLessThan(TOLERANCE);
}

function boundViewOffset(work: FrameModel['works'][number]): number | undefined {
  const view = work.bindings.find((row) => row.groupIndex === 0 && row.binding === 0);
  return view === undefined ? undefined : (view.bufferOffset ?? 0) + (view.dynamicOffset ?? 0);
}

async function cookBillboard(material: AssetGuid, blend: 'alpha' | 'additive', size = 0.6) {
  const cooked = await cookParticleCodeEffect(
    {
      schemaVersion: 3,
      emitters: [
        {
          id: 'fog-particle',
          capacity: 1,
          backend: { required: 'gpu' },
          space: 'world',
          bounds: { kind: 'sphere', center: [0, 0, -TRANSLUCENT_FOG_PANE_DISTANCE], radius: 2 },
          simulationWhenCulled: 'pause',
          schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
          program: { module: 'fog-particle.wgsl' },
          renderers: [{ kind: 'billboard', material: AssetGuid.format(material), blend }],
        },
      ],
    },
    {
      'fog-particle.wgsl': {
        entry: `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(0.0, 0.0, -${TRANSLUCENT_FOG_PANE_DISTANCE.toFixed(1)});
  (*particle).color = vec4<f32>(1.0, 0.0, 0.0, ${PARTICLE_ALPHA.toFixed(2)});
  (*particle).sprite_size = vec2<f32>(${size.toFixed(2)}, ${size.toFixed(2)});
  (*particle).lifetime = 1000.0;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}`,
      },
    },
  );
  if (!cooked.ok) throw cooked.error;
  return cooked.value.asset;
}

function reverseZPerspective(): Float32Array {
  const focal = 1 / Math.tan(Math.PI / 8);
  const near = 0.1;
  const far = 100;
  return new Float32Array([
    focal,
    0,
    0,
    0,
    0,
    focal,
    0,
    0,
    0,
    0,
    near / (far - near),
    -1,
    0,
    0,
    (far * near) / (far - near),
    0,
  ]);
}

interface BillboardScene {
  readonly renderer: Renderer;
  readonly recorder: RecorderAttachment;
  readonly world: World;
}

/** One GPU billboard over the unfogged wall, drawn through a recording RHI. */
async function withBillboard(
  blend: 'alpha' | 'additive',
  size: number,
  run: (scene: BillboardScene) => Promise<void>,
): Promise<void> {
  const target = offscreenCanvas(TRANSLUCENT_FOG_SIZE);
  const recorder = attachRecorder(webgpu).unwrap();
  const vfx = createVfxRuntimeHost({
    camera: {
      read: () => ({
        position: new Float32Array([0, 0, 0]),
        right: new Float32Array([1, 0, 0]),
        up: new Float32Array([0, 1, 0]),
        viewProjection: reverseZPerspective(),
      }),
    },
  });
  const host = await constructRuntimeRendererHost(
    target.canvas,
    { rhi: recorder.backend.rhi, features: [vfx.feature] },
    { shaderManifestUrl: manifestUrl },
  );
  if (!host.ok) throw new Error(JSON.stringify(host.error));
  const { renderer, assets } = host.value;
  try {
    const material = AssetGuid.random();
    assets.catalog(material, createBuiltinMaterialAsset('unlit')).unwrap();
    const effect = await cookBillboard(material, blend, size);
    const world = new World();
    spawnFogBackdrop(world, false);
    (await vfx.attachWorld({ world, assets })).unwrap();
    world
      .spawn({
        component: ParticleEffectPlayer,
        data: {
          effect: world.allocSharedRef('ParticleEffectAsset', effect),
          playing: true,
          seed: 1,
          timeScale: 1,
        },
      })
      .unwrap();
    await run({ renderer, recorder, world });
  } finally {
    renderer.dispose();
    target.destroy();
    (await recorder.dispose()).unwrap();
  }
}

it.each([
  ['alpha', 'premultiplied'],
  ['additive', 'additive'],
] as const)(
  'fogs a %s GPU billboard at its own depth',
  {
    timeout: 180_000,
  },
  async (blend, composition: TranslucentFogComposition) => {
    mkdirSync(directory, { recursive: true });
    await withBillboard(blend, 0.6, async ({ renderer, recorder, world }) => {
      const unfoggedImage = await renderFogFrames(renderer, world, {
        path: 'forward',
        domain: 'linear-hdr',
        frames: 30,
      });
      const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
      expect(
        runtime.snapshot(),
        JSON.stringify(renderer.inspect().featureDiagnostics),
      ).toHaveLength(0);
      const unfogged = readRgba(unfoggedImage, PANE_PIXEL[0], PANE_PIXEL[1]);
      const { particle, expected, wallDepthFogged } = oracle(blend, unfogged);
      // The unfogged frame must show a real red particle over the wall; for alpha
      // it also recovers the coverage from the wall's blue lane.
      expect(particle[0], JSON.stringify(unfogged)).toBeGreaterThan(0.2);
      expect(Math.abs(particle[1]), JSON.stringify(unfogged)).toBeLessThan(TOLERANCE);
      expect(Math.abs(particle[2]), JSON.stringify(unfogged)).toBeLessThan(TOLERANCE);

      spawnUniformFog(world);
      let tape: EncodedTape | undefined;
      const foggedImage = await renderFogFrames(renderer, world, {
        path: 'forward',
        domain: 'linear-hdr',
        frames: 3,
        recorder,
        capture(value) {
          tape = value;
          writeFileSync(`${directory}/particle-${blend}.rhitape`, value.bytes);
        },
      });
      const fogged = readRgba(foggedImage, PANE_PIXEL[0], PANE_PIXEL[1]);
      expectPixel(fogged, expected, `${blend} particle live`);
      const falsifierGap = Math.max(...lanes.map((c) => Math.abs(fogged[c] - wallDepthFogged[c])));
      expect(falsifierGap).toBeGreaterThan(TOLERANCE * 4);

      // RHI Debug: the billboard draw runs after the opaque fog pass, binds the
      // View copy of its blend composition, and its fresh-device replay output
      // reproduces the oracle.
      if (tape === undefined) throw new Error('missing particle fog capture');
      const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
      const fragment = (work: FrameModel['works'][number]) =>
        work.pipeline.shaders.find((shader) => shader.stage === 'fragment')?.source ?? '';
      const fogWorks = model.works.filter((work) => fragment(work).includes('fog_view'));
      const drawWorks = model.works.filter((work) => fragment(work).includes('fn softParticle('));
      expect(fogWorks).toHaveLength(1);
      expect(drawWorks).toHaveLength(1);
      const [fogWork] = fogWorks;
      const [drawWork] = drawWorks;
      if (fogWork === undefined || drawWork === undefined) throw new Error('missing fog works');
      expect(fogWork.workIndex).toBeLessThan(drawWork.workIndex);
      expect(boundViewOffset(drawWork)).toBe(translucentViewOffset(composition));
      const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const device = (await adapter.requestDevice(deviceOptionsForAdapter(adapter))).unwrap();
      const replay = (
        await openReplay(decodeTape(tape.bytes).unwrap(), {
          device,
          createShaderModule: webgpu.createShaderModule,
        })
      ).unwrap();
      let replayed: Rgb;
      try {
        const attachment = (await replay.inspectWork(drawWork.workIndex, ['pixels'])).unwrap()
          .attachment;
        if (attachment === undefined) throw new Error('missing billboard replay output');
        expect(attachment.format).toBe('rgba16float');
        replayed = readRgba(
          {
            bytes: attachment.bytes,
            metadata: { format: 'rgba16float', bytesPerRow: TRANSLUCENT_FOG_SIZE * 8 },
          },
          PANE_PIXEL[0],
          PANE_PIXEL[1],
        );
      } finally {
        (await replay.dispose()).unwrap();
      }
      expectPixel(replayed, expected, `${blend} particle replay`);
      writeFileSync(
        `${directory}/particle-${blend}-evidence.json`,
        JSON.stringify(
          {
            backend: 'dawn',
            composition,
            viewOffset: boundViewOffset(drawWork),
            fogWorkIndex: fogWork.workIndex,
            drawWorkIndex: drawWork.workIndex,
            unfogged,
            live: fogged,
            replay: replayed,
            expected,
            wallDepthFogged,
          },
          null,
          2,
        ),
      );
    });
  },
);

it('shades a GPU billboard point-symmetrically about its center', {
  timeout: 180_000,
}, async () => {
  // The billboard shading is radial; any term keyed on the quad's corner UVs
  // (such as a fract() over uv.x + uv.y) shows up as a seam across the sprite
  // diagonal and breaks the point reflection through the screen center.
  await withBillboard('alpha', 1.4, async ({ renderer, world }) => {
    const image = await renderFogFrames(renderer, world, {
      path: 'forward',
      domain: 'linear-hdr',
      frames: 30,
    });
    const center = readRgba(image, PANE_PIXEL[0], PANE_PIXEL[1]);
    expect(center[0], JSON.stringify(center)).toBeGreaterThan(0.2);
    let worst = { gap: 0, x: 0, y: 0 };
    for (let y = 0; y < TRANSLUCENT_FOG_SIZE; y++)
      for (let x = 0; x < TRANSLUCENT_FOG_SIZE; x++) {
        const a = readRgba(image, x, y);
        const b = readRgba(image, TRANSLUCENT_FOG_SIZE - 1 - x, TRANSLUCENT_FOG_SIZE - 1 - y);
        const gap = Math.max(...lanes.map((c) => Math.abs(a[c] - b[c])));
        if (gap > worst.gap) worst = { gap, x, y };
      }
    expect(worst.gap, JSON.stringify(worst)).toBeLessThan(0.01);
  });
});
