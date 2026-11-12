import { fileURLToPath, pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
// Self-reference keeps one modeling module instance shared with the Pack under capture.
import * as modeling from '@forgeax/engine-modeling';
import { AssetGuid, resolvePackParameterValues } from '@forgeax/engine-pack/source';
import { loadScriptablePack } from '@forgeax/engine-pack/source-node';
import { maxOf, minOf } from '../arrays';
import { captureEnvironment } from './build-identity';
import {
  type CaptureFailure,
  type CaptureReport,
  type CaptureRequest,
  type CaptureResponse,
  type CaptureTiming,
  type CheckpointSummary,
  HIGHLIGHT_SLOT,
  HISTORY_LIMIT,
  ID_LIMIT,
  ISSUE_LIMIT,
  OVERLAY_VERTEX_LIMIT,
  type OverlayPayload,
  type PackMaterials,
  type ParameterRange,
  type PoseReport,
  REPLAY_LIMIT,
  type RenderPayload,
  type ReplayPayload,
  type RigSummary,
  type SectionRequest,
  type SelectionReport,
  type SessionHistory,
  type SessionSummary,
  type SessionValidation,
  type SynthesisPayload,
  type ValidationFinding,
  type VerifyPayload,
  XRAY_SLOT,
} from './protocol';

function failure(code: string, expected: string, hint: string, detail?: unknown): CaptureFailure {
  return { code, expected, hint, ...(detail === undefined ? {} : { detail: plain(detail) }) };
}

/** Structured-clone and JSON safe projection of arbitrary failure detail. */
function plain(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, item) =>
        ArrayBuffer.isView(item)
          ? `<${item.constructor.name} ${(item as Uint8Array).length}>`
          : item,
      ),
    );
  } catch {
    return String(value);
  }
}

function asFailure(error: unknown): CaptureFailure {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const e = error as {
      code: unknown;
      expected?: unknown;
      hint?: unknown;
      detail?: unknown;
      message?: unknown;
    };
    return failure(
      String(e.code),
      typeof e.expected === 'string' ? e.expected : String(e.message ?? ''),
      typeof e.hint === 'string' ? e.hint : 'inspect detail',
      e.detail,
    );
  }
  return failure(
    'model-capture-failed',
    'the Pack build completes',
    'inspect detail',
    String(error),
  );
}

function checkpoints(model: modeling.Model): CheckpointSummary[] {
  return model.diagnostics().checkpoints.map((c) => ({
    name: c.name,
    opIndex: c.opIndex,
    faces: c.faces,
    vertices: c.vertices,
    ...(c.source === undefined ? {} : { source: c.source }),
  }));
}

/**
 * Element ids a validation detail names: `face`/`vertex` scalars, `faces`/`vertices`/`pairs`
 * arrays. A scalar `faces` is a count (`uv-missing`), not an id.
 */
function elementIds(scalar: unknown, lists: readonly unknown[]): number[] {
  const values = lists.filter((list) => Array.isArray(list)).flat(3);
  if (Number.isInteger(scalar)) values.unshift(scalar);
  return [...new Set(values.filter((n): n is number => Number.isInteger(n) && n >= 0))];
}

/** Locate one validation issue on the session mesh and, through its face label, on source. */
function finding(
  model: modeling.Model,
  issue: modeling.Issue<modeling.ValidationCode>,
): ValidationFinding {
  const mesh = model.editMesh;
  const detail = issue.detail as Record<string, unknown>;
  const faces = elementIds(detail.face, [detail.faces, detail.pairs])
    .filter((f) => mesh.isFaceAlive(f))
    .slice(0, ID_LIMIT);
  const vertices = elementIds(detail.vertex, [detail.vertices]).slice(0, ID_LIMIT);
  const first = faces[0];
  let point: [number, number, number] | undefined;
  if (first !== undefined) {
    const loop = mesh.faceVertices(first).map((v) => mesh.position(v));
    point = [0, 1, 2].map(
      (k) => loop.reduce((sum, p) => sum + (p[k] as number), 0) / loop.length,
    ) as [number, number, number];
  } else if (vertices[0] !== undefined && mesh.isVertexAlive(vertices[0])) {
    point = mesh.position(vertices[0]);
  } else if (Array.isArray(detail.point) && detail.point.length === 3) {
    point = detail.point as [number, number, number];
  }
  const label = first === undefined ? '' : (mesh.labelNames[mesh.fLabel[first] as number] ?? '');
  const role = first === undefined ? '' : (mesh.roleNames[mesh.fRole[first] as number] ?? '');
  // Surface-quality issues name the operation that declared their patch or feature line.
  const producer = Number.isInteger(detail.opIndex)
    ? model.journal[detail.opIndex as number]
    : label === ''
      ? undefined
      : [...model.journal].reverse().find((entry) => entry.label === label);
  const certainty = detail.certainty === 'candidate' ? 'candidate' : 'confirmed';
  return {
    code: issue.code,
    severity: issue.severity,
    certainty,
    location: {
      ...(faces.length === 0 ? {} : { faces }),
      ...(vertices.length === 0 ? {} : { vertices }),
      ...(point === undefined ? {} : { point }),
      ...(label === '' ? {} : { createdBy: { label, role } }),
      ...(producer?.source === undefined ? {} : { source: producer.source }),
    },
    detail: plain(issue.detail),
  };
}

/**
 * `output` is what the session produced: its own finish() (`mesh/<key>`), else the
 * `scene/<key>` of a rig finished from it, so rig Packs have an output session too.
 */
function summarize(
  index: number,
  model: modeling.Model,
  options: modeling.ValidateOptions | undefined,
  timing: { validateMs: number },
  rigOutput: string | undefined,
): SessionSummary {
  const d = model.diagnostics();
  const output = d.inspection.output ?? rigOutput;
  const journal = d.inspection.journal;
  const poisoned = d.inspection.poisoned;
  const site = (poisoned?.detail as { site?: { opIndex?: number } } | undefined)?.site;
  const poisonSource = site?.opIndex === undefined ? undefined : journal[site.opIndex]?.source;
  return {
    index,
    ...(output === undefined ? {} : { output }),
    faces: d.inspection.faces,
    edges: d.inspection.edges,
    vertices: d.inspection.vertices,
    tags: d.inspection.tags,
    labels: d.inspection.labels,
    materials: d.inspection.materials,
    checkpoints: checkpoints(model),
    operations: journal.length,
    ...(poisoned === undefined
      ? {}
      : {
          poisoned: {
            ...asFailure(poisoned),
            ...(poisonSource === undefined ? {} : { source: poisonSource }),
          },
        }),
    ...(options === undefined ? {} : { validation: validation(model, options, timing) }),
  };
}

/**
 * The exact validation (self-intersection over every face pair dominates large
 * assemblies), computed only for requests that ask for it.
 */
function validation(
  model: modeling.Model,
  options: modeling.ValidateOptions,
  timing: { validateMs: number },
): SessionValidation {
  const started = performance.now();
  const validation = model.validate(options);
  timing.validateMs += performance.now() - started;
  const journal = model.journal;
  return {
    pass: validation.pass,
    closed: validation.closed,
    volume: validation.volume,
    boundaryEdges: validation.boundaryEdges,
    issues: validation.issues.slice(0, ISSUE_LIMIT).map((issue) => finding(model, issue)),
    issuesTruncated: validation.issues.length > ISSUE_LIMIT,
    operations: journal
      .filter((entry) => (entry.diagnostics?.length ?? 0) > 0)
      .map((entry) => ({
        opIndex: entry.opIndex,
        op: entry.op,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        ...(entry.source === undefined ? {} : { source: entry.source }),
        diagnostics: plain(entry.diagnostics) as unknown[],
      })),
  };
}

function history(index: number, model: modeling.Model): SessionHistory {
  const journal = model.journal;
  const output = model.inspect().output;
  return {
    index,
    ...(output === undefined ? {} : { output }),
    steps: journal.slice(0, HISTORY_LIMIT).map((entry) => ({
      opIndex: entry.opIndex,
      op: entry.op,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      args: plain(entry.args),
      status: entry.status,
      roles: entry.roles,
      faces: entry.faces,
      vertices: entry.vertices,
      durationMs: Math.round(entry.durationMs * 1000) / 1000,
      ...(entry.source === undefined ? {} : { source: entry.source }),
      ...(entry.diagnostics === undefined
        ? {}
        : { diagnostics: plain(entry.diagnostics) as unknown[] }),
      ...(entry.repair === undefined ? {} : { repair: entry.repair }),
      ...(entry.error === undefined ? {} : { error: asFailure(entry.error) }),
    })),
    stepsTruncated: journal.length > HISTORY_LIMIT,
    checkpoints: checkpoints(model),
  };
}

/** The state right after operation `opIndex`: the last kept step snapshot at or before it. */
function stateAfter(model: modeling.Model, opIndex: number): modeling.EditMesh | CaptureFailure {
  const operations = model.journal.length;
  if (!Number.isInteger(opIndex) || opIndex < 0 || opIndex >= operations) {
    return failure(
      'model-selection-empty',
      `step ${opIndex} is an operation index of the session (0..${operations - 1})`,
      'list the operations with model.history',
      { operations },
    );
  }
  const steps = model.diagnostics().steps;
  let found: modeling.StepSnapshot | undefined;
  for (const step of steps) if (step.opIndex <= opIndex) found = step;
  if (found === undefined) {
    return failure(
      'model-selection-empty',
      `the session has geometry after operation ${opIndex}`,
      'pick a later step; the operations before it did not succeed',
      { firstStep: steps[0]?.opIndex ?? null },
    );
  }
  const decoded = modeling.decodeSnapshot(found.snapshot);
  if (!decoded.ok) return asFailure(decoded.error);
  if (decoded.value.faceCount === 0) {
    return failure(
      'model-selection-empty',
      `the session has geometry after operation ${opIndex}`,
      'pick a later step; the operations up to it created no faces',
      { opIndex },
    );
  }
  return decoded.value;
}

function meshAt(
  model: modeling.Model,
  checkpoint: string | undefined,
  step?: number,
): modeling.EditMesh | CaptureFailure {
  if (step !== undefined) return stateAfter(model, step);
  if (checkpoint === undefined) return model.editMesh;
  const found = model.diagnostics().checkpoints.find((c) => c.name === checkpoint);
  if (found === undefined) {
    return failure(
      'model-selection-empty',
      `checkpoint '${checkpoint}' exists in the captured session`,
      "call m.checkpoint('<name>') in the Pack build; checkpoints are kept only during a capture",
      { available: model.diagnostics().checkpoints.map((c) => c.name) },
    );
  }
  const decoded = modeling.decodeSnapshot(found.snapshot);
  return decoded.ok ? decoded.value : asFailure(decoded.error);
}

/**
 * The session a selection or overlay targets: the requested index, else the only
 * session, else the single session whose finish() produced an output.
 */
function targetSession(
  sessions: readonly SessionSummary[],
  requested: number | undefined,
  built: boolean,
): number | CaptureFailure {
  const listed = sessions.map((s) => ({
    index: s.index,
    output: s.output ?? null,
    faces: s.faces,
  }));
  if (requested !== undefined) {
    if (Number.isInteger(requested) && requested >= 0 && requested < sessions.length) {
      return requested;
    }
    return failure(
      'model-selection-empty',
      `session ${requested} exists among the ${sessions.length} captured model() sessions`,
      'pass --session with a listed index',
      { sessions: listed },
    );
  }
  if (sessions.length === 1) return 0;
  // A failed build may have stopped before the main session's finish(): a helper that
  // finished is then not "the output session".
  const producing = sessions.filter((s) => s.output !== undefined);
  if (built && producing.length === 1) return (producing[0] as SessionSummary).index;
  return failure(
    'tool-invalid-args',
    sessions.length === 0
      ? 'the Pack build creates a model() session'
      : built
        ? 'exactly one captured session produced the output, or --session names one'
        : 'the build succeeds, or --session names the session to inspect',
    sessions.length === 0
      ? 'the Pack must create a session with model()'
      : 'pass --session with an index from detail.sessions (output marks the session whose finish() produced it)',
    { sessions: listed },
  );
}

function parseSelector(expression: string): modeling.Selector<modeling.Domain> | CaptureFailure {
  let selector: unknown;
  try {
    selector = new Function('sel', `"use strict"; return (${expression});`)(modeling.sel);
  } catch (error) {
    return failure(
      'tool-invalid-args',
      'selector is a sel.* expression',
      "write it as in code, for example sel.tag('shell').and(sel.facing('+y'))",
      String(error),
    );
  }
  if (!(selector instanceof modeling.Selector)) {
    return failure(
      'tool-invalid-args',
      'selector evaluates to a Selector',
      'start the expression with sel.',
      { selector: expression },
    );
  }
  return selector as modeling.Selector<modeling.Domain>;
}

function select(
  mesh: modeling.EditMesh,
  session: number,
  request: CaptureRequest,
  expression: string,
): SelectionReport | CaptureFailure {
  const selector = parseSelector(expression);
  if ('code' in selector) return selector;
  const ids = selector.evaluate(mesh);
  const points: [number, number, number][] = [];
  for (const id of ids) {
    if (selector.domain === 'face')
      for (const v of mesh.faceVertices(id)) points.push(mesh.position(v));
    else if (selector.domain === 'edge')
      for (const v of mesh.edgeVertices(id)) points.push(mesh.position(v));
    else points.push(mesh.position(id));
  }
  const bounds =
    points.length === 0
      ? undefined
      : ([0, 1, 2]
          .map((k) => minOf(points.map((p) => p[k] as number)))
          .concat(
            [0, 1, 2].map((k) => maxOf(points.map((p) => p[k] as number))),
          ) as unknown as readonly [number, number, number, number, number, number]);
  let highlight: OverlayPayload | undefined;
  if (request.highlight === true) {
    const faces =
      selector.domain === 'face'
        ? ids
        : selector.domain === 'edge'
          ? (selector as modeling.EdgeSelector).toFaces().evaluate(mesh)
          : [];
    const overlay = selectionOverlay(mesh, faces);
    if ('code' in overlay) return overlay;
    highlight = overlay;
  }
  return {
    session,
    ...(request.checkpoint === undefined ? {} : { checkpoint: request.checkpoint }),
    selector: expression,
    domain: selector.domain,
    count: ids.length,
    ids: ids.slice(0, ID_LIMIT),
    ...(bounds === undefined ? {} : { bounds }),
    ...(highlight === undefined ? {} : { highlight }),
  };
}

const SELECTION_COLOR = [1, 0.62, 0.05, 1] as const;

/** Selected faces as a triangle-list overlay lifted off the surface (preview highlight). */
function selectionOverlay(
  mesh: modeling.EditMesh,
  faces: readonly number[],
): OverlayPayload | CaptureFailure {
  let extent = 0;
  for (const v of mesh.vertices()) {
    const p = mesh.position(v);
    extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  }
  const positions = modeling.liftedFaceTriangles(mesh, faces, Math.max(extent * 2e-3, 1e-4));
  const count = positions.length / 3;
  if (count > OVERLAY_VERTEX_LIMIT) {
    return failure(
      'model-work-budget',
      `the selection overlay has at most ${OVERLAY_VERTEX_LIMIT} vertices`,
      'narrow the selector or highlight a checkpoint',
      { vertices: count },
    );
  }
  return {
    kind: 'selection',
    topology: 'triangle-list',
    positions,
    colors: Array.from({ length: count }, () => SELECTION_COLOR).flat(),
    legend: [{ label: 'selection', color: [...SELECTION_COLOR], faces: faces.length }],
  };
}

/** Declared parameters with a numeric range and their resolved values. */
function parameterRanges(
  definition: unknown,
  values: Readonly<Record<string, unknown>> | undefined,
): ParameterRange[] {
  const declared =
    (definition as { parameters?: readonly Record<string, unknown>[] }).parameters ?? [];
  const out: ParameterRange[] = [];
  for (const p of declared) {
    const { name, type, minimum, maximum } = p;
    const value = values?.[name as string] ?? p.default;
    if (
      typeof name === 'string' &&
      typeof minimum === 'number' &&
      typeof maximum === 'number' &&
      typeof value === 'number' &&
      minimum < maximum
    ) {
      out.push({ name, type: String(type), value, minimum, maximum });
    }
  }
  return out;
}

/** Pick faces on the target state and synthesize the selector of the picks. */
function synthesis(
  mesh: modeling.EditMesh,
  session: number,
  request: CaptureRequest,
  parameters: readonly ParameterRange[],
): SynthesisPayload | CaptureFailure {
  const spec = request.synthesize as NonNullable<CaptureRequest['synthesize']>;
  const picked = modeling.pickFaces(mesh, spec.pick);
  if (!picked.ok) return asFailure(picked.error);
  const result = modeling.synthesizeSelector(
    mesh,
    picked.value,
    spec.maxAtoms === undefined ? {} : { maxAtoms: spec.maxAtoms },
  );
  if (!result.ok) return asFailure(result.error);
  // The expression a human copies must reproduce the result when parsed back.
  const parsed = parseSelector(result.value.expression);
  if ('code' in parsed) return parsed;
  const ids = parsed.evaluate(mesh);
  if (ids.length !== result.value.matched) {
    return failure(
      'model-capture-failed',
      'the synthesized expression evaluates to its reported faces',
      'report this selector synthesis defect',
      { expression: result.value.expression, matched: result.value.matched, parsed: ids.length },
    );
  }
  const highlight = selectionOverlay(mesh, ids);
  if ('code' in highlight) return highlight;
  const { faceMap } = mesh.compact();
  return {
    session,
    ...(request.checkpoint === undefined ? {} : { checkpoint: request.checkpoint }),
    ...(request.step === undefined ? {} : { step: request.step }),
    picked: picked.value,
    synthesis: result.value,
    highlight,
    reference: modeling.encodeSnapshot(mesh),
    faces: picked.value.map((f) => faceMap[f] as number),
    parameters,
  };
}

/** Score a selector on this build against picks carried over from the reference state. */
function verify(
  mesh: modeling.EditMesh,
  session: number,
  spec: NonNullable<CaptureRequest['verify']>,
): VerifyPayload | CaptureFailure {
  const selector = parseSelector(spec.selector);
  if ('code' in selector) return selector;
  if (selector.domain !== 'face') {
    return failure(
      'tool-invalid-args',
      'the verified selector selects faces',
      'pass a face selector',
    );
  }
  const reference = modeling.decodeSnapshot(spec.reference);
  if (!reference.ok) return asFailure(reference.error);
  const { mesh: canonical, faceMap } = mesh.compact();
  const carried = modeling.transferSelection(reference.value, spec.faces, canonical);
  const selected = selector.evaluate(mesh).map((f) => faceMap[f] as number);
  const expected = new Set(carried.faces);
  const common = selected.filter((f) => expected.has(f)).length;
  const union = expected.size + selected.length - common;
  return {
    session,
    expected: expected.size,
    matched: selected.length,
    common,
    lost: carried.lost,
    jaccard: union === 0 ? 1 : common / union,
  };
}

function summarizeRig(
  index: number,
  rig: modeling.Rig,
  sessions: readonly modeling.Model[],
): RigSummary {
  const parts = rig.parts();
  return {
    index,
    session: sessions.indexOf(rig.source),
    ...(rig.output === undefined ? {} : { output: rig.output }),
    joints: rig.joints.map((j) => ({
      name: j.name,
      parent: j.parent,
      kind: j.kind,
      axis: j.axis,
      ...(j.limits === undefined ? {} : { limits: j.limits }),
    })),
    parts: parts.ok ? parts.value : [],
    ...(rig.path === undefined ? {} : { path: rig.path.keys.map((k) => k.u) }),
    ...(parts.ok ? {} : { error: asFailure(parts.error) }),
  };
}

/** The rig a pose or scan targets: the requested index, else the only rig, else the one whose finish() ran. */
function targetRig(
  rigs: readonly RigSummary[],
  requested: number | undefined,
  built: boolean,
): number | CaptureFailure {
  const listed = rigs.map((r) => ({
    index: r.index,
    session: r.session,
    output: r.output ?? null,
  }));
  if (requested !== undefined) {
    if (Number.isInteger(requested) && requested >= 0 && requested < rigs.length) return requested;
    return failure(
      'model-selection-empty',
      `rig ${requested} exists among the ${rigs.length} captured rigs`,
      'pass --rig with a listed index',
      { rigs: listed },
    );
  }
  if (rigs.length === 1) return 0;
  const producing = rigs.filter((r) => r.output !== undefined);
  if (built && producing.length === 1) return (producing[0] as RigSummary).index;
  return failure(
    'tool-invalid-args',
    rigs.length === 0
      ? 'the Pack build creates a rig with rig()'
      : 'exactly one rig produced an output, or --rig names one',
    rigs.length === 0
      ? 'pose and scan need a rig(session, { joints }) in the Pack build'
      : 'pass --rig with an index from detail.rigs',
    { rigs: listed },
  );
}

function noPath(rig: number): CaptureFailure {
  return failure(
    'model-selection-empty',
    'the rig exported a transformation path',
    'pass path to rig.finish({ key, packageId, path }) in the Pack build, or pose explicit joint values with --pose',
    { rig },
  );
}

/** Joint values of a pose request, the pose report and the parts in contact. */
function poseOf(
  rig: modeling.Rig,
  index: number,
  request: NonNullable<CaptureRequest['pose']>,
):
  | { values: modeling.Pose; report: PoseReport; highlight?: modeling.FaceSelector }
  | CaptureFailure {
  let values: modeling.Pose = (request.values ?? {}) as modeling.Pose;
  if (request.u !== undefined) {
    if (request.values !== undefined)
      return failure(
        'tool-invalid-args',
        'either --u or --pose names the pose',
        'pass one of them',
      );
    const path = rig.path;
    if (path === undefined) return noPath(index);
    const sampled = rig.sample(path, request.u);
    if (!sampled.ok) return asFailure(sampled.error);
    values = sampled.value;
  }
  const limits = request.limits === undefined ? {} : { limits: request.limits };
  const posed = rig.pose(values, limits);
  if (!posed.ok) return asFailure(posed.error);
  const hit = rig.interference(values, {
    ...limits,
    ...(request.tolerance === undefined ? {} : { tolerance: request.tolerance }),
  });
  if (!hit.ok) return asFailure(hit.error);
  const touching = [
    ...new Set(hit.value.pairs.filter((p) => p.status !== 'designed').flatMap((p) => p.parts)),
  ].sort();
  let highlight: modeling.FaceSelector | undefined;
  for (const part of touching) {
    const faces = rig.partFaces(part);
    if (!faces.ok) return asFailure(faces.error);
    highlight = highlight === undefined ? faces.value : highlight.or(faces.value);
  }
  return {
    values,
    report: {
      rig: index,
      session: -1,
      ...(request.u === undefined ? {} : { u: request.u }),
      values: Object.fromEntries(
        posed.value.joints.filter((j) => j.value !== null).map((j) => [j.name, j.value]),
      ),
      clamped: posed.value.clamped,
      joints: posed.value.joints.map((j) => ({ name: j.name, world: j.world })),
      interference: hit.value,
      highlighted: touching,
    },
    ...(highlight === undefined ? {} : { highlight }),
  };
}

const round = (ms: number) => Math.round(ms * 10) / 10;

async function run(request: CaptureRequest): Promise<CaptureResponse> {
  const started = performance.now();
  let mark = started;
  const lap = () => {
    const now = performance.now();
    const ms = now - mark;
    mark = now;
    return ms;
  };
  let serial = 0;
  const loaded = await loadScriptablePack(request.sourcePath, {
    executor: {
      async load(entry: string) {
        serial++;
        return import(`${pathToFileURL(entry).href}?model-capture=${Date.now()}-${serial}`);
      },
    },
  });
  if (!loaded.ok) return { ok: false, error: asFailure(loaded.error) };
  const definition = loaded.value;
  const values =
    'parameters' in definition
      ? resolvePackParameterValues(definition, request.values ?? {})
      : undefined;
  if (values !== undefined && !values.ok) return { ok: false, error: asFailure(values.error) };
  if (request.step !== undefined && request.checkpoint !== undefined) {
    return {
      ok: false,
      error: failure(
        'tool-invalid-args',
        'either a checkpoint or a step names the state',
        'pass --checkpoint or --step, not both',
      ),
    };
  }
  if (request.explode !== undefined && request.section !== undefined) {
    return {
      ok: false,
      error: failure(
        'tool-invalid-args',
        'a render is either an explode or a section view',
        'render them separately',
      ),
    };
  }
  const steps = request.step !== undefined || request.replay !== undefined;
  const loadMs = lap();
  const captured = await modeling.captureModels(
    () =>
      (definition.build as (context: unknown) => unknown)({
        packageId: definition.packageId,
        ...(values === undefined ? {} : { values: values.value }),
        readByGuid: async () => ({
          ok: false,
          error: failure(
            'model-capability-unavailable',
            'a capture reads no other Pack outputs',
            'inspect the upstream Pack directly',
          ),
        }),
      }),
    { steps },
  );
  if (!captured.ok) return { ok: false, error: asFailure(captured.error) };
  const built = (await captured.value.value) as {
    ok?: boolean;
    value?: Record<string, unknown>;
    error?: unknown;
  };
  const sessions = captured.value.sessions;
  const buildMs = lap();
  let runs: Pick<CaptureTiming, 'cold' | 'hot' | 'local' | 'final' | 'env'> | undefined;
  if (request.timingRuns !== undefined) {
    const rebuild = async (value: unknown): Promise<number | CaptureFailure> => {
      const begun = performance.now();
      const again = await modeling.captureModels(() =>
        (definition.build as (context: unknown) => unknown)({
          packageId: definition.packageId,
          ...(value === undefined ? {} : { values: value }),
          readByGuid: async () => ({
            ok: false,
            error: failure(
              'model-capability-unavailable',
              'a capture reads no other Pack outputs',
              'inspect the upstream Pack directly',
            ),
          }),
        }),
      );
      if (!again.ok) return asFailure(again.error);
      await again.value.value;
      return round(performance.now() - begun);
    };
    const edit = request.timingRuns.local;
    const edited =
      edit === undefined || !('parameters' in definition)
        ? undefined
        : resolvePackParameterValues(definition, { ...request.values, ...edit });
    if (edited !== undefined && !edited.ok) return { ok: false, error: asFailure(edited.error) };
    const hot = await rebuild(values?.value);
    if (typeof hot !== 'number') return { ok: false, error: hot };
    const timed: { -readonly [K in keyof NonNullable<typeof runs>]: NonNullable<typeof runs>[K] } =
      {
        cold: round(buildMs),
        hot,
        env: captureEnvironment(fileURLToPath(new URL('../', import.meta.url))),
      };
    if (edited !== undefined) {
      const local = await rebuild(edited.value);
      if (typeof local !== 'number') return { ok: false, error: local };
      const final = await rebuild(values?.value);
      if (typeof final !== 'number') return { ok: false, error: final };
      timed.local = local;
      timed.final = final;
    }
    runs = timed;
    mark = performance.now();
  }
  const validated = { validateMs: 0 };
  const report: {
    -readonly [K in keyof CaptureReport]: CaptureReport[K];
  } = {
    build:
      built?.ok === true
        ? { ok: true, outputs: Object.keys(built.value ?? {}) }
        : { ok: false, outputs: [], error: asFailure(built?.error) },
    sessions: sessions.map((model, index) =>
      summarize(
        index,
        model,
        request.validate,
        validated,
        captured.value.rigs.find((r) => r.source === model)?.output,
      ),
    ),
    timing: { loadMs, buildMs, summarizeMs: 0, validateMs: 0, targetMs: 0, totalMs: 0 },
  };
  if (request.history === true) report.history = sessions.map((m, i) => history(i, m));
  const rigs = captured.value.rigs;
  if (rigs.length > 0) report.rigs = rigs.map((r, i) => summarizeRig(i, r, sessions));
  let posed:
    | { mesh: modeling.EditMesh; session: number; highlight?: modeling.FaceSelector }
    | undefined;
  if (request.pose !== undefined || request.scan !== undefined) {
    const which = targetRig(
      report.rigs ?? [],
      (request.pose ?? request.scan)?.rig,
      report.build.ok,
    );
    if (typeof which !== 'number') return { ok: false, error: which };
    const rig = rigs[which] as modeling.Rig;
    const session = sessions.indexOf(rig.source);
    if (request.scan !== undefined) {
      const path = rig.path;
      if (path === undefined) return { ok: false, error: noPath(which) };
      const scanned = rig.scan(path, {
        ...(request.scan.step === undefined ? {} : { step: request.scan.step }),
        ...(request.scan.maxTravel === undefined ? {} : { maxTravel: request.scan.maxTravel }),
        ...(request.scan.refine === undefined ? {} : { refine: request.scan.refine }),
        ...(request.scan.tolerance === undefined ? {} : { tolerance: request.scan.tolerance }),
        ...(request.scan.clearance === undefined ? {} : { clearance: request.scan.clearance }),
      });
      if (!scanned.ok) return { ok: false, error: asFailure(scanned.error) };
      report.scan = { rig: which, session, report: scanned.value };
    }
    if (request.pose !== undefined) {
      const pose = poseOf(rig, which, request.pose);
      if ('code' in pose) return { ok: false, error: pose };
      report.pose = { ...pose.report, session };
      const snapshot = rig.posedSnapshot(
        pose.values,
        request.pose.limits === undefined ? {} : { limits: request.pose.limits },
      );
      if (!snapshot.ok) return { ok: false, error: asFailure(snapshot.error) };
      const decoded = modeling.decodeSnapshot(snapshot.value);
      if (!decoded.ok) return { ok: false, error: asFailure(decoded.error) };
      posed = {
        mesh: decoded.value,
        session,
        ...(pose.highlight === undefined ? {} : { highlight: pose.highlight }),
      };
    }
  }

  const summarizeMs = lap() - validated.validateMs;
  const finish = (): CaptureResponse => {
    report.timing = {
      loadMs: round(loadMs),
      buildMs: round(buildMs),
      summarizeMs: round(summarizeMs),
      validateMs: round(validated.validateMs),
      targetMs: round(lap()),
      totalMs: round(performance.now() - started),
      ...runs,
    };
    return { ok: true, value: report };
  };
  const needsSession =
    request.selector !== undefined ||
    (request.overlays?.length ?? 0) > 0 ||
    request.render === true ||
    request.replay !== undefined ||
    request.snapshot === true ||
    request.synthesize !== undefined ||
    request.verify !== undefined;
  if (!needsSession) return finish();
  const index = posed?.session ?? targetSession(report.sessions, request.session, report.build.ok);
  if (typeof index !== 'number') return { ok: false, error: index };
  report.session = index;
  const model = sessions[index] as modeling.Model;
  const mesh = posed?.mesh ?? meshAt(model, request.checkpoint, request.step);
  if ('code' in mesh) return { ok: false, error: mesh };
  if (request.selector !== undefined) {
    const selected = select(mesh, index, request, request.selector);
    if ('code' in selected) return { ok: false, error: selected };
    report.selected = selected;
  }
  if ((request.overlays?.length ?? 0) > 0) {
    const overlays: OverlayPayload[] = [];
    for (const kind of request.overlays ?? []) {
      const overlay = overlayPayload(mesh, kind, request.overlayBounds);
      if ('code' in overlay) return { ok: false, error: overlay };
      overlays.push(overlay);
    }
    report.overlays = overlays;
  }
  if (request.render === true) {
    const rendered = renderPayload(
      mesh,
      index,
      model,
      request,
      request.checkpoint !== undefined || request.step !== undefined,
      posed?.highlight,
    );
    if ('code' in rendered) return { ok: false, error: rendered };
    report.render = rendered;
  }
  if (request.replay !== undefined) {
    const replayed = replayPayload(model, index, request.replay);
    if ('code' in replayed) return { ok: false, error: replayed };
    report.replay = replayed;
  }
  if (request.synthesize !== undefined) {
    const synthesized = synthesis(mesh, index, request, parameterRanges(definition, values?.value));
    if ('code' in synthesized) return { ok: false, error: synthesized };
    report.synthesis = synthesized;
  }
  if (request.verify !== undefined) {
    const verified = verify(mesh, index, request.verify);
    if ('code' in verified) return { ok: false, error: verified };
    report.verified = verified;
  }
  if (request.render === true || request.replay !== undefined) {
    const packed = packMaterials(
      built?.ok === true ? built.value : undefined,
      definition.packageId,
    );
    if (packed !== undefined) report.materials = packed;
  }
  if (request.snapshot === true) {
    report.state = {
      session: index,
      ...(request.checkpoint === undefined ? {} : { checkpoint: request.checkpoint }),
      snapshot: modeling.encodeSnapshot(mesh),
    };
  }
  return finish();
}

function packMaterials(
  outputs: Record<string, unknown> | undefined,
  packageId: Parameters<typeof AssetGuid.derive>[0],
): PackMaterials | undefined {
  const materials: Record<string, PackMaterials['materials'][string]> = {};
  const textures: Record<string, PackMaterials['textures'][string]> = {};
  for (const [key, asset] of Object.entries(outputs ?? {})) {
    if (key.startsWith('material/')) {
      materials[key.slice('material/'.length)] = asset as PackMaterials['materials'][string];
    } else if (key.startsWith('texture/')) {
      textures[AssetGuid.format(AssetGuid.derive(packageId, key))] =
        asset as PackMaterials['textures'][string];
    }
  }
  return Object.keys(materials).length === 0 ? undefined : { materials, textures };
}

function overlayPayload(
  mesh: modeling.EditMesh,
  kind: modeling.OverlayKind,
  bounds: readonly number[] | undefined,
): OverlayPayload | CaptureFailure {
  const overlay = modeling.projectOverlay(mesh, kind, bounds);
  if (!overlay.ok) return asFailure(overlay.error);
  const asset = overlay.value.mesh;
  const positions = Array.from(asset.attributes.position as Float32Array);
  if (positions.length / 3 > OVERLAY_VERTEX_LIMIT) {
    return failure(
      'model-work-budget',
      `the overlay has at most ${OVERLAY_VERTEX_LIMIT} vertices`,
      'select a checkpoint or a smaller Pack; for edges, frame a close-up (model.render --frame)',
      { kind, vertices: positions.length / 3 },
    );
  }
  return {
    kind: overlay.value.kind,
    topology: asset.submeshes[0]?.topology === 'line-list' ? 'line-list' : 'triangle-list',
    positions,
    colors: Array.from(asset.attributes.color as Float32Array),
    legend: overlay.value.legend,
  };
}

function faceSelector(
  view: modeling.Model,
  expression: string,
): modeling.FaceSelector | CaptureFailure | undefined {
  const selector = parseSelector(expression);
  if ('code' in selector) return selector;
  const faces =
    selector.domain === 'face'
      ? (selector as modeling.FaceSelector)
      : selector.domain === 'edge'
        ? (selector as modeling.EdgeSelector).toFaces()
        : undefined;
  return faces !== undefined && view.count(faces) > 0 ? faces : undefined;
}

/** Cut the view session at the plane and derive its even-odd cap, hatch and outline. */
function section(
  view: modeling.Model,
  request: SectionRequest,
): NonNullable<RenderPayload['section']> | CaptureFailure {
  const values = [...(request.point ?? []), ...(request.normal ?? [])];
  if (values.length !== 6 || !values.every(Number.isFinite)) {
    return failure(
      'tool-invalid-args',
      'section has a finite point and normal',
      'pass point and normal as [x, y, z]',
      {
        section: plain(request),
      },
    );
  }
  const point = request.point as [number, number, number];
  const normal = request.normal as [number, number, number];
  view.planeCut({ point, normal, keep: 'negative' });
  if (view.poisoned !== undefined) return asFailure(view.poisoned);
  const frame = modeling.planeFrame(point, normal);
  const segments = modeling.sectionSegments(view.editMesh, frame, view.tolerance * 10);
  if (segments.length === 0) {
    return failure(
      'model-selection-empty',
      'the section plane crosses the subject',
      'move the plane point inside the subject bounds',
      { point, normal },
    );
  }
  const filled = modeling.evenOddFill(segments);
  if (!filled.ok) return asFailure(filled.error);
  const us = segments.flatMap(([a, b]) => [a[0], b[0]]);
  const vs = segments.flatMap(([a, b]) => [a[1], b[1]]);
  const extent = Math.max(maxOf(us) - minOf(us), maxOf(vs) - minOf(vs));
  const spacing = request.spacing ?? modeling.hatchSpacing(segments);
  if (!(spacing > 0) || !Number.isFinite(spacing)) {
    return failure(
      'tool-invalid-args',
      'section spacing is a positive length',
      'pass spacing in meters',
      {
        spacing,
      },
    );
  }
  const hatched = modeling.evenOddHatch(segments, spacing, request.angle ?? 45);
  if (!hatched.ok) return asFailure(hatched.error);
  // Lines sit just off the cap so they win the depth test against it.
  const lift = Math.max(extent * 1e-3, view.tolerance * 10);
  const flat = (points: readonly modeling.Point2[], height: number) =>
    points.flatMap((p) => modeling.fromPlane(frame, p, height));
  let area = 0;
  const cap = filled.value;
  for (let i = 0; i < cap.length; i += 3) {
    const [a, b, c] = [cap[i], cap[i + 1], cap[i + 2]] as [
      modeling.Point2,
      modeling.Point2,
      modeling.Point2,
    ];
    area += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  return {
    point,
    normal: frame.normal,
    cap: flat(cap, 0),
    hatch: flat(hatched.value.flat(), lift),
    outline: flat(segments.flat(), lift),
    area: Math.round(area * 1e6) / 1e6,
    spacing,
  };
}

/**
 * Export a session state for viewing: a fresh session holds an FXEM copy; X-ray
 * faces move to the xray slot and the selection (edges as their adjacent faces) to
 * the highlight slot; a section cuts the copy, an explode moves its parts apart;
 * a state without complete `uv0` or `uv1` gets a box projection of that channel so
 * export can run.
 */
function renderPayload(
  mesh: modeling.EditMesh,
  session: number,
  model: modeling.Model,
  request: Pick<CaptureRequest, 'checkpoint' | 'selector' | 'xray' | 'explode' | 'section'>,
  intermediate: boolean,
  highlight?: modeling.FaceSelector,
): RenderPayload | CaptureFailure {
  let view = modeling.model();
  view.append(modeling.encodeSnapshot(mesh));
  let xrayFaces = 0;
  if (request.xray !== undefined) {
    const faces = faceSelector(view, request.xray);
    if (faces !== undefined && 'code' in faces) return faces;
    if (faces === undefined) {
      return failure(
        'model-selection-empty',
        'the xray selector matches faces',
        'try it with model.select',
        {
          xray: request.xray,
        },
      );
    }
    xrayFaces = view.count(faces);
    view.assign(faces, XRAY_SLOT);
  }
  if (request.selector !== undefined) {
    const faces = faceSelector(view, request.selector);
    if (faces !== undefined && 'code' in faces) return faces;
    if (faces !== undefined) view.assign(faces, HIGHLIGHT_SLOT);
  }
  if (highlight !== undefined && view.count(highlight) > 0) view.assign(highlight, HIGHLIGHT_SLOT);
  let sectioned: RenderPayload['section'];
  if (request.section !== undefined) {
    const cut = section(view, request.section);
    if ('code' in cut) return cut;
    sectioned = cut;
  }
  let exploded: RenderPayload['explode'];
  if (request.explode !== undefined) {
    const moved = modeling.explodeMesh(view.editMesh, request.explode);
    if (!moved.ok) return asFailure(moved.error);
    view = modeling.model();
    view.append(modeling.encodeSnapshot(moved.value.mesh));
    exploded = { by: request.explode.by, parts: moved.value.parts };
  }
  // Checkpoints and steps precede finish-time sharp intent (markSharp usually runs
  // last), so they view with 35 degree auto-smoothing; the final state keeps intent.
  const options = intermediate
    ? ({ normals: { mode: 'autoSmooth', angle: 35 } } as const)
    : ({ normals: { mode: 'weighted' } } as const);
  let exported = view.toMesh(options);
  let uvProjected = false;
  // Between UV writes a state can lack uv0 and a partly written uv1; box-project the
  // channel export names, once per channel.
  for (let attempt = 0; attempt < 2 && !exported.ok && view.poisoned === undefined; attempt++) {
    const channel = (exported.error.detail as { readonly channel?: unknown } | undefined)?.channel;
    view.uv.project({ mode: 'box', scale: 1, ...(channel === 'uv1' ? { channel } : {}) });
    uvProjected = true;
    exported = view.toMesh(options);
  }
  if (!exported.ok) return asFailure(exported.error);
  const { mesh: asset, report } = exported.value;
  const diagnostics = model.diagnostics();
  return {
    session,
    ...(request.checkpoint === undefined ? {} : { checkpoint: request.checkpoint }),
    mesh: asset,
    faces: report.faces,
    triangles: report.triangles,
    gpuVertices: report.gpuVertices,
    bounds: report.aabb,
    uvProjected,
    drawing: {
      drawings: diagnostics.drawings,
      contours: diagnostics.contours,
      surfaces: diagnostics.surfaces,
      featureLines: diagnostics.featureLines,
    },
    ...(exploded === undefined ? {} : { explode: exploded }),
    ...(sectioned === undefined ? {} : { section: sectioned }),
    ...(request.xray === undefined ? {} : { xray: { selector: request.xray, faces: xrayFaces } }),
  };
}

/** Render payloads of the requested operation states, each right after its operation. */
function replayPayload(
  model: modeling.Model,
  session: number,
  replay: readonly number[] | 'all',
): ReplayPayload | CaptureFailure {
  const journal = model.journal;
  let requested = replay;
  if (requested === 'all') {
    const states = journal.filter((e) => e.status === 'ok' && e.faces > 0).map((e) => e.opIndex);
    requested =
      states.length <= REPLAY_LIMIT
        ? states
        : Array.from(
            { length: REPLAY_LIMIT },
            (_, i) => states[Math.round((i * (states.length - 1)) / (REPLAY_LIMIT - 1))] as number,
          );
  }
  if (requested.length === 0 || requested.length > REPLAY_LIMIT) {
    return failure(
      'tool-invalid-args',
      `a replay lists 1..${REPLAY_LIMIT} steps`,
      'sample the operations (for example every k-th) to stay within the limit',
      { steps: requested.length, operations: journal.length },
    );
  }
  const frames: ReplayPayload['frames'][number][] = [];
  for (const opIndex of requested) {
    const state = stateAfter(model, opIndex);
    if ('code' in state) return state;
    const rendered = renderPayload(state, session, model, {}, true);
    if ('code' in rendered) return rendered;
    const entry = journal[opIndex] as modeling.JournalEntry;
    frames.push({
      ...rendered,
      opIndex,
      op: entry.op,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      ...(entry.source === undefined ? {} : { source: entry.source }),
    });
  }
  return {
    session,
    operations: journal.length,
    frames,
    stepsTruncated: model.diagnostics().stepsTruncated,
  };
}

const request = workerData as CaptureRequest;
run(request)
  .then((response) => parentPort?.postMessage(response))
  .catch((error: unknown) =>
    parentPort?.postMessage({ ok: false, error: asFailure(error) } satisfies CaptureResponse),
  );
