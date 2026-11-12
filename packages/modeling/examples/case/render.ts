import {
  type AssetRegistry,
  createCatalogSource,
  createMaterialLoader,
} from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  EditMesh,
  encodeSnapshot,
  type FaceSelector,
  type Model,
  measureUv,
  model,
  NONE,
  type StandardMaterialOptions,
  sel,
  type TextureSink,
} from '@forgeax/engine-modeling';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  Skylight,
} from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { Transform } from '@forgeax/engine-scene';
import type {
  Asset,
  AssetHandle,
  EquirectAsset,
  MaterialAsset,
  MeshAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import {
  buildEngineShaderManifest,
  publishShaderManifest,
} from '@forgeax/engine-vite-plugin-shader';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { createRuntimePackPublication, encodeMaterialProgramWire } from '@forgeax/engine-pack/runtime';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { PNG } from 'pngjs';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import type { RecordedStep } from './record';

/**
 * Shared Dawn harness of the shipped cases: one real Renderer, two
 * directional lights, a camera and one shown mesh whose material slots map to colors.
 * Each render reads back the presented frame as a PNG.
 */
export type Rgb = readonly [number, number, number];
export interface View {
  readonly eye: [number, number, number];
  readonly target: [number, number, number];
}

const LABEL_PALETTE: readonly Rgb[] = [
  [0.9, 0.3, 0.25],
  [0.25, 0.6, 0.9],
  [0.3, 0.75, 0.35],
  [0.95, 0.75, 0.2],
  [0.65, 0.4, 0.85],
  [0.2, 0.8, 0.75],
  [0.95, 0.5, 0.7],
  [0.6, 0.6, 0.25],
  [0.45, 0.45, 0.9],
  [0.85, 0.55, 0.35],
  [0.4, 0.85, 0.55],
  [0.75, 0.25, 0.5],
];

export const CASE_FOV = Math.PI / 5;

function lookAt(eye: [number, number, number], target: [number, number, number]) {
  const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const l = Math.hypot(d[0] as number, d[1] as number, d[2] as number);
  const [x, y, z] = d.map((c) => c / l) as [number, number, number];
  const yaw = Math.atan2(-x, -z);
  const pitch = Math.asin(y);
  const [sy, cy, sp, cp] = [
    Math.sin(yaw / 2),
    Math.cos(yaw / 2),
    Math.sin(pitch / 2),
    Math.cos(pitch / 2),
  ];
  return [cy * sp, sy * cp, -sy * sp, cy * cp] as [number, number, number, number];
}

/** A camera that frames `bounds` from the fixed three-quarter direction. */
export function frame(
  bounds: { readonly min: readonly number[]; readonly max: readonly number[] },
  fov = CASE_FOV,
  direction: readonly number[] = [0.56, 0.42, 0.71],
): View {
  const center = [0, 1, 2].map(
    (k) => ((bounds.min[k] as number) + (bounds.max[k] as number)) / 2,
  ) as [number, number, number];
  const radius =
    Math.hypot(...[0, 1, 2].map((k) => (bounds.max[k] as number) - (bounds.min[k] as number))) /
    2;
  const l = Math.hypot(...direction);
  const distance = (radius / Math.sin(fov / 2)) * 1.02;
  const eye = direction.map((c, k) => (center[k] as number) + (c / l) * distance) as [
    number,
    number,
    number,
  ];
  return { eye, target: center };
}

export function frameModel(m: Model, direction?: readonly number[]): View {
  const bounds = m.bounds(sel.all());
  if (!bounds.ok) throw bounds.error;
  return frame(bounds.value, CASE_FOV, direction);
}

export function frameSnapshot(snapshot: Uint8Array, direction?: readonly number[]): View {
  const state = model();
  state.append(snapshot);
  return frameModel(state, direction);
}

/**
 * A renderable copy of a session state: reloaded from FXEM, with the faces the step
 * touched in the highlight slot, box-projected and auto-smoothed (derived normals only).
 */
export function stateMesh(snapshot: Uint8Array, highlight?: FaceSelector): MeshAsset {
  const view = model();
  view.append(snapshot);
  if (highlight !== undefined && view.count(highlight) > 0) view.assign(highlight, 'highlight');
  view.uv.project({ mode: 'box', scale: 0.5 });
  const out = view.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

/** The final state with one material slot per label that owns faces, for the V-tags view. */
export function labelMesh(m: Model): { mesh: MeshAsset; legend: string[] } {
  const view = model();
  view.append(m.snapshot());
  // A role names the most recent labeled operation, so earlier labels can own no faces.
  const legend = m
    .inspect()
    .labels.filter((l) => Object.values(l.roles).some((n) => n > 0))
    .map((l) => l.label);
  for (const label of legend) view.assign(sel.createdBy(label), `label:${label}`);
  view.uv.project({ mode: 'box', scale: 0.5 });
  const out = view.toMesh({ normals: { mode: 'weighted' } });
  if (!out.ok) throw out.error;
  return { mesh: out.value.mesh, legend };
}

export function highlighted(m: Model, selector: FaceSelector): MeshAsset {
  const view = model();
  view.append(m.snapshot());
  view.assign(selector, 'highlight');
  view.uv.project({ mode: 'box', scale: 0.5 });
  const out = view.toMesh({ normals: { mode: 'weighted' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

/**
 * What a step touched, re-evaluated on its result: faces its label produced, the tag an
 * append gave its part, or its selector (edge selections show their adjacent faces).
 * Deleting steps show nothing.
 */
export function touched(step: RecordedStep): FaceSelector | undefined {
  const label = step.entry.label;
  if (label !== undefined && step.entry.op !== 'append') return sel.createdBy(label);
  if (label !== undefined) return sel.createdBy(label, 'part');
  const tag = (step.entry.args as { tag?: unknown } | undefined)?.tag;
  if (step.entry.op === 'append' && typeof tag === 'string') return sel.tag(tag);
  if (step.entry.op === 'delete' || step.selector === undefined) return undefined;
  const selector = step.selector;
  return selector.domain === 'edge'
    ? (selector as unknown as { toFaces(): FaceSelector }).toFaces()
    : selector.domain === 'face'
      ? (selector as FaceSelector)
      : undefined;
}

/** Slot that renders with the checker texture (V-uv). */
export const CHECKER_SLOT = 'checker';

/**
 * UV test texture: `cells` x `cells` checker squares whose light squares are tinted by
 * position (red grows with u, green with v), so mirroring and rotation are visible.
 */
export function checkerTexture(size = 1024, cells = 32): TextureAsset {
  const data = new Uint8Array(size * size * 4);
  const cell = size / cells;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const light = (cx + cy) % 2 === 0;
      const o = (y * size + x) * 4;
      data[o] = light ? 150 + Math.round((cx / cells) * 105) : 45;
      data[o + 1] = light ? 150 + Math.round((cy / cells) * 105) : 45;
      data[o + 2] = light ? 200 : 55;
      data[o + 3] = 255;
    }
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: size, height: size } },
    format: 'rgba8unorm-srgb',
    colorSpace: 'srgb',
    // Generated mips streak along triangle edges on the lavapipe Dawn path; one level is enough here.
    mips: { kind: 'none' },
    data,
  };
}

/** A session state with its own uv0 on every face, in the checker slot (V-uv). */
export function checkerMesh(snapshot: Uint8Array): MeshAsset {
  const view = model();
  view.append(snapshot);
  view.assign(sel.all(), CHECKER_SLOT);
  const out = view.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

/**
 * The uv0 layout of a session state as flat geometry at (u, v, 0): one material slot
 * per island (`label:island-<i>`, the V-tags palette) over a dark atlas square
 * [0, 1]^2 a little behind it. Rendered head-on with `layoutView`.
 */
export function uvLayoutMesh(snapshot: Uint8Array): {
  mesh: MeshAsset;
  legend: string[];
  /** UV extent of the islands (the unit square not included). */
  bounds: { min: [number, number]; max: [number, number] };
} {
  const source = model();
  source.append(snapshot);
  const mesh = source.editMesh;
  const measured = measureUv(mesh);
  if (!measured.ok) throw measured.error;
  const islands = measured.value.islands.length;
  const legend = Array.from({ length: islands }, (_, i) => `island-${i}`);
  const flat = new EditMesh();
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  const quad = (x0: number, y0: number, x1: number, y1: number, z: number, slot: string) => {
    const loop = [
      flat.addVertex(x0, y0, z),
      flat.addVertex(x1, y0, z),
      flat.addVertex(x1, y1, z),
      flat.addVertex(x0, y1, z),
    ];
    const f = flat.addFace(loop, flat.nameIndex(flat.materialNames, slot)).unwrap();
    for (const h of flat.faceHalves(f)) {
      const p = flat.position(flat.hVert[h] as number);
      flat.setCorner('uv0', h, [p[0], p[1]]);
    }
  };
  quad(-0.01, -0.01, 1.01, 1.01, -0.004, 'atlas-border');
  quad(0, 0, 1, 1, -0.002, 'atlas');
  for (const f of mesh.faces()) {
    const island = measured.value.faceIsland[f] as number;
    if (island === NONE) continue;
    const halves = mesh.faceHalves(f);
    const uv = halves.map((h) => mesh.corner('uv0', h) as Float32Array);
    let area = 0;
    for (let i = 0; i < uv.length; i++) {
      const a = uv[i] as Float32Array;
      const b = uv[(i + 1) % uv.length] as Float32Array;
      area += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number);
    }
    if (!(Math.abs(area) > 1e-14)) continue;
    // Islands overlap in a box projection: lift later islands slightly so each stays visible.
    const z = (island % 64) * 1e-5;
    const ordered = area > 0 ? uv : [...uv].reverse();
    for (const p of uv) {
      for (const k of [0, 1] as const) {
        min[k] = Math.min(min[k], p[k] as number);
        max[k] = Math.max(max[k], p[k] as number);
      }
    }
    const loop = ordered.map((p) => flat.addVertex(p[0] as number, p[1] as number, z));
    const g = flat.addFace(loop, flat.nameIndex(flat.materialNames, `label:island-${island}`));
    if (!g.ok) continue;
    for (const h of flat.faceHalves(g.value)) {
      const p = flat.position(flat.hVert[h] as number);
      flat.setCorner('uv0', h, [p[0], p[1]]);
    }
  }
  const view = model();
  view.append(encodeSnapshot(flat));
  const out = view.toMesh({ normals: { mode: 'flat' } });
  if (!out.ok) throw out.error;
  return { mesh: out.value.mesh, legend, bounds: { min, max } };
}

/** Head-on camera over a UV extent (default the unit square). */
export function layoutView(
  aspect: number,
  bounds: { min: readonly number[]; max: readonly number[] } = { min: [0, 0], max: [1, 1] },
): View {
  const [x0, y0] = bounds.min as [number, number];
  const [x1, y1] = bounds.max as [number, number];
  const half = 0.53 * Math.max(y1 - y0, (x1 - x0) / aspect);
  const distance = half / Math.tan(CASE_FOV / 2);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return { eye: [cx, cy, distance], target: [cx, cy, 0] };
}

export interface CaseRenderer {
  aim(view: View): void;
  /** Draw `frames` completed ready frames (default 3) and read the last one back. */
  /** `extras` draw alongside (overlay lines, analysis meshes); slots `analysis` and `Overlay` are unlit. */
  render(
    mesh: MeshAsset | undefined,
    legend?: readonly string[],
    frames?: number,
    extras?: readonly MeshAsset[],
  ): Promise<PNG>;
  /** Pixels that differ from the empty background. */
  covered(png: PNG): number;
  state(): string;
  dispose(): Promise<void>;
}

/** A case render whose GPU commands failed validation; its pixels would be a stale frame. */
export function caseRenderValidationError(message: string): Error & {
  readonly code: 'case-render-gpu-validation';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly message: string };
} {
  return Object.assign(new Error(`case-render-gpu-validation: ${message.split('\n')[0]}`), {
    code: 'case-render-gpu-validation' as const,
    expected: 'every draw of the case render passes GPU validation',
    hint: 'detail.message names the rejected pipeline or resource; fix the mesh layout or material it names',
    detail: { message },
  });
}

export async function createCaseRenderer(options: {
  readonly width: number;
  readonly height: number;
  readonly slots: Readonly<Record<string, Rgb>>;
  /** Slots rendered metallic. */
  readonly metallic?: readonly string[];
  /** Slots rendered with a full Standard material; its textures become runtime assets. */
  readonly materials?: Readonly<Record<string, (texture: TextureSink) => StandardMaterialOptions>>;
  /** Image-based lighting from an equirect (for example `studioEnvironment()`). */
  readonly environment?: EquirectAsset;
  readonly view: View;
  /** Texture of the `checker` slot (V-uv), sampled with repeat addressing. */
  readonly checker?: TextureAsset;
}): Promise<CaseRenderer> {
  const { width: WIDTH, height: HEIGHT } = options;
  const manifest = await buildEngineShaderManifest();
  const manifestUrl = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          'toJSON' in manifest
            ? manifest
            : publishShaderManifest(manifest.entries, manifest.materialShaders),
        ),
      ],
      { type: 'application/json' },
    ),
  );
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  const gpu = globalThis.navigator.gpu;
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (adapterOptions) => {
    const adapter = await requestAdapter(adapterOptions);
    if (adapter === null) return adapter;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const created = await requestDevice(descriptor);
      device ??= created;
      return created;
    };
    return adapter;
  };
  const canvas = {
    width: WIDTH,
    height: HEIGHT,
    getContext: () => ({
      configure(configuration: GPUCanvasConfiguration) {
        target ??= configuration.device.createTexture({
          size: [WIDTH, HEIGHT],
          format: configuration.format,
          usage: 0x11,
          viewFormats: [
            configuration.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb',
          ],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>>;
  try {
    host = await constructRuntimeRendererHost(canvas, {}, { shaderManifestUrl: manifestUrl });
  } finally {
    gpu.requestAdapter = requestAdapter;
  }
  if (!host.ok) throw host.error;
  // The host's registry shares the Renderer's shader registry, so cooked programs admit.
  const { renderer, assets } = host.value;
  const world = new World();
  world.bindAssets(assets).unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const materials = new Map<string, ReturnType<typeof assets.create>>();
  const material = (color: Rgb, metallic: number) => {
    const key = `${color.join(',')}:${metallic}`;
    let handle = materials.get(key);
    if (handle === undefined) {
      handle = assets.create({
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'forgeax::default-standard-pbr' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: { baseColor: [...color], metallic, roughness: 0.5 },
      });
      materials.set(key, handle);
    }
    return handle.unwrap() as AssetHandle<'material'>;
  };
  const authored = await publishMaterials(assets, options.materials ?? {});
  // Vertex-colored analysis views (zebra, curvature) and overlay lines draw unlit.
  let unlit: AssetHandle<'material'> | undefined;
  const slotMaterial = (name: string, legend: readonly string[]): AssetHandle<'material'> => {
    if (name === 'analysis' || name === 'Overlay') {
      unlit ??= assets.create(Materials.unlit([1, 1, 1, 1])).unwrap() as AssetHandle<'material'>;
      return unlit;
    }
    return (
      authored.get(name) ??
      material(slotColor(name, legend), options.metallic?.includes(name) === true ? 0.6 : 0)
    );
  };
  const checker =
    options.checker === undefined
      ? undefined
      : {
          texture: assets.create(options.checker).unwrap(),
          sampler: assets
            .create({
              kind: 'sampler',
              magFilter: 'linear',
              minFilter: 'linear',
              addressModeU: 'repeat',
              addressModeV: 'repeat',
            })
            .unwrap(),
        };
  let checkerMaterial: AssetHandle<'material'> | undefined;
  const checkered = () => {
    if (checker === undefined) throw new Error('createCaseRenderer: no checker texture');
    checkerMaterial ??= assets
      .create({
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'forgeax::default-standard-pbr' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: { baseColor: [1, 1, 1], metallic: 0, roughness: 0.7, baseColorTexture: checker },
      })
      .unwrap() as AssetHandle<'material'>;
    return checkerMaterial;
  };
  const slotColor = (name: string, legend: readonly string[]): Rgb => {
    if (name.startsWith('label:')) {
      const i = legend.indexOf(name.slice('label:'.length));
      return LABEL_PALETTE[i % LABEL_PALETTE.length] as Rgb;
    }
    return options.slots[name] ?? (options.slots.Default as Rgb);
  };
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [-0.45, -0.75, -0.5], color: [1, 0.98, 0.95], intensity: 2.6 },
    })
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [0.6, -0.3, 0.55], color: [0.75, 0.82, 1], intensity: 0.9 },
    })
    .unwrap();
  if (options.environment !== undefined) {
    const equirect = assets.create(options.environment).unwrap() as AssetHandle<'equirect'>;
    world.spawn({ component: Skylight, data: { equirect, intensity: 1 } as never }).unwrap();
  }
  const camera = world
    .spawn(
      {
        component: Transform,
        data: { pos: options.view.eye, quat: lookAt(options.view.eye, options.view.target) },
      },
      {
        component: Camera,
        data: { fov: CASE_FOV, aspect: WIDTH / HEIGHT, near: 0.01, far: 50 } as never,
      },
    )
    .unwrap();
  let shown: ReturnType<typeof world.spawn> | undefined;
  const shownExtras: ReturnType<ReturnType<typeof world.spawn>['unwrap']>[] = [];
  const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
  const draw = async (
    mesh: MeshAsset | undefined,
    legend: readonly string[] = [],
    frames = 3,
    extras: readonly MeshAsset[] = [],
  ) => {
    if (shown?.ok === true) world.despawn(shown.value).unwrap();
    shown = undefined;
    for (const entity of shownExtras.splice(0)) world.despawn(entity).unwrap();
    for (const extra of extras) {
      const handle = assets.create(extra).unwrap();
      shownExtras.push(
        world
          .spawn(
            { component: Transform, data: { pos: [0, 0, 0] } },
            { component: MeshFilter, data: { assetHandle: handle } },
            {
              component: MeshRenderer,
              data: { materials: extra.materialSlots.map((slot) => slotMaterial(slot.slotName, legend)) },
            },
          )
          .unwrap(),
      );
    }
    if (mesh !== undefined) {
      const handle = assets.create(mesh).unwrap();
      const slots = mesh.materialSlots.map((slot) =>
        slot.slotName === CHECKER_SLOT ? checkered() : slotMaterial(slot.slotName, legend),
      );
      shown = world.spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: handle } },
        { component: MeshRenderer, data: { materials: slots } },
      );
      shown.unwrap();
    }
    world.update(1 / 60).unwrap();
    const lease = attached.value;
    for (let i = 0; i < frames; i++) {
      await drawReadyFrame(renderer, { leases: [lease], camera: { lease }, environment: { lease } });
    }
    if (device === undefined || target === undefined) throw new Error('device not captured');
    const buffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: 0x0001 | 0x0008 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer, bytesPerRow, rowsPerImage: HEIGHT },
      [WIDTH, HEIGHT, 1],
    );
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    await buffer.mapAsync(0x0001);
    const padded = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    const png = new PNG({ width: WIDTH, height: HEIGHT });
    const bgra = target.format.startsWith('bgra');
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const s = y * bytesPerRow + x * 4;
        const o = (y * WIDTH + x) * 4;
        png.data[o] = padded[s + (bgra ? 2 : 0)] as number;
        png.data[o + 1] = padded[s + 1] as number;
        png.data[o + 2] = padded[s + (bgra ? 0 : 2)] as number;
        png.data[o + 3] = 255;
      }
    }
    return png;
  };
  // A draw the GPU rejects leaves the target holding the previous frame: fail the
  // render instead of returning that image as this view's evidence.
  const render: typeof draw = async (...args) => {
    const scoped = device;
    scoped?.pushErrorScope('validation');
    let png: PNG | undefined;
    let failure: unknown;
    try {
      png = await draw(...args);
    } catch (cause) {
      failure = cause;
    }
    const error = await scoped?.popErrorScope();
    if (error != null) throw caseRenderValidationError(error.message);
    if (failure !== undefined || png === undefined) throw failure;
    return png;
  };
  const background = (await render(undefined)).data;
  return {
    aim(view) {
      world.set(camera, Transform, { pos: view.eye, quat: lookAt(view.eye, view.target) } as never);
    },
    render,
    covered(png) {
      let n = 0;
      for (let i = 0; i < png.data.length; i += 4) {
        const d =
          Math.abs((png.data[i] as number) - (background[i] as number)) +
          Math.abs((png.data[i + 1] as number) - (background[i + 1] as number)) +
          Math.abs((png.data[i + 2] as number) - (background[i + 2] as number));
        if (d > 6) n++;
      }
      return n;
    },
    state: () => renderer.inspect().state,
    dispose: async () => {
      await renderer.dispose();
    },
  };
}

const CASE_PACKAGE = definePackageId('01900000-0000-7000-8000-00000000ca5e');
// Native case renderers share the cooker's bounded program roster within this file.
const caseMaterialCooker = createMaterialPackCooker([], { profile: 'webgpu-storage' });

/**
 * Cook the slot materials and publish them with their generated textures through the
 * ordinary Pack publication and catalog, as a built Pack would: optional Standard layers
 * (clearcoat, anisotropy) only render from a cooked specialization.
 * Keep typed artifacts until the source wire encoder can share complete programs.
 */
export async function publishMaterials(
  assets: AssetRegistry,
  recipes: Readonly<Record<string, (texture: TextureSink) => StandardMaterialOptions>>,
): Promise<Map<string, AssetHandle<'material'>>> {
  const handles = new Map<string, AssetHandle<'material'>>();
  if (Object.keys(recipes).length === 0) return handles;
  const guidOf = (key: string) =>
    AssetGuid.format(AssetGuid.derive(CASE_PACKAGE, key));
  const entries: { guid: string; asset: Asset; refs: string[] }[] = [];
  const textures = new Set<string>();
  const texture: TextureSink = (key, asset) => {
    const guid = guidOf(`texture/${key}`);
    if (!textures.has(guid)) {
      textures.add(guid);
      entries.push({ guid, asset, refs: [] });
    }
    return guid;
  };
  const slots: [string, string][] = [];
  for (const [slot, recipe] of Object.entries(recipes)) {
    const guid = guidOf(`material/${slot}`);
    const cooked = await caseMaterialCooker.cook({ guid, source: Materials.standard(recipe(texture)) });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { readonly cooked: unknown }).cooked,
    ).unwrap();
    if (
      record.programs.some(({ selections }) =>
        selections.some(({ context }) =>
          context.backend !== 'webgpu' || context.capability === 'uniform-fallback',
        ),
      )
    ) {
      throw new Error('case renderer requires a storage WebGPU material publication');
    }
    const ready = await createMaterialLoader({
      loadPublication: async () => ({
        guid,
        record,
        artifacts: Object.fromEntries(
          record.programs.map(({ artifact }) => [
            artifact.path,
            { mediaType: artifact.mediaType, bytes: artifact.bytes },
          ]),
        ),
      }),
      loadReference: async () => true,
    }).load({ guid, specializationKey: record.specializationKey ?? '' });
    if (ready.status !== 'Ready') throw new Error(`material ${slot}: ${JSON.stringify(ready)}`);
    const r = ready.record;
    entries.push({
      guid,
      refs: [...r.refs.parent, ...r.refs.textures, ...r.refs.samplers, ...r.refs.modules].filter(
        (reference) => AssetGuid.parse(reference).ok,
      ),
      asset: {
        kind: 'material',
        ...r.resolved,
        cooked: r,
      } as unknown as MaterialAsset,
    });
    slots.push([slot, guid]);
  }
  const packageUrl = 'case-pack://case/pack.json';
  const sourcePath = 'case.pack';
  const publication = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath,
    sourceRevision: 'case',
    packageUrl,
    sourceKeys: new Map(),
    pack: {
      assets: entries.map(({ guid, asset, refs }) => ({
        guid,
        kind: asset.kind,
        payload: asset,
        refs,
        artifacts: {},
      })),
    },
  });
  const body = JSON.stringify(encodeMaterialProgramWire(publication.pack), (_key, value) =>
    ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
  );
  assets.setCatalogSource(
    createCatalogSource({
      entries: entries.map(({ guid, asset }) => ({
        guid,
        kind: asset.kind,
        packageUrl,
        sourcePath,
        publication: publication.publication,
      })),
      fetch: async () => new Response(body),
    }),
  );
  for (const [slot, guid] of slots) {
    const loaded = await assets.load(guid, 'material');
    if (!loaded.ok) throw loaded.error;
    handles.set(slot, loaded.value as AssetHandle<'material'>);
  }
  return handles;
}

/** One history.json step, as examples/CASES.md describes it. */
export function historyStep(step: RecordedStep & { readonly line: number }, n: number) {
  return {
    n,
    session: step.session,
    op: step.entry.op,
    ...(step.entry.label === undefined ? {} : { label: step.entry.label }),
    args: step.entry.args,
    sourceLine: step.line,
    ...(step.selection === undefined ? {} : { selection: step.selection }),
    status: step.entry.status,
    roles: step.entry.roles,
    ...(step.entry.repair === undefined ? {} : { repair: step.entry.repair }),
    result: { verts: step.vertices, edges: step.edges, faces: step.faces },
    diagnostics: step.entry.diagnostics ?? [],
    image: `step-${String(n).padStart(2, '0')}.png`,
    ms: Math.round(step.entry.durationMs * 1000) / 1000,
  };
}
