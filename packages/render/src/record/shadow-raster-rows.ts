import type { BindGroup, Buffer, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import {
  type PreparedRasterBindings,
  recordPreparedRasterAfter,
} from '../gpu-driven/prepared-raster-bundle';
import type { RenderFrameState } from './frame-snapshot';

export type ShadowRasterBindingRow = {
  -readonly [K in keyof PreparedRasterBindings]?: PreparedRasterBindings[K] | undefined;
};

/** Validate all of a light view's bindings before issuing its first caster. Scissored
 * regions replay the same short-lived list. Native handles never survive release. */
export class ShadowRasterRows {
  readonly lane = 'direct';
  private readonly rows: ShadowRasterBindingRow[] = [];
  private readonly offsetWords = new Uint32Array(1);
  private count = 0;
  private highWater = 0;
  private recording = false;

  static borrow(frame: RenderFrameState): ShadowRasterRows {
    frame.shadowRasterRows ??= new ShadowRasterRows();
    const owner = frame.shadowRasterRows;
    const run = owner.recording ? new ShadowRasterRows() : owner;
    run.recording = true;
    return run;
  }

  next(view: BindGroup, indirect: Buffer): ShadowRasterBindingRow {
    const i = this.count++;
    this.rows[i] ??= { viewOffset: 0, materialOffset: 0 };
    const row = this.rows[i];
    row.view = view;
    row.indirect = indirect;
    return row;
  }

  record(pass: RhiRenderPassEncoder): void {
    let previous: PreparedRasterBindings | undefined;
    for (let i = 0; i < this.count; i++) {
      const row = this.rows[i] as PreparedRasterBindings;
      recordPreparedRasterAfter(pass, row, previous, undefined, this.offsetWords);
      previous = row;
    }
  }

  release(): void {
    for (let i = 0; i < this.count; i++) {
      const row = this.rows[i];
      if (row === undefined) continue;
      row.pipeline =
        row.view =
        row.material =
        row.mesh =
        row.vertex =
        row.index =
        row.indirect =
          undefined;
      row.meshOffsets = row.vertexStreams = row.windows = undefined;
    }
    this.highWater = Math.max(this.highWater, this.count);
    this.count = 0;
    this.recording = false;
  }

  finishFrame(): void {
    if (!this.recording && this.rows.length > this.highWater * 2) this.rows.length = this.highWater;
    this.highWater = 0;
  }
}
