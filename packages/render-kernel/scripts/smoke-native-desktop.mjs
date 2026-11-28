#!/usr/bin/env node
// Cross-platform (macOS Metal / Windows DX12 / Linux Vulkan) native desktop 3D qualification
// and benchmark for @forgeax/engine-render-kernel/native.
//
// Pipeline:
//   Pass 1: 1024x1024 depth32float directional shadow pass (depth-only 4-BGL PSO)
//   Pass 2: 1280x720 rgba16float HDR + depth32float forward lit + textured + PCF-shadowed 3D pass
//   Pass 3: Fullscreen ACES tonemap + sRGB encode directly to SURFACE_SWAPCHAIN_HANDLE (or offscreen in --headless)
//
// Exercises continuous partial change (5% rotating transforms + 1 material UBO edit per frame),
// live OS window resize (1280x720 -> 960x540), pixel witness assertions, and async OS render-thread telemetry.

import assert from 'node:assert/strict';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DELTA_FLAG_BASELINE,
  DRAW_FLAG_INSTANCING,
  LAYOUT_FAMILY_SCENE_4BGL,
  OBJ_FLAG_CAST_SHADOW,
  OBJ_FLAG_FRUSTUM_CULLED,
  OBJ_FLAG_VISIBLE,
  PASS_TAG_FORWARD_OPAQUE,
  PASS_TAG_SHADOW_DEPTH,
  RENDER_STATE_CULL_BACK,
  RENDER_STATE_DEPTH_LESS_EQUAL,
  RENDER_STATE_DEPTH_WRITE,
  SORT_MATERIAL_PSO,
  SURFACE_SWAPCHAIN_HANDLE,
  TEXTURE_FORMAT_DEPTH32_FLOAT,
  TEXTURE_FORMAT_RGBA8_UNORM,
  TEXTURE_FORMAT_RGBA16_FLOAT,
} from '../dist/index.mjs';
import { createNativeRenderKernel, isNativeRenderKernelAvailable } from '../dist/desktop/index.mjs';

const args = new Set(process.argv.slice(2));
const headless = args.has('--headless') || process.env.FORGEAX_NATIVE_DESKTOP_HEADLESS === '1';
const framesArg = process.argv.find((a) => a.startsWith('--frames='));
const totalFrames = framesArg ? Math.max(30, Number(framesArg.split('=')[1])) : 140;
const addonPathArg = process.argv.find((a) => a.startsWith('--addon='));
const addonPath = addonPathArg ? addonPathArg.slice('--addon='.length) : undefined;

if (!isNativeRenderKernelAvailable(addonPath)) {
  console.error('[render-kernel-desktop] Native addon not found. Build with: pnpm --filter @forgeax/engine-render-kernel build:native');
  process.exit(1);
}

// Column-major 4x4 matrix math helpers (WebGPU clip space z in [0, 1])
function mat4Perspective(fovRad, aspect, near, far) {
  const f = 1 / Math.tan(fovRad / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * nf, -1,
    0, 0, far * near * nf, 0,
  ]);
}

function mat4Ortho(l, r, b, t, n, f) {
  const lr = 1 / (l - r);
  const bt = 1 / (b - t);
  const nf = 1 / (n - f);
  return new Float32Array([
    -2 * lr, 0, 0, 0,
    0, -2 * bt, 0, 0,
    0, 0, nf, 0,
    (l + r) * lr, (t + b) * bt, n * nf, 1,
  ]);
}

function mat4LookAt(eye, target, up) {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  const zLen = Math.hypot(zx, zy, zz) || 1;
  zx /= zLen; zy /= zLen; zz /= zLen;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  const xLen = Math.hypot(xx, xy, xz) || 1;
  xx /= xLen; xy /= xLen; xz /= xLen;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function mat4Mul(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function writeTrs(out, offset, tx, ty, tz, sx, sy, sz, rotY) {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  out[offset + 0] = c * sx; out[offset + 1] = 0; out[offset + 2] = -s * sx; out[offset + 3] = 0;
  out[offset + 4] = 0;      out[offset + 5] = sy; out[offset + 6] = 0;       out[offset + 7] = 0;
  out[offset + 8] = s * sz; out[offset + 9] = 0; out[offset + 10] = c * sz;  out[offset + 11] = 0;
  out[offset + 12] = tx;    out[offset + 13] = ty; out[offset + 14] = tz;    out[offset + 15] = 1;
}

// Indexed unit cube with position (vec3), normal (vec3), uv (vec2) = 32 bytes/vertex
function buildCubeMesh() {
  const faces = [
    { n: [0, 0, 1],  v: [[-0.5,-0.5,0.5],[0.5,-0.5,0.5],[0.5,0.5,0.5],[-0.5,0.5,0.5]] },
    { n: [0, 0, -1], v: [[0.5,-0.5,-0.5],[-0.5,-0.5,-0.5],[-0.5,0.5,-0.5],[0.5,0.5,-0.5]] },
    { n: [1, 0, 0],  v: [[0.5,-0.5,0.5],[0.5,-0.5,-0.5],[0.5,0.5,-0.5],[0.5,0.5,0.5]] },
    { n: [-1, 0, 0], v: [[-0.5,-0.5,-0.5],[-0.5,-0.5,0.5],[-0.5,0.5,0.5],[-0.5,0.5,-0.5]] },
    { n: [0, 1, 0],  v: [[-0.5,0.5,0.5],[0.5,0.5,0.5],[0.5,0.5,-0.5],[-0.5,0.5,-0.5]] },
    { n: [0, -1, 0], v: [[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0.5,-0.5,0.5],[-0.5,-0.5,0.5]] },
  ];
  const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const verts = new Float32Array(24 * 8);
  const idx = new Uint16Array(36);
  let vo = 0;
  let io = 0;
  for (let f = 0; f < 6; f++) {
    const face = faces[f];
    const base = f * 4;
    for (let i = 0; i < 4; i++) {
      verts[vo++] = face.v[i][0]; verts[vo++] = face.v[i][1]; verts[vo++] = face.v[i][2];
      verts[vo++] = face.n[0];    verts[vo++] = face.n[1];    verts[vo++] = face.n[2];
      verts[vo++] = uvs[i][0];    verts[vo++] = uvs[i][1];
    }
    idx[io++] = base; idx[io++] = base + 1; idx[io++] = base + 2;
    idx[io++] = base; idx[io++] = base + 2; idx[io++] = base + 3;
  }
  return { verts, idx };
}

function makeCheckerTexture(size, colorA, colorB) {
  const data = new Uint8Array(size * size * 4);
  const tile = Math.max(1, size >> 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = (((x / tile) | 0) + ((y / tile) | 0)) % 2 === 0 ? colorA : colorB;
      const off = (y * size + x) * 4;
      data[off] = c[0]; data[off + 1] = c[1]; data[off + 2] = c[2]; data[off + 3] = 255;
    }
  }
  return data;
}

const WGSL_SHADOW_DEPTH = `
struct ViewUniform {
  view_proj: mat4x4<f32>,
  light_vp: mat4x4<f32>,
  camera_pos: vec4<f32>,
  ambient: vec4<f32>,
};
struct SceneObjectGpu {
  world: mat4x4<f32>,
  params0: vec4<f32>,
  params1: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u_view: ViewUniform;
@group(2) @binding(0) var<storage, read> s_objects: array<SceneObjectGpu>;
@group(3) @binding(0) var<storage, read> s_instance_rows: array<u32>;

@vertex
fn vs_shadow(
  @location(0) pos: vec3<f32>,
  @builtin(instance_index) inst: u32,
) -> @builtin(position) vec4<f32> {
  let obj = s_objects[s_instance_rows[inst]];
  return u_view.light_vp * (obj.world * vec4<f32>(pos, 1.0));
}
`;

const WGSL_3D_PBR_SHADOW = `
struct ViewUniform {
  view_proj: mat4x4<f32>,
  light_vp: mat4x4<f32>,
  camera_pos: vec4<f32>,
  ambient: vec4<f32>,
};
struct MaterialUniform {
  albedo: vec4<f32>,
  roughness_metallic: vec4<f32>,
};
struct SceneObjectGpu {
  world: mat4x4<f32>,
  params0: vec4<f32>,
  params1: vec4<f32>,
};
struct SceneLightGpu {
  position_range: vec4<f32>,
  direction_intensity: vec4<f32>,
  color_outer_cos: vec4<f32>,
  flags_meta: vec4<u32>,
};

@group(0) @binding(0) var<uniform> u_view: ViewUniform;
@group(1) @binding(0) var<uniform> u_mat: MaterialUniform;
@group(1) @binding(1) var t_albedo: texture_2d<f32>;
@group(1) @binding(2) var s_albedo: sampler;
@group(2) @binding(0) var<storage, read> s_objects: array<SceneObjectGpu>;
@group(2) @binding(1) var<storage, read> s_lights: array<SceneLightGpu>;
@group(2) @binding(2) var t_shadow: texture_depth_2d;
@group(2) @binding(3) var s_shadow: sampler_comparison;
@group(3) @binding(0) var<storage, read> s_instance_rows: array<u32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) world_pos: vec3<f32>,
  @location(1) world_n: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

@vertex
fn vs_main(
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @builtin(instance_index) inst: u32,
) -> VsOut {
  let obj = s_objects[s_instance_rows[inst]];
  let wp = obj.world * vec4<f32>(pos, 1.0);
  var out: VsOut;
  out.pos = u_view.view_proj * wp;
  out.world_pos = wp.xyz;
  out.world_n = normalize((obj.world * vec4<f32>(normal, 0.0)).xyz);
  out.uv = uv;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let light = s_lights[0];
  let n = normalize(in.world_n);
  let l = normalize(-light.direction_intensity.xyz);
  let v = normalize(u_view.camera_pos.xyz - in.world_pos);
  let h = normalize(l + v);

  let shadow_clip = u_view.light_vp * vec4<f32>(in.world_pos + n * 0.04, 1.0);
  let shadow_ndc = shadow_clip.xyz / shadow_clip.w;
  let shadow_uv = vec2<f32>(shadow_ndc.x * 0.5 + 0.5, 0.5 - shadow_ndc.y * 0.5);
  let in_bounds = shadow_uv.x >= 0.0 && shadow_uv.x <= 1.0 && shadow_uv.y >= 0.0 && shadow_uv.y <= 1.0 && shadow_ndc.z >= 0.0 && shadow_ndc.z <= 1.0;
  let shadow_sample = textureSampleCompare(t_shadow, s_shadow, clamp(shadow_uv, vec2<f32>(0.0), vec2<f32>(1.0)), shadow_ndc.z - 0.002);
  let shadow = select(1.0, shadow_sample, in_bounds);

  let tex = textureSample(t_albedo, s_albedo, in.uv).rgb;
  let base = tex * u_mat.albedo.rgb;
  let ndotl = max(dot(n, l), 0.0);
  let spec_pow = mix(8.0, 96.0, 1.0 - clamp(u_mat.roughness_metallic.x, 0.05, 1.0));
  let spec = pow(max(dot(n, h), 0.0), spec_pow) * (0.15 + 0.6 * u_mat.roughness_metallic.y);
  let direct = (base * ndotl + vec3<f32>(spec)) * light.color_outer_cos.rgb * light.direction_intensity.w * shadow;
  let color = base * u_view.ambient.rgb + direct;
  return vec4<f32>(color, 1.0);
}
`;

const WGSL_TONEMAP_ACES = `
@group(0) @binding(0) var t_hdr: texture_2d<f32>;
@group(0) @binding(1) var s_hdr: sampler;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var uv = array<vec2<f32>, 3>(vec2(0.0, 1.0), vec2(2.0, 1.0), vec2(0.0, -1.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[idx], 0.0, 1.0);
  o.uv = uv[idx];
  return o;
}
fn aces(x: vec3<f32>) -> vec3<f32> {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let hdr = textureSample(t_hdr, s_hdr, in.uv).rgb;
  let mapped = pow(aces(hdr), vec3<f32>(1.0 / 2.2));
  return vec4<f32>(mapped, 1.0);
}
`;

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
};

const kernel = createNativeRenderKernel({
  maxInFlight: 2,
  ...(addonPath ? { addonPath } : {}),
  ...(headless ? {} : { window: { title: 'ForgeAX Native RenderKernel Desktop (wgpu 30)', width: 1280, height: 720 } }),
}).unwrap();

try {
  const initStats = kernel.getThreadStats().unwrap();
  const [winW, winH] = headless ? [1280, 720] : kernel.getWindowPhysicalSize().unwrap();
  let surfaceWidth = Math.max(1, winW || 1280);
  let surfaceHeight = Math.max(1, winH || 720);

  const { verts, idx } = buildCubeMesh();
  const cubeMesh = kernel.assets.createMesh(
    { vertexLayoutId: 3, vertexCount: 24, indexCount: 36, isUint32Index: false, label: 'cube' },
    new Uint8Array(verts.buffer),
    new Uint8Array(idx.buffer),
  ).unwrap();

  const sampler = kernel.assets.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  }).unwrap();
  const postSampler = kernel.assets.createSampler({ magFilter: 'linear', minFilter: 'linear' }).unwrap();

  const textures = [
    makeCheckerTexture(64, [235, 90, 75], [160, 45, 40]),
    makeCheckerTexture(64, [80, 175, 240], [35, 95, 160]),
    makeCheckerTexture(64, [110, 220, 120], [50, 130, 65]),
    makeCheckerTexture(64, [235, 200, 95], [175, 145, 60]),
    makeCheckerTexture(64, [185, 190, 200], [140, 145, 155]), // ground
  ].map((bytes, i) =>
    kernel.assets.createTexture(
      { width: 64, height: 64, format: TEXTURE_FORMAT_RGBA8_UNORM, usage: 0x04 | 0x02, label: `checker-${i}` },
      bytes,
    ).unwrap(),
  );

  const vertexLayout = [
    {
      arrayStride: 32,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x2' },
      ],
    },
  ];

  const shadowShader = kernel.assets.registerShaderProgram({
    code: WGSL_SHADOW_DEPTH,
    vertexEntryPoint: 'vs_shadow',
    layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
    vertexBufferLayouts: vertexLayout,
    colorFormats: [],
    depthFormat: 'depth32float',
    label: 'shadow-depth-4bgl',
  }).unwrap();

  const litShader = kernel.assets.registerShaderProgram({
    code: WGSL_3D_PBR_SHADOW,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
    vertexBufferLayouts: vertexLayout,
    colorFormats: ['rgba16float'],
    depthFormat: 'depth32float',
    label: 'pbr-shadow-4bgl',
  }).unwrap();

  const tonemapShader = kernel.assets.registerShaderProgram({
    code: WGSL_TONEMAP_ACES,
    layoutFamilyId: 0,
    colorFormats: headless ? ['rgba8unorm'] : [initStats.surfaceFormat ?? 'bgra8unorm'],
    label: 'tonemap-aces',
  }).unwrap();

  const tonemapWitnessShader = kernel.assets.registerShaderProgram({
    code: WGSL_TONEMAP_ACES,
    layoutFamilyId: 0,
    colorFormats: ['rgba8unorm'],
    label: 'tonemap-witness',
  }).unwrap();

  const stateBits = RENDER_STATE_DEPTH_WRITE | RENDER_STATE_DEPTH_LESS_EQUAL | RENDER_STATE_CULL_BACK;
  const cubeMaterials = [0, 1, 2, 3].map((i) =>
    kernel.assets.createMaterial(
      {
        shaderProgramId: litShader,
        layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
        renderStateBits: stateBits,
        queue: 1000,
        baseColorTextureId: textures[i],
        samplerId: sampler,
        label: `mat-cube-${i}`,
      },
      new Uint8Array(new Float32Array([1, 1, 1, 1, 0.25 + i * 0.2, 0.2 + i * 0.15, 0, 0]).buffer),
    ).unwrap(),
  );
  const groundMaterial = kernel.assets.createMaterial(
    {
      shaderProgramId: litShader,
      layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
      renderStateBits: stateBits,
      queue: 1000,
      baseColorTextureId: textures[4],
      samplerId: sampler,
      label: 'mat-ground',
    },
    new Uint8Array(new Float32Array([0.95, 0.95, 0.98, 1, 0.85, 0.0, 0, 0]).buffer),
  ).unwrap();

  // Build 1,000 cubes + 1 ground plane (1,001 scene objects total)
  const cubeCount = 1000;
  const totalCount = cubeCount + 1;
  const objs = [];
  const ids = [];
  const mats = new Float32Array(totalCount * 16);

  // Object 1: ground plane
  objs.push({
    objectId: 1,
    meshId: cubeMesh,
    materialId: groundMaterial,
    queue: 1000,
    objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_CAST_SHADOW | OBJ_FLAG_FRUSTUM_CULLED,
    localBoundsMin: [-0.5, -0.5, -0.5],
    localBoundsMax: [0.5, 0.5, 0.5],
  });
  ids.push(1);
  writeTrs(mats, 0, 0, -0.5, 0, 60, 1, 60, 0);

  // Objects 2..1001: 32x32 grid of 3D cubes casting shadows on the ground
  const gridSide = Math.ceil(Math.sqrt(cubeCount));
  for (let i = 0; i < cubeCount; i++) {
    const oid = i + 2;
    const gx = (i % gridSide) - gridSide / 2;
    const gz = Math.floor(i / gridSide) - gridSide / 2;
    objs.push({
      objectId: oid,
      meshId: cubeMesh,
      materialId: cubeMaterials[i % 4],
      queue: 1000,
      objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_CAST_SHADOW | OBJ_FLAG_FRUSTUM_CULLED,
      localBoundsMin: [-0.5, -0.5, -0.5],
      localBoundsMax: [0.5, 0.5, 0.5],
    });
    ids.push(oid);
    writeTrs(mats, (i + 1) * 16, gx * 1.4, 0.6 + (i % 3) * 0.35, gz * 1.4, 0.85, 1.2, 0.85, i * 0.13);
  }

  const lightDir = [-0.55, -0.8, -0.45];
  const lLen = Math.hypot(...lightDir);
  const normLightDir = [lightDir[0] / lLen, lightDir[1] / lLen, lightDir[2] / lLen];
  const lightVp = mat4Mul(
    mat4Ortho(-28, 28, -28, 28, 1, 90),
    mat4LookAt([24, 34, 20], [0, 0, 0], [0, 1, 0]),
  );

  const baseline = kernel.beginSceneDelta(256 * 1024);
  baseline
    .reset(1, 1, 0, DELTA_FLAG_BASELINE)
    .upsertObjects(objs)
    .setTransforms(ids, mats)
    .setLights([
      {
        lightId: 1,
        kind: 0,
        castShadow: true,
        cascadeCount: 1,
        position: [24, 34, 20],
        direction: normLightDir,
        color: [1.0, 0.97, 0.92],
        intensity: 1.6,
      },
    ]);
  assert.equal(kernel.commitSceneDelta(baseline).unwrap(), 1);

  const viewUbo = new Float32Array(40); // 160 bytes: view_proj(16) + light_vp(16) + cam_pos(4) + ambient(4)
  const viewUboBytes = new Uint8Array(viewUbo.buffer);

  function fillViewUbo(angle, aspect) {
    const camPos = [Math.sin(angle) * 24, 14, Math.cos(angle) * 24];
    const vp = mat4Mul(mat4Perspective(Math.PI / 4, aspect, 0.2, 160), mat4LookAt(camPos, [0, 0.5, 0], [0, 1, 0]));
    viewUbo.set(vp, 0);
    viewUbo.set(lightVp, 16);
    viewUbo.set([camPos[0], camPos[1], camPos[2], 1], 32);
    viewUbo.set([0.16, 0.19, 0.24, 1], 36);
    return { vp, camPos };
  }

  // 1. Deterministic synchronous pixel witness frame (proves shadow + depth + textures + tonemap!)
  {
    const { vp, camPos } = fillViewUbo(0.45, 16 / 9);
    const rec = kernel.beginFrame(1, 640, 360).unwrap();
    const vSlice = rec.writeUniform(viewUboBytes);
    const shadowCull = kernel.cull({ viewProj: lightVp, cameraPos: [24, 34, 20] }).unwrap();
    const mainCull = kernel.cull({ viewProj: vp, cameraPos: camPos }).unwrap();
    assert(shadowCull.visibleShadowCasterCount > 500, 'shadow cull must find visible casters');
    assert(mainCull.visibleOpaqueCount > 200, 'main cull must find visible 3D cubes');

    const shadowDepth = rec.acquireTempTexture(TEXTURE_FORMAT_DEPTH32_FLOAT, 1024, 1024, 1, 1, 1, 0x14);
    const hdrColor = rec.acquireTempTexture(TEXTURE_FORMAT_RGBA16_FLOAT, 640, 360, 1, 1, 1, 0x14);
    const mainDepth = rec.acquireTempTexture(TEXTURE_FORMAT_DEPTH32_FLOAT, 640, 360, 1, 1, 1, 0x10);
    const witnessOut = rec.acquireTempTexture(TEXTURE_FORMAT_RGBA8_UNORM, 640, 360, 1, 1, 1, 0x11);

    // Pass 1: shadow depth
    rec.beginRenderPass({
      labelId: 1,
      colorAttachments: [],
      depthAttachment: { texture: shadowDepth, loadOp: 'clear', storeOp: 'store', clearDepth: 1.0 },
    });
    rec.drawRenderers({
      cullId: shadowCull.cullId,
      passTag: PASS_TAG_SHADOW_DEPTH,
      sortMode: SORT_MATERIAL_PSO,
      drawFlags: DRAW_FLAG_INSTANCING,
      queueMin: 0,
      queueMax: 2500,
      viewUniformOffset: vSlice.offset,
      viewUniformLength: vSlice.length,
      overrideShader: shadowShader,
      passAttachmentId: 1,
    });
    rec.endRenderPass();

    // Pass 2: 3D HDR + depth + shadow-map sampling
    const shadowBind = rec.beginBindingSet().bindTexture(0, shadowDepth).finish();
    rec.beginRenderPass({
      labelId: 2,
      colorAttachments: [{ texture: hdrColor, clearColor: [0.06, 0.11, 0.2, 1] }],
      depthAttachment: { texture: mainDepth, loadOp: 'clear', storeOp: 'discard', clearDepth: 1.0 },
    });
    rec.drawRenderers({
      cullId: mainCull.cullId,
      passTag: PASS_TAG_FORWARD_OPAQUE,
      sortMode: SORT_MATERIAL_PSO,
      drawFlags: DRAW_FLAG_INSTANCING,
      queueMin: 0,
      queueMax: 2500,
      viewUniformOffset: vSlice.offset,
      viewUniformLength: vSlice.length,
      extraBindings: shadowBind,
      passAttachmentId: 2,
    });
    rec.endRenderPass();

    // Pass 3: fullscreen ACES tonemap
    const postBind = rec.beginBindingSet().bindTexture(0, hdrColor).bindSampler(1, postSampler).finish();
    rec.beginRenderPass({
      labelId: 3,
      colorAttachments: [{ texture: witnessOut, clearColor: [0, 0, 0, 1] }],
    });
    rec.drawFullscreen(tonemapWitnessShader, postBind);
    rec.endRenderPass();

    const receipt = kernel.submitFrame(rec).unwrap();
    assert.equal(receipt.executedPasses, 3);
    const rb = kernel.readbackPoolTexture(4).unwrap();
    assert.equal(rb.width, 640);
    assert.equal(rb.height, 360);
    let nonSkyPixels = 0;
    let brightPixels = 0;
    let darkGroundOrShadowPixels = 0;
    const skyR = rb.pixels[0];
    const skyG = rb.pixels[1];
    const skyB = rb.pixels[2];
    for (let i = 0; i < rb.pixels.length; i += 4) {
      const r = rb.pixels[i];
      const g = rb.pixels[i + 1];
      const b = rb.pixels[i + 2];
      const lum = (r * 0.299 + g * 0.587 + b * 0.114);
      if (Math.abs(r - skyR) + Math.abs(g - skyG) + Math.abs(b - skyB) > 20) nonSkyPixels++;
      if (lum > 140) brightPixels++;
      if (lum > 20 && lum < 80) darkGroundOrShadowPixels++;
    }
    assert(nonSkyPixels > 40000, `expected rendered 3D geometry pixels, got ${nonSkyPixels}`);
    assert(brightPixels > 5000, `expected lit highlights, got ${brightPixels}`);
    assert(darkGroundOrShadowPixels > 2000, `expected shadowed/shaded variance, got ${darkGroundOrShadowPixels}`);
  }

  // Let OS window manager (macOS WindowServer / Win32 DWM) expose the window before presenting.
  if (!headless) {
    for (let i = 0; i < 10; i++) {
      kernel.pollWindowEvents().unwrap();
      await delay(10);
    }
    const [pw, ph] = kernel.getWindowPhysicalSize().unwrap();
    if (pw > 0 && ph > 0) {
      surfaceWidth = pw;
      surfaceHeight = ph;
    }
  }

  // 2. Async pipelined continuous partial-change 3-pass loop (presenting directly to native swapchain!)
  const editN = 50; // 5% rotating partial transform edits per frame
  const editIds = new Uint32Array(editN);
  const editMats = new Float32Array(editN * 16);
  const matParamScratch = new Float32Array(8);
  const deltaWriter = kernel.beginSceneDelta(16 * 1024);

  const mainThreadTimes = [];
  const wallStart = performance.now();
  let resizedOnce = false;
  let frameNum = 2;

  for (let f = 0; f < totalFrames; f++, frameNum++) {
    if (!headless) {
      const events = kernel.pollWindowEvents().unwrap();
      for (const ev of events) {
        if (ev.kind === 'resized' && ev.width > 0 && ev.height > 0) {
          surfaceWidth = ev.width;
          surfaceHeight = ev.height;
        }
      }
      // Exercise live OS window + swapchain resize mid-flight!
      if (!resizedOnce && f === Math.floor(totalFrames * 0.75)) {
        resizedOnce = true;
        kernel.resizeWindow(960, 540).unwrap();
        kernel.pollWindowEvents().unwrap();
        const [nw, nh] = kernel.getWindowPhysicalSize().unwrap();
        if (nw > 0 && nh > 0) {
          surfaceWidth = nw;
          surfaceHeight = nh;
        }
      }
    }

    // 5% rotating cube transforms + 1 dynamic material update every frame
    const startIdx = (f * editN) % cubeCount;
    for (let k = 0; k < editN; k++) {
      const idxCube = (startIdx + k) % cubeCount;
      editIds[k] = idxCube + 2;
      const gx = (idxCube % gridSide) - gridSide / 2;
      const gz = Math.floor(idxCube / gridSide) - gridSide / 2;
      const bob = 0.6 + (idxCube % 3) * 0.35 + Math.sin(f * 0.08 + k) * 0.3;
      writeTrs(editMats, k * 16, gx * 1.4, bob, gz * 1.4, 0.85, 1.2, 0.85, f * 0.05 + idxCube * 0.13);
    }
    const tint = 0.85 + 0.15 * Math.sin(f * 0.1);
    matParamScratch.set([tint, 0.95, 1.0, 1.0, 0.3, 0.35, 0, 0]);
    deltaWriter
      .reset(1, f + 2, f + 1, 0)
      .setTransforms(editIds, editMats, editN)
      .updateMaterialParams(cubeMaterials[f % 4], 0, new Uint8Array(matParamScratch.buffer));

    const { vp, camPos } = fillViewUbo(0.45 + f * 0.015, surfaceWidth / surfaceHeight);

    const t0 = performance.now();
    const rec = kernel.preparePipelinedRecorder(frameNum, surfaceWidth, surfaceHeight);
    const vSlice = rec.writeUniform(viewUboBytes);
    const shadowDepth = rec.acquireTempTexture(TEXTURE_FORMAT_DEPTH32_FLOAT, 1024, 1024, 1, 1, 1, 0x14);
    const hdrColor = rec.acquireTempTexture(TEXTURE_FORMAT_RGBA16_FLOAT, surfaceWidth, surfaceHeight, 1, 1, 1, 0x14);
    const mainDepth = rec.acquireTempTexture(TEXTURE_FORMAT_DEPTH32_FLOAT, surfaceWidth, surfaceHeight, 1, 1, 1, 0x10);
    const finalTarget = headless
      ? rec.acquireTempTexture(TEXTURE_FORMAT_RGBA8_UNORM, surfaceWidth, surfaceHeight, 1, 1, 1, 0x11)
      : SURFACE_SWAPCHAIN_HANDLE;

    rec.beginRenderPass({
      labelId: 1,
      colorAttachments: [],
      depthAttachment: { texture: shadowDepth, loadOp: 'clear', storeOp: 'store', clearDepth: 1.0 },
    });
    rec.drawRenderers({
      cullId: 1,
      passTag: PASS_TAG_SHADOW_DEPTH,
      sortMode: SORT_MATERIAL_PSO,
      drawFlags: DRAW_FLAG_INSTANCING,
      queueMin: 0,
      queueMax: 2500,
      viewUniformOffset: vSlice.offset,
      viewUniformLength: vSlice.length,
      overrideShader: shadowShader,
      passAttachmentId: 1,
    });
    rec.endRenderPass();

    const shadowBind = rec.beginBindingSet().bindTexture(0, shadowDepth).finish();
    rec.beginRenderPass({
      labelId: 2,
      colorAttachments: [{ texture: hdrColor, clearColor: [0.06, 0.11, 0.2, 1] }],
      depthAttachment: { texture: mainDepth, loadOp: 'clear', storeOp: 'discard', clearDepth: 1.0 },
    });
    rec.drawRenderers({
      cullId: 2,
      passTag: PASS_TAG_FORWARD_OPAQUE,
      sortMode: SORT_MATERIAL_PSO,
      drawFlags: DRAW_FLAG_INSTANCING,
      queueMin: 0,
      queueMax: 2500,
      viewUniformOffset: vSlice.offset,
      viewUniformLength: vSlice.length,
      extraBindings: shadowBind,
      passAttachmentId: 2,
    });
    rec.endRenderPass();

    const postBind = rec.beginBindingSet().bindTexture(0, hdrColor).bindSampler(1, postSampler).finish();
    rec.beginRenderPass({
      labelId: 3,
      colorAttachments: [{ texture: finalTarget, clearColor: [0, 0, 0, 1] }],
    });
    rec.drawFullscreen(tonemapShader, postBind);
    rec.endRenderPass();

    kernel.submitPipelinedFrameAsync(rec, {
      delta: deltaWriter,
      culls: [
        { viewProj: lightVp, cameraPos: [24, 34, 20] },
        { viewProj: vp, cameraPos: camPos },
      ],
    }).unwrap();

    const dt = performance.now() - t0;
    if (f >= 20) mainThreadTimes.push(dt);
  }

  kernel.flush().unwrap();
  const wallElapsedMs = performance.now() - wallStart;
  const stats = kernel.getThreadStats().unwrap();

  assert.equal(stats.completedFrames, totalFrames + 1);
  assert.equal(stats.inFlightFrames, 0);
  const occludedSkipped = headless ? 0 : Math.max(0, totalFrames - stats.surfacePresents);
  if (!headless && process.env.FORGEAX_REQUIRE_VISIBLE_PRESENTS === '1') {
    assert(stats.surfacePresents > 0, `expected > 0 visible native presents, got ${stats.surfacePresents}`);
  }

  console.log(JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    mode: headless ? 'headless' : 'native-window',
    adapter: stats.adapterName,
    backend: stats.backendName,
    surfaceFormat: stats.surfaceFormat ?? null,
    finalSurfaceExtent: [surfaceWidth, surfaceHeight],
    resizedLiveWindow: resizedOnce,
    sceneObjects: totalCount,
    passesPerFrame: 3,
    completedFrames: stats.completedFrames,
    surfacePresents: stats.surfacePresents,
    occludedSkipped,
    wallFps: +((totalFrames * 1000) / wallElapsedMs).toFixed(1),
    jsMainThreadP50Ms: +pct(mainThreadTimes, 0.5).toFixed(4),
    jsMainThreadP95Ms: +pct(mainThreadTimes, 0.95).toFixed(4),
    jsMainThreadMeanMs: +(mainThreadTimes.reduce((a, b) => a + b, 0) / mainThreadTimes.length).toFixed(4),
    renderThreadAvgPlanUs: +(stats.totalPlanUs / stats.completedFrames).toFixed(1),
    renderThreadAvgEncodeSubmitUs: +(stats.totalEncodeSubmitUs / stats.completedFrames).toFixed(1),
    dirtyRowsUploaded: stats.dirtyRowsUploaded,
    dirtyRangeWrites: stats.dirtyRangeWrites,
    materialUploads: stats.materialUploads,
  }, null, 2));
} finally {
  kernel.dispose();
}
