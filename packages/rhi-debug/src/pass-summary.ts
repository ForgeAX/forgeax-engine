import type { FrameModel, FramePass, JsonValue, ResourceEntry, WorkEntry } from './frame-model';

/** A color or depth attachment resolved through its view to the texture it renders into. */
export interface PassTargetSummary {
  readonly viewId: string;
  readonly textureId: string | null;
  /** Texture `desc.label`; the tape records no label for swapchain-backed textures. */
  readonly label: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly format: string | null;
}

export interface PassPipelineCount {
  readonly label: string;
  readonly count: number;
}

/** One render or compute pass: what it draws or dispatches, and into which targets. */
export interface PassSummary {
  readonly passIndex: number;
  readonly kind: FramePass['kind'];
  /** The pass `desc.label` the producer gave `beginRenderPass`/`beginComputePass`. */
  readonly label: string | null;
  readonly colorTargets: readonly PassTargetSummary[];
  readonly depthTarget: PassTargetSummary | null;
  /** Work count per recorded kind (`drawIndexed`, `drawIndirect`, `dispatchWorkgroups`, ...). */
  readonly workCounts: Readonly<Record<string, number>>;
  /** First and last `workIndex`, or null for a pass with no work. */
  readonly workRange: readonly [number, number] | null;
  /** Pipeline `desc.label` histogram, most used first. */
  readonly pipelines: readonly PassPipelineCount[];
}

/** A labelled resource row for `--label` lookups. */
export interface ResourceSummary {
  readonly resourceId: string;
  readonly kind: string;
  readonly label: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly format: string | null;
}

type JsonRecord = { readonly [key: string]: JsonValue };

const isRecord = (value: JsonValue | undefined | null): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Descriptor `desc` payload of a create event, when it has one. */
function descOf(entry: ResourceEntry | undefined): JsonRecord | undefined {
  const descriptor = entry?.descriptor;
  if (!isRecord(descriptor)) return undefined;
  const desc = descriptor.desc;
  return isRecord(desc) ? desc : undefined;
}

function labelOf(entry: ResourceEntry | undefined): string | null {
  const label = descOf(entry)?.label;
  return typeof label === 'string' && label.length > 0 ? label : null;
}

function numberAt(value: JsonValue | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

/** `size` is `{width,height}` in recorded tapes and `[w,h,d]` in hand-built ones. */
function extentOf(desc: JsonRecord | undefined): {
  readonly width: number | null;
  readonly height: number | null;
} {
  const size = desc?.size;
  if (Array.isArray(size)) return { width: numberAt(size[0]), height: numberAt(size[1]) };
  if (isRecord(size)) return { width: numberAt(size.width), height: numberAt(size.height) };
  return { width: null, height: null };
}

function targetOf(
  resources: ReadonlyMap<string, ResourceEntry>,
  viewId: string,
): PassTargetSummary {
  const view = resources.get(viewId);
  const viewDescriptor = view?.descriptor;
  const source = isRecord(viewDescriptor) ? viewDescriptor.sourceHandleId : undefined;
  const textureId = typeof source === 'string' ? source : null;
  const texture = textureId === null ? undefined : resources.get(textureId);
  const desc = descOf(texture);
  return {
    viewId,
    textureId,
    label: labelOf(texture) ?? labelOf(view),
    ...extentOf(desc),
    format: typeof desc?.format === 'string' ? desc.format : null,
  };
}

function pipelineLabel(work: WorkEntry): string {
  const { pipeline } = work;
  if (pipeline.status !== 'available') return `<${pipeline.reason}>`;
  const desc = isRecord(pipeline.descriptor) ? pipeline.descriptor.desc : undefined;
  const label = isRecord(desc) ? desc.label : undefined;
  return typeof label === 'string' && label.length > 0 ? label : (pipeline.pipelineHandleId ?? '?');
}

/** The `desc.label` of the pass's begin command. */
function passLabel(model: FrameModel, pass: FramePass): string | null {
  const first = pass.commandIndices[0];
  const params = first === undefined ? undefined : model.commands[first]?.params;
  const desc = isRecord(params) ? params.desc : undefined;
  const label = isRecord(desc) ? desc.label : undefined;
  return typeof label === 'string' && label.length > 0 ? label : null;
}

function tally(values: readonly string[]): readonly PassPipelineCount[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function workCountsOf(works: readonly WorkEntry[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const work of works) counts[work.kind] = (counts[work.kind] ?? 0) + 1;
  return counts;
}

function resourceIndex(model: FrameModel): ReadonlyMap<string, ResourceEntry> {
  return new Map(model.resources.map((entry) => [entry.resourceId, entry]));
}

/** One row per render/compute pass, in submission order. Pure model projection; no GPU. */
export function summarizePasses(model: FrameModel): readonly PassSummary[] {
  const resources = resourceIndex(model);
  const worksByPass = new Map<number, WorkEntry[]>();
  for (const work of model.works) {
    const list = worksByPass.get(work.passIndex);
    if (list === undefined) worksByPass.set(work.passIndex, [work]);
    else list.push(work);
  }
  return model.passes.map((pass) => {
    const works = worksByPass.get(pass.passIndex) ?? [];
    const first = works[0];
    const last = works[works.length - 1];
    return {
      passIndex: pass.passIndex,
      kind: pass.kind,
      label: passLabel(model, pass),
      colorTargets: pass.colorAttachmentViewHandleIds.map((id) => targetOf(resources, id)),
      depthTarget:
        pass.depthStencilViewHandleId === null
          ? null
          : targetOf(resources, pass.depthStencilViewHandleId),
      workCounts: workCountsOf(works),
      workRange:
        first === undefined || last === undefined ? null : [first.workIndex, last.workIndex],
      pipelines: tally(works.map(pipelineLabel)),
    };
  });
}

/** Per-work pipeline label for `summary.works[]`. */
export function workPipelineLabel(work: WorkEntry): string {
  return pipelineLabel(work);
}

function targetText(target: PassTargetSummary): string {
  const size = target.width === null ? '' : ` ${target.width}x${target.height}`;
  return `${target.label ?? target.viewId}${size}${target.format === null ? '' : ` ${target.format}`}`;
}

/** One scannable line per pass; the same facts as `PassSummary`, for terminals and agents. */
export function passLine(pass: PassSummary): string {
  const counts = Object.entries(pass.workCounts)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(', ');
  const targets = [
    ...pass.colorTargets.map(targetText),
    ...(pass.depthTarget === null ? [] : [`depth ${targetText(pass.depthTarget)}`]),
  ].join(' + ');
  const pipelines = pass.pipelines
    .map(({ label, count }) => (count > 1 ? `${label} x${count}` : label))
    .join(', ');
  return [
    `#${pass.passIndex} ${pass.kind} ${pass.label === null ? '-' : JSON.stringify(pass.label)}`,
    targets === '' ? undefined : `-> ${targets}`,
    counts === '' ? 'no work' : counts,
    pipelines === '' ? undefined : `[${pipelines}]`,
  ]
    .filter((part) => part !== undefined)
    .join(' | ');
}

/**
 * Textures, buffers and views whose own or source label matches `pattern`.
 * Views report the label of the texture they view.
 */
export function summarizeResources(model: FrameModel, pattern: RegExp): readonly ResourceSummary[] {
  const resources = resourceIndex(model);
  const rows: ResourceSummary[] = [];
  for (const entry of model.resources) {
    if (entry.kind !== 'texture' && entry.kind !== 'buffer' && entry.kind !== 'texture-view')
      continue;
    const view = entry.kind === 'texture-view' ? targetOf(resources, entry.resourceId) : undefined;
    const desc = descOf(entry);
    const label = view?.label ?? labelOf(entry);
    if (label === null || !pattern.test(label)) continue;
    rows.push({
      resourceId: entry.resourceId,
      kind: entry.kind,
      label,
      ...(view === undefined ? extentOf(desc) : { width: view.width, height: view.height }),
      format:
        view === undefined ? (typeof desc?.format === 'string' ? desc.format : null) : view.format,
    });
  }
  return rows;
}
