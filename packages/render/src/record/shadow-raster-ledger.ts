import type {
  BindGroup,
  Buffer,
  RenderBundle,
  RenderPipeline,
  Result,
  RhiError,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { type ShadowViewInspection, shadowViewIdentityKey } from '../gpu-driven/shadow-views';
import type {
  ShadowCacheStatistics,
  ShadowRasterInspection,
  ShadowRasterViewInspection,
  ShadowViewIdentity,
  ShadowViewInvalidationReason,
  ShadowWorkloadCommands,
  ShadowWorkloadPass,
} from '../inspection-types';
import { MAX_INSPECTION_SAMPLES } from '../observation-budget';

export interface ShadowUpdateRevision {
  readonly source: object;
  readonly target?: object | undefined;
  readonly entity: number;
  readonly revision: number;
}

interface ShadowRasterEntry {
  identity: ShadowViewIdentity;
  key: string;
  invalidationReason: ShadowViewInvalidationReason | undefined;
  drawCount: number;
  workload?: MutableCommands | undefined;
  passName?: string | undefined;
  texelCulled: number | undefined;
  cameraCulled: number | undefined;
  dirtyRectCount: number | undefined;
  revision?: ShadowUpdateRevision | undefined;
}

type MutableCommands = { -readonly [K in keyof ShadowWorkloadCommands]: ShadowWorkloadCommands[K] };
const commands = (): MutableCommands => ({
  directDraws: 0,
  directIndexedDraws: 0,
  indirectDraws: 0,
  indexedIndirectDraws: 0,
  bundleCalls: 0,
  knownBundleIndirectDraws: 0,
  knownBundleIndexedIndirectDraws: 0,
  directVertexInstances: 0,
  directIndexInstances: 0,
});
function addProduct(previous: number | null, count: number, instances = 1): number | null {
  const value = count * instances;
  return previous !== null &&
    Number.isSafeInteger(count) &&
    count >= 0 &&
    Number.isSafeInteger(instances) &&
    instances >= 0 &&
    Number.isSafeInteger(value) &&
    Number.isSafeInteger(previous + value)
    ? previous + value
    : null;
}

/**
 * Forwards one shadow pass and counts its draw commands. A single instance is
 * rebound per pass because the graph encodes shadow passes sequentially.
 */
class DrawCountingRenderPass implements RhiRenderPassEncoder {
  target: RhiRenderPassEncoder | undefined;
  draws = 0;
  workload: MutableCommands | undefined;

  private get pass(): RhiRenderPassEncoder {
    return this.target as RhiRenderPassEncoder;
  }

  setPipeline(pipeline: RenderPipeline): void {
    this.pass.setPipeline(pipeline);
  }
  setVertexBuffer(slot: number, buffer: Buffer, offset?: number, size?: number): void {
    this.pass.setVertexBuffer(slot, buffer, offset, size);
  }
  setIndexBuffer(
    buffer: Buffer,
    format: 'uint16' | 'uint32',
    offset?: number,
    size?: number,
  ): void {
    this.pass.setIndexBuffer(buffer, format, offset, size);
  }
  setBindGroup(index: number, bindGroup: BindGroup, dynamicOffsets?: readonly number[]): void;
  setBindGroup(
    index: number,
    bindGroup: BindGroup,
    dynamicOffsetsData: Uint32Array,
    dynamicOffsetsDataStart: number,
    dynamicOffsetsDataLength: number,
  ): void;
  setBindGroup(
    index: number,
    bindGroup: BindGroup,
    offsets?: readonly number[] | Uint32Array,
    start?: number,
    length?: number,
  ): void {
    if (offsets instanceof Uint32Array) {
      this.pass.setBindGroup(index, bindGroup, offsets, start ?? 0, length ?? offsets.length);
    } else {
      this.pass.setBindGroup(index, bindGroup, offsets);
    }
  }
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number) {
    this.draws += 1;
    this.pass.draw(vertexCount, instanceCount, firstVertex, firstInstance);
    if (this.workload !== undefined) {
      this.workload.directDraws += 1;
      this.workload.directVertexInstances = addProduct(
        this.workload.directVertexInstances,
        vertexCount,
        instanceCount,
      );
    }
  }
  drawIndexed(
    indexCount: number,
    instanceCount?: number,
    firstIndex?: number,
    baseVertex?: number,
    firstInstance?: number,
  ): void {
    this.draws += 1;
    this.pass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
    if (this.workload !== undefined) {
      this.workload.directIndexedDraws += 1;
      this.workload.directIndexInstances = addProduct(
        this.workload.directIndexInstances,
        indexCount,
        instanceCount,
      );
    }
  }
  drawIndirect(indirectBuffer: Buffer, indirectOffset: number): void {
    this.draws += 1;
    this.pass.drawIndirect(indirectBuffer, indirectOffset);
    if (this.workload !== undefined) this.workload.indirectDraws += 1;
  }
  drawIndexedIndirect(indirectBuffer: Buffer, indirectOffset: number): void {
    this.draws += 1;
    this.pass.drawIndexedIndirect(indirectBuffer, indirectOffset);
    if (this.workload !== undefined) this.workload.indexedIndirectDraws += 1;
  }
  end(): void {
    this.pass.end();
  }
  setViewport(x: number, y: number, w: number, h: number, minDepth: number, maxDepth: number) {
    this.pass.setViewport(x, y, w, h, minDepth, maxDepth);
  }
  setScissorRect(x: number, y: number, w: number, h: number): void {
    this.pass.setScissorRect(x, y, w, h);
  }
  setBlendConstant(color: GPUColor): void {
    this.pass.setBlendConstant(color);
  }
  setStencilReference(reference: number): void {
    this.pass.setStencilReference(reference);
  }
  pushDebugGroup(groupLabel: string): void {
    this.pass.pushDebugGroup(groupLabel);
  }
  popDebugGroup(): void {
    this.pass.popDebugGroup();
  }
  insertDebugMarker(markerLabel: string): void {
    this.pass.insertDebugMarker(markerLabel);
  }
  executeBundles(bundles: Iterable<RenderBundle>): Result<void, RhiError> {
    const result = this.pass.executeBundles(bundles);
    if (result.ok && this.workload !== undefined) this.workload.bundleCalls += 1;
    return result;
  }
  beginOcclusionQuery(queryIndex: number): Result<void, RhiError> {
    return this.pass.beginOcclusionQuery(queryIndex);
  }
  endOcclusionQuery(): Result<void, RhiError> {
    return this.pass.endOcclusionQuery();
  }
}

/** Internal stock bundle producer bridge; never traverses opaque bundle handles. */
export function capturesShadowBundleWorkload(pass: RhiRenderPassEncoder): boolean {
  return pass instanceof DrawCountingRenderPass && pass.workload !== undefined;
}

export function recordShadowBundleWorkload(
  pass: RhiRenderPassEncoder,
  known: { readonly indirect: number; readonly indexedIndirect: number } | undefined,
): void {
  if (
    !(pass instanceof DrawCountingRenderPass) ||
    pass.workload === undefined ||
    known === undefined
  )
    return;
  pass.workload.knownBundleIndirectDraws += known.indirect;
  pass.workload.knownBundleIndexedIndirectDraws += known.indexedIndirect;
}

const EMPTY_SHADOW_RASTER: ShadowRasterInspection = Object.freeze({
  passCount: 0,
  drawCount: 0,
  views: Object.freeze([]),
});

/**
 * Per-frame shadow view decisions and draw counts. Entries are reused across
 * frames; the detached inspection is built only when a consumer reads it.
 */
export class ShadowRasterLedger {
  private staged: ShadowRasterEntry[] = [];
  private stagedLength = 0;
  private workloadFrame: number | undefined;
  private committedWorkloadFrame: number | undefined;
  private committed: ShadowRasterEntry[] = [];
  private committedLength = 0;
  private snapshot: ShadowRasterInspection | undefined = EMPTY_SHADOW_RASTER;
  private readonly statistics = new Map<
    string,
    {
      revision?: ShadowUpdateRevision;
      decisions: number;
      hits: number;
      rebuilds: number;
      drawCount: number;
      invalidations: Partial<Record<ShadowViewInvalidationReason, number>>;
    }
  >();
  private readonly activeKeys = new Set<string>();
  private readonly counter = new DrawCountingRenderPass();

  /** Start staging a frame; the previous committed frame stays readable. */
  begin(captureWorkload = false, frameId?: number): void {
    this.workloadFrame = captureWorkload ? frameId : undefined;
    this.stagedLength = 0;
  }

  hasRevision(identity: ShadowViewIdentity, revision: ShadowUpdateRevision): boolean {
    const previous = this.statistics.get(shadowViewIdentityKey(identity))?.revision;
    return (
      previous?.source === revision.source &&
      previous.target === revision.target &&
      previous.entity === revision.entity &&
      previous.revision === revision.revision
    );
  }

  /** Record one view decision and return its entry slot. */
  evaluate(
    identity: ShadowViewIdentity,
    invalidationReason: ShadowViewInvalidationReason | undefined,
    texelCulled?: number,
    cameraCulled?: number,
    dirtyRectCount?: number,
    revision?: ShadowUpdateRevision,
  ): number {
    const slot = this.stagedLength;
    this.stagedLength += 1;
    const entry = this.staged[slot];
    if (entry === undefined) {
      this.staged.push({
        identity,
        key: shadowViewIdentityKey(identity),
        invalidationReason,
        drawCount: 0,
        workload: this.workloadFrame === undefined ? undefined : commands(),
        texelCulled,
        cameraCulled,
        dirtyRectCount,
        revision,
      });
    } else {
      if (entry.identity !== identity) entry.key = shadowViewIdentityKey(identity);
      entry.identity = identity;
      entry.invalidationReason = invalidationReason;
      entry.drawCount = 0;
      entry.passName = undefined;
      entry.workload = this.workloadFrame === undefined ? undefined : commands();
      entry.texelCulled = texelCulled;
      entry.cameraCulled = cameraCulled;
      entry.dirtyRectCount = dirtyRectCount;
      entry.revision = revision;
    }
    return slot;
  }

  /** Run `encode` against a counting view of `pass`, attributing draws to `slot`. */
  encode(
    slot: number,
    pass: RhiRenderPassEncoder,
    encode: (pass: RhiRenderPassEncoder) => void,
    passName?: string,
  ) {
    const counter = this.counter;
    counter.target = pass;
    counter.draws = 0;
    const entry = this.staged[slot];
    counter.workload = slot < this.stagedLength ? entry?.workload : undefined;
    if (entry !== undefined && slot < this.stagedLength)
      entry.passName = counter.workload === undefined ? undefined : passName;
    try {
      encode(counter);
    } finally {
      const entry = this.staged[slot];
      if (entry !== undefined && slot < this.stagedLength) entry.drawCount += counter.draws;
      counter.target = undefined;
      counter.workload = undefined;
    }
  }

  /** Publish the staged frame after its queue submit succeeded. */
  commit(): void {
    const active = this.activeKeys;
    active.clear();
    for (let slot = 0; slot < this.stagedLength; slot += 1) {
      const entry = this.staged[slot] as ShadowRasterEntry;
      active.add(entry.key);
      let statistics = this.statistics.get(entry.key);
      if (statistics === undefined) {
        statistics = { decisions: 0, hits: 0, rebuilds: 0, drawCount: 0, invalidations: {} };
        this.statistics.set(entry.key, statistics);
      }
      statistics.decisions += 1;
      statistics.drawCount += entry.drawCount;
      if (entry.invalidationReason === undefined) statistics.hits += 1;
      else {
        statistics.rebuilds += 1;
        if (entry.revision !== undefined) statistics.revision = entry.revision;
        const reason = entry.invalidationReason;
        statistics.invalidations[reason] = (statistics.invalidations[reason] ?? 0) + 1;
      }
    }
    for (const key of this.statistics.keys()) {
      if (!active.has(key)) this.statistics.delete(key);
    }
    this.committedWorkloadFrame = this.workloadFrame;
    const previous = this.committed;
    this.committed = this.staged;
    this.committedLength = this.stagedLength;
    this.staged = previous;
    this.stagedLength = 0;
    this.snapshot = undefined;
  }

  captureWorkload(
    frameId: number,
    culling?: readonly Pick<ShadowViewInspection, 'identity' | 'lastCullingObservation'>[],
  ): readonly ShadowWorkloadPass[] | undefined {
    if (this.committedWorkloadFrame !== frameId) return undefined;
    const rows: ShadowWorkloadPass[] = [];
    for (let slot = 0; slot < Math.min(this.committedLength, MAX_INSPECTION_SAMPLES); slot += 1) {
      const entry = this.committed[slot];
      if (entry?.workload === undefined) return undefined;
      const observed = culling?.find(
        (row) => shadowViewIdentityKey(row.identity) === entry.key,
      )?.lastCullingObservation;
      rows.push(
        Object.freeze({
          identity: Object.freeze({
            ...entry.identity,
            ...(entry.identity.terrainReceiver === undefined
              ? {}
              : {
                  terrainReceiver: Object.freeze({ ...entry.identity.terrainReceiver }),
                }),
          }),
          passName: entry.passName ?? null,
          cache: entry.invalidationReason === undefined ? 'hit' : 'miss',
          ...(entry.invalidationReason === undefined
            ? {}
            : { invalidationReason: entry.invalidationReason }),
          commands: Object.freeze({ ...entry.workload }),
          indirectActual: 'unobserved',
          bundleContents: 'unobserved',
          ...(observed === undefined
            ? {}
            : {
                lastCullingObservation: Object.freeze({
                  ...observed,
                  producer: Object.freeze({ ...observed.producer }),
                }),
              }),
        }),
      );
    }
    return this.committedLength > MAX_INSPECTION_SAMPLES ? undefined : Object.freeze(rows);
  }

  inspect(): ShadowRasterInspection {
    if (this.snapshot !== undefined) return this.snapshot;
    let passCount = 0;
    let drawCount = 0;
    const views: ShadowRasterViewInspection[] = [];
    for (let slot = 0; slot < this.committedLength; slot += 1) {
      const entry = this.committed[slot] as ShadowRasterEntry;
      drawCount += entry.drawCount;
      const accumulated = this.statistics.get(entry.key) as ShadowCacheStatistics;
      const statistics = Object.freeze({
        decisions: accumulated.decisions,
        hits: accumulated.hits,
        rebuilds: accumulated.rebuilds,
        drawCount: accumulated.drawCount,
        invalidations: Object.freeze({ ...accumulated.invalidations }),
      });
      const culled = {
        statistics,
        ...(entry.texelCulled === undefined ? {} : { texelCulled: entry.texelCulled }),
        ...(entry.cameraCulled === undefined ? {} : { cameraCulled: entry.cameraCulled }),
      };
      if (entry.invalidationReason === undefined) {
        views.push(
          Object.freeze({
            identity: entry.identity,
            cache: 'hit',
            drawCount: entry.drawCount,
            ...culled,
          }),
        );
        continue;
      }
      passCount += 1;
      views.push(
        Object.freeze({
          identity: entry.identity,
          cache: 'miss',
          invalidationReason: entry.invalidationReason,
          drawCount: entry.drawCount,
          ...culled,
          ...(entry.dirtyRectCount === undefined ? {} : { dirtyRectCount: entry.dirtyRectCount }),
        }),
      );
    }
    this.snapshot = Object.freeze({ passCount, drawCount, views: Object.freeze(views) });
    return this.snapshot;
  }
}
