/**
 * View modeling window (design 12): the logic the panel needs, kept free of React and
 * DOM so it is testable with node:test. The panel only calls existing Engine
 * operations: `model.*` through `engine.workspace.call`, the Pack draft through
 * `asset.source.draft`, overlays through `preview.display.set`. It never writes
 * operator calls into source.
 */

export type Vec = readonly [number, number, number];

/** Orthographic pixel mapping `model.render` reports per view (`views[].camera.mapping`). */
export interface OrthoMapping {
  readonly width: number;
  readonly height: number;
  readonly pixelsPerMeter: number;
  readonly center: Vec;
  readonly right: Vec;
  readonly up: Vec;
}

export interface RenderedView {
  readonly view: string;
  /** Project-relative PNG path. */
  readonly image: string;
  readonly camera: {
    readonly eye: readonly number[];
    readonly target: readonly number[];
    readonly mapping?: OrthoMapping;
  };
}

export interface PickRay {
  readonly origin: Vec;
  readonly direction: Vec;
}

export interface PickBox {
  readonly center: Vec;
  readonly right: Vec;
  readonly up: Vec;
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly direction: Vec;
  readonly visible?: boolean;
}

export interface FacePick {
  readonly faces?: readonly number[];
  readonly rays?: readonly PickRay[];
  readonly boxes?: readonly PickBox[];
}

const add = (a: Vec, b: Vec, s = 1): Vec => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const norm = (a: Vec): Vec => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
};

function viewDirection(view: RenderedView): Vec {
  const [ex, ey, ez] = view.camera.eye as [number, number, number];
  const [tx, ty, tz] = view.camera.target as [number, number, number];
  return norm([tx - ex, ty - ey, tz - ez]);
}

/** World point on the view plane through the mapping center under image pixel (px, py). */
function pixelPoint(m: OrthoMapping, px: number, py: number): Vec {
  return add(
    add(m.center, m.right, (px - m.width / 2) / m.pixelsPerMeter),
    m.up,
    (m.height / 2 - py) / m.pixelsPerMeter,
  );
}

/**
 * The pick ray under a click at image pixel (px, py) of an orthographic view: it starts
 * behind the subject (at the camera plane) and runs along the view direction.
 */
export function pixelRay(view: RenderedView, px: number, py: number): PickRay | undefined {
  const m = view.camera.mapping;
  if (m === undefined) return undefined;
  const direction = viewDirection(view);
  const [ex, ey, ez] = view.camera.eye as [number, number, number];
  const back = Math.hypot(ex - m.center[0], ey - m.center[1], ez - m.center[2]);
  return { origin: add(pixelPoint(m, px, py), direction, -back), direction };
}

/** The box select of an image-pixel rectangle in an orthographic view. */
export function pixelBox(
  view: RenderedView,
  from: readonly [number, number],
  to: readonly [number, number],
  visible = true,
): PickBox | undefined {
  const m = view.camera.mapping;
  if (m === undefined) return undefined;
  const halfWidth = Math.abs(to[0] - from[0]) / 2 / m.pixelsPerMeter;
  const halfHeight = Math.abs(to[1] - from[1]) / 2 / m.pixelsPerMeter;
  if (!(halfWidth > 0 && halfHeight > 0)) return undefined;
  return {
    center: pixelPoint(m, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2),
    right: m.right,
    up: m.up,
    halfWidth,
    halfHeight,
    direction: viewDirection(view),
    visible,
  };
}

/** Merge a new pick into the current one; `replace` starts over (a click without Shift). */
export function mergePick(current: FacePick, next: FacePick, replace: boolean): FacePick {
  if (replace) return next;
  const out: { faces?: number[]; rays?: PickRay[]; boxes?: PickBox[] } = {};
  const faces = [...(current.faces ?? []), ...(next.faces ?? [])];
  const rays = [...(current.rays ?? []), ...(next.rays ?? [])];
  const boxes = [...(current.boxes ?? []), ...(next.boxes ?? [])];
  if (faces.length > 0) out.faces = [...new Set(faces)].sort((a, b) => a - b);
  if (rays.length > 0) out.rays = rays;
  if (boxes.length > 0) out.boxes = boxes;
  return out;
}

export function pickSize(pick: FacePick): number {
  return (pick.faces?.length ?? 0) + (pick.rays?.length ?? 0) + (pick.boxes?.length ?? 0);
}

/** A Pack draft field as the panel sees it (`PackDraftField` subset). */
export interface DraftField {
  readonly name: string;
  readonly type: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly apply?: unknown;
}

export interface Slider {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly integer: boolean;
}

const INTEGER_TYPES = new Set(['u32', 'i32', 'u8', 'u16', 'i8', 'i16', 'int', 'integer']);

/**
 * Sliders for the draft's numeric generation parameters with a declared range; other
 * fields stay with the content browser's Pack parameters panel.
 */
export function slidersOf(fields: readonly DraftField[]): Slider[] {
  return fields.flatMap((field) => {
    const { minimum, maximum } = field;
    if (typeof minimum !== 'number' || typeof maximum !== 'number' || !(minimum < maximum)) return [];
    if (!['f32', 'f64', 'number'].includes(field.type) && !INTEGER_TYPES.has(field.type)) return [];
    const integer = INTEGER_TYPES.has(field.type);
    return [{ name: field.name, min: minimum, max: maximum, step: integer ? 1 : (maximum - minimum) / 200, integer }];
  });
}

/** Snap a slider position to the field's domain. */
export function sliderValue(slider: Slider, raw: number): number {
  const clamped = Math.min(slider.max, Math.max(slider.min, raw));
  return slider.integer ? Math.round(clamped) : Math.round(clamped * 1e6) / 1e6;
}

/** Draft values that differ from the Pack declaration: the `values` model.* calls take. */
export function draftValues(
  values: Readonly<Record<string, unknown>> | undefined,
  sliders: readonly Slider[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sliders) {
    const value = values?.[s.name];
    if (typeof value === 'number' && Number.isFinite(value)) out[s.name] = value;
  }
  return out;
}

export interface CheckpointRow {
  readonly key: string;
  readonly name: string;
  readonly session: number;
  /** `model.render` argument naming the state; absent for the final state. */
  readonly checkpoint?: string;
  readonly faces: number;
  readonly opIndex?: number;
}

interface InspectSession {
  readonly index: number;
  readonly output?: string;
  readonly faces: number;
  readonly checkpoints: readonly { readonly name: string; readonly opIndex: number; readonly faces: number }[];
}

/**
 * Checkpoint list of `model.inspect`: every session's checkpoints (helper sessions
 * build parts the output session appends), then the final state of each output session.
 */
export function checkpointRows(report: { readonly sessions?: readonly InspectSession[] }): CheckpointRow[] {
  const sessions = report.sessions ?? [];
  const outputs = sessions.filter((s) => s.output !== undefined);
  const finals = outputs.length > 0 ? outputs : sessions.slice(-1);
  return [
    ...sessions.flatMap((s) =>
      s.checkpoints.map((c) => ({
        key: `${s.index}:${c.name}`,
        name: c.name,
        session: s.index,
        checkpoint: c.name,
        faces: c.faces,
        opIndex: c.opIndex,
      })),
    ),
    ...finals.map((s) => ({ key: `${s.index}:final`, name: s.output ?? `session ${s.index}`, session: s.index, faces: s.faces })),
  ];
}

/** The `model.synthesize` report fields the panel shows. */
export interface SynthesisReport {
  readonly expression: string;
  readonly jaccard: number;
  readonly picked: number;
  readonly matched: number;
  readonly fallback: boolean;
  readonly stability: 'stable' | 'unstable' | 'unchecked';
  readonly checks: readonly {
    readonly parameter: string;
    readonly value: number;
    readonly jaccard: number;
    readonly error?: { readonly code: string };
  }[];
  readonly alternatives: readonly { readonly expression: string; readonly jaccard: number }[];
  readonly session: number;
  readonly checkpoint?: string;
  readonly highlight: {
    readonly topology: 'triangle-list' | 'line-list';
    readonly positions: readonly number[];
    readonly colors: readonly number[];
  };
}

/** Stability failures in words, for the panel and the AI reference. */
export function stabilityNotes(report: SynthesisReport): string[] {
  if (report.fallback) return ['names positions (near): holds for this build only'];
  if (report.jaccard < 1) return [`best combination reaches J = ${report.jaccard.toFixed(3)} only`];
  return report.checks
    .filter((c) => c.error !== undefined || c.jaccard !== 1)
    .map((c) =>
      c.error !== undefined
        ? `${c.parameter} = ${c.value}: rebuild failed (${c.error.code})`
        : `${c.parameter} = ${c.value}: J = ${c.jaccard}`,
    );
}

/**
 * The conversation reference a human hands to the AI: the selector, its J and
 * stability, and where it was evaluated. View never inserts operator calls; the AI
 * decides what to do with the selector.
 */
export function selectorReference(
  report: SynthesisReport,
  context: { readonly source: string; readonly values: Readonly<Record<string, unknown>> },
): { readonly title: string; readonly text: string } {
  const where = {
    source: context.source,
    values: context.values,
    session: report.session,
    ...(report.checkpoint === undefined ? {} : { checkpoint: report.checkpoint }),
  };
  const notes = stabilityNotes(report);
  return {
    title: `Selector for ${report.picked} picked faces`,
    text: [
      `Selector picked in the View modeling window (J = ${report.jaccard}, ${report.stability}):`,
      report.expression,
      JSON.stringify(where),
      notes.length > 0 ? `Stability: ${notes.join('; ')}` : 'Stable at every ranged parameter minimum and maximum.',
      'Verify with model.select before using it in an operator call.',
    ].join('\n'),
  };
}

/** `preview.display.set` overlays of a synthesized selection. */
export const SELECTION_OVERLAY_KEY = 'modeling.selection';

export function highlightOverlays(report: SynthesisReport | undefined) {
  return {
    [SELECTION_OVERLAY_KEY]:
      report === undefined || report.highlight.positions.length === 0
        ? null
        : {
            topology: report.highlight.topology,
            positions: report.highlight.positions,
            colors: report.highlight.colors,
          },
  };
}

/** Engine host service the panel calls `model.*` through (DevKit workspace owner). */
export const ENGINE_WORKSPACE_CALL_SERVICE = 'engine.workspace.call';

export type Request = (service: string, payload: unknown) => Promise<unknown>;

/**
 * Capture budget of each Pack rebuild the window asks for. Later stages of a large
 * assembly outgrow the 60 s tool default on a busy host; the panel already shows only
 * the latest result, so a slow rebuild costs waiting, not a wrong answer.
 */
export const CAPTURE_TIMEOUT_MS = 300_000;

/** `model.*` through the caller's admitted workspace session (project-scoped). */
export function modelingOperations(request: Request) {
  const call = <T>(operation: string, args: Record<string, unknown>) =>
    request(ENGINE_WORKSPACE_CALL_SERVICE, {
      operation,
      args: { timeoutMs: CAPTURE_TIMEOUT_MS, ...args },
    }) as Promise<T>;
  return {
    inspect: (source: string, values: Record<string, unknown>) => call<{ sessions: InspectSession[] }>('model.inspect', { source, values }),
    render: (args: Record<string, unknown>) =>
      call<{ views: RenderedView[]; mesh: { faces: number } }>('model.render', {
        views: ['iso'],
        projection: 'orthographic',
        annotate: false,
        width: 384,
        height: 384,
        ...args,
      }),
    synthesize: (args: Record<string, unknown>) => call<SynthesisReport>('model.synthesize', args),
    select: (args: Record<string, unknown>) =>
      call<{ selected: { count: number; highlight?: SynthesisReport['highlight'] } }>('model.select', { highlight: true, ...args }),
  };
}

/** Project-relative form of a Pack source path (sources and drafts may report absolute paths). */
export function projectRelative(path: string, root: string | undefined): string {
  if (root === undefined || root === '') return path;
  const base = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/** The modeling Pack draft as the panel sees it (a `PackDraftSnapshot` subset). */
export interface DraftView {
  readonly fields: readonly DraftField[];
  readonly values: Readonly<Record<string, unknown>>;
  readonly unsaved: boolean;
}

/** A Pack draft handle over the existing `asset.source.draft` path; the panel never owns the draft. */
export interface DraftHandle {
  getSnapshot(): { readonly draft?: DraftView; readonly pending: boolean };
  subscribe(listener: () => void): () => void;
  open(): Promise<unknown>;
  edit(field: string, value: unknown): void;
  flush(): Promise<void>;
  save(): Promise<unknown>;
  dispose(): void;
}

export interface ModelingContext {
  readonly projectId?: string;
  readonly root?: string;
  /** Workspace previews: highlight overlays go to the selected one. */
  readonly previews: readonly { readonly targetId: string; readonly generation?: number; readonly label: string }[];
}

/** Everything the panel reaches; `frontend.ts` binds it to the View workspace client. */
export interface ModelingHost {
  context(): ModelingContext;
  subscribe(listener: () => void): () => void;
  listSources(): Promise<string[]>;
  readonly operations: ReturnType<typeof modelingOperations>;
  /** A data URL of a project file (model.render PNGs). */
  readImage(path: string): Promise<string | undefined>;
  draft(sourcePath: string): DraftHandle | undefined;
  setOverlays(
    target: { readonly targetId: string; readonly generation?: number },
    overlays: ReturnType<typeof highlightOverlays>,
  ): Promise<void>;
  copy(text: string): Promise<void>;
}
