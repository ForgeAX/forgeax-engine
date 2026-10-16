import type {
  BindGroup,
  Buffer,
  RenderBundle,
  RenderPipeline,
  Result,
  RhiError,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { shadowViewIdentityKey } from '../gpu-driven/shadow-views';
import type {
  ShadowCacheStatistics,
  ShadowRasterInspection,
  ShadowRasterViewInspection,
  ShadowViewIdentity,
  ShadowViewInvalidationReason,
} from '../inspection-types';

interface ShadowRasterEntry {
  identity: ShadowViewIdentity;
  key: string;
  invalidationReason: ShadowViewInvalidationReason | undefined;
  drawCount: number;
  texelCulled: number | undefined;
  cameraCulled: number | undefined;
  dirtyRectCount: number | undefined;
}

/**
 * Forwards one shadow pass and counts its draw commands. A single instance is
 * rebound per pass because the graph encodes shadow passes sequentially.
 */
class DrawCountingRenderPass implements RhiRenderPassEncoder {
  target: RhiRenderPassEncoder | undefined;
  draws = 0;

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
  }
  drawIndirect(indirectBuffer: Buffer, indirectOffset: number): void {
    this.draws += 1;
    this.pass.drawIndirect(indirectBuffer, indirectOffset);
  }
  drawIndexedIndirect(indirectBuffer: Buffer, indirectOffset: number): void {
    this.draws += 1;
    this.pass.drawIndexedIndirect(indirectBuffer, indirectOffset);
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
    return this.pass.executeBundles(bundles);
  }
  beginOcclusionQuery(queryIndex: number): Result<void, RhiError> {
    return this.pass.beginOcclusionQuery(queryIndex);
  }
  endOcclusionQuery(): Result<void, RhiError> {
    return this.pass.endOcclusionQuery();
  }
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
  private committed: ShadowRasterEntry[] = [];
  private committedLength = 0;
  private snapshot: ShadowRasterInspection | undefined = EMPTY_SHADOW_RASTER;
  private readonly statistics = new Map<
    string,
    {
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
  begin(): void {
    this.stagedLength = 0;
  }

  /** Record one view decision and return its entry slot. */
  evaluate(
    identity: ShadowViewIdentity,
    invalidationReason: ShadowViewInvalidationReason | undefined,
    texelCulled?: number,
    cameraCulled?: number,
    dirtyRectCount?: number,
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
        texelCulled,
        cameraCulled,
        dirtyRectCount,
      });
    } else {
      if (entry.identity !== identity) entry.key = shadowViewIdentityKey(identity);
      entry.identity = identity;
      entry.invalidationReason = invalidationReason;
      entry.drawCount = 0;
      entry.texelCulled = texelCulled;
      entry.cameraCulled = cameraCulled;
      entry.dirtyRectCount = dirtyRectCount;
    }
    return slot;
  }

  /** Run `encode` against a counting view of `pass`, attributing draws to `slot`. */
  encode(slot: number, pass: RhiRenderPassEncoder, encode: (pass: RhiRenderPassEncoder) => void) {
    const counter = this.counter;
    counter.target = pass;
    counter.draws = 0;
    try {
      encode(counter);
    } finally {
      const entry = this.staged[slot];
      if (entry !== undefined && slot < this.stagedLength) entry.drawCount += counter.draws;
      counter.target = undefined;
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
        const reason = entry.invalidationReason;
        statistics.invalidations[reason] = (statistics.invalidations[reason] ?? 0) + 1;
      }
    }
    for (const key of this.statistics.keys()) {
      if (!active.has(key)) this.statistics.delete(key);
    }
    const previous = this.committed;
    this.committed = this.staged;
    this.committedLength = this.stagedLength;
    this.staged = previous;
    this.stagedLength = 0;
    this.snapshot = undefined;
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
        ...accumulated,
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
