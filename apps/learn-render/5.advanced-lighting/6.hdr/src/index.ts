// apps/learn-render/5.advanced-lighting/6.hdr/src/index.ts
// LearnOpenGL section 5.6 - HDR.
//
// Two RenderPipelineAsset PODs, hot-swapped via `renderer.installPipeline`:
//   key '1' -> HDR pipeline (rgba16float offscreen + LO exposure tonemap)
//   key '2' -> LDR pipeline (rgba16float offscreen + passthrough; burns to
//                            white because the swap-chain rgba8unorm-srgb
//                            store clamps > 1.0 values to 1.0 -> the
//                            canonical LearnOpenGL 5.6 LDR teaching artefact)
//
// t9 spike: minimal scene (single cube) with the rgba16float offscreen +
// `_routeFromOpts: true` combination wired through the full five-step chain
// (postProcess.register x2 -> registerPipeline x2 -> assets.register x2 ->
// installPipeline). t11 will expand to the full LO 5.6 tunnel + 4 lights.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"            public engine API consumed
//   - "// 2. example-specific glue"   LO 5.6 scene constants + WGSL + chain
//   - "// 3. bootstrap"               entry point wiring + keydown HUD

// 1. engine usage
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { type App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { TONEMAP_NONE, perspective } from '@forgeax/engine-render';

import { Materials } from '@forgeax/engine-render';
import { PointLight, PostProcessParams } from '@forgeax/engine-render';

import { createBoxGeometry } from '@forgeax/engine-geometry';
import type { MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';
import { CAMERA_NEAR, CAMERA_POS_Z, TUNNEL_POS_Z, TUNNEL_SCALE_Z } from './tunnel-layout';
import {
  exposeLearnRenderTestApp,
  markLearnRenderTestBootstrapStage,
  trackLearnRenderTestBootstrap,
} from '../../../../shared/src/learn-render-test-lifecycle';
import {
  HDR_EXPOSURE_POSTPROCESS_ID,
  hdrDisplayNameByKey,
  hdrFeature,
  installHdrPipelineByKey,
  setHdrPipelineRegistryForTest,
  type HdrMode,
} from './hdr-pipeline';

// 2. example-specific glue



// LO exposure default value (LearnOpenGL section 5.6, default exposure=1.0).
// Grep-able constant so AI users land on the per-pixel exposure scalar.
const LO_EXPOSURE = 1.0;

// Q/E keyboard exposure tuning (feat-20260621 M-B2 / R-B5). Clamp lower bound
// strictly > 0 (exposure 0 would collapse exp(-c*0) to 0 -> black); upper bound
// kept reasonable so highlights still recover. Step per key event.
const EXPOSURE_MIN = 0.1;
const EXPOSURE_MAX = 10.0;
const EXPOSURE_STEP = 0.1;
let currentExposure = LO_EXPOSURE;
let currentMode: HdrMode = 'hdr';

// 16 B params UBO: [exposure(f32), mode(f32), pad, pad].
function packExposureBytes(exposure: number, mode: 0 | 1 = 0): Uint8Array {
  const buf = new ArrayBuffer(16);
  const values = new Float32Array(buf);
  values[0] = exposure;
  values[1] = mode;
  return new Uint8Array(buf);
}

// Texture GUID from forgeax-engine-assets/learn-opengl/textures/wood.png.meta.json
// Wood floor + walls cover the LO tunnel interior.
const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';

// LO 5.6 tunnel geometry. The LearnOpenGL HDR scene is a long
// rectangular corridor with a bright light at the far end + three weak
// coloured lights along the depth -- bright values exceed 1.0 in the
// rgba16float offscreen, exposing the LDR clamp under '2' and the LO
// exposure tonemap recovery under '1'.
const TUNNEL_SCALE_X = 5.0;
const TUNNEL_SCALE_Y = 5.0;

// 4 lights along the tunnel depth (camera at z=0, z=-50 = far end).
//
// feat-20260621 M-B1 (R-B1/R-B2): the overbright source is now PHYSICAL point
// lighting, faithful to LearnOpenGL section 5.6 -- a strong white PointLight at
// the far end illuminates the wood tunnel walls via inverse-square attenuation,
// pushing far-wall radiance > 1.0 in the rgba16float offscreen. The emissive
// light-box cubes are DEMOTED to mere position markers (emissiveIntensity well
// under 1.0): LO also draws a small light cube, but it is not the overbright
// source. AI-grep targets: `intensity: 200` (strong PointLight, far above the
// engine default of 1) + the demoted `LIGHT_BOX_EMISSIVE_INTENSITY`.
//
// Strong far-end PointLight: intensity ~200 + range ~60m. With the engine's
// KHR_lights_punctual quartic falloff `max(min(1-(d^2/range^2)^2,1),0)/max(d^2,1e-4)`,
// at the ~5m tunnel-wall distance this lands far-wall radiance well above 1.0
// (standard PBR evalPoint writes raw to rgba16float, no clamp) -- the physical
// prerequisite for the LDR-burn / HDR-recover contrast (R-B1, plan D-2).
const STRONG_LIGHT_INTENSITY = 200.0;
const STRONG_LIGHT_RANGE = 60.0;

// Weak coloured fill PointLights along the tunnel depth (LO uses similar
// coloured fills). intensity ~12, range ~20m -- visible colour cast without
// dominating the far-end overbright.
const WEAK_LIGHT_INTENSITY = 12.0;
const WEAK_LIGHT_RANGE = 20.0;

// Light-box emissive: DEMOTED to a dim position marker only (R-B2/AC-B4). Far
// below 1.0 so it never manufactures the overbright -- the PointLights do.
const LIGHT_BOX_EMISSIVE_INTENSITY = 0.4;

// Light positions (LO layout: one strong at far end + three weak fanned
// across the tunnel, each visible as a small emissive cube box).
const STRONG_LIGHT_POS: readonly [number, number, number] = [0.0, 0.0, -45.0];
const WEAK_LIGHT_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [-1.4, -1.9, -9.0],
  [0.0, -1.8, -4.0],
  [0.8, -1.7, -6.0],
];

// Light box (cube scaled small to visualise each PointLight).
const LIGHT_BOX_SCALE = 0.25;

// Strong light is white; weak lights are saturated R/G/B for visual
// distinction (LearnOpenGL uses similar coloured fills along the tunnel).
// PointLight.color is linear [0,1] per channel -- the magnitude comes from
// the intensity scalar, not from color values > 1 (those belong to emissive).
const STRONG_LIGHT_COLOR: readonly [number, number, number] = [1.0, 1.0, 1.0];
const WEAK_LIGHT_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [1.0, 0.0, 0.0], // red
  [0.0, 1.0, 0.0], // green
  [0.0, 0.0, 1.0], // blue
];

// First-person camera entry pose: looking down the tunnel along -Z.
const CAMERA_POS_X = 0.0;
const CAMERA_POS_Y = 0.0;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_FAR = 100.0;

// HDR (LO exposure tonemap) fragment shader. Implements the canonical
// LearnOpenGL section 5.6 equation:
//   mapped = 1.0 - exp(-hdrColor * exposure)
// (LearnOpenGL HDR chapter, https://learnopengl.com/Advanced-Lighting/HDR).
//
// AI-user teaching path:
//   1. The scene renders into 'offscreenHdr' (rgba16float) so per-channel
//      values can exceed 1.0 (bright lights are encoded raw).
//   2. This fullscreen pass samples that HDR target and folds the
//      exponential exposure tonemap; result is a [0..1] linear value
//      ready for the swap-chain.
//   3. The swap-chain 'rgba8unorm-srgb' view HW-encodes linear -> sRGB
//      on store. We deliberately do NOT apply pow(1/2.2) here -- doing
//      so would double-encode and produce a too-bright image. The
//      gamma-correction sibling demo 5.2 covers the gamma teaching
//      path explicitly (per plan-decisions D-7: this demo's job is the
//      HDR exposure curve, not the gamma encode).
//
// Forgeax production-grade equivalent: declare `Camera.tonemap =
// TONEMAP_REINHARD_EXTENDED` and let the URP default pipeline run
// `packages/shader/src/tonemap.wgsl`. This demo hand-rolls a tiny LO
// exposure tonemap so the teaching equation `exp(-hdrColor * exposure)`
// is grep-able alongside the per-mode pipeline registration (AC-11 anchor).
// The 7.bloom sibling demo (in this same feat) shows the production-grade
// `Camera.tonemap = TONEMAP_REINHARD_EXTENDED` field-driven path.
const HDR_LO_EXPOSURE_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}

// HDR exposure params UBO (16 B std140; feat-20260621 M-B2 data-driven channel).
// params.exposure occupies the first f32 slot; the rest is padding. The value
// is driven per-frame by the PostProcessParams ECS component (Q/E keyboard ->
// world.set -> extract snapshot -> engine queue.writeBuffer), NOT a hardcoded
// literal -- this dogfoods the unified post-process params channel (R-B3).
struct ExposureParams {
  exposure : f32,
  pad0 : f32,
  pad1 : f32,
  pad2 : f32,
};

@group(1) @binding(0) var hdrTexture : texture_2d<f32>;
@group(1) @binding(1) var hdrSampler : sampler;
@group(1) @binding(2) var<uniform> params : ExposureParams;

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let hdrColor = textureSample(hdrTexture, hdrSampler, in.uv).rgb;
  // LearnOpenGL section 5.6 EXACT exposure tonemap equation (R-B4):
  let mapped = vec3<f32>(1.0, 1.0, 1.0) - exp(-hdrColor * params.exposure);
  return vec4<f32>(mapped, 1.0);
}
`;

// LDR passthrough fragment shader. Reads the rgba16float offscreen and
// writes raw RGB to the swap-chain unchanged.
//
// LDR teaching artefact (intentional, plan-decisions D-1):
// values exceeding 1.0 in the rgba16float HDR offscreen stay raw through
// this passthrough; the swap-chain 'rgba8unorm-srgb' view's u8 store
// clamps `>1.0` channels to 1.0 (pure white) before the HW sRGB encode.
// This is the canonical LearnOpenGL 5.6 "burn to white" image: AI users
// press '2' to see HDR detail vanish into white blowouts where bright
// lights live, then press '1' to see exp(-hdrColor * exposure) recover
// shadow + highlight detail in one step.
const HDR_PASSTHROUGH_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}

@group(1) @binding(0) var hdrTexture : texture_2d<f32>;
@group(1) @binding(1) var hdrSampler : sampler;

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let hdrColor = textureSample(hdrTexture, hdrSampler, in.uv).rgb;
  return vec4<f32>(hdrColor, 1.0);
}
`;

void HDR_LO_EXPOSURE_WGSL;
void HDR_PASSTHROUGH_WGSL;

// Floats per procedural-mesh vertex (position3 + normal3 + uv2 + tangent4).
// createBoxGeometry emits this 12-float interleaved stride.
const FLOATS_PER_VERTEX = 12;
// Byte offsets of the normal x/y/z floats inside one 12-float vertex.
const NORMAL_FLOAT_OFFSET = 3;

// Return a copy of `mesh` with its surface turned inside-out: every normal is
// negated (so an enclosing box lights its INTERIOR -- the wall normals now face
// the tunnel axis where the point lights sit, giving NdotL > 0) and every
// triangle is re-wound (so the flipped faces still pass the pipeline-default
// `frontFace='ccw'` + `cullMode='back'` test when viewed from inside).
//
// Why this and not a renderState/cull tweak (verify round 1 V1 root cause): the
// standard PBR forward shader is single-sided -- `NdotL = max(dot(N,L), 0)`
// with no front-facing flip. The built-in cube (createBoxGeometry) has OUTWARD
// normals, so the camera-inside tunnel walls have normals pointing AWAY from
// the interior lights -> dot(N,L) < 0 -> diffuse+specular clamp to 0 -> black,
// under EVERY cull/frontFace combination (cull changes visibility, not
// lighting). Flipping the normals is the fix; the winding reversal keeps the
// now-inward faces visible under default back-face culling.
//
// Both the interleaved `vertices` buffer (the render-record consumer:
// GPU residency cache writeBuffer(vbo, 0, mesh.vertices)) AND the derived
// `attributes.normal` view are negated to keep them consistent (charter SSOT).
function negateInPlace(buf: Float32Array, start: number, count: number): void {
  for (let i = start; i < start + count; i++) {
    buf[i] = -(buf[i] as number);
  }
}

function invertMesh(mesh: MeshAsset): MeshAsset {
  const vertices = mesh.vertices.slice();
  for (let base = 0; base < vertices.length; base += FLOATS_PER_VERTEX) {
    negateInPlace(vertices, base + NORMAL_FLOAT_OFFSET, 3);
  }

  // createBoxGeometry emits a Float32Array normal attribute; narrow before the
  // numeric negate (VertexAttributeMap allows ArrayBuffer | Float32Array | ...).
  const srcNormal = mesh.attributes.normal;
  let normal: Float32Array | undefined;
  if (srcNormal instanceof Float32Array) {
    normal = srcNormal.slice();
    negateInPlace(normal, 0, normal.length);
  }

  const srcIndices = mesh.indices;
  if (srcIndices === undefined) {
    throw new Error('[learn-render 5.6 hdr] invertMesh requires an indexed mesh');
  }
  // Reverse triangle winding: swap the 2nd and 3rd index of every triangle.
  const indices = srcIndices.slice();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const tmp = indices[t + 1] as number;
    indices[t + 1] = indices[t + 2] as number;
    indices[t + 2] = tmp;
  }

  return {
    ...mesh,
    vertices,
    indices,
    attributes: normal === undefined ? mesh.attributes : { ...mesh.attributes, normal },
  };
}

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.6 hdr] missing <canvas id='app'> in index.html");
}

const bootstrapPromise = bootstrap(canvas);
trackLearnRenderTestBootstrap(bootstrapPromise, canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  markLearnRenderTestBootstrapStage(target, 'hdr.createApp');
  const appRes = await createApp(
    target,
    { features: [hdrFeature] },
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  markLearnRenderTestBootstrapStage(target, 'hdr.createApp.complete');
  if (!appRes.ok) {
    console.error('[learn-render 5.6 hdr] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  exposeLearnRenderTestApp(app, target);
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 5.6 hdr] app.onError:', error.code, error.hint);
    const bus = (
      globalThis as unknown as {
        __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __captureHdr?: () => Promise<Uint8Array>;
      }
    ).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });

  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 5.6 hdr] asset host unavailable');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  markLearnRenderTestBootstrapStage(target, 'hdr.assets.loadByGuid');

  // Wood texture for the tunnel walls + floor (inward-facing box interior;
  // see invertMesh below).
  const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
  if (!woodGuidRes.ok) {
    console.error('[learn-render 5.6 hdr] wood GUID parse failed');
    return;
  }
  const traceScope = globalThis as typeof globalThis & {
    __forgeaxAssetLoadTrace?: (event: {
      readonly phase: string;
      readonly at: number;
      readonly guid?: string;
      readonly packageUrl?: string;
      readonly artifactKey?: string;
      readonly detail?: Readonly<Record<string, unknown>>;
    }) => void;
  };
  const traceStartedAt = Date.now();
  const traceSink = (event: {
    readonly phase: string;
    readonly at: number;
    readonly guid?: string;
    readonly packageUrl?: string;
    readonly artifactKey?: string;
    readonly detail?: Readonly<Record<string, unknown>>;
  }): void => {
    const elapsedMs = Date.now() - traceStartedAt;
    console.info(
      `[learn-render 5.6 hdr] asset-load-phase ${JSON.stringify({ ...event, elapsedMs })}`,
    );
    markLearnRenderTestBootstrapStage(target, `hdr.assets.${event.phase}`);
  };
  traceScope.__forgeaxAssetLoadTrace = traceSink;
  let woodTexRes: Awaited<ReturnType<typeof assets.loadByGuid<TextureAsset>>>;
  try {
    woodTexRes = await assets.loadByGuid<TextureAsset>(woodGuidRes.value);
  } finally {
    if (traceScope.__forgeaxAssetLoadTrace === traceSink) {
      delete traceScope.__forgeaxAssetLoadTrace;
    }
  }
  markLearnRenderTestBootstrapStage(target, 'hdr.assets.loadByGuid.complete');
  if (!woodTexRes.ok) {
    console.error('[learn-render 5.6 hdr] wood loadByGuid failed:', woodTexRes.error.code);
    return;
  }
  const woodTex = woodTexRes.value;

  // Tunnel material: standard PBR wood baseColor, matte finish (rough +
  // non-metal) so the bright interior point lights paint clear highlights.
  const tunnelMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [1.0, 1.0, 1.0, 1.0],
      roughness: 0.85,
      metallic: 0.0,
      baseColorTexture: unwrapHandle(world.allocSharedRef('TextureAsset', woodTex)),
    }),
  );

  // Tunnel mesh = an INWARD-facing unit box (verify round 1 V1 fix). The camera
  // sits inside the box; the built-in HANDLE_CUBE has outward normals, so its
  // inner walls have normals pointing AWAY from the interior point lights and
  // the single-sided PBR shader (`NdotL = max(dot(N,L), 0)`) renders them black
  // under every cull/frontFace combination (the prior renderState/cull attempt
  // was misdiagnosed -- cull only affects visibility, not lighting). `invertMesh`
  // negates the wall normals so they face the tunnel axis (NdotL > 0 -> lit) and
  // re-winds the triangles so the now-inward faces survive default back-face
  // culling. The Transform scale (5x5x50) stretches the unit box into the LO 5.6
  // corridor; positive scale does not change normal direction.
  const tunnelMeshRes = createBoxGeometry(1, 1, 1);
  if (!tunnelMeshRes.ok) {
    console.error('[learn-render 5.6 hdr] createBoxGeometry failed:', tunnelMeshRes.error.code);
    return;
  }
  const tunnelMeshHandle = world.allocSharedRef('MeshAsset', invertMesh(tunnelMeshRes.value));
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, TUNNEL_POS_Z], scale: [TUNNEL_SCALE_X, TUNNEL_SCALE_Y, TUNNEL_SCALE_Z],},
      },
      { component: MeshFilter, data: { assetHandle: tunnelMeshHandle } },
      { component: MeshRenderer, data: { materials: [tunnelMat] } },
    )
    .unwrap();

  // Strong white PointLight at the far end of the tunnel (R-B1). intensity ~200
  // + range ~60m drives the wood far-wall radiance > 1.0 in the rgba16float
  // offscreen via inverse-square attenuation -- the physical overbright source
  // (NOT emissive self-illumination). The companion light-box cube is a dim
  // position marker (emissiveIntensity 0.4, well under 1.0; R-B2/AC-B4).
  const strongMarkerMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [1.0, 1.0, 1.0, 1.0],
      roughness: 0.4,
      emissive: STRONG_LIGHT_COLOR,
      emissiveIntensity: LIGHT_BOX_EMISSIVE_INTENSITY,
    }),
  );
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [STRONG_LIGHT_POS[0], STRONG_LIGHT_POS[1], STRONG_LIGHT_POS[2]], scale: [LIGHT_BOX_SCALE, LIGHT_BOX_SCALE, LIGHT_BOX_SCALE],},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [strongMarkerMat] } },
    )
    .unwrap();
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [STRONG_LIGHT_POS[0], STRONG_LIGHT_POS[1], STRONG_LIGHT_POS[2]],},
    },
    {
      component: PointLight,
      data: {
        color: [STRONG_LIGHT_COLOR[0], STRONG_LIGHT_COLOR[1], STRONG_LIGHT_COLOR[2]],
        intensity: STRONG_LIGHT_INTENSITY,
        range: STRONG_LIGHT_RANGE,
      },
    },
  );

  // Three weak coloured PointLights along the tunnel depth (R/G/B fill). Each
  // intensity ~12 + range ~20m casts a visible colour wash on the wood without
  // dominating the far-end overbright. The companion light-box cube is a dim
  // emissive marker (0.4, under 1.0) so the LDR mode preserves colour but only
  // burns to white at the strong far light (R-B2/AC-B4).
  for (let i = 0; i < WEAK_LIGHT_POSITIONS.length; i++) {
    const pos = WEAK_LIGHT_POSITIONS[i];
    const color = WEAK_LIGHT_COLORS[i];
    if (pos === undefined || color === undefined) continue;
    const weakMarkerMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      Materials.standard({
        baseColor: [1.0, 1.0, 1.0, 1.0],
        roughness: 0.4,
        emissive: color,
        emissiveIntensity: LIGHT_BOX_EMISSIVE_INTENSITY,
      }),
    );
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [pos[0], pos[1], pos[2]], scale: [LIGHT_BOX_SCALE, LIGHT_BOX_SCALE, LIGHT_BOX_SCALE],},
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [weakMarkerMat] } },
      )
      .unwrap();
    world.spawn(
      {
        component: Transform,
        data: { pos: [pos[0], pos[1], pos[2]]},
      },
      {
        component: PointLight,
        data: {
          color: [color[0], color[1], color[2]],
          intensity: WEAK_LIGHT_INTENSITY,
          range: WEAK_LIGHT_RANGE,
        },
      },
    );
  }

  // Camera. `tonemap = TONEMAP_REINHARD_EXTENDED` declares the HDR
  // geometry pipeline variant (plan-decisions D-2): in this demo we run
  // a custom RenderPipeline so the engine's URP tonemap pass does NOT
  // execute -- the only effect of this field is to flip the geometry
  // pipeline-variant cache to the HDR side (rgba16float-compatible
  // standard PBR variant). The actual tonemap is the LO exposure
  // fragment registered via postProcess.register below.
  //
  // bloom is intentionally OMITTED from the Camera spawn data (plan-
  // decisions D-7): our custom RenderPipeline does not emit the URP
  // bloom pass chain, so declaring `bloom = BLOOM_ENABLED` here would
  // be a phantom field. Compare with 7.bloom which does the opposite:
  // declares `bloom = BLOOM_ENABLED` to opt into the URP bloom chain
  // *because* it consumes the URP default pipeline.
  const cameraEntity = world
    .spawn(
      {
        component: Transform,
        data: { pos: [CAMERA_POS_X, CAMERA_POS_Y, CAMERA_POS_Z]},
      },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: CAMERA_FOV,
            aspect: target.width / target.height,
            near: CAMERA_NEAR,
            far: CAMERA_FAR,
          }),
          tonemap: TONEMAP_NONE,
        },
      },
    )
    .unwrap();

  // feat-20260621 M-B2 (R-B3): data-driven exposure. Spawn a PostProcessParams
  // entity keyed by the HDR exposure shader id; the live exposure (Q/E keyboard)
  // is packed into its `data` each change -> extract snapshot -> engine uploads
  // to the eager-created params UBO. No imperative setter (charter P4 / D-9).
  const exposureParamsEntity = world
    .spawn({
      component: PostProcessParams,
      data: { shader: HDR_EXPOSURE_POSTPROCESS_ID, data: packExposureBytes(LO_EXPOSURE) },
    })
    .unwrap();

  // First-person controls so AI users can walk down the tunnel and
  // compare HDR vs LDR detail at different distances from the strong
  // light.
  addFirstPersonSystem(app.world, {
    name: 'learn-render-5.6-first-person',
    overrideBackend: undefined,
  });

  setHdrPipelineRegistryForTest({
    setMode: (mode) => {
      currentMode = mode;
      world.set(exposureParamsEntity, PostProcessParams, {
        data: packExposureBytes(currentExposure, mode === 'hdr' ? 0 : 1),
      });
    },
  });

  markLearnRenderTestBootstrapStage(target, 'hdr.app.start');
  const startRes = app.start();
  markLearnRenderTestBootstrapStage(target, 'hdr.app.start.complete');
  if (!startRes.ok) {
    console.error('[learn-render 5.6 hdr] app.start failed:', startRes.error);
    return;
  }

  const initialInstall = installHdrPipelineByKey('1');
  if (!initialInstall.ok) return;

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    let activeKey: '1' | '2' = '1';
    // Live exposure (feat-20260621 M-B2 / R-B5/R-B6): Q lowers, E raises. The
    // value drives the PostProcessParams.data each change; HUD shows it live.
    let exposure = currentExposure;
    const hudElement = document.getElementById('hud');
    const renderHud = (): void => {
      if (hudElement === null) return;
      const displayName = hdrDisplayNameByKey(activeKey) ?? 'hdr';
      hudElement.innerText = `hdr: ${displayName} (exposure=${exposure.toFixed(2)}) | press 1 = HDR, 2 = LDR, Q/E = exposure -/+`;
    };
    renderHud();
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      const key = event.key;
      // Q/E exposure tuning (R-B5): does not collide with 1/2 (mode) or WASD +
      // mouse (first-person). Lower-cased so Shift-held still works.
      const lower = key.toLowerCase();
      if (lower === 'q' || lower === 'e') {
        const next = lower === 'e' ? exposure + EXPOSURE_STEP : exposure - EXPOSURE_STEP;
        exposure = Math.min(EXPOSURE_MAX, Math.max(EXPOSURE_MIN, next));
        currentExposure = exposure;
        // Data-driven update: write the new 16 B params into the component; the
        // engine uploads it to the eager-created UBO next frame (no setter).
        world.set(exposureParamsEntity, PostProcessParams, {
          data: packExposureBytes(exposure, currentMode === 'hdr' ? 0 : 1),
        });
        renderHud();
        return;
      }
      if (key === activeKey) return;
      const installResult = installHdrPipelineByKey(key);
      if (!installResult.ok) {
        if (installResult.error.code === 'unknown-hdr-key') return;
        console.error(
          '[learn-render 5.6 hdr] installHdrPipelineByKey failed:',
          installResult.error,
        );
        return;
      }
      activeKey = key as '1' | '2';
      renderHud();
    });
  }

  installCaptureHook(app, world, target);
  markLearnRenderTestBootstrapStage(target, 'hdr.bootstrap.complete');
}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + readPixels so the live canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world'], canvas: HTMLCanvasElement): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureHdr?: CaptureHook };
  const renderer = app.renderer;
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  win.__captureHdr = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const frame = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!frame.ok) throw frame.error;
    await renderer.observe(frame.value, { include: ['draws'] });
    const r = await captureCanvasPixels(canvas);
    if (!r.ok) {
      throw new Error(
        `[learn-render 5.6 hdr] canvas capture failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
