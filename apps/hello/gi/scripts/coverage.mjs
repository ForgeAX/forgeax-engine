// hello-gi representation coverage tool (Lumen Lite step 4 acceptance). For each
// scene it runs the ordinary Renderer with the irradiance-field gather, then
// classifies one pixel-center camera ray per pixel through the exact Global SDF
// march, Card candidate search and Card lookup the probe kernels consume
// (IRRADIANCE_FIELD_COVERAGE_WGSL over the Renderer's live resources), and
// compares the first hit with the triangle path tracer's first-hit AOVs
// (distance, shading normal, albedo, identity). It also accounts the Card
// atlas against the material textures it summarizes, measures which producers
// re-run after one material edit, and (--capture) reads the Global SDF and Card
// atlas back from RHI Debug tapes on a fresh device with replay pass timing.
//
//   node scripts/coverage.mjs [--scenes leak,alcove,sponza] [--size 128]
//     [--out <dir>] [--capture] [--sponza <prepared dir>] [--sponza-dist <dist>]
//     [--card-bytes <n>]
//
// A scene whose authored Card capture budget rejects preparation keeps that
// structured rejection in its report; with --card-bytes it is then measured
// again under that explicit budget.
//
// Coverage classes and colors are COVERAGE_CLASSES below; report.json carries
// the legend, every count and the metric tables.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import * as gi from './gi-dawn.mjs';
import { contactSheet, writePng } from './gi-metrics.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const SIZE = Number(option('size', '128'));
const CAPTURE = args.includes('--capture');
const SPONZA = option('sponza');
const SPONZA_DIST = resolve(option('sponza-dist', resolve(gi.appRoot, 'dist')));
const SCENES = option('scenes', SPONZA ? 'leak,alcove,sponza' : 'leak,alcove')
  .split(',')
  .filter(Boolean);
const CARD_BYTES = option('card-bytes') === undefined ? undefined : Number(option('card-bytes'));
const OUT = resolve(option('out', resolve(gi.monorepoRoot, 'artifacts/step4-acceptance')));
mkdirSync(OUT, { recursive: true });
const log = (line) => console.log(`[coverage] ${line}`);
/** The scene's irradiance-field profile, optionally with an explicit Card capture budget. */
function fieldGi(scene, maxCaptureBytes) {
  const authored = scenes.diffuseGiFor('irradiance-field', scene);
  if (maxCaptureBytes === undefined) return authored;
  const cards = { ...authored.field.cards, maxCaptureBytes };
  return { ...authored, field: { ...authored.field, cards } };
}

/** Closed coverage taxonomy, in report order. `sky`/`false-hit` are reference misses. */
const COVERAGE_CLASSES = {
  mapped: [40, 200, 60],
  rejected: [255, 120, 180],
  stale: [0, 128, 128],
  'no-card': [40, 100, 255],
  'no-candidate': [30, 40, 140],
  'candidate-overflow': [0, 220, 220],
  'invalid-normal': [128, 128, 0],
  backface: [140, 80, 30],
  'sdf-miss': [130, 40, 200],
  'step-budget': [255, 230, 0],
  'negative-start': [255, 140, 0],
  'no-sdf': [220, 30, 30],
  'not-resident': [96, 96, 96],
  'false-hit': [255, 0, 255],
  sky: [0, 0, 0],
};
/** First-hit correspondence where both the reference and the Global SDF hit:
 * `agree` within one cell along the ray; `grazing` off along the ray but within one
 * cell of the reference surface plane; `early`/`late` otherwise. */
const CORRESPONDENCE_CLASSES = {
  agree: [40, 200, 60],
  grazing: [200, 200, 40],
  early: [230, 40, 40],
  late: [40, 100, 255],
  'mask-proxy': [255, 0, 255],
  'sdf-no-hit': [96, 96, 96],
  'reference-miss': [0, 0, 0],
};
const STATUS = { miss: 0, hit: 1, negativeStart: 2, stepBudget: 3, missingField: 4, outside: 5 };
const LOOKUP = { notSurface: 0, mapped: 1, unmapped: 2, stale: 3 };
const FLAGS = { missingField: 1, overflow: 2, invalidNormal: 4 };
const NO_HIT = 0xffffffff;

const ALPHA_BLEND = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

await gi.installDawn();
const scenes = await import('../src/scenes.ts');
const build = await import('../src/build-scene.ts');
const { Materials, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { quat } = await import('@forgeax/engine-math');
const { createBoxGeometry, createExtrusionGeometry } = await import('@forgeax/engine-geometry');
const webgpu = await import('@forgeax/engine-rhi-webgpu');
const { buildRaySurfaceScene, IRRADIANCE_FIELD_COVERAGE_BYTES, IRRADIANCE_FIELD_COVERAGE_WGSL } =
  await import('@forgeax/engine-render/internal');
const debug = await import('@forgeax/engine-rhi-debug');

const surface = (baseColor, extra = {}) =>
  Materials.standard({ baseColor, roughness: 0.8, metallic: 0, specular: 0, ...extra });
/** Diagnostic materials beyond the GI table: a fully cut MASK panel (its alpha is
 * below the cutoff everywhere) with an opaque twin for the conservative-proxy
 * reference, plus materials the retained field must reject as a whole. */
const cooked = await gi.cookGiMaterials({
  mask: surface([0.85, 0.85, 0.85, 0.3], { alphaCutoff: 0.5 }),
  'mask-opaque': surface([0.85, 0.85, 0.85, 1]),
  blend: surface([0.85, 0.85, 0.85, 0.5], {
    renderState: { blend: ALPHA_BLEND, depthWriteEnabled: false },
  }),
  'two-sided': surface([0.85, 0.85, 0.85, 1], { renderState: { cullMode: 'none' } }),
}, ['blend', 'two-sided']);
const traceDevice = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();

// ---------------------------------------------------------------- scenes

const boxGeometry = createBoxGeometry(2, 2, 2).unwrap();
/** A single closed U-shaped mesh (top view), extruded 2 m: its niche interior is
 * concave inside one Card layout, unlike walls built from separate boxes. */
const nicheGeometry = createExtrusionGeometry(
  [
    [-1, 0],
    [-0.8, 0],
    [-0.8, 1],
    [0.8, 1],
    [0.8, 0],
    [1, 0],
    [1, 1.2],
    [-1, 1.2],
  ].map(([x, y]) => ({ x, y })),
  2,
).unwrap();
const meshes = {
  box: await build.createGiBoxMesh(),
  niche: await build.withTracedRepresentations(nicheGeometry, 0.1),
};
const geometries = { box: boxGeometry, niche: nicheGeometry };

const yawQuat = (yaw) => quat.fromAxisAngle(quat.create(), [0, 1, 0], yaw);
const boxObject = (box, name) => ({
  name,
  mesh: 'box',
  material: box.material,
  pos: box.center,
  rot: yawQuat(box.yaw ?? 0),
  scale: box.half,
});
const leakObjects = scenes.PROCEDURAL_SCENES.leak.boxes.map((box, i) =>
  boxObject(box, ['floor', 'ceiling', 'back', 'left', 'right', 'wall', 'jamb', 'lintel', 'cube'][i]),
);
const ALCOVE = {
  id: 'alcove',
  objects: [
    boxObject({ material: 'white', center: [0, -0.1, -0.5], half: [4.2, 0.1, 3] }, 'floor'),
    boxObject({ material: 'white', center: [0, 1.6, -3.3], half: [4.2, 1.6, 0.1] }, 'back'),
    {
      name: 'niche',
      mesh: 'niche',
      material: 'sand',
      pos: [-1.9, 1, -1.2],
      // Local z (extrusion, centered) is world up; local +y (into the niche) is world -z.
      rot: quat.fromAxisAngle(quat.create(), [1, 0, 0], -Math.PI / 2),
      scale: [1, 1, 1],
    },
    // A free-standing 2 cm panel, thinner than one Global SDF cell.
    boxObject(
      { material: 'white', center: [0.9, 1, -1.1], half: [0.6, 1, 0.01], yaw: 0.3 },
      'thin',
    ),
    // A fully cut MASK panel in front of the back wall.
    boxObject({ material: 'mask', center: [2.8, 1, -1.4], half: [0.7, 1, 0.03] }, 'mask'),
  ],
  light: {
    kind: 'point',
    position: [0, 2.6, 1.2],
    moved: [0, 2.6, 1.2],
    color: [1, 0.96, 0.9],
    intensity: 30,
    range: 30,
  },
  environment: [0, 0, 0],
  maxDistance: 40,
  camera: { origin: [0, 1.4, 6.5], target: [0.3, 1, -1.5], up: [0, 1, 0], verticalFov: 0.85 },
  bounds: { lo: [-4.2, -0.2, -3.4], hi: [4.2, 3.2, 2.5] },
  edit: { object: 'thin', material: 'red' },
};
const LEAK = {
  ...scenes.PROCEDURAL_SCENES.leak,
  objects: leakObjects,
  bounds: scenes.proceduralBounds(scenes.PROCEDURAL_SCENES.leak.boxes),
  edit: { object: 'cube', material: 'blue' },
};
const PROCEDURAL = { leak: LEAK, alcove: ALCOVE };

/** Column-major TRS matching the ECS Transform the Renderer draws. */
function trs(pos, q, s) {
  const [x, y, z, w] = q;
  const r = [
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
  ];
  return [
    r[0] * s[0],
    r[1] * s[0],
    r[2] * s[0],
    0,
    r[3] * s[1],
    r[4] * s[1],
    r[5] * s[1],
    0,
    r[6] * s[2],
    r[7] * s[2],
    r[8] * s[2],
    0,
    pos[0],
    pos[1],
    pos[2],
    1,
  ];
}

function spawnObjects(world, scene, material) {
  const handles = Object.fromEntries(
    Object.entries(meshes).map(([name, mesh]) => [name, world.allocSharedRef('MeshAsset', mesh)]),
  );
  const entities = new Map();
  for (const o of scene.objects)
    entities.set(
      o.name,
      world
        .spawn(
          { component: Transform, data: { pos: [...o.pos], quat: [...o.rot], scale: [...o.scale] } },
          { component: MeshFilter, data: { assetHandle: handles[o.mesh] } },
          { component: MeshRenderer, data: { materials: [material(o.material)] } },
        )
        .unwrap(),
    );
  build.spawnLight(world, scene.light);
  build.spawnCamera(world, scene.camera, 1);
  return entities;
}

/** Exact ray instances over the same meshes; `swap` replaces material names. */
function rayScene(scene, swap = {}) {
  const names = [...cooked.keys()];
  const instances = scene.objects.map((o, i) => {
    const g = geometries[o.mesh];
    return {
      instanceId: i,
      geometryId: o.mesh === 'box' ? 0 : 1,
      mask: 255,
      materialId: names.indexOf(swap[o.material] ?? o.material),
      positions: g.attributes.position,
      normals: g.attributes.normal,
      tangents: g.attributes.tangent,
      uvSets: [g.attributes.uv],
      indices: g.indices,
      transform: trs(o.pos, o.rot, o.scale),
    };
  });
  const materials = names.flatMap((name, id) =>
    cooked.get(name).program === undefined
      ? []
      : [{ id, asset: cooked.get(name).asset, program: cooked.get(name).program }],
  );
  return { scene: buildRaySurfaceScene(instances).unwrap(), materials };
}

// ------------------------------------------------------ device accounting

const TEXEL_BYTES = {
  rgba16float: 8,
  rgba32float: 16,
  rg32float: 8,
  depth32float: 4,
  'depth24plus-stencil8': 4,
  depth24plus: 4,
  r32float: 4,
  r32uint: 4,
  rg16float: 4,
  r16float: 2,
  r8unorm: 1,
  rg8unorm: 2,
  rg11b10ufloat: 4,
  rgb10a2unorm: 4,
};
const texelBytes = (format) =>
  TEXEL_BYTES[format] ??
  (/^(bc1|bc4|etc2-rgb8|eac-r11)/.test(format)
    ? 0.5
    : /^(bc|astc-4x4|etc2-rgba8|eac-rg11)/.test(format)
      ? 1
      : 4);
function textureBytes(d) {
  const size = Array.isArray(d.size) ? d.size : [d.size.width, d.size.height ?? 1, d.size.depthOrArrayLayers ?? 1];
  const [w, h = 1, layers = 1] = size;
  let bytes = 0;
  for (let m = 0; m < (d.mipLevelCount ?? 1); m++)
    bytes += Math.max(1, w >> m) * Math.max(1, h >> m) * layers * texelBytes(d.format);
  return bytes;
}
const groupOf = (label = '') =>
  label.startsWith('cards.')
    ? 'cards'
    : label.startsWith('probe-global.')
      ? 'probe-global'
      : label.startsWith('irradiance-field.')
        ? 'irradiance-field'
        : 'other';

/** Wraps the native device: latest live resource per label, creation events and
 * live/peak bytes per producer group. */
function createTracker() {
  const latest = new Map();
  const events = [];
  const live = new Map();
  const peak = { total: 0, groups: {}, created: [] };
  let created = new Set();
  let frame = 0;
  const totals = () => {
    const groups = {};
    let total = 0;
    for (const { group, bytes } of live.values()) {
      groups[group] = (groups[group] ?? 0) + bytes;
      total += bytes;
    }
    return { total, groups };
  };
  const add = (resource, label, bytes, kind, descriptor) => {
    // The tool's own readback and ray buffers are not part of the engine's footprint.
    if (label?.startsWith('coverage.')) return;
    const group = groupOf(label);
    live.set(resource, { group, bytes, label, kind });
    created.add(resource);
    if (label) latest.set(label, { resource, descriptor });
    events.push({ frame, label: label ?? '', kind, bytes, group });
    const now = totals();
    if (now.total > peak.total) {
      peak.total = now.total;
      // What, created since the last reset, is still live at the peak.
      const byLabel = new Map();
      for (const r of created) {
        const entry = live.get(r);
        if (entry === undefined) continue;
        const key = (entry.label ?? `(unlabeled ${entry.kind})`).replace(/(?<=[-.])\d+/g, 'N');
        byLabel.set(key, (byLabel.get(key) ?? 0) + entry.bytes);
      }
      peak.created = [...byLabel]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([label, bytes]) => ({ label, bytes }));
    }
    for (const [g, b] of Object.entries(now.groups)) peak.groups[g] = Math.max(peak.groups[g] ?? 0, b);
    const destroy = resource.destroy.bind(resource);
    resource.destroy = () => {
      live.delete(resource);
      destroy();
    };
  };
  return {
    latest,
    events,
    peak,
    totals,
    setFrame(value) {
      frame = value;
    },
    resetPeak() {
      const now = totals();
      peak.total = now.total;
      peak.groups = { ...now.groups };
      peak.created = [];
      created = new Set();
    },
    install(device) {
      const createBuffer = device.createBuffer.bind(device);
      device.createBuffer = (d) => {
        const b = createBuffer(d);
        add(b, d.label, d.size, 'buffer', d);
        return b;
      };
      const createTexture = device.createTexture.bind(device);
      device.createTexture = (d) => {
        const t = createTexture(d);
        add(t, d.label, textureBytes(d), 'texture', d);
        return t;
      };
    },
  };
}

async function readBuffer(device, buffer, size = buffer.size) {
  const staging = device.createBuffer({ label: "coverage.readback", size, usage: 9 });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(1);
  const bytes = new Uint8Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return bytes;
}

/** Tightly packed texel rows of mip 0, layer 0. */
async function readTexture(device, texture) {
  const bpt = texelBytes(texture.format);
  const { width, height } = texture;
  const row = Math.ceil((width * bpt) / 256) * 256;
  const staging = device.createBuffer({ label: "coverage.readback", size: row * height, usage: 9 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow: row }, [width, height]);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(1);
  const mapped = new Uint8Array(staging.getMappedRange());
  const out = new Uint8Array(width * height * bpt);
  for (let y = 0; y < height; y++)
    out.set(mapped.subarray(y * row, y * row + width * bpt), y * width * bpt);
  staging.unmap();
  staging.destroy();
  return { width, height, format: texture.format, bytes: out };
}

const CARD_PLANES = ['albedoRoughness', 'normals', 'emissionMetallic', 'f0Validity'];
const BINDINGS = [
  [0, 'probe-global.voxels'],
  [1, 'probe-global.settings'],
  [2, 'probe-global.instances'],
  [3, 'probe-global.fields'],
  [4, 'probe-global.bounds'],
  [5, 'probe-global.card-projections'],
  [6, 'irradiance-field.card-lit'],
  [9, 'irradiance-field.frame'],
  [10, 'probe-global.card-settings'],
  ...CARD_PLANES.map((name, i) => [11 + i, `cards.${name}`]),
  [15, 'cards.depth'],
];

/** The Renderer's Global SDF region box (cells strictly inside the sample margin). */
async function regionGrid(device, tracker) {
  const bytes = await readBuffer(device, tracker.latest.get('probe-global.settings').resource);
  const f = new Float32Array(bytes.buffer);
  const u = new Uint32Array(bytes.buffer);
  const origin = [f[0], f[1], f[2]];
  const spacing = f[3];
  const dims = [u[4], u[5], u[6]];
  return {
    origin,
    spacing,
    dims,
    lo: origin.map((o) => o + spacing),
    hi: origin.map((o, a) => o + (dims[a] - 2) * spacing),
  };
}

/** Pixel-center rays clipped to the region; a ray that never enters is not resident. */
function clippedRays(camera, grid, maxDistance) {
  const rays = gi.pixelCenterRays(camera, SIZE, SIZE);
  const bytes = new ArrayBuffer(rays.length * 48);
  const f = new Float32Array(bytes);
  const u = new Uint32Array(bytes);
  const resident = new Uint8Array(rays.length);
  rays.forEach((ray, i) => {
    let t0 = 0;
    let t1 = maxDistance;
    for (let a = 0; a < 3; a++) {
      const o = ray.origin[a];
      const d = ray.direction[a];
      if (Math.abs(d) < 1e-12) {
        if (o < grid.lo[a] || o > grid.hi[a]) t0 = Infinity;
        continue;
      }
      const ta = (grid.lo[a] - o) / d;
      const tb = (grid.hi[a] - o) / d;
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
    }
    resident[i] = t0 < t1 ? 1 : 0;
    const tMin = t0 > 0 ? t0 + 1e-3 * grid.spacing : 0;
    f.set([...ray.origin, resident[i] ? tMin : 1], i * 12);
    f.set([...ray.direction, resident[i] ? t1 : 0], i * 12 + 4);
    u.set([1, 0, 0, 0], i * 12 + 8);
  });
  return { bytes: new Uint8Array(bytes), resident, directions: rays.map((r) => r.direction) };
}

/** Dispatch the coverage kernel against the Renderer's live trace resources. */
async function classify(device, tracker, rays) {
  const n = SIZE * SIZE;
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code: IRRADIANCE_FIELD_COVERAGE_WGSL });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'classifyRays' },
  });
  const rayBuffer = device.createBuffer({ label: "coverage.rays", size: rays.bytes.byteLength, usage: 0x80 | 8 });
  device.queue.writeBuffer(rayBuffer, 0, rays.bytes);
  const out = device.createBuffer({ label: "coverage.records", size: n * IRRADIANCE_FIELD_COVERAGE_BYTES, usage: 0x80 | 4 });
  const entries = [
    { binding: 7, resource: { buffer: rayBuffer } },
    { binding: 8, resource: { buffer: out } },
    ...BINDINGS.map(([binding, label]) => {
      const entry = tracker.latest.get(label);
      if (entry === undefined) throw new Error(`coverage: no live ${label}`);
      return {
        binding,
        resource: entry.descriptor.format === undefined
          ? { buffer: entry.resource }
          : entry.resource.createView(),
      };
    }),
  ];
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
  // The second, warm dispatch is the reported wall time (pipeline creation excluded).
  let gpuWallMs = 0;
  for (let k = 0; k < 2; k++) {
    const started = performance.now();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    gpuWallMs = performance.now() - started;
  }
  const error = await device.popErrorScope();
  if (error) throw new Error(`coverage kernel validation: ${error.message}`);
  const bytes = await readBuffer(device, out);
  rayBuffer.destroy();
  out.destroy();
  return { u: new Uint32Array(bytes.buffer), f: new Float32Array(bytes.buffer), gpuWallMs };
}

// ------------------------------------------------------------ reference

/** First-hit AOVs from the path tracer's accumulation rows (pixel-center rays). */
async function firstHits(common) {
  let rows;
  await gi.tracePath({
    ...common,
    device: traceDevice,
    compile: webgpu.createShaderModule,
    lights: [],
    width: SIZE,
    height: SIZE,
    maxBounces: 1,
    environment: [0, 0, 0],
    samples: 1,
    onAccumulation: (f) => {
      rows = f;
    },
  });
  const ids = new Uint32Array(rows.buffer);
  return {
    hit: (p) => ids[p * 20 + 16] !== NO_HIT,
    t: (p) => rows[p * 20 + 15],
    normal: (p) => [rows[p * 20 + 12], rows[p * 20 + 13], rows[p * 20 + 14]],
    albedo: (p) => [rows[p * 20 + 8], rows[p * 20 + 9], rows[p * 20 + 10]],
    instance: (p) => ids[p * 20 + 16],
    material: (p) => ids[p * 20 + 19],
  };
}

async function proceduralReferences(scene) {
  const exact = rayScene(scene);
  const common = { camera: scene.camera, maxDistance: scene.maxDistance };
  const actual = await firstHits({ ...common, ...exact });
  const hasMask = scene.objects.some((o) => o.material === 'mask');
  const opaque = hasMask
    ? await firstHits({ ...common, ...rayScene(scene, { mask: 'mask-opaque' }) })
    : undefined;
  const maskIndex = scene.objects.findIndex((o) => o.material === 'mask');
  return {
    actual,
    // Pixels whose opaque-twin first hit is the MASK panel the exact trace sees through.
    maskProxy: (p) =>
      opaque !== undefined && opaque.hit(p) && opaque.instance(p) === maskIndex &&
      (!actual.hit(p) || actual.instance(p) !== maskIndex),
    objectName: (id) => scene.objects[id]?.name ?? `instance-${id}`,
    masked: () => false,
  };
}

async function sponzaReferences() {
  const { createGltfResources } = await import(
    resolve(gi.monorepoRoot, 'scripts/raytracing/gltf/resources.mjs')
  );
  const prepared = JSON.parse(readFileSync(resolve(SPONZA, 'prepared.json'), 'utf8'));
  const load = async (name) => new Uint8Array(readFileSync(resolve(SPONZA, name)));
  const resources = await createGltfResources(traceDevice, webgpu.createShaderModule, prepared, load);
  const masked = new Set(prepared.report.maskedMaterials ?? []);
  try {
    const actual = await firstHits({
      scene: resources.scene,
      materials: prepared.materials,
      resolveTexture: resources.resolveTexture,
      camera: scenes.SPONZA.camera,
      maxDistance: scenes.SPONZA.maxDistance,
    });
    return {
      actual,
      maskProxy: () => false,
      objectName: (id) => `instance-${id}`,
      masked: (p) => actual.hit(p) && masked.has(actual.material(p)),
      maskedMaterials: [...masked],
    };
  } finally {
    resources.dispose?.();
  }
}

// ---------------------------------------------------------- the Renderer

const percentile = (values, q) => {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const round = (v, digits = 4) => (v === null || v === undefined ? v : Number(v.toFixed(digits)));

/** Per-pass GPU ms summed over frames, from Renderer pass timing. */
function addTimings(sum, timings) {
  if (timings?.status !== 'complete' && timings?.status !== 'partial') return;
  for (const pass of timings.frame.passes)
    if (pass.status === 'measured') {
      const entry = sum.get(pass.passName) ?? { ms: 0, frames: 0 };
      entry.ms += pass.durationNanoseconds / 1e6;
      entry.frames++;
      sum.set(pass.passName, entry);
    }
}
/** Per-pass GPU ms (summed, or averaged over `frames`) and how many frames ran it. */
const passTable = (sum, frames = 1) =>
  [...sum]
    .map(([name, { ms, frames: ran }]) => ({ name, ms: round(ms / frames, 3), frames: ran }))
    .sort((a, b) => b.ms - a.ms);
/** The GI producers a material edit may re-run, by Renderer pass name. */
const PRODUCERS = {
  globalSdfCompose: /^irradiance-field\.compose$/,
  cardCapture: /^irradiance-field\.card\.capture$/,
  cardSurface: /^irradiance-field\.card-surface$/,
  cardLighting: /^irradiance-field\.(card-lighting|radiosity)$/,
  probes: /^irradiance-field\.(trace|update)-probes$/,
};
const producerCost = (passes) =>
  Object.fromEntries(
    Object.entries(PRODUCERS).map(([name, pattern]) => {
      const matched = passes.filter((p) => pattern.test(p.name));
      return [
        name,
        {
          ms: round(matched.reduce((s, p) => s + p.ms, 0), 3),
          frames: Math.max(0, ...matched.map((p) => p.frames)),
        },
      ];
    }),
  );

async function createSceneRenderer(id, tracker) {
  const created = await gi.createGiRenderer({
    width: SIZE,
    height: SIZE,
    timing: true,
    capture: CAPTURE,
    onDevice: (device) => tracker.install(device),
  });
  const world = new World();
  let entities;
  let scene;
  let material;
  if (id === 'sponza') {
    scene = scenes.SPONZA;
    await gi.spawnSponza(world, created.assets, SPONZA_DIST);
  } else {
    scene = PROCEDURAL[id];
    material = gi.publishMaterials(world, created.assets, cooked);
    entities = spawnObjects(world, scene, material);
  }
  const lease = created.renderer.attach(world).unwrap();
  const driver = await gi.createFrameDriver({ renderer: created.renderer, world, lease });
  return { ...created, world, entities, scene, material, driver };
}

/** Draw until the field is ready with every Card tile captured (or failed).
 * With a recorder, the first frame that records Card capture is taped. */
async function settleField(ctx, tracker, { after = -1, tape } = {}) {
  const { renderer, driver } = ctx;
  const started = performance.now();
  const passes = new Map();
  let frames = 0;
  let taped;
  let tapeMs = 0;
  while (performance.now() - started < 600000) {
    const before = renderer.inspect().diffuseGi;
    tracker.setFrame(frames);
    if (
      tape !== undefined &&
      taped === undefined &&
      before?.state === 'ready' &&
      before.generation > after &&
      (before.cards?.captured ?? 0) < (before.cards?.tiles ?? 0)
    ) {
      const tapeStarted = performance.now();
      const { observed, ...result } = await captureTape(ctx, `${tape}`);
      taped = result;
      addTimings(passes, observed?.timings);
      tapeMs += performance.now() - tapeStarted;
      frames++;
      continue;
    }
    const { observed } = await driver.observe(['linear-hdr'], ['linear-hdr', 'timings']);
    addTimings(passes, observed.timings);
    frames++;
    const state = renderer.inspect().diffuseGi;
    const wallMs = performance.now() - started - tapeMs;
    if (state?.state === 'failed') return { state, frames, wallMs };
    if (
      state?.state === 'ready' &&
      state.generation > after &&
      state.submittedFrames > 0 &&
      state.cards?.captured === state.cards?.tiles
    )
      return {
        state,
        frames,
        wallMs,
        passes: passTable(passes),
        tape: taped,
      };
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`field did not settle: ${JSON.stringify(renderer.inspect().diffuseGi)}`);
}

async function steadyTimings(driver, frames = 6) {
  const sum = new Map();
  let total = 0;
  for (let k = 0; k < frames; k++) {
    const { observed } = await driver.observe(['linear-hdr'], ['linear-hdr', 'timings']);
    addTimings(sum, observed.timings);
    total += (observed.timings?.frame?.measuredPassNanoseconds ?? 0) / 1e6;
  }
  return { frameMs: round(total / frames, 3), passes: passTable(sum, frames) };
}

// -------------------------------------------------------------- RHI Debug

async function captureTape(ctx, name) {
  const pending = ctx.recorder.captureFrame({ byteBudget: 2 ** 31, snapshotTimeoutMs: 600000 });
  const seeded = await ctx.recorder.frameBoundary();
  if (!seeded.ok) return { ok: false, stage: 'seed', error: seeded.error.code };
  const { observed } = await ctx.driver.observe(['linear-hdr'], ['linear-hdr', 'timings']);
  const tape = await pending;
  if (!tape.ok) return { ok: false, stage: 'capture', error: tape.error.code, observed };
  const path = resolve(OUT, `${name}.rhitape`);
  writeFileSync(path, tape.value.bytes);
  return {
    ok: true,
    path,
    bytes: tape.value.bytes.byteLength,
    digest: tape.value.digest,
    observed,
  };
}

/** Open a tape on a fresh device; `inspect` receives the frame model and session. */
async function withReplay(tape, inspect) {
  const decoded = debug.decodeTape(new Uint8Array(readFileSync(tape.path)));
  if (!decoded.ok) return { ok: false, stage: 'decode', error: decoded.error.code };
  const model = debug.buildFrameModel(decoded.value);
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(
      debug.replayDeviceRequest(decoded.value, adapter.features, adapter.limits),
    )
  ).unwrap();
  const replay = await debug.openReplay(decoded.value, {
    device,
    createShaderModule: webgpu.createShaderModule,
  });
  if (!replay.ok) return { ok: false, stage: 'replay-open', error: replay.error.code };
  try {
    return { ok: true, works: model.works.length, ...(await inspect(model, replay.value)) };
  } finally {
    await replay.value.dispose();
    device.destroy?.();
  }
}

const labelOf = (resource) => resource.descriptor?.desc?.label;
/** A work's identity in a tape: its pipeline label, else its shader entry point. */
const workName = (work) =>
  work.pipeline?.descriptor?.desc?.label ?? work.pipeline?.shaders?.at(-1)?.entryPoint;
const lastResource = (model, label) => model.resources.findLast((r) => labelOf(r) === label);

/** Replay pass timing; unlabeled compute passes take their first work's name. */
async function replayTiming(model, replay) {
  const timing = await replay.timePasses();
  if (!timing.ok) return { ok: false, error: timing.error.code };
  const by = new Map();
  for (const pass of timing.value.passes) {
    const first = model.works[pass.workIndices[0]];
    const key = (pass.label ?? (first && workName(first)) ?? `${pass.kind}-${pass.passIndex}`)
      .replace(/(?<=[-.])\d+/g, 'N');
    const entry = by.get(key) ?? { ms: 0, frames: 0 };
    entry.ms += (pass.gpuNanoseconds ?? 0) / 1e6;
    entry.frames++;
    by.set(key, entry);
  }
  return {
    ok: true,
    totalMs: round(timing.value.totalGpuNanoseconds / 1e6, 3),
    passes: passTable(by),
  };
}

/** Card capture draws in a tape: pipeline label -> instance, primitive range, material. */
function captureWorks(model) {
  const works = [];
  for (const work of model.works) {
    const label = workName(work);
    const m = typeof label === 'string'
      ? /^cards\.capture\.instance-(\d+)\.indices-(\d+)-(\d+)\.material-(\d+)$/.exec(label)
      : null;
    if (m)
      works.push({
        workIndex: work.workIndex,
        instanceId: Number(m[1]),
        indexOffset: Number(m[2]),
        indexCount: Number(m[3]),
        materialId: Number(m[4]),
      });
  }
  return works;
}

/** Work histogram by pipeline label: which producer kernels a taped frame ran. */
function workHistogram(model) {
  const out = {};
  for (const work of model.works) {
    const label = workName(work);
    if (typeof label !== 'string') continue;
    const key = label.replace(/(?<=[-.])\d+/g, 'N');
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** The first Card capture frame after an edit, replayed on a fresh device. */
async function editTape(tape) {
  if (!tape.ok) return tape;
  return {
    ...tape,
    ...(await withReplay(tape, async (model) => {
      const works = captureWorks(model);
      return {
        captureDraws: works.length,
        instances: new Set(works.map((w) => w.instanceId)).size,
        works: workHistogram(model),
      };
    })),
  };
}

// ------------------------------------------------------- classification

function classifyPixels(scene, records, rays, reference, grid) {
  const n = SIZE * SIZE;
  const coverage = new Array(n);
  const correspondence = new Array(n);
  const dt = [];
  const dtMasked = [];
  const offset = [];
  const angle = [];
  const albedoError = [];
  const perObject = new Map();
  const tol = grid.spacing;
  const { u, f } = records;
  for (let p = 0; p < n; p++) {
    const w = p * (IRRADIANCE_FIELD_COVERAGE_BYTES / 4);
    const status = u[w];
    const flags = u[w + 1];
    const seen = u[w + 2];
    const lookup = u[w + 3];
    const owned = u[w + 7];
    const gtHit = reference.actual.hit(p);
    let cls;
    if (!rays.resident[p]) cls = gtHit ? 'not-resident' : 'sky';
    else if (!gtHit) cls = status === STATUS.hit ? 'false-hit' : 'sky';
    else if (status === STATUS.missingField) cls = 'no-sdf';
    else if (status === STATUS.outside) cls = 'not-resident';
    else if (status === STATUS.negativeStart) cls = 'negative-start';
    else if (status === STATUS.stepBudget) cls = 'step-budget';
    else if (status !== STATUS.hit) cls = 'sdf-miss';
    else if (flags & FLAGS.missingField) cls = 'no-sdf';
    else if (flags & FLAGS.overflow) cls = 'candidate-overflow';
    else if (flags & FLAGS.invalidNormal) cls = 'invalid-normal';
    else if (f[w + 15] > 0) cls = 'backface';
    else if (lookup === LOOKUP.mapped) cls = 'mapped';
    else if (lookup === LOOKUP.stale) cls = 'stale';
    else if (owned === 0) cls = seen === 0 ? 'no-candidate' : 'no-card';
    else cls = 'rejected';
    coverage[p] = cls;
    const proxy = reference.maskProxy(p);
    let corr;
    if (status !== STATUS.hit || !rays.resident[p]) corr = gtHit ? 'sdf-no-hit' : 'reference-miss';
    else if (!gtHit) corr = 'reference-miss';
    else {
      const delta = f[w + 8] - reference.actual.t(p);
      const gn = reference.actual.normal(p);
      const d = rays.directions[p];
      const planeOffset = Math.abs(delta * (d[0] * gn[0] + d[1] * gn[1] + d[2] * gn[2]));
      (reference.masked(p) ? dtMasked : dt).push(delta);
      offset.push(planeOffset);
      corr =
        Math.abs(delta) <= tol
          ? 'agree'
          : planeOffset <= tol
            ? 'grazing'
            : delta < 0
              ? 'early'
              : 'late';
      if (proxy && corr === 'early') corr = 'mask-proxy';
      if (corr === 'agree') {
        const cos = gn[0] * f[w + 12] + gn[1] * f[w + 13] + gn[2] * f[w + 14];
        angle.push((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
        if (lookup === LOOKUP.mapped) {
          const ga = reference.actual.albedo(p);
          albedoError.push(
            Math.max(...[0, 1, 2].map((c) => Math.abs(f[w + 16 + c] - ga[c]))),
          );
        }
      }
    }
    correspondence[p] = corr;
    if (gtHit || proxy) {
      const key = proxy ? 'mask (proxy)' : reference.objectName(reference.actual.instance(p));
      const entry = perObject.get(key) ?? { pixels: 0, coverage: {}, correspondence: {} };
      entry.pixels++;
      entry.coverage[cls] = (entry.coverage[cls] ?? 0) + 1;
      entry.correspondence[corr] = (entry.correspondence[corr] ?? 0) + 1;
      perObject.set(key, entry);
    }
  }
  const count = (list, classes) =>
    Object.fromEntries(Object.keys(classes).map((k) => [k, list.filter((c) => c === k).length]));
  const stats = (values) => ({
    count: values.length,
    median: round(percentile(values, 0.5)),
    p90: round(percentile(values, 0.9)),
    p99: round(percentile(values, 0.99)),
  });
  const absolute = (values) => values.map(Math.abs);
  const coverageCounts = count(coverage, COVERAGE_CLASSES);
  const referenceHits = n - coverageCounts.sky - coverageCounts['false-hit'];
  return {
    coverage,
    correspondence,
    summary: {
      pixels: n,
      referenceHits,
      mappedFraction: round(coverageCounts.mapped / Math.max(1, referenceHits)),
      coverage: coverageCounts,
      correspondence: count(correspondence, CORRESPONDENCE_CLASSES),
      toleranceMeters: round(tol),
      distanceErrorMeters: {
        signed: stats(dt),
        absolute: stats(absolute(dt)),
        ...(dtMasked.length > 0 ? { maskedMaterialAbsolute: stats(absolute(dtMasked)) } : {}),
        referencePlaneOffset: stats(offset),
      },
      normalAngleDegrees: stats(angle),
      cardAlbedoMaxChannelError: stats(albedoError),
      perObject: Object.fromEntries(perObject),
    },
  };
}

const paint = (classes, palette) => {
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  classes.forEach((c, p) => {
    rgba.set([...palette[c], 255], p * 4);
  });
  return rgba;
};
function heat(values, scale) {
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  values.forEach((v, p) => {
    if (v === undefined) {
      rgba.set([0, 0, 0, 255], p * 4);
      return;
    }
    const t = Math.min(1, Math.abs(v) / scale);
    rgba.set([Math.round(255 * t), Math.round(255 * (1 - Math.abs(2 * t - 1))), Math.round(255 * (1 - t)), 255], p * 4);
  });
  return rgba;
}
const albedoImage = (get) => {
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  for (let p = 0; p < SIZE * SIZE; p++) {
    const c = get(p);
    rgba.set(c ? [...c.map((v) => Math.round(255 * Math.min(1, v ** (1 / 2.2)))), 255] : [0, 0, 0, 255], p * 4);
  }
  return rgba;
};

// ------------------------------------------------------- memory / atlas

async function cardAccounting(device, tracker) {
  const settings = new Uint32Array(
    (await readBuffer(device, tracker.latest.get('probe-global.card-settings').resource)).buffer,
  );
  const [count, resolution] = settings;
  const projections = await readBuffer(device, tracker.latest.get('probe-global.card-projections').resource);
  const view = new DataView(projections.buffer);
  const atlas = tracker.latest.get('cards.albedoRoughness').resource;
  const tilesPerRow = atlas.width / resolution;
  const cards = [];
  for (let i = 0; i < count; i++) {
    const at = (k) => view.getFloat32(i * 80 + k * 4, true);
    cards.push({
      index: i,
      instanceId: view.getUint32(i * 80 + 64, true),
      valid: view.getUint32(i * 80 + 68, true) === 1,
      atlas: {
        x: (i % tilesPerRow) * resolution,
        y: Math.floor(i / tilesPerRow) * resolution,
        size: resolution,
      },
      texelMeters: round(Math.max(at(7), at(11)) / resolution),
      depthRange: round(at(15)),
    });
  }
  const live = [...tracker.latest.values()];
  const bytesOf = (prefix) =>
    live
      .filter(({ descriptor }) => descriptor.label?.startsWith(prefix))
      .reduce((s, { descriptor }) => s + (descriptor.format ? textureBytes(descriptor) : descriptor.size), 0);
  const atlasBytes = [...CARD_PLANES, 'depth'].reduce((s, name) => s + bytesOf(`cards.${name}`), 0);
  const captureBuffers = ['projection', 'triangles', 'attributes'].reduce(
    (s, name) => s + bytesOf(`cards.${name}`),
    0,
  );
  const cardBuffers = ['card-surfaces', 'card-direct', 'card-lit'].reduce(
    (s, name) => s + bytesOf(`irradiance-field.${name}`),
    0,
  );
  const now = tracker.totals();
  const sdfBytes = ['voxels', 'instances', 'fields', 'bounds'].reduce(
    (s, name) => s + bytesOf(`probe-global.${name}`),
    0,
  );
  const texels = count * resolution * resolution;
  const texelMeters = cards.map((c) => c.texelMeters);
  return {
    cards: count,
    resolution,
    atlas: {
      width: atlas.width,
      height: atlas.height,
      bytes: atlasBytes,
      usedTexels: texels,
      occupancy: round(texels / (atlas.width * atlas.height)),
    },
    captureBuffers,
    cardLightingBuffers: cardBuffers,
    bytesPerCardTexel: round((atlasBytes + cardBuffers) / Math.max(1, texels), 1),
    globalSdfBytes: sdfBytes,
    projectionBytes: bytesOf('probe-global.card-projections'),
    texelMeters: {
      median: round(percentile(texelMeters, 0.5)),
      max: round(Math.max(...texelMeters, 0)),
    },
    // Every other live texture (frame targets, shadow maps, material textures),
    // largest first: the residency the Card atlas sits next to.
    otherTextures: otherTextures(tracker),
    liveBytes: now,
    cardTable: cards,
  };
}

function otherTextures(tracker) {
  const by = new Map();
  for (const { descriptor } of tracker.latest.values()) {
    if (descriptor.format === undefined || groupOf(descriptor.label) !== 'other') continue;
    const key = (descriptor.label ?? '(unlabeled)').replace(/(?<=[-.])\d+/g, 'N');
    const entry = by.get(key) ?? { count: 0, bytes: 0 };
    entry.count++;
    entry.bytes += textureBytes(descriptor);
    by.set(key, entry);
  }
  const rows = [...by].sort((a, b) => b[1].bytes - a[1].bytes);
  return {
    bytes: rows.reduce((s, [, e]) => s + e.bytes, 0),
    largest: rows.slice(0, 12).map(([label, e]) => ({ label, ...e })),
  };
}

/** Changed Card tiles between two atlas plane readbacks. */
function changedTiles(before, after, resolution, count) {
  const bpt = texelBytes(before.format);
  const tilesPerRow = before.width / resolution;
  const changed = [];
  for (let i = 0; i < count; i++) {
    const x0 = (i % tilesPerRow) * resolution;
    const y0 = Math.floor(i / tilesPerRow) * resolution;
    let differs = false;
    for (let y = y0; y < y0 + resolution && !differs; y++) {
      const a = (y * before.width + x0) * bpt;
      for (let k = 0; k < resolution * bpt; k++)
        if (before.bytes[a + k] !== after.bytes[a + k]) {
          differs = true;
          break;
        }
    }
    if (differs) changed.push(i);
  }
  return changed;
}

const equalBytes = (a, b) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

// ------------------------------------------------------------ main loop

async function runScene(id) {
  const tracker = createTracker();
  const ctx = await createSceneRenderer(id, tracker);
  const { renderer, driver, scene } = ctx;
  const direct = gi.directProfile(renderer.inspect().profile);
  renderer.setProfile(direct).unwrap();
  for (let i = 0; i < 3; i++) await driver.draw();
  const device = ctx.canvas.native();
  tracker.resetPeak();
  const before = { ...tracker.totals() };
  const eventsBefore = tracker.events.length;
  const profile = renderer.setProfile({ ...direct, diffuseGi: fieldGi(scene) });
  if (!profile.ok) throw new Error(`setProfile: ${JSON.stringify(profile.error)}`);
  log(`${id}: preparing field`);
  let built = await settleField(ctx, tracker, { tape: CAPTURE ? `${id}-prepare` : undefined });
  let budgetRejection;
  if (built.state.state === 'failed' && CARD_BYTES !== undefined) {
    budgetRejection = { cards: fieldGi(scene).field.cards, error: built.state.error };
    log(`${id}: authored Card budget rejected; retrying with ${CARD_BYTES} bytes`);
    ctx.cardBytes = CARD_BYTES;
    renderer.setProfile({ ...direct, diffuseGi: fieldGi(scene, CARD_BYTES) }).unwrap();
    tracker.resetPeak();
    built = await settleField(ctx, tracker, { tape: CAPTURE ? `${id}-prepare` : undefined });
  }
  if (built.state.state === 'failed') throw new Error(`${id}: field failed ${JSON.stringify(built.state)}`);
  const prepared = {
    frames: built.frames,
    wallMs: round(built.wallMs, 1),
    producers: producerCost(built.passes),
    gpuMsAllPasses: round(built.passes.reduce((s, p) => s + p.ms, 0), 3),
    passes: built.passes,
    createdResources: summarizeEvents(tracker.events.slice(eventsBefore)),
    peakBytes: {
      total: tracker.peak.total - before.total,
      groups: Object.fromEntries(
        Object.entries(tracker.peak.groups).map(([g, b]) => [g, b - (before.groups[g] ?? 0)]),
      ),
    },
  };
  const steady = await steadyTimings(driver);
  const grid = await regionGrid(device, tracker);
  const rays = clippedRays(scene.camera, grid, scene.maxDistance);
  log(`${id}: classifying ${SIZE}x${SIZE} rays (spacing ${grid.spacing.toFixed(3)} m)`);
  const records = await classify(device, tracker, rays);
  const memory = await cardAccounting(device, tracker);
  log(`${id}: tracing first-hit reference`);
  const reference = id === 'sponza' ? await sponzaReferences() : await proceduralReferences(scene);
  const result = classifyPixels(scene, records, rays, reference, grid);

  // Images.
  const files = {};
  const png = (name, rgba) => {
    writePng(resolve(OUT, `${id}-${name}.png`), rgba, SIZE, SIZE);
    files[name] = `${id}-${name}.png`;
    return rgba;
  };
  const w = IRRADIANCE_FIELD_COVERAGE_BYTES / 4;
  const dtValues = result.correspondence.map((c, p) =>
    c === 'agree' || c === 'grazing' || c === 'early' || c === 'late' || c === 'mask-proxy'
      ? records.f[p * w + 8] - reference.actual.t(p)
      : undefined,
  );
  const tiles = [
    { label: `${id} coverage`, rgba: png('coverage', paint(result.coverage, COVERAGE_CLASSES)) },
    {
      label: `${id} first hit`,
      rgba: png('correspondence', paint(result.correspondence, CORRESPONDENCE_CLASSES)),
    },
    { label: `dt to ${(4 * grid.spacing).toFixed(2)}m`, rgba: png('distance-error', heat(dtValues, 4 * grid.spacing)) },
    {
      label: 'card albedo',
      rgba: png(
        'card-albedo',
        albedoImage((p) =>
          result.coverage[p] === 'mapped'
            ? [0, 1, 2].map((c) => records.f[p * w + 16 + c])
            : undefined,
        ),
      ),
    },
    {
      label: 'reference albedo',
      rgba: png(
        'reference-albedo',
        albedoImage((p) => (reference.actual.hit(p) ? reference.actual.albedo(p) : undefined)),
      ),
    },
  ];

  // RHI Debug: preparation tape (Card capture draws), steady tape (byte-exact
  // Global SDF + atlas against the live device, replay pass timing).
  const rhi = {};
  if (CAPTURE) {
    if (built.tape?.ok)
      rhi.prepare = {
        ...built.tape,
        ...(await withReplay(built.tape, async (model, replay) => {
          const works = captureWorks(model);
          return {
            captureDraws: works.length,
            instances: new Set(works.map((w) => w.instanceId)).size,
            captureWorks: works,
            works: workHistogram(model),
            timing: await replayTiming(model, replay),
          };
        })),
      };
    else rhi.prepare = built.tape ?? { ok: false, reason: 'no frame recorded Card capture' };
    const { observed: _steadyObserved, ...steadyTape } = await captureTape(ctx, `${id}-steady`);
    const live = {
      voxels: await readBuffer(device, tracker.latest.get('probe-global.voxels').resource),
      ...Object.fromEntries(
        await Promise.all(
          [...CARD_PLANES, 'depth'].map(async (name) => [
            name,
            (await readTexture(device, tracker.latest.get(`cards.${name}`).resource)).bytes,
          ]),
        ),
      ),
    };
    rhi.steady = steadyTape.ok
      ? {
          ...steadyTape,
          ...(await withReplay(steadyTape, async (model, replay) => {
            const reads = {};
            for (const [name, label] of [
              ['voxels', 'probe-global.voxels'],
              ...[...CARD_PLANES, 'depth'].map((n) => [n, `cards.${n}`]),
            ]) {
              const resource = lastResource(model, label);
              if (resource === undefined) {
                reads[name] = { ok: false, reason: `${label} not in tape` };
                continue;
              }
              const read = await replay.readResource(resource.resourceId);
              reads[name] = read.ok
                ? {
                    ok: true,
                    resourceId: resource.resourceId,
                    bytes: read.value.bytes.byteLength,
                    byteExact: equalBytes(read.value.bytes, live[name]),
                  }
                : { ok: false, error: read.error.code, detail: read.error.detail };
            }
            return { reads, timing: await replayTiming(model, replay) };
          })),
        }
      : steadyTape;
  }

  // Material edit: which producers re-run, how many Cards are recaptured.
  let edit;
  if (scene.edit !== undefined) {
    const atlas = tracker.latest.get('cards.albedoRoughness').resource;
    const atlasBefore = await readTexture(device, atlas);
    const voxelsBefore = await readBuffer(device, tracker.latest.get('probe-global.voxels').resource);
    const generation = renderer.inspect().diffuseGi.generation;
    const mark = tracker.events.length;
    tracker.resetPeak();
    const editBase = tracker.totals();
    ctx.world
      .set(ctx.entities.get(scene.edit.object), MeshRenderer, {
        materials: [ctx.material(scene.edit.material)],
      })
      .unwrap();
    const rebuilt = await settleField(ctx, tracker, {
      after: generation,
      tape: CAPTURE ? `${id}-edit` : undefined,
    });
    const atlasAfter = await readTexture(device, tracker.latest.get('cards.albedoRoughness').resource);
    const memoryAfter = await cardAccounting(device, tracker);
    const changed = changedTiles(atlasBefore, atlasAfter, memoryAfter.resolution, memoryAfter.cards);
    const owners = [...new Set(changed.map((i) => memoryAfter.cardTable[i].instanceId))];
    edit = {
      object: scene.edit.object,
      material: scene.edit.material,
      generation: [generation, rebuilt.state.generation],
      frames: rebuilt.frames,
      wallMs: round(rebuilt.wallMs, 1),
      recapturedTiles: rebuilt.state.cards.tiles,
      changedTiles: changed.length,
      changedTileOwners: owners,
      cardsOfEditedInstance: owners.length === 1
        ? memoryAfter.cardTable.filter((c) => c.instanceId === owners[0]).length
        : null,
      globalSdfVoxelsByteIdentical: equalBytes(
        voxelsBefore,
        await readBuffer(device, tracker.latest.get('probe-global.voxels').resource),
      ),
      recreated: summarizeEvents(tracker.events.slice(mark)),
      peakExtraBytes: tracker.peak.total - editBase.total,
      peakLiveAllocations: tracker.peak.created,
      producers: producerCost(rebuilt.passes),
      gpuMsAllPasses: round(rebuilt.passes.reduce((s, p) => s + p.ms, 0), 3),
      ...(rebuilt.tape === undefined ? {} : { tape: await editTape(rebuilt.tape) }),
    };
    log(
      `${id}: edit ${edit.object}->${edit.material}: generation ${edit.generation.join('->')}, ` +
        `${edit.recapturedTiles} tiles recaptured, ${edit.changedTiles} changed`,
    );
  }

  const failures = await rejectionRuns(id);
  renderer.dispose?.();
  const { summary } = result;
  log(
    `${id}: mapped ${(summary.mappedFraction * 100).toFixed(1)}% of ${summary.referenceHits} hits; ` +
      `|dt| median ${summary.distanceErrorMeters.absolute.median} m`,
  );
  return {
    report: {
      id,
      size: SIZE,
      backend: renderer.inspect().capabilities?.backendKind,
      grid: { origin: grid.origin, spacing: grid.spacing, dimensions: grid.dims },
      cardsProfile: fieldGi(scene, ctx.cardBytes).field.cards,
      ...(budgetRejection === undefined ? {} : { budgetRejection }),
      field: built.state,
      prepared,
      steady,
      kernelWallMs: round(records.gpuWallMs, 2),
      coverage: summary,
      memory: { ...memory, cardTable: undefined },
      cards: memory.cardTable,
      edit,
      rejections: failures,
      rhi,
      errors: ctx.errors.map((e) =>
        typeof e === 'string' ? e : JSON.parse(JSON.stringify({ code: e.code, detail: e.detail })),
      ),
      files,
      ...(reference.maskedMaterials ? { maskedMaterials: reference.maskedMaterials } : {}),
    },
    tiles,
  };
}

function summarizeEvents(events) {
  const out = {};
  for (const e of events) {
    const key = e.label.replace(/(?<=[-.])\d+/g, 'N') || `(${e.kind})`;
    const entry = out[key] ?? { count: 0, bytes: 0, group: e.group };
    entry.count++;
    entry.bytes += e.bytes;
    out[key] = entry;
  }
  return Object.fromEntries(
    Object.entries(out).filter(([, v]) => v.group !== 'other' || v.bytes > 1 << 20),
  );
}

/** Whole-field outcomes: each material the retained field cannot represent turns
 * the gather into a structured failure instead of a silent hole. */
async function rejectionRuns(id) {
  if (id !== 'leak') return undefined;
  const out = {};
  for (const material of ['blend', 'two-sided']) {
    const tracker = createTracker();
    const ctx = await createSceneRenderer(id, tracker);
    ctx.world
      .set(ctx.entities.get('cube'), MeshRenderer, { materials: [ctx.material(material)] })
      .unwrap();
    const direct = gi.directProfile(ctx.renderer.inspect().profile);
    ctx.renderer
      .setProfile({ ...direct, diffuseGi: fieldGi(ctx.scene, ctx.cardBytes) })
      .unwrap();
    let state;
    for (let k = 0; k < 600; k++) {
      await ctx.driver.draw();
      state = ctx.renderer.inspect().diffuseGi;
      if (state?.state !== 'preparing') break;
      await new Promise((r) => setTimeout(r, 0));
    }
    out[material] = {
      state: state?.state,
      code: state?.error?.code,
      detail: state?.error?.detail,
    };
    log(`${id}: ${material} cube -> ${state?.state} ${JSON.stringify(state?.error?.detail ?? {})}`);
    ctx.renderer.dispose?.();
  }
  return out;
}

const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gi.appRoot }).toString().trim();
  } catch {
    return undefined;
  }
})();
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  commit,
  platform: `${process.platform}-${process.arch}`,
  size: SIZE,
  legend: { coverage: COVERAGE_CLASSES, correspondence: CORRESPONDENCE_CLASSES },
  scenes: [],
};
const rows = [];
for (const id of SCENES) {
  if (id === 'sponza' && (SPONZA === undefined || !existsSync(resolve(SPONZA_DIST, 'pack-index.json')))) {
    log('sponza: skipped (needs --sponza <prepared dir> and a built hello-gi dist)');
    continue;
  }
  if (id !== 'sponza' && PROCEDURAL[id] === undefined) throw new Error(`unknown scene ${id}`);
  const { report: sceneReport, tiles } = await runScene(id);
  report.scenes.push(sceneReport);
  rows.push(tiles);
  writeFileSync(resolve(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
const legendTile = (palette) => {
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  const names = Object.keys(palette);
  const band = Math.floor(SIZE / names.length);
  names.forEach((name, i) => {
    for (let y = i * band; y < (i + 1) * band; y++)
      for (let x = 0; x < SIZE; x++) rgba.set([...palette[name], 255], (y * SIZE + x) * 4);
  });
  return rgba;
};
if (rows.length > 0) {
  rows.push([
    { label: 'coverage legend', rgba: legendTile(COVERAGE_CLASSES) },
    { label: 'first hit legend', rgba: legendTile(CORRESPONDENCE_CLASSES) },
  ]);
  const sheet = contactSheet(rows, SIZE, SIZE);
  writePng(resolve(OUT, 'contact-sheet.png'), sheet.rgba, sheet.width, sheet.height);
  report.contactSheet = 'contact-sheet.png';
}
writeFileSync(resolve(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
log(`wrote ${resolve(OUT, 'report.json')}`);
process.exit(0);
