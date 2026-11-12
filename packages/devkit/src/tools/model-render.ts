import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fitToolPreviewCameraToAabb, workspaceMeshDisplayPlugin } from '@forgeax/engine-app';
import { assetsPlugin } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { encodePng } from '@forgeax/engine-image/png';
import {
  type ColoredTriangles,
  coloredMesh,
  curvatureComb,
  curvatureShading,
  ORTHO_VIEW_NAMES,
  ORTHO_VIEWS,
  type OrthoView,
  OVERLAY_KINDS,
  type OverlayKind,
  surfaceField,
  zebraStripes,
} from '@forgeax/engine-modeling';
import {
  CAPTURE_HEAP_ARG,
  CAPTURE_TIMEOUT_ARG,
  type CaptureReport,
  type CaptureRequest,
  captureRequest,
  confineToRoot,
  HIGHLIGHT_SLOT,
  POSE_ARGS,
  type RenderPayload,
  relativeSources,
  runCapture,
  STEP_ARG,
  XRAY_SLOT,
} from '@forgeax/engine-modeling/tools';
import {
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  Skylight,
} from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { Transform } from '@forgeax/engine-scene';
import {
  type ArtifactRef,
  defineCommand,
  type JsonValue,
  operationCommandPath,
  type ToolContribution,
  type ToolJsonSchema,
  toolJsonSchema,
} from '@forgeax/engine-tool-runtime';
import {
  type AssetHandle,
  isValidAssetGuidString,
  type MaterialAsset,
  type MeshAsset,
  type TextureAsset,
} from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { nodeGpu } from '../node-gpu.js';
import {
  drawGrid,
  drawScaleBar,
  drawViewPolyline,
  formatMeters,
  freeMask,
  niceStep,
  type OrthoMapping,
  SHEET_COLORS,
  SheetCanvas,
  viewToPixel,
  worldToPixel,
} from './model-sheet.js';

type Triple = readonly [number, number, number];
type Bounds = readonly [number, number, number, number, number, number];

/**
 * Closed camera set: unit directions from the subject center to the eye (Y-up,
 * `front` looks along -Z at the +Z face). The six axis views use the modeling
 * kernel's drawing frames, so contours and design drawings line up with them.
 */
export const MODEL_RENDER_VIEWS = {
  ...(Object.fromEntries(
    ORTHO_VIEW_NAMES.map((view) => [view, ORTHO_VIEWS[view].toward]),
  ) as unknown as Record<OrthoView, Triple>),
  iso: [0.56, 0.42, 0.71],
} as const satisfies Record<string, Triple>;
/**
 * A free camera direction: `yaw` (degrees about +Y from the front view; 90 is `right`)
 * with `pitch` (degrees of the eye above the horizon; 90 is `top`), or an explicit
 * `direction` from the subject center to the eye. `name` labels the view and its file.
 */
export interface ModelRenderCamera {
  readonly name?: string;
  readonly yaw?: number;
  readonly pitch?: number;
  readonly direction?: Triple;
}
export type ModelRenderView = OrthoView | 'iso' | ModelRenderCamera;
const DEFAULT_VIEWS: readonly ModelRenderView[] = ['front', 'right', 'top', 'iso'];

const VIEW_NAME = /^[a-z0-9][a-z0-9_.-]*$/;
const fixed = (n: number) => `${Math.round(n * 100) / 100}`;

/** Label and file stem of a view. */
export function viewName(view: ModelRenderView): string {
  if (typeof view === 'string') return view;
  if (view.name !== undefined) return view.name;
  if (view.direction !== undefined) return `dir-${view.direction.map(fixed).join('_')}`;
  return `yaw${fixed(view.yaw ?? 0)}-pitch${fixed(view.pitch ?? 0)}`;
}

/** Why a view is malformed, or undefined when it is a named view or a well-formed camera. */
export function viewProblem(view: unknown): string | undefined {
  if (typeof view === 'string') {
    return Object.hasOwn(MODEL_RENDER_VIEWS, view)
      ? undefined
      : `a named view is one of ${Object.keys(MODEL_RENDER_VIEWS).join(', ')}`;
  }
  if (view === null || typeof view !== 'object' || Array.isArray(view))
    return 'a view is a name or a { yaw, pitch } / { direction } camera';
  const v = view as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!['name', 'yaw', 'pitch', 'direction'].includes(key))
      return `a camera has only name, yaw, pitch or direction (not ${key})`;
  }
  if (v.name !== undefined && (typeof v.name !== 'string' || !VIEW_NAME.test(v.name)))
    return 'a camera name is a lowercase file-name segment';
  const angles = v.yaw !== undefined || v.pitch !== undefined;
  if (angles === (v.direction !== undefined))
    return 'a camera gives either yaw and pitch or a direction';
  if (v.direction !== undefined) {
    const d = v.direction;
    if (
      !Array.isArray(d) ||
      d.length !== 3 ||
      !d.every((n) => typeof n === 'number' && Number.isFinite(n))
    )
      return 'direction is three finite numbers';
    if (Math.hypot(...(d as number[])) < 1e-9) return 'direction is not zero';
    return undefined;
  }
  for (const key of ['yaw', 'pitch'] as const) {
    const n = v[key] ?? 0;
    if (typeof n !== 'number' || !Number.isFinite(n)) return `${key} is a finite number of degrees`;
  }
  if (Math.abs((v.pitch as number | undefined) ?? 0) > 90)
    return 'pitch is within [-90, 90] degrees';
  return undefined;
}

/** A failure for the first malformed or duplicated view, if any. */
function checkViews(views: readonly unknown[]): Failure | undefined {
  const names = new Set<string>();
  for (const [index, view] of views.entries()) {
    const problem = viewProblem(view);
    if (problem !== undefined)
      return fail(
        'tool-invalid-args',
        problem,
        'pass named views or { name?, yaw, pitch } / { name?, direction } cameras',
        { index, view: view as JsonValue },
      );
    const name = viewName(view as ModelRenderView);
    if (names.has(name))
      return fail('tool-invalid-args', 'view names are unique', 'give each camera its own name', {
        index,
        name,
      });
    names.add(name);
  }
  return undefined;
}

const ANALYSIS_MODES = ['zebra', 'curvature-gaussian', 'curvature-mean'] as const;
const MATERIALS_MODES = ['auto', 'palette'] as const;

const FOV = Math.PI / 5;
/** Share of each side an orthographic sheet keeps free for dimension lines. */
const ORTHO_MARGIN = 0.14;
const CLEAR: readonly [number, number, number, number] = [0.11, 0.12, 0.14, 1];
const SLOT_PALETTE: readonly (readonly [number, number, number])[] = [
  [0.62, 0.64, 0.66],
  [0.3, 0.45, 0.62],
  [0.78, 0.52, 0.22],
  [0.32, 0.55, 0.36],
  [0.55, 0.38, 0.62],
  [0.7, 0.66, 0.4],
];
const HIGHLIGHT_COLOR: readonly [number, number, number] = [0.95, 0.2, 0.55];
const XRAY_COLOR: readonly [number, number, number, number] = [0.45, 0.7, 1, 0.16];
const SECTION_CAP: readonly [number, number, number, number] = [0.8, 0.06, 0.04, 1];
const SECTION_LINE: readonly [number, number, number, number] = [0.02, 0.005, 0.005, 1];
const ALPHA_BLEND = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
} as const;

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 } as const;

const commonArgs = {
  source: {
    type: 'string',
    description: 'Project-relative .pack.ts path whose build() uses model()',
  },
  values: {
    type: 'object',
    description: 'Parameter overrides; defaults come from the Pack declaration',
  },
  session: {
    type: 'integer',
    minimum: 0,
    description:
      'Captured session; default is the only session, else the one whose finish() produced the output',
  },
  timeoutMs: CAPTURE_TIMEOUT_ARG,
  heapMb: CAPTURE_HEAP_ARG,
  projection: {
    enum: ['orthographic', 'perspective'],
    description:
      'Camera lens (default orthographic: every view on one pixels-per-meter scale, true front/side/top drawings)',
  },
  scale: {
    type: 'number',
    exclusiveMinimum: 0,
    description:
      'Orthographic pixels per meter; default fits the subject (or --frame) into every view',
  },
  width: {
    type: 'integer',
    minimum: 64,
    maximum: 2048,
    description: 'Width of each view',
  },
  height: {
    type: 'integer',
    minimum: 64,
    maximum: 2048,
    description: 'Height of each view',
  },
  output: {
    type: 'string',
    description: 'Also copy the contact sheet PNG to this project-relative path',
  },
  frame: {
    type: 'array',
    items: { type: 'number' },
    minItems: 6,
    maxItems: 6,
    description:
      'Frame these bounds [minX, minY, minZ, maxX, maxY, maxZ] instead of the subject, so renders of different states or parameters share one camera',
  },
} as const;

const argsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source'],
  properties: {
    ...commonArgs,
    checkpoint: {
      type: 'string',
      description: 'Name passed to m.checkpoint(); default is the final state',
    },
    step: STEP_ARG,
    ...POSE_ARGS,
    selector: {
      type: 'string',
      description:
        'sel.* expression whose faces (edges: adjacent faces) render in the magenta highlight slot',
    },
    views: {
      type: 'array',
      items: { type: ['string', 'object'] },
      minItems: 1,
      uniqueItems: true,
      description:
        'Camera set, in sheet order (default front, right, top, iso): named views (front, back, left, right, top, bottom, iso) or free cameras { name?, yaw, pitch } (degrees: yaw about +Y from front, 90 = right; pitch = eye above the horizon, 90 = top) or { name?, direction: [x, y, z] } (subject to eye); orthographic cameras share the one pixels-per-meter scale',
    },
    materials: {
      enum: [...MATERIALS_MODES],
      description:
        "Surface materials (default palette): palette colors every slot; auto binds the Pack's own material/<slotName> output to the slot of the same name (same-Pack textures included) and keeps the palette color for slots without one. The result lists materialBinding per slot (pack, palette or reserved for the highlight and xray slots)",
    },
    mode: {
      enum: ['material', 'wireframe', ...ANALYSIS_MODES],
      description:
        "Display mode (default material): wireframe, or a surface-quality view: zebra (reflected parallel light stripes, view dependent), curvature-gaussian or curvature-mean (diverging blue-white-red shading). Surface views evaluate the session's NURBS patches exactly where render vertices lie on them and fall back to a quadric fit on the mesh elsewhere",
    },
    zebra: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'number', exclusiveMinimum: 0, maximum: 90 },
        orientation: { type: 'number' },
        refine: { type: 'integer', minimum: 0, maximum: 6 },
      },
      description:
        'Zebra stripes: angular stripe width in degrees (default 4), stripe direction in degrees from screen right (default 0), subdivision depth where stripes crowd (default 3)',
    },
    curvature: {
      type: 'object',
      additionalProperties: false,
      properties: { range: { type: 'number', exclusiveMinimum: 0 } },
      description:
        'Curvature shading: value at the ends of the diverging map (1/m^2 Gaussian, 1/m mean); default the 95th percentile of |value| in the scene. Pass one range to compare renders',
    },
    combs: {
      type: ['boolean', 'object'],
      properties: {
        scale: { type: 'number', exclusiveMinimum: 0 },
        samples: { type: 'integer', minimum: 2, maximum: 1024 },
      },
      description:
        'Curvature combs of the session feature lines (m.featureLine) as an overlay: true, or { scale (tooth meters per 1/m, default longest tooth 15 % of the line), samples (default 64) }',
    },
    overlays: {
      type: 'array',
      items: { enum: [...OVERLAY_KINDS] },
      uniqueItems: true,
      description:
        'Diagnostic overlays drawn through the preview display (tags, roles, elementIds, sharp, seams, normals, edges). edges is V-wire: every n-gon edge over the shaded body; with --frame only the edges inside the close-up frame',
    },
    annotate: {
      type: 'boolean',
      description:
        'Orthographic drawing sheet (default true): grid, scale bar, extent dimensions, design drawing curves and dimensions, extruded contours and --measure spans',
    },
    measure: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to'],
        properties: { from: vec3, to: vec3, label: { type: 'string', maxLength: 40 } },
      },
      description:
        'World spans drawn as dimension lines in every orthographic view: true length in iso and for spans parallel to an axis view, else projected length with the 3D length',
    },
    xray: {
      type: 'string',
      description:
        'sel.* expression of an outer shell drawn see-through, so inner parts stay visible',
    },
    explode: {
      type: 'object',
      additionalProperties: false,
      required: ['by', 'distance'],
      properties: {
        by: { enum: ['tag', 'label', 'material', 'island'] },
        distance: { type: 'number', minimum: 0 },
        directions: { type: 'object', additionalProperties: vec3 },
      },
      description:
        'Exploded view: parts (faces grouped by tag, label, material or connected island) move apart by distance, along authored directions or away from the center',
    },
    section: {
      type: 'object',
      additionalProperties: false,
      required: ['point', 'normal'],
      properties: {
        point: vec3,
        normal: vec3,
        spacing: { type: 'number', exclusiveMinimum: 0 },
        angle: { type: 'number' },
      },
      description:
        'Section view: cut at the plane, keep the side opposite normal, cap the cut (even-odd, holes stay open) and hatch it; look from the normal side',
    },
  },
} as const;

const replaySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source'],
  properties: {
    ...commonArgs,
    steps: {
      type: 'array',
      items: { type: 'integer', minimum: 0 },
      minItems: 1,
      maxItems: 64,
      description:
        'Operation indices (model.history opIndex) to show, in order; default every successful operation that leaves faces, sampled to 64',
    },
    view: {
      type: ['string', 'object'],
      description:
        'Camera of every frame (default iso): a named view or a free camera { name?, yaw, pitch } / { name?, direction }',
    },
  },
} as const;

interface MeasureSpan {
  readonly from: Triple;
  readonly to: Triple;
  readonly label?: string;
}

interface CommonArgs {
  readonly projection?: 'orthographic' | 'perspective';
  readonly scale?: number;
  readonly width?: number;
  readonly height?: number;
  readonly output?: string;
  readonly frame?: Bounds;
}

type AnalysisMode = (typeof ANALYSIS_MODES)[number];

interface RenderArgs extends CommonArgs {
  readonly views?: readonly ModelRenderView[];
  readonly materials?: (typeof MATERIALS_MODES)[number];
  readonly mode?: 'material' | 'wireframe' | AnalysisMode;
  readonly zebra?: {
    readonly width?: number;
    readonly orientation?: number;
    readonly refine?: number;
  };
  readonly curvature?: { readonly range?: number };
  readonly combs?: boolean | { readonly scale?: number; readonly samples?: number };
  readonly overlays?: readonly OverlayKind[];
  readonly annotate?: boolean;
  readonly measure?: readonly MeasureSpan[];
  readonly xray?: string;
  readonly explode?: CaptureRequest['explode'];
  readonly section?: CaptureRequest['section'];
}

interface ReplayArgs extends CommonArgs {
  readonly steps?: readonly number[];
  readonly view?: ModelRenderView;
}

type Failure = {
  readonly ok: false;
  readonly error: { code: string; expected: string; hint: string; detail?: JsonValue };
};

function fail(code: string, expected: string, hint: string, detail?: unknown): Failure {
  return {
    ok: false,
    error: {
      code,
      expected,
      hint,
      ...(detail === undefined ? {} : { detail: detail as JsonValue }),
    },
  };
}

const sub3 = (a: Triple, b: Triple): Triple => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Triple, b: Triple) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Triple, b: Triple): Triple => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize3 = (a: Triple): Triple => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Unit direction from the subject center to the eye. */
export function viewDirection(view: ModelRenderView): Triple {
  if (typeof view === 'string') return normalize3(MODEL_RENDER_VIEWS[view]);
  if (view.direction !== undefined) return normalize3(view.direction);
  const yaw = ((view.yaw ?? 0) * Math.PI) / 180;
  const pitch = ((view.pitch ?? 0) * Math.PI) / 180;
  return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
}

/**
 * Drawing frame of a view: the kernel frame for axis views, otherwise a level camera
 * (screen right horizontal, up toward +Y); straight down or up keeps the top/bottom
 * frame turned by the yaw.
 */
export function viewFrame(view: ModelRenderView): { right: Triple; up: Triple; toward: Triple } {
  if (typeof view === 'string' && view !== 'iso') return ORTHO_VIEWS[view];
  const toward = viewDirection(view);
  const level = cross3([0, 1, 0], toward);
  if (Math.hypot(...level) < 1e-9) {
    const yaw = typeof view === 'object' ? ((view.yaw ?? 0) * Math.PI) / 180 : 0;
    const right: Triple = [Math.cos(yaw), 0, -Math.sin(yaw)];
    return { right, up: cross3(toward, right), toward };
  }
  const right = normalize3(level);
  return { right, up: cross3(toward, right), toward };
}

/** Rotation taking camera +X/+Y/+Z to right/up/toward, as an `[x, y, z, w]` quaternion. */
export function frameQuaternion(frame: {
  right: Triple;
  up: Triple;
  toward: Triple;
}): [number, number, number, number] {
  const [m00, m10, m20] = frame.right;
  const [m01, m11, m21] = frame.up;
  const [m02, m12, m22] = frame.toward;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
}

const corners = (b: Bounds): Triple[] =>
  [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [
    i & 1 ? b[3] : b[0],
    i & 2 ? b[4] : b[1],
    i & 4 ? b[5] : b[2],
  ]);

/** One pixels-per-meter for every view: the largest scale that fits the bounds into all of them. */
export function orthoScale(
  bounds: Bounds,
  views: readonly ModelRenderView[],
  width: number,
  height: number,
): number {
  let scale = Infinity;
  for (const view of views) {
    const f = viewFrame(view);
    const us = corners(bounds).map((p) => dot3(p, f.right));
    const vs = corners(bounds).map((p) => dot3(p, f.up));
    const du = Math.max(Math.max(...us) - Math.min(...us), 1e-6);
    const dv = Math.max(Math.max(...vs) - Math.min(...vs), 1e-6);
    scale = Math.min(
      scale,
      (width * (1 - 2 * ORTHO_MARGIN)) / du,
      (height * (1 - 2 * ORTHO_MARGIN)) / dv,
    );
  }
  return scale;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Offscreen canvas whose swap texture is readable; `configure` hands over the device. */
function offscreenTarget(width: number, height: number) {
  let device: GPUDevice | undefined;
  let texture: GPUTexture | undefined;
  const errors: string[] = [];
  return {
    errors,
    canvas: {
      width,
      height,
      getContext: () => ({
        configure(options: GPUCanvasConfiguration) {
          if (device !== options.device)
            options.device.addEventListener('uncapturederror', (event) => {
              if (errors.length < 8)
                errors.push((event as GPUUncapturedErrorEvent).error.message.split('\n')[0] ?? '');
            });
          device = options.device;
          texture?.destroy();
          texture = options.device.createTexture({
            size: [width, height],
            format: options.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          });
        },
        unconfigure() {},
        getCurrentTexture: () => texture,
      }),
      addEventListener() {},
      removeEventListener() {},
    },
    async read(): Promise<Uint8Array> {
      if (device === undefined || texture === undefined)
        throw new Error('render target was never configured');
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const buffer = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, [
        width,
        height,
        1,
      ]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const padded = new Uint8Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      buffer.destroy();
      const bgra = texture.format.startsWith('bgra');
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const s = y * bytesPerRow + x * 4;
          const o = (y * width + x) * 4;
          rgba[o] = padded[s + (bgra ? 2 : 0)] as number;
          rgba[o + 1] = padded[s + 1] as number;
          rgba[o + 2] = padded[s + (bgra ? 0 : 2)] as number;
          rgba[o + 3] = 255;
        }
      return rgba;
    },
    /** Retire the target and its device; Dawn keeps the process alive while a device lives. */
    async destroy() {
      texture?.destroy();
      if (device === undefined) return;
      device.destroy();
      await device.queue.onSubmittedWorkDone().catch(() => undefined);
    },
  };
}

/** Share of pixels that differ from the clear color: the per-view falsifier. */
function coverage(rgba: Uint8Array, background: Uint8Array): number {
  const free = freeMask(rgba, background);
  let covered = 0;
  for (const p of free) if (p === 0) covered++;
  return Math.round((covered / free.length) * 10_000) / 10_000;
}

function sheetLayout(
  count: number,
  width: number,
  height: number,
  columns = Math.ceil(Math.sqrt(count)),
) {
  const rows = Math.ceil(count / columns);
  const gutter = 4;
  return {
    width: columns * width + (columns - 1) * gutter,
    height: rows * height + (rows - 1) * gutter,
    tiles: Array.from({ length: count }, (_, i) => ({
      x: (i % columns) * (width + gutter),
      y: Math.floor(i / columns) * (height + gutter),
      width,
      height,
    })),
  };
}

type Renderer = Extract<
  Awaited<ReturnType<typeof constructRuntimeRendererHost>>,
  { ok: true }
>['value']['renderer'];

/** Submit until the scene picture is ready (pipelines compile asynchronously). */
async function drawReady(
  renderer: Renderer,
  request: Parameters<Renderer['draw']>[0],
): Promise<void> {
  const deadline = Date.now() + 30_000;
  do {
    const submitted = renderer.draw(request);
    if (!submitted.ok) throw submitted.error;
    const completed = await submitted.value.completed;
    if (!completed.ok) throw completed.error;
    if (submitted.value.presentation === 'ready') return;
    await new Promise((done) => setTimeout(done, 0));
  } while (Date.now() < deadline);
  throw new Error('model render: the scene picture did not become ready within 30 s');
}

interface Overlay {
  readonly topology: 'triangle-list' | 'line-list';
  readonly positions: readonly number[];
  readonly colors: readonly number[];
}

/**
 * A surface-quality view replacing the subject's materials: vertex-colored triangles
 * drawn unlit, built once (curvature) or for each camera (zebra reflects the view ray).
 */
interface Analysis {
  readonly colored: (camera: PlacedCamera) => ColoredTriangles | Failure;
  readonly perCamera: boolean;
}

/** One subject drawn from every camera: a session state with its display overlays. */
interface RenderState {
  readonly mesh: MeshAsset;
  readonly mode: 'material' | 'wireframe';
  readonly overlays: Readonly<Record<string, Overlay>>;
  readonly analysis?: Analysis;
}

interface CameraSet {
  readonly views: readonly ModelRenderView[];
  readonly width: number;
  readonly height: number;
  readonly projection: 'orthographic' | 'perspective';
  readonly bounds: Bounds;
  readonly scale?: number;
}

interface PlacedCamera {
  readonly view: ModelRenderView;
  readonly eye: number[];
  readonly target: readonly number[];
  readonly mapping?: OrthoMapping;
}

function placeCameras(set: CameraSet) {
  const b = set.bounds;
  const center: Triple = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
  const radius = Math.max(Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2, 1e-3);
  if (set.projection === 'perspective') {
    const fit = fitToolPreviewCameraToAabb(b, { aspect: set.width / set.height, fov: FOV });
    const cameras: PlacedCamera[] = set.views.map((view) => {
      const t = viewFrame(view).toward;
      return {
        view,
        eye: fit.center.map((c, k) => c + (t[k] as number) * fit.distance),
        target: fit.center,
      };
    });
    return {
      cameras,
      camera: { fov: FOV, aspect: set.width / set.height, near: fit.near, far: fit.far },
      frame: {
        projection: 'perspective',
        fov: FOV,
        distance: fit.distance,
        radius: fit.radius,
        bounds: b,
      },
    } as const;
  }
  const pixelsPerMeter = set.scale ?? orthoScale(b, set.views, set.width, set.height);
  const distance = radius * 2 + 1;
  const halfW = set.width / 2 / pixelsPerMeter;
  const halfH = set.height / 2 / pixelsPerMeter;
  const cameras: PlacedCamera[] = set.views.map((view) => {
    const f = viewFrame(view);
    return {
      view,
      eye: center.map((c, k) => c + (f.toward[k] as number) * distance),
      target: center,
      mapping: {
        width: set.width,
        height: set.height,
        pixelsPerMeter,
        center,
        right: f.right,
        up: f.up,
      },
    };
  });
  return {
    cameras,
    camera: {
      projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
      left: -halfW,
      right: halfW,
      bottom: -halfH,
      top: halfH,
      aspect: set.width / set.height,
      near: Math.max(distance - radius * 1.5, 1e-3),
      far: distance + radius * 1.5,
    },
    frame: { projection: 'orthographic', pixelsPerMeter, radius, bounds: b },
  } as const;
}

type PackMaterials = NonNullable<CaptureReport['materials']>;

/** Where a slot's material comes from: the Pack, the renderer palette, or the renderer itself. */
export type MaterialSource = 'pack' | 'palette' | 'reserved';

export interface MaterialBinding {
  readonly slot: string;
  readonly source: MaterialSource;
}

/** The Pack materials bound by `--materials auto`, and the textures their GUIDs resolve to. */
export interface MaterialPlan {
  readonly packed: ReadonlyMap<string, MaterialAsset>;
  readonly textures: PackMaterials['textures'];
}

const isReservedSlot = (slot: string) => slot === HIGHLIGHT_SLOT || slot === XRAY_SLOT;

function slotSource(slot: string, plan: MaterialPlan | undefined): MaterialSource {
  if (isReservedSlot(slot)) return 'reserved';
  return plan?.packed.has(slot) === true ? 'pack' : 'palette';
}

/**
 * Copy `value` with every GUID string replaced by `resolve(guid)`; the first GUID with
 * no resolution is returned instead. Typed arrays and other non-plain values pass through.
 */
function mapGuids(
  value: unknown,
  resolve: (guid: string) => unknown,
): { readonly value: unknown } | { readonly unresolved: string } {
  if (typeof value === 'string' && isValidAssetGuidString(value)) {
    const resolved = resolve(value);
    return resolved === undefined ? { unresolved: value } : { value: resolved };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const mapped = mapGuids(item, resolve);
      if ('unresolved' in mapped) return mapped;
      out.push(mapped.value);
    }
    return { value: out };
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const mapped = mapGuids(item, resolve);
      if ('unresolved' in mapped) return mapped;
      out[key] = mapped.value;
    }
    return { value: out };
  }
  return { value };
}

/**
 * The Pack material with its texture GUIDs rewritten by `texture`. GUIDs outside `values`
 * (a parent material, a custom shader module) are not same-Pack textures and never resolve.
 */
function bindMaterial(
  material: MaterialAsset,
  texture: (guid: string) => unknown,
): { readonly value: MaterialAsset } | { readonly unresolved: string } {
  const { values, ...rest } = material as MaterialAsset & { readonly values?: unknown };
  const stray = mapGuids(rest, () => undefined);
  if ('unresolved' in stray) return stray;
  if (values === undefined) return { value: material };
  const mapped = mapGuids(values, texture);
  if ('unresolved' in mapped) return mapped;
  return { value: { ...material, values: mapped.value } as MaterialAsset };
}

/** The source of each distinct slot name, in first-use order. */
export function materialBindingOf(
  slots: readonly string[],
  plan: MaterialPlan | undefined,
): MaterialBinding[] {
  return [...new Set(slots)].map((slot) => ({ slot, source: slotSource(slot, plan) }));
}

function packedMaterial(material: MaterialAsset, texture: (guid: string) => unknown) {
  const bound = bindMaterial(material, texture);
  if ('unresolved' in bound) throw new Error(`unplanned GUID ${bound.unresolved}`);
  return bound.value;
}

/**
 * Select the Pack materials the model slots bind. Every GUID a bound material holds must be
 * a same-Pack texture of the capture; any other fails the render with the slot and GUID.
 */
export function planMaterials(slots: readonly string[], pack: PackMaterials | undefined) {
  const packed = new Map<string, MaterialAsset>();
  const textures = pack?.textures ?? {};
  for (const slot of slots) {
    if (pack === undefined || isReservedSlot(slot) || !Object.hasOwn(pack.materials, slot))
      continue;
    const material = pack.materials[slot] as MaterialAsset;
    const checked = bindMaterial(material, (guid) =>
      Object.hasOwn(textures, guid) ? guid : undefined,
    );
    if ('unresolved' in checked)
      return fail(
        'model-render-material-load-failed',
        'every GUID of a bound Pack material is a texture output of the same Pack',
        `emit texture/<key> from the Pack and reference it by its derived GUID, or drop the cross-Pack reference from material/${slot}; use --materials palette to ignore Pack materials`,
        { slot, guid: checked.unresolved },
      );
    packed.set(slot, material);
  }
  return { packed, textures } satisfies MaterialPlan;
}

/** The adapter strings WebGPU exposes (`GPUAdapterInfo`), as reported by the selected backend. */
export interface RendererAdapter {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
}

/** Which RHI backend drew the images, on which adapter, and whether that adapter is a CPU rasterizer. */
export interface RendererFacts {
  readonly backend: string;
  readonly adapter: RendererAdapter;
  readonly software: boolean;
}

const SOFTWARE_ADAPTER_MARKERS = ['llvmpipe', 'lavapipe', 'swiftshader'] as const;

/** True for the CPU rasterizers (Lavapipe, SwiftShader) whose pixels differ from a GPU's (F-23). */
export function isSoftwareAdapter(info: RendererAdapter): boolean {
  const text =
    `${info.vendor} ${info.architecture} ${info.device} ${info.description}`.toLowerCase();
  return SOFTWARE_ADAPTER_MARKERS.some((marker) => text.includes(marker));
}

async function renderStates(
  gpu: GPU,
  states: readonly RenderState[],
  set: CameraSet,
  signal: AbortSignal | undefined,
  plan?: MaterialPlan,
): Promise<
  | {
      readonly ok: true;
      readonly value: {
        readonly materialBinding: readonly MaterialBinding[];
        readonly images: Uint8Array[][];
        readonly background: Uint8Array;
        readonly coverage: number[][];
        readonly cameras: PlacedCamera[];
        readonly frame: ReturnType<typeof placeCameras>['frame'];
        readonly renderer: RendererFacts;
      };
    }
  | Failure
> {
  const { width, height } = set;
  const target = offscreenTarget(width, height);
  const { requestAdapterFrom, rhi } = await import('@forgeax/engine-rhi-webgpu');
  const manifest = await buildEngineShaderManifest();
  const manifestText = JSON.stringify(manifest);
  // The Renderer asks the explicit GPU for its adapter; keep the info of that very request.
  let adapterInfo: Partial<GPUAdapterInfo> | undefined;
  const host = await constructRuntimeRendererHost(
    target.canvas,
    {
      rhi: {
        ...rhi,
        requestAdapter: (options?: Parameters<typeof requestAdapterFrom>[1]) =>
          requestAdapterFrom(
            {
              requestAdapter: async (opts: unknown) => {
                const adapter = await gpu.requestAdapter(opts as GPURequestAdapterOptions);
                adapterInfo = adapter?.info;
                return adapter;
              },
            } as never,
            options,
          ),
      },
    } as never,
    {
      shaderManifestUrl: 'forgeax-model-render:/shaders/manifest.json',
      readShaderManifest: async () => manifestText,
    },
  );
  if (!host.ok)
    return fail(
      'model-render-backend-unavailable',
      'the Engine Renderer starts on the Node GPU',
      'inspect detail',
      { cause: String(host.error) },
    );
  const initialized = await host.value.initialization;
  if (!initialized.ok)
    return fail(
      'model-render-backend-unavailable',
      'the Engine Renderer initializes',
      'inspect detail',
      { cause: String(initialized.error) },
    );
  const { renderer, assets } = host.value;
  const adapter: RendererAdapter = {
    vendor: adapterInfo?.vendor ?? '',
    architecture: adapterInfo?.architecture ?? '',
    device: adapterInfo?.device ?? '',
    description: adapterInfo?.description ?? '',
  };
  const facts: RendererFacts = {
    backend: renderer.inspect().capabilities.backendKind,
    adapter,
    software: isSoftwareAdapter(adapter),
  };
  // Renderer errors and uncaptured device (validation) errors fail the render
  // instead of only reaching the console.
  const gpuErrors = target.errors;
  const stopErrors = renderer.subscribe((event) => {
    if (event.kind === 'error' && gpuErrors.length < 8)
      gpuErrors.push(`${event.error.code}: ${event.error.message}`);
  });
  try {
    const world = new World({ assets });
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
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
    world.spawn({ component: Skylight, data: { color: [1, 1, 1], intensity: 0.2 } }).unwrap();
    const context = await createWorldContext(world, [assetsPlugin(assets)]);
    try {
      const placed = placeCameras(set);
      const camera = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 1] } },
          { component: Camera, data: { ...placed.camera, clearColor: [...CLEAR] } as never },
        )
        .unwrap();
      const draw = async () => {
        world.update(1 / 60).unwrap();
        for (let i = 0; i < 2; i++)
          await drawReady(renderer, {
            leases: [lease],
            camera: { lease },
            environment: { lease },
          } as never);
        return target.read();
      };
      const background = await draw();
      // Colors follow slot names in first-use order across all states, so a replay
      // keeps each slot's color while slots appear.
      const palette = new Map<string, number>();
      for (const state of states)
        for (const slot of state.mesh.materialSlots)
          if (
            slot.slotName !== HIGHLIGHT_SLOT &&
            slot.slotName !== XRAY_SLOT &&
            !palette.has(slot.slotName)
          )
            palette.set(slot.slotName, palette.size);
      const materialBinding = materialBindingOf(
        states.flatMap((state) => state.mesh.materialSlots.map((slot) => slot.slotName)),
        plan,
      );
      // Same-Pack textures load once for every state; materials hold them until released.
      const textureHandles = new Map<string, AssetHandle<'texture'>>();
      const textureOf = (guid: string) => {
        let handle = textureHandles.get(guid);
        if (handle === undefined) {
          handle = assets
            .create(plan?.textures[guid] as TextureAsset)
            .unwrap() as AssetHandle<'texture'>;
          textureHandles.set(guid, handle);
        }
        return handle;
      };
      const images: Uint8Array[][] = [];
      for (const state of states) {
        const slots = state.mesh.materialSlots.map(
          (slot) =>
            assets
              .create(
                slotSource(slot.slotName, plan) === 'pack'
                  ? packedMaterial(plan?.packed.get(slot.slotName) as MaterialAsset, textureOf)
                  : slot.slotName === XRAY_SLOT
                    ? Materials.standard({
                        baseColor: [...XRAY_COLOR],
                        metallic: 0,
                        roughness: 0.4,
                        renderState: {
                          blend: ALPHA_BLEND,
                          depthWriteEnabled: false,
                          cullMode: 'none',
                        },
                        queue: 3000,
                      })
                    : Materials.standard({
                        baseColor: [
                          ...(slot.slotName === HIGHLIGHT_SLOT
                            ? HIGHLIGHT_COLOR
                            : (SLOT_PALETTE[
                                (palette.get(slot.slotName) ?? 0) % SLOT_PALETTE.length
                              ] as Triple)),
                          1,
                        ] as [number, number, number, number],
                        metallic: 0,
                        roughness: 0.55,
                      }),
              )
              .unwrap() as AssetHandle<'material'>,
        );
        const meshHandle = assets.create(state.mesh).unwrap();
        const subject = world
          .spawn(
            { component: Transform, data: { pos: [0, 0, 0] } },
            { component: MeshFilter, data: { assetHandle: meshHandle } },
            { component: MeshRenderer, data: { materials: slots } },
          )
          .unwrap();
        const unlit =
          state.analysis === undefined
            ? undefined
            : (assets.create(Materials.unlit([1, 1, 1, 1])).unwrap() as AssetHandle<'material'>);
        let analysisMesh: AssetHandle<'mesh'> | undefined;
        // The analysis triangles replace the subject's geometry; the preview display keeps
        // the subject for wireframe and overlays.
        const showAnalysis = (placement: PlacedCamera) => {
          if (state.analysis === undefined || unlit === undefined) return;
          if (analysisMesh !== undefined && !state.analysis.perCamera) return;
          const colored = state.analysis.colored(placement);
          if ('ok' in colored) throw new AnalysisFailure(colored);
          const asset = coloredMesh(colored);
          if (!asset.ok) throw asset.error;
          const previous = analysisMesh;
          analysisMesh = assets.create(asset.value).unwrap() as AssetHandle<'mesh'>;
          world.set(subject, MeshFilter, { assetHandle: analysisMesh } as never);
          world.set(subject, MeshRenderer, { materials: [unlit] } as never);
          if (previous !== undefined) assets.release(previous).unwrap();
        };
        const decorated = state.mode === 'wireframe' || Object.keys(state.overlays).length > 0;
        const fiber = decorated
          ? context.plugin(workspaceMeshDisplayPlugin, { mesh: state.mesh, entity: subject })
          : undefined;
        try {
          if (fiber !== undefined) {
            await fiber.await();
            const display = fiber.ctx.get('engineWorkspacePreviewDisplay');
            if (display === undefined) throw new Error('preview display service is unavailable');
            await display.set({ mode: state.mode, overlays: state.overlays as never });
          }
          const row: Uint8Array[] = [];
          for (const placement of placed.cameras) {
            if (signal?.aborted === true) throw new Error('model render cancelled');
            world.set(camera, Transform, {
              pos: placement.eye,
              quat: frameQuaternion(viewFrame(placement.view)),
            } as never);
            showAnalysis(placement);
            row.push(await draw());
          }
          images.push(row);
        } finally {
          await fiber?.dispose();
          world.despawn(subject).unwrap();
          for (const handle of [meshHandle, ...slots, unlit, analysisMesh])
            if (handle !== undefined) assets.release(handle).unwrap();
        }
      }
      for (const handle of textureHandles.values()) assets.release(handle).unwrap();
      if (gpuErrors.length > 0)
        return fail(
          'model-render-gpu-error',
          'the Renderer draws every view without device or validation errors',
          'inspect detail.errors; a validation error names the owning pipeline or resource',
          { errors: gpuErrors },
        );
      const covered = images.map((row) => row.map((image) => coverage(image, background)));
      if (covered.some((row) => row.every((c) => c === 0)))
        return fail(
          'model-render-empty',
          'every state shows the subject in some view',
          'inspect the mesh bounds and material slots',
          { coverage: covered },
        );
      return {
        ok: true,
        value: {
          materialBinding,
          images,
          background,
          coverage: covered,
          cameras: placed.cameras,
          frame: placed.frame,
          renderer: facts,
        },
      };
    } finally {
      await context.fiber.dispose();
    }
  } catch (cause) {
    if (cause instanceof AnalysisFailure) return cause.failure;
    throw cause;
  } finally {
    stopErrors();
    await renderer.dispose();
    await target.destroy();
  }
}

/** A surface view that cannot be built for one camera ends the render with its failure. */
class AnalysisFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.error.expected);
  }
}

/** Annotation facts of one orthographic view, as drawn. */
interface ViewAnnotation {
  readonly grid: number;
  /**
   * Axis views: the subject's horizontal and vertical extents on the sheet. Iso views
   * have no in-plane extent that is a real size, so they report `size` instead.
   */
  readonly extents?: { readonly horizontal: number; readonly vertical: number };
  /** Iso views: true 3D bounding-box size, drawn along the box edges. */
  readonly size?: { readonly x: number; readonly y: number; readonly z: number };
  /** Labels moved off their preferred spot to avoid others, and labels still overlapping. */
  readonly labels: { readonly displaced: number; readonly overlapping: readonly string[] };
  /** Drawing curves drawn on this view, as `<drawing>/<item id>`. */
  readonly drawn: readonly string[];
  readonly contours: readonly string[];
  readonly dimensions: readonly {
    readonly name: string;
    readonly value: number;
    readonly basis: string;
  }[];
  readonly measures: readonly {
    readonly label: string;
    readonly projected: number;
    readonly length: number;
  }[];
}

/** Draw the orthographic sheet layer of one view in place. */
export function annotateView(
  image: Uint8Array,
  background: Uint8Array,
  mapping: OrthoMapping,
  view: ModelRenderView,
  subject: Bounds,
  drawing: Pick<RenderPayload['drawing'], 'drawings' | 'contours'>,
  measures: readonly MeasureSpan[],
): ViewAnnotation {
  const canvas = new SheetCanvas(mapping.width, mapping.height, image, freeMask(image, background));
  const text = mapping.width >= 480 ? 2 : 1;
  const grid = niceStep(24 / mapping.pixelsPerMeter);
  drawGrid(canvas, mapping, grid);
  const drawn: string[] = [];
  // Drawing items in this ortho view (section stations have their own planes, not a sheet view).
  const onView = (d: RenderPayload['drawing']['drawings'][number], id: string) => {
    const v = d.views.find((w) => w.id === id);
    return v !== undefined && 'ortho' in v && v.ortho === view;
  };
  for (const d of drawing.drawings)
    for (const curve of d.curves)
      if (onView(d, curve.view)) {
        drawViewPolyline(canvas, mapping, curve.points, curve.closed, SHEET_COLORS.reference, {
          width: 2,
        });
        drawn.push(`${d.name}/${curve.id}`);
      }
  const contours: string[] = [];
  for (const contour of drawing.contours)
    if (contour.view === view) {
      drawViewPolyline(canvas, mapping, contour.points, true, SHEET_COLORS.contour, { dash: 6 });
      contours.push(contour.id);
    }
  const f = { right: mapping.right, up: mapping.up };
  const offset = 14 * text;
  // The title and scale bar claim their boxes first, so dimension labels avoid them.
  canvas.text(
    `${viewName(view)} ortho`,
    8 * text,
    8 * text,
    SHEET_COLORS.text,
    text,
    [0.08, 0.09, 0.11, 0.8],
  );
  drawScaleBar(canvas, mapping, niceStep(60 / mapping.pixelsPerMeter), text);
  // Free cameras are oblique like iso: projected lengths are not sizes.
  const iso = typeof view === 'object' || view === 'iso';
  let extents: ViewAnnotation['extents'];
  let size: ViewAnnotation['size'];
  if (iso) {
    // Projected lengths are not sizes in an oblique view: label the three box edges
    // from the lowest corner with their true 3D lengths.
    const box = corners(subject);
    const origin = box.reduce((low, c) =>
      worldToPixel(mapping, c)[1] > worldToPixel(mapping, low)[1] ? c : low,
    );
    const lo: Triple = [subject[0], subject[1], subject[2]];
    const hi: Triple = [subject[3], subject[4], subject[5]];
    size = { x: hi[0] - lo[0], y: hi[1] - lo[1], z: hi[2] - lo[2] };
    for (const [axis, name] of [
      [0, 'X'],
      [1, 'Y'],
      [2, 'Z'],
    ] as const) {
      const length = hi[axis] - lo[axis];
      if (length <= 0) continue;
      const end = [...origin] as [number, number, number];
      end[axis] = origin[axis] === lo[axis] ? hi[axis] : lo[axis];
      canvas.dimension(
        worldToPixel(mapping, origin),
        worldToPixel(mapping, end),
        `${name} ${formatMeters(length)}`,
        SHEET_COLORS.dimension,
        offset,
        text,
      );
    }
  } else {
    const us = corners(subject).map((p) => dot3(p, f.right));
    const vs = corners(subject).map((p) => dot3(p, f.up));
    const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
    extents = { horizontal: u1 - u0, vertical: v1 - v0 };
    canvas.dimension(
      viewToPixel(mapping, u0, v0),
      viewToPixel(mapping, u1, v0),
      formatMeters(u1 - u0),
      SHEET_COLORS.dimension,
      offset,
      text,
    );
    canvas.dimension(
      viewToPixel(mapping, u1, v0),
      viewToPixel(mapping, u1, v1),
      formatMeters(v1 - v0),
      SHEET_COLORS.dimension,
      offset,
      text,
    );
  }
  const dimensions: ViewAnnotation['dimensions'][number][] = [];
  for (const d of drawing.drawings)
    for (const dim of d.dimensions)
      if (onView(d, dim.view) && dim.from !== undefined && dim.to !== undefined) {
        const basis = dim.basis ?? 'estimate';
        canvas.dimension(
          viewToPixel(mapping, dim.from[0], dim.from[1]),
          viewToPixel(mapping, dim.to[0], dim.to[1]),
          `${dim.id} ${formatMeters(dim.value)}${basis === 'estimate' ? ' (est)' : ''}`,
          SHEET_COLORS.reference,
          -offset * 2,
          text,
        );
        dimensions.push({ name: dim.id, value: dim.value, basis });
      }
  const measured: ViewAnnotation['measures'][number][] = [];
  for (const [i, span] of measures.entries()) {
    const d = sub3(span.to, span.from);
    const projected = Math.hypot(dot3(d, f.right), dot3(d, f.up));
    if (projected * mapping.pixelsPerMeter < 4) continue;
    const label = span.label ?? `m${i + 1}`;
    const length = Math.hypot(...d);
    // An axis view shows a span's real length only when it lies parallel to the sheet
    // (to the printed precision); otherwise both lengths are printed.
    const parallel = !iso && formatMeters(length) === formatMeters(projected);
    canvas.dimension(
      worldToPixel(mapping, span.from),
      worldToPixel(mapping, span.to),
      iso || parallel
        ? `${label} ${formatMeters(length)}`
        : `${label} ${formatMeters(projected)} (3D ${formatMeters(length)})`,
      SHEET_COLORS.measure,
      -offset,
      text,
    );
    measured.push({ label, projected, length: Math.hypot(...d) });
  }
  return {
    grid,
    ...(extents === undefined ? {} : { extents }),
    ...(size === undefined ? {} : { size }),
    labels: { displaced: canvas.displaced, overlapping: [...canvas.overlapping] },
    drawn,
    contours,
    dimensions,
    measures: measured,
  };
}

/**
 * The surface view of a render: one surface field over the exported state (exact on the
 * session's NURBS patches), shaded once for curvature or per camera for zebra stripes.
 */
function analysisOf(
  args: RenderArgs,
  payload: RenderPayload,
): { readonly state: Analysis; readonly facts: Record<string, unknown> } | Failure | undefined {
  const mode = args.mode;
  if (mode !== 'zebra' && mode !== 'curvature-gaussian' && mode !== 'curvature-mean')
    return undefined;
  const surfaces = payload.drawing.surfaces.map((s) => s.surface);
  const field = surfaceField(payload.mesh, surfaces);
  if (!field.ok)
    return fail(field.error.code, field.error.expected, field.error.hint, field.error.detail);
  const source = {
    vertices: field.value.positions.length / 3,
    exactVertices: field.value.exactVertices,
    surfaces: payload.drawing.surfaces.map((s) => s.name),
  };
  if (mode === 'zebra') {
    const zebra = args.zebra ?? {};
    const colored = (camera: PlacedCamera): ColoredTriangles | Failure => {
      const frame = viewFrame(camera.view);
      const stripes = zebraStripes(field.value, surfaces, {
        ...(camera.mapping === undefined
          ? { eye: camera.eye as [number, number, number] }
          : { direction: [...frame.toward] as [number, number, number] }),
        right: [...frame.right] as [number, number, number],
        up: [...frame.up] as [number, number, number],
        ...zebra,
      });
      return stripes.ok
        ? stripes.value
        : fail(
            stripes.error.code,
            stripes.error.expected,
            stripes.error.hint,
            stripes.error.detail,
          );
    };
    const probe = zebraStripes(field.value, surfaces, {
      direction: [0, 0, 1],
      right: [1, 0, 0],
      up: [0, 1, 0],
      ...zebra,
      refine: 0,
    });
    if (!probe.ok)
      return fail(probe.error.code, probe.error.expected, probe.error.hint, probe.error.detail);
    return {
      state: { colored, perCamera: true },
      facts: {
        kind: mode,
        ...source,
        width: zebra.width ?? 4,
        orientation: zebra.orientation ?? 0,
        refine: zebra.refine ?? 3,
      },
    };
  }
  const kind = mode === 'curvature-gaussian' ? 'gaussian' : 'mean';
  const shaded = curvatureShading(field.value, {
    kind,
    ...(args.curvature?.range === undefined ? {} : { range: args.curvature.range }),
  });
  if (!shaded.ok)
    return fail(shaded.error.code, shaded.error.expected, shaded.error.hint, shaded.error.detail);
  const values = kind === 'gaussian' ? field.value.gaussian : field.value.mean;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return {
    state: { colored: () => shaded.value, perCamera: false },
    facts: {
      kind: mode,
      ...source,
      range: shaded.value.range,
      unit: kind === 'gaussian' ? '1/m^2' : '1/m',
      min,
      max,
      colors: { negative: 'blue', zero: 'white', positive: 'red' },
    },
  };
}

/** Curvature combs of every feature line of the session as one line overlay. */
function combsOf(
  args: RenderArgs,
  payload: RenderPayload,
):
  | { readonly overlay: Overlay; readonly facts: readonly Record<string, unknown>[] }
  | Failure
  | undefined {
  if (args.combs === undefined || args.combs === false) return undefined;
  const options = args.combs === true ? {} : args.combs;
  if (payload.drawing.featureLines.length === 0)
    return fail(
      'model-selection-empty',
      'the session declares feature lines (m.featureLine) to comb',
      'declare the styling lines with m.featureLine({ name, curve })',
    );
  const positions: number[] = [];
  const colors: number[] = [];
  const facts: Record<string, unknown>[] = [];
  for (const line of payload.drawing.featureLines) {
    const comb = curvatureComb(line.curve, options);
    if (!comb.ok)
      return fail(comb.error.code, comb.error.expected, comb.error.hint, {
        ...comb.error.detail,
        line: line.name,
      });
    positions.push(...comb.value.positions);
    colors.push(...comb.value.colors);
    facts.push({ name: line.name, maxCurvature: comb.value.maxCurvature, scale: comb.value.scale });
  }
  return { overlay: { topology: 'line-list', positions, colors }, facts };
}

function overlaysOf(report: CaptureReport, payload: RenderPayload): Record<string, Overlay> {
  const overlays: Record<string, Overlay> = Object.fromEntries(
    (report.overlays ?? []).map((overlay) => [
      overlay.kind.toLowerCase(),
      { topology: overlay.topology, positions: overlay.positions, colors: overlay.colors },
    ]),
  );
  const section = payload.section;
  if (section !== undefined) {
    const paint = (positions: readonly number[], color: readonly number[]) =>
      Array.from({ length: positions.length / 3 }, () => color).flat();
    overlays['section-cap'] = {
      topology: 'triangle-list',
      positions: section.cap,
      colors: paint(section.cap, SECTION_CAP),
    };
    const lines = [...section.hatch, ...section.outline];
    overlays['section-lines'] = {
      topology: 'line-list',
      positions: lines,
      colors: paint(lines, SECTION_LINE),
    };
  }
  return overlays;
}

async function publisher(projectRoot: string, prefix: string) {
  const runId = `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const runDir = join(projectRoot, '.forgeax', 'tool-runs', runId);
  await mkdir(runDir, { recursive: true });
  const artifacts: ArtifactRef[] = [];
  const uri = (path: string) => relative(projectRoot, path).split(sep).join('/');
  return {
    artifacts,
    async publish(name: string, png: Uint8Array) {
      const path = join(runDir, name);
      await writeFile(path, png);
      artifacts.push({
        kind: 'png',
        digest: sha256(png),
        uri: uri(path),
        mediaType: 'image/png',
        sizeBytes: png.byteLength,
      });
      return uri(path);
    },
  };
}

function compose(images: readonly Uint8Array[], width: number, height: number, columns?: number) {
  const layout = sheetLayout(images.length, width, height, columns);
  const sheet = new Uint8Array(layout.width * layout.height * 4);
  for (let i = 0; i < sheet.length; i += 4) sheet.set([18, 19, 22, 255], i);
  for (const [index, image] of images.entries()) {
    const tile = layout.tiles[index] as (typeof layout.tiles)[number];
    for (let y = 0; y < height; y++)
      sheet.set(
        image.subarray(y * width * 4, (y + 1) * width * 4),
        ((tile.y + y) * layout.width + tile.x) * 4,
      );
  }
  return { layout, png: encodePng(layout.width, layout.height, sheet) };
}

async function copyOutput(projectRoot: string, output: string | undefined, png: Uint8Array) {
  if (output === undefined) return;
  const target = confineToRoot(projectRoot, output);
  if (target === undefined) return;
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, png);
}

const RENDER_ERRORS = [
  'tool-invalid-args',
  'model-selection-empty',
  'model-work-budget',
  'model-capture-failed',
  'model-op-no-effect',
  'model-render-backend-unavailable',
  'model-render-gpu-error',
  'model-render-empty',
  'model-render-material-load-failed',
];

async function capture(
  projectRoot: string,
  args: Record<string, unknown>,
  extra: Partial<CaptureRequest>,
) {
  const request = captureRequest(projectRoot, args);
  if ('ok' in request) return request as Failure;
  if (
    args.output !== undefined &&
    (typeof args.output !== 'string' || confineToRoot(projectRoot, args.output) === undefined)
  )
    return fail(
      'tool-invalid-args',
      'output stays inside the project root',
      'pass a project-relative PNG path',
      { output: args.output as JsonValue },
    );
  const captured = await runCapture({ ...request, ...extra });
  if (!captured.ok)
    return fail(
      captured.error.code,
      captured.error.expected,
      captured.error.hint,
      captured.error.detail ?? null,
    );
  return { ok: true as const, value: captured.value, capturedAt: performance.now() };
}

/** Capture phases from the Worker plus the Renderer and publication time that followed. */
function renderTiming(captured: { value: CaptureReport; capturedAt: number }) {
  return {
    ...captured.value.timing,
    renderMs: Math.round((performance.now() - captured.capturedAt) * 10) / 10,
  };
}

/**
 * `model.render`: re-run a modeling Pack build in the capture Worker, export the
 * selected session state (final, a checkpoint or a step) as a session-local
 * MeshAsset, and draw it with the real Engine Renderer through the preview display
 * from a closed camera set: orthographic drawings on one scale with a sheet layer
 * (grid, scale bar, dimensions, design drawing, contours), optionally exploded,
 * sectioned or X-rayed. Writes one PNG per view plus a contact sheet under
 * `.forgeax/tool-runs/<run>/` and returns their artifacts.
 */
export function createModelRenderTool(projectRoot: string): ToolContribution {
  return defineCommand(
    {
      id: 'model.render',
      path: operationCommandPath('model.render'),
      title: 'Modeling render',
      summary:
        'Renders a modeling Pack session state (final, --checkpoint or --step) with the real Engine Renderer from a fixed camera set (front/back/left/right/top/bottom/iso), orthographic on one scale by default with a drawing-sheet layer (grid, scale bar, extent dimensions, design drawing, contours, --measure spans); optional wireframe, --selector highlight, diagnostic overlays, --xray shell, --explode parts or --section plane; a rig posed with --u/--pose (parts in contact highlighted); returns per-view PNGs, a contact sheet and JSON facts.',
      realm: 'host',
      argsSchema: toolJsonSchema(argsSchema as unknown as ToolJsonSchema),
      resultSchema: toolJsonSchema({ type: 'object' } as ToolJsonSchema),
      evidence: ['png'],
      capabilities: [],
      errors: RENDER_ERRORS,
      inputSchema: argsSchema as unknown as JsonValue,
    },
    async (rawArgs, context) => {
      const args = rawArgs as Record<string, unknown> & RenderArgs;
      const views = args.views ?? DEFAULT_VIEWS;
      const malformed = checkViews(views);
      if (malformed !== undefined) return malformed as never;
      const width = args.width ?? 512;
      const height = args.height ?? 512;
      const projection = args.projection ?? 'orthographic';
      const overlays = args.overlays ?? [];
      const captured = await capture(projectRoot, args, {
        overlays,
        ...(overlays.includes('edges') && args.frame !== undefined
          ? { overlayBounds: args.frame }
          : {}),
        render: true,
        ...(args.xray === undefined ? {} : { xray: args.xray }),
        ...(args.explode === undefined ? {} : { explode: args.explode }),
        ...(args.section === undefined ? {} : { section: args.section }),
      });
      if (!captured.ok) return captured as never;
      const report = captured.value;
      const payload = report.render;
      if (payload === undefined)
        return fail(
          'model-capture-failed',
          'the capture returns a render payload',
          'inspect the capture',
        ) as never;
      const plan = planMaterials(
        payload.mesh.materialSlots.map((slot) => slot.slotName),
        args.materials === 'auto' ? report.materials : undefined,
      );
      if ('ok' in plan) return plan as never;
      const gpu = await nodeGpu();
      if (!gpu.ok)
        return fail('model-render-backend-unavailable', gpu.error.expected, gpu.error.hint, {
          cause: gpu.error.cause,
        }) as never;
      const mode = args.mode ?? 'material';
      const analysis = analysisOf(args, payload);
      if (analysis !== undefined && 'ok' in analysis) return analysis as never;
      const combs = combsOf(args, payload);
      if (combs !== undefined && 'ok' in combs) return combs as never;
      const rendered = await renderStates(
        gpu.value,
        [
          {
            mesh: payload.mesh,
            mode: mode === 'wireframe' ? 'wireframe' : 'material',
            overlays: {
              ...overlaysOf(report, payload),
              ...(combs === undefined ? {} : { combs: combs.overlay }),
            },
            ...(analysis === undefined ? {} : { analysis: analysis.state }),
          },
        ],
        {
          views,
          width,
          height,
          projection,
          bounds: args.frame ?? payload.bounds,
          ...(args.scale === undefined ? {} : { scale: args.scale }),
        },
        context?.signal,
        plan,
      );
      if (!rendered.ok) return rendered as never;
      const out = await publisher(projectRoot, 'model-render');
      const annotate = projection === 'orthographic' && args.annotate !== false;
      const images = rendered.value.images[0] as Uint8Array[];
      const facts = [];
      for (const [index, view] of views.entries()) {
        const image = images[index] as Uint8Array;
        const placement = rendered.value.cameras[index] as PlacedCamera;
        const annotation =
          annotate && placement.mapping !== undefined
            ? annotateView(
                image,
                rendered.value.background,
                placement.mapping,
                view,
                payload.bounds,
                payload.drawing,
                args.measure ?? [],
              )
            : undefined;
        facts.push({
          view: viewName(view),
          ...(typeof view === 'object' ? { direction: viewDirection(view) } : {}),
          image: await out.publish(`view-${viewName(view)}.png`, encodePng(width, height, image)),
          coverage: rendered.value.coverage[0]?.[index],
          camera: {
            eye: placement.eye.map((n) => Math.round(n * 1e4) / 1e4),
            target: placement.target,
            // Pixel (px, py) of an orthographic view lies on the world line through
            // center + right * (px - width / 2) / pixelsPerMeter
            //        + up * (height / 2 - py) / pixelsPerMeter, along target - eye.
            ...(placement.mapping === undefined ? {} : { mapping: placement.mapping }),
          },
          ...(annotation === undefined ? {} : { annotation }),
        });
      }
      const sheet = compose(images, width, height);
      const sheetUri = await out.publish('sheet.png', sheet.png);
      await copyOutput(projectRoot, args.output, sheet.png);
      const session = report.sessions[payload.session];
      const value = relativeSources(
        {
          source: args.source,
          values: args.values ?? {},
          session: payload.session,
          ...(payload.checkpoint === undefined ? {} : { checkpoint: payload.checkpoint }),
          ...(args.step === undefined ? {} : { step: args.step }),
          mode,
          projection,
          materialBinding: rendered.value.materialBinding,
          renderer: rendered.value.renderer,
          ...(analysis === undefined ? {} : { analysis: analysis.facts }),
          ...(combs === undefined ? {} : { combs: combs.facts }),
          ...(report.selected === undefined ? {} : { selected: report.selected }),
          overlays: (report.overlays ?? []).map((overlay) => ({
            kind: overlay.kind,
            legend: overlay.legend,
          })),
          mesh: {
            faces: payload.faces,
            triangles: payload.triangles,
            gpuVertices: payload.gpuVertices,
            bounds: payload.bounds,
            materialSlots: payload.mesh.materialSlots.map((slot) => slot.slotName),
            uvProjected: payload.uvProjected,
          },
          drawing: {
            drawings: payload.drawing.drawings.map((d) => ({
              name: d.name,
              sources: d.sources,
              views: d.views,
              dimensions: d.dimensions,
              curves: d.curves.map((c) => ({
                id: c.id,
                view: c.view,
                role: c.role,
                points: c.points.length,
              })),
            })),
            contours: payload.drawing.contours.map((c) => ({
              id: c.id,
              view: c.view,
              kind: c.kind,
              points: c.points.length,
              deviation: c.deviation,
              tolerance: c.tolerance,
              bounds: c.bounds,
            })),
          },
          ...(payload.explode === undefined ? {} : { explode: payload.explode }),
          ...(payload.section === undefined
            ? {}
            : {
                section: {
                  point: payload.section.point,
                  normal: payload.section.normal,
                  area: payload.section.area,
                  spacing: payload.section.spacing,
                  capTriangles: payload.section.cap.length / 9,
                  hatchLines: payload.section.hatch.length / 6,
                },
              }),
          ...(payload.xray === undefined ? {} : { xray: payload.xray }),
          ...(session === undefined
            ? {}
            : { output: session.output ?? null, checkpoints: session.checkpoints }),
          ...(report.pose === undefined ? {} : { pose: report.pose }),
          frame: rendered.value.frame,
          timing: renderTiming(captured),
          sheet: { image: sheetUri, width: sheet.layout.width, height: sheet.layout.height },
          views: facts.map((fact, index) => ({ ...fact, tile: sheet.layout.tiles[index] })),
        },
        projectRoot,
      );
      return { ok: true, value: value as unknown as JsonValue, artifacts: out.artifacts } as never;
    },
  ) as ToolContribution;
}

/**
 * `model.replay`: rebuild a modeling Pack session step by step from its journal
 * (a step snapshot after every operation) and render each state with one camera
 * framing all of them, as numbered frames plus a strip sheet labeled with the
 * operation, its label and author source line.
 */
export function createModelReplayTool(projectRoot: string): ToolContribution {
  return defineCommand(
    {
      id: 'model.replay',
      path: operationCommandPath('model.replay'),
      title: 'Modeling replay',
      summary:
        'Replays a modeling Pack session step by step: re-runs the build with a snapshot after every operation and renders the chosen --steps (default every operation that leaves faces, at most 64) with the real Engine Renderer from one fixed camera that frames every state; returns numbered frame PNGs, a labeled strip sheet and the operation, label and source line of each frame.',
      realm: 'host',
      argsSchema: toolJsonSchema(replaySchema as unknown as ToolJsonSchema),
      resultSchema: toolJsonSchema({ type: 'object' } as ToolJsonSchema),
      evidence: ['png'],
      capabilities: [],
      errors: RENDER_ERRORS,
      inputSchema: replaySchema as unknown as JsonValue,
    },
    async (rawArgs, context) => {
      const args = rawArgs as Record<string, unknown> & ReplayArgs;
      const view = args.view ?? 'iso';
      const malformed = checkViews([view]);
      if (malformed !== undefined) return malformed as never;
      const width = args.width ?? 320;
      const height = args.height ?? 320;
      const projection = args.projection ?? 'orthographic';
      const captured = await capture(projectRoot, args, { replay: args.steps ?? 'all' });
      if (!captured.ok) return captured as never;
      const replay = captured.value.replay;
      if (replay === undefined || replay.frames.length === 0)
        return fail(
          'model-selection-empty',
          'the session has steps with geometry',
          'inspect model.history',
        ) as never;
      const union = replay.frames.reduce<number[]>(
        (acc, frame) =>
          [0, 1, 2, 3, 4, 5].map((k) =>
            (k < 3 ? Math.min : Math.max)(acc[k] as number, frame.bounds[k] as number),
          ),
        [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
      ) as unknown as Bounds;
      const gpu = await nodeGpu();
      if (!gpu.ok)
        return fail('model-render-backend-unavailable', gpu.error.expected, gpu.error.hint, {
          cause: gpu.error.cause,
        }) as never;
      const rendered = await renderStates(
        gpu.value,
        replay.frames.map((frame) => ({ mesh: frame.mesh, mode: 'material', overlays: {} })),
        {
          views: [view],
          width,
          height,
          projection,
          bounds: args.frame ?? union,
          ...(args.scale === undefined ? {} : { scale: args.scale }),
        },
        context?.signal,
      );
      if (!rendered.ok) return rendered as never;
      const out = await publisher(projectRoot, 'model-replay');
      const text = width >= 480 ? 2 : 1;
      const frames = [];
      const images: Uint8Array[] = [];
      for (const [index, frame] of replay.frames.entries()) {
        const image = rendered.value.images[index]?.[0] as Uint8Array;
        const canvas = new SheetCanvas(width, height, image);
        const caption = `${index + 1}/${replay.frames.length} #${frame.opIndex} ${frame.op}${frame.label === undefined ? '' : ` ${frame.label}`}`;
        canvas.text(
          caption.slice(0, Math.floor((width - 12) / (6 * text))),
          6 * text,
          6 * text,
          SHEET_COLORS.text,
          text,
          [0.08, 0.09, 0.11, 0.8],
        );
        images.push(image);
        frames.push({
          opIndex: frame.opIndex,
          op: frame.op,
          ...(frame.label === undefined ? {} : { label: frame.label }),
          ...(frame.source === undefined ? {} : { source: frame.source }),
          faces: frame.faces,
          triangles: frame.triangles,
          bounds: frame.bounds,
          coverage: rendered.value.coverage[index]?.[0],
          image: await out.publish(
            `step-${String(frame.opIndex).padStart(3, '0')}.png`,
            encodePng(width, height, image),
          ),
        });
      }
      const sheet = compose(
        images,
        width,
        height,
        Math.min(images.length, Math.max(1, Math.round(Math.sqrt(images.length * 1.6)))),
      );
      const sheetUri = await out.publish('strip.png', sheet.png);
      await copyOutput(projectRoot, args.output, sheet.png);
      const value = relativeSources(
        {
          source: args.source,
          values: args.values ?? {},
          session: replay.session,
          operations: replay.operations,
          stepsTruncated: replay.stepsTruncated,
          view,
          projection,
          frame: rendered.value.frame,
          timing: renderTiming(captured),
          sheet: { image: sheetUri, width: sheet.layout.width, height: sheet.layout.height },
          frames: frames.map((frame, index) => ({ ...frame, tile: sheet.layout.tiles[index] })),
        },
        projectRoot,
      );
      return { ok: true, value: value as unknown as JsonValue, artifacts: out.artifacts } as never;
    },
  ) as ToolContribution;
}
