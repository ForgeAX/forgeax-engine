// C-410 Dawn/lavapipe renderer (from the T1 detail-case renderer): reads <CASE_DIR>/scene.json (meshes,
// materials, texture sets, variants, views, jobs) and writes <CASE_DIR>/renders/<job>.png.
// Same lights for every job: two directional lights + studio skylight, no shadow maps.
// `id` jobs: every object material is black (keeping its opacity texture and cutoff) in front of
// an emissive white backdrop -> object/silhouette mask. Jitter = sub-pixel camera offset.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { studioEnvironment, textureFrom } from '@forgeax/engine-modeling';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, Skylight } from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { Transform } from '@forgeax/engine-scene';
import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import { buildEngineShaderManifest, publishShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { PNG } from 'pngjs';
import { it } from 'vitest';
import { drawReadyFrame } from '../../../../../scripts/test/ready-render-frame.mjs';

type V3 = [number, number, number];
const CASE = process.env.C410_CASE_DIR ?? '';
// Renders a case directory prepared by case/build.mts, bake.mts, compose.mts and scene.mts; skipped without one.
const scene = CASE ? JSON.parse(readFileSync(join(CASE, 'scene.json'), 'utf8')) : { W: 1, H: 1, fov: 1 };
const ONLY = process.env.C410_JOBS ? new RegExp(process.env.C410_JOBS) : undefined;
const OUT = join(CASE, 'renders');
const { W, H, fov: FOV } = scene as { W: number; H: number; fov: number };

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function lookAt(eye: V3, target: V3) {
  const [x, y, z] = norm(sub(target, eye));
  const yaw = Math.atan2(-x, -z), pitch = Math.asin(y);
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  return [cy * sp, sy * cp, -sy * sp, cy * cp] as [number, number, number, number];
}

function loadMesh(name: string): MeshAsset & { aabbArr: number[] } {
  const meta = JSON.parse(readFileSync(join(CASE, 'meshes', `${name}.meta.json`), 'utf8'));
  const bin = readFileSync(join(CASE, 'meshes', `${name}.bin`));
  const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  let off = 0;
  const A: Record<string, Float32Array> = {};
  for (const [n, c] of meta.attrs as [string, number][]) { A[n] = new Float32Array(buf, off, meta.verts * c).slice(); off += meta.verts * c * 4; }
  const indices = new Uint32Array(buf, off, meta.indexCount).slice();
  const attributes = { position: A.position!, normal: A.normal!, uv: A.uv!, tangent: A.tangent! };
  const packed = packInterleavedVertexAttributes(attributes as never, meta.verts);
  if (!packed.ok) throw packed.error;
  return { kind: 'mesh', vertices: packed.value.vertices, indices, attributes, aabb: new Float32Array(meta.aabb), aabbArr: meta.aabb, submeshes: meta.submeshes.map((s: object) => ({ ...s, vertexCount: meta.verts, topology: 'triangle-list' })), materialSlots: (meta.slots as string[]).map((s) => ({ slotName: s, sourceKey: `case:${s}` })) } as unknown as MeshAsset & { aabbArr: number[] };
}
function quadMesh(): MeshAsset {
  const position = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  const normal = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const tangent = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const attributes = { position, normal, uv, tangent };
  const packed = packInterleavedVertexAttributes(attributes as never, 4);
  if (!packed.ok) throw packed.error;
  return { kind: 'mesh', vertices: packed.value.vertices, indices, attributes, aabb: new Float32Array([-0.5, -0.5, 0, 0.5, 0.5, 0]), submeshes: [{ indexOffset: 0, indexCount: 6, vertexCount: 4, materialSlot: 0, topology: 'triangle-list' }], materialSlots: [{ slotName: 'backdrop', sourceKey: 'case:backdrop' }] } as unknown as MeshAsset;
}
const lin = (b: number) => { const c = b / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

it.skipIf(!CASE)('C-410 case render', async () => {
  mkdirSync(OUT, { recursive: true });
  const manifest = await buildEngineShaderManifest();
  const manifestUrl = URL.createObjectURL(new Blob([JSON.stringify('toJSON' in manifest ? manifest : publishShaderManifest(manifest.entries, manifest.materialShaders))], { type: 'application/json' }));
  let device: GPUDevice | undefined, target: GPUTexture | undefined;
  const gpu = globalThis.navigator.gpu, requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (o) => { const a = await requestAdapter(o); if (a === null) return a; const rd = a.requestDevice.bind(a); a.requestDevice = async (d) => { const c = await rd(d); device ??= c; return c; }; return a; };
  const canvas = { width: W, height: H, getContext: () => ({ configure(c: GPUCanvasConfiguration) { target ??= c.device.createTexture({ size: [W, H], format: c.format, usage: 0x11, viewFormats: [c.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'] }); }, unconfigure() {}, getCurrentTexture: () => target }), addEventListener() {}, removeEventListener() {} } as unknown as HTMLCanvasElement;
  let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>>;
  try { host = await constructRuntimeRendererHost(canvas, {}, { shaderManifestUrl: manifestUrl }); } finally { gpu.requestAdapter = requestAdapter; }
  if (!host.ok) throw host.error;
  const { renderer, assets } = host.value;
  const world = new World();
  world.bindAssets(assets).unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;

  // texture sets (normal / albedo / orm raw rgba), with and without mips
  const texCache = new Map<string, unknown>();
  const texSet = (name: string, mips: boolean): Record<string, unknown> => {
    const key = `${name}@${mips}`;
    if (texCache.has(key)) return texCache.get(key) as Record<string, unknown>;
    const t = scene.textures[name] as { w: number; h: number; dir: string };
    const raw = (m: string) => new Uint8Array(readFileSync(join(t.dir, `${m}.rgba`)));
    const mk = (b: Uint8Array, f: (o: number) => [number, number, number, number], colorSpace: 'srgb' | 'linear') => { const r = textureFrom(t.w, t.h, (x, y) => f((y * t.w + x) * 4), { colorSpace, mips }); if (!r.ok) throw r.error; void b; return assets.create(r.value).unwrap(); };
    const nb = raw('normal'), ab = raw('albedo'), ob = raw('orm');
    const eb = existsSync(join(t.dir, 'emissive.rgba')) ? raw('emissive') : undefined;
    const set = {
      normal: mk(nb, (o) => [nb[o]! / 255, nb[o + 1]! / 255, nb[o + 2]! / 255, 1], 'linear'),
      albedo: mk(ab, (o) => [lin(ab[o]!), lin(ab[o + 1]!), lin(ab[o + 2]!), ab[o + 3]! / 255], 'srgb'),
      orm: mk(ob, (o) => [ob[o]! / 255, ob[o + 1]! / 255, ob[o + 2]! / 255, 1], 'linear'),
      ...(eb ? { emissive: mk(eb, (o) => [eb[o]! / 255, eb[o + 1]! / 255, eb[o + 2]! / 255, 1], 'linear') } : {}),
    };
    texCache.set(key, set);
    return set;
  };
  type Desc = { color: V3; metallic: number; roughness: number; emissive?: V3; ei?: number; maps?: string; layers?: string[]; alphaCutoff?: number; doubleSided?: boolean; normalScale?: number };
  const matCache = new Map<string, AssetHandle<'material'>>();
  const material = (ref: string, id: boolean): AssetHandle<'material'> => {
    const key = `${ref}#${id}`;
    const hit = matCache.get(key);
    if (hit) return hit;
    const [name, flag] = ref.split('@');
    const d = scene.materials[name!] as Desc;
    if (!d) throw new Error(`material ${name}`);
    const mips = flag === 'mip';
    const o: Record<string, unknown> = { baseColor: id ? [0, 0, 0, 1] : [...d.color, 1], metallic: id ? 0 : d.metallic, roughness: id ? 1 : d.roughness };
    if (!id && d.emissive) { o.emissive = d.emissive; o.emissiveIntensity = d.ei ?? 1; }
    if (d.maps) {
      const t = texSet(d.maps, mips);
      o.baseColorTexture = { texture: t.albedo };
      if (!id) {
        if (d.layers === undefined || d.layers.includes('normal')) o.normalTexture = { texture: t.normal };
        if (d.layers === undefined || d.layers.includes('orm')) { o.metallicRoughnessTexture = { texture: t.orm }; o.occlusionTexture = { texture: t.orm }; }
        if (t.emissive && (d.layers === undefined || d.layers.includes('emissive'))) { o.emissiveTexture = { texture: t.emissive }; o.emissive = [1, 1, 1]; o.emissiveIntensity = d.ei ?? 4; }
        if (d.layers !== undefined && !d.layers.includes('albedo')) delete o.baseColorTexture;
        if (d.normalScale) o.normalScale = [d.normalScale, d.normalScale];
      }
    }
    if (d.alphaCutoff !== undefined) o.alphaCutoff = d.alphaCutoff;
    if (d.doubleSided) o.renderState = { cullMode: 'none' };
    const h = assets.create(Materials.standard(o as never)).unwrap() as AssetHandle<'material'>;
    matCache.set(key, h);
    return h;
  };
  const backdropMat = (color: V3, intensity: number) => assets.create(Materials.standard({ baseColor: [0, 0, 0, 1], metallic: 0, roughness: 1, emissive: color, emissiveIntensity: intensity } as never)).unwrap() as AssetHandle<'material'>;
  const whiteBackdrop = backdropMat([1, 1, 1], 6);
  const shadedBackdrop = scene.backdrop ? backdropMat(scene.backdrop.color, scene.backdrop.intensity) : undefined;
  const quad = assets.create(quadMesh()).unwrap();

  type Light = { direction: V3; color: V3; intensity: number; shadow?: boolean };
  const lights = (scene.lights ?? [{ direction: [-0.45, -0.75, -0.5], color: [1, 0.98, 0.95], intensity: 2.6 }, { direction: [0.6, -0.3, -0.55], color: [0.75, 0.82, 1], intensity: 0.9 }]) as Light[];
  for (const li of lights) world.spawn({ component: DirectionalLight, data: { direction: li.direction, color: li.color, intensity: li.intensity, ...(li.shadow ? { castShadow: true, cascadeCount: 2, shadowDistance: 14, mapSize: 2048 } : {}) } as never }).unwrap();
  const env = assets.create(studioEnvironment().unwrap() as never).unwrap() as unknown as AssetHandle<'equirect'>;
  world.spawn({ component: Skylight, data: { equirect: env, intensity: scene.skylight ?? 1 } as never }).unwrap();
  const v0 = Object.values(scene.views)[0] as { eye: V3; target: V3 };
  const camera = world.spawn({ component: Transform, data: { pos: v0.eye, quat: lookAt(v0.eye, v0.target) } }, { component: Camera, data: { fov: FOV, aspect: W / H, near: 0.02, far: 400, ...(scene.clearColor ? { clearColor: scene.clearColor } : {}) } as never }).unwrap();

  const meshCache = new Map<string, { h: unknown; m: MeshAsset & { aabbArr: number[] } }>();
  // Stage meshes are large: keep high and low resident, release any other mesh before loading the next.
  const meshes = { get: (n: string) => { let e = meshCache.get(n); if (!e) { for (const [k, v] of meshCache) if (k !== 'high' && k !== 'low') { assets.release(v.h as number).unwrap(); meshCache.delete(k); } const m = loadMesh(n); e = { h: assets.create(m).unwrap(), m }; meshCache.set(n, e); } return e; } };
  const bytesPerRow = Math.ceil((W * 4) / 256) * 256;
  let shown: number[] = [];
  let floorMat: AssetHandle<'material'> | undefined;
  const timing: Record<string, number> = {};
  for (const job of scene.jobs as { view: string; variant: string; out: string; jitter?: [number, number]; id?: boolean }[]) {
    if (ONLY && !ONLY.test(job.out)) continue;
    const view = scene.views[job.view] as { eye: V3; target: V3 };
    const f = norm(sub(view.target, view.eye)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
    const dist = Math.hypot(...sub(view.target, view.eye));
    const px = (2 * dist * Math.tan(FOV / 2)) / H;
    const [jx, jy] = job.jitter ?? [0, 0];
    const off: V3 = [r[0] * jx * px + u[0] * jy * px, r[1] * jx * px + u[1] * jy * px, r[2] * jx * px + u[2] * jy * px];
    const eye: V3 = [view.eye[0] + off[0], view.eye[1] + off[1], view.eye[2] + off[2]], tgt: V3 = [view.target[0] + off[0], view.target[1] + off[1], view.target[2] + off[2]];
    world.set(camera, Transform, { pos: eye, quat: lookAt(eye, tgt) } as never);
    for (const e of shown) world.despawn(e as never).unwrap();
    shown = [];
    let far = 0;
    for (const part of scene.variants[job.variant] as { mesh: string; materials: string[] }[]) {
      const mesh = meshes.get(part.mesh)!;
      const b = mesh.m.aabbArr;
      for (const cx of [b[0]!, b[3]!]) for (const cy of [b[1]!, b[4]!]) for (const cz of [b[2]!, b[5]!]) far = Math.max(far, dot(sub([cx, cy, cz], eye), f));
      const mats = part.materials.map((m) => material(m, !!job.id));
      shown.push(world.spawn({ component: Transform, data: { pos: [0, 0, 0] } }, { component: MeshFilter, data: { assetHandle: mesh.h as AssetHandle<'mesh'> } }, { component: MeshRenderer, data: { materials: mats } }).unwrap() as never);
    }
    if (scene.floor && !job.id) {
      const fl = scene.floor as { size: number; color: V3; roughness: number };
      floorMat ??= assets.create(Materials.standard({ baseColor: [...fl.color, 1], metallic: 0, roughness: fl.roughness } as never)).unwrap() as AssetHandle<'material'>;
      shown.push(world.spawn({ component: Transform, data: { pos: [0, 0, 0], quat: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: [fl.size, fl.size, 1] } as never }, { component: MeshFilter, data: { assetHandle: quad } }, { component: MeshRenderer, data: { materials: [floorMat] } }).unwrap() as never);
    }
    const bd = job.id ? whiteBackdrop : shadedBackdrop;
    if (bd) {
      const d = far + 0.5, s = 4 * d * Math.tan(FOV / 2) * (W / H) + 10;
      const c: V3 = [eye[0] + f[0] * d, eye[1] + f[1] * d, eye[2] + f[2] * d];
      shown.push(world.spawn({ component: Transform, data: { pos: c, quat: lookAt([0, 0, 0], [f[0], f[1], f[2]]), scale: [s, s, 1] } as never }, { component: MeshFilter, data: { assetHandle: quad } }, { component: MeshRenderer, data: { materials: [bd] } }).unwrap() as never);
    }
    world.update(1 / 60).unwrap();
    device?.pushErrorScope('validation');
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) await drawReadyFrame(renderer, { leases: [lease], camera: { lease }, environment: { lease } });
    timing[job.out] = Math.round((performance.now() - t0) / 3);
    if (!device || !target) throw new Error('device not captured');
    const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x0001 | 0x0008 });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: H }, [W, H, 1]);
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    await buffer.mapAsync(0x0001);
    const padded = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap(); buffer.destroy();
    const verr = await device.popErrorScope();
    if (verr) throw new Error(`gpu validation: ${verr.message}`);
    const png = new PNG({ width: W, height: H }), bgra = target.format.startsWith('bgra');
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = y * bytesPerRow + x * 4, o = (y * W + x) * 4; png.data[o] = padded[s + (bgra ? 2 : 0)]!; png.data[o + 1] = padded[s + 1]!; png.data[o + 2] = padded[s + (bgra ? 0 : 2)]!; png.data[o + 3] = 255; }
    mkdirSync(join(OUT, job.out, '..'), { recursive: true });
    writeFileSync(join(OUT, `${job.out}.png`), PNG.sync.write(png));
  }
  writeFileSync(join(OUT, `timing${process.env.C410_JOBS ? '-partial' : ''}.json`), JSON.stringify(timing, null, 1));
  await renderer.dispose();
}, 3_600_000);
