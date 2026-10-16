import type { RenderableSnapshot } from '../render-system-extract';

/** Internal receipt for one concrete CPU/GPU presentation draw unit. */
export interface RenderableDrawReceipt {
  readonly pipeline?: import('@forgeax/engine-rhi').RenderPipeline;
  readonly programKey?: string;
  readonly materialSlot?: number;
  readonly passIndex?: number;
  readonly unsupportedLineage?: boolean;
  readonly lane: 'cpu' | 'gpu';
  readonly ready: boolean;
}

/** Accepted indices in the current CPU validation's row domain. */
export interface GpuDrivenDrawReceipts {
  readonly renderableIndices: readonly number[];
  readonly submeshIndices: readonly number[];
  /** Compact source draw positions accepted by the same ownership validation. */
  readonly ownedDraws: ReadonlyMap<RenderableSnapshot, readonly boolean[]>;
}

/** Consume the pre-submit ownership result only after successful submission. */
export function emitGpuDrivenDrawReceipts<T>(
  validated: readonly T[],
  receipts: GpuDrivenDrawReceipts,
  onRenderableDraw: (entry: T, submeshIndex: number, receipt: RenderableDrawReceipt) => void,
): void {
  let index = 0;
  for (const submeshIndex of receipts.submeshIndices) {
    const renderableIndex = receipts.renderableIndices[index++];
    const entry = renderableIndex === undefined ? undefined : validated[renderableIndex];
    if (entry === undefined)
      throw new Error('GPU draw receipt is outside its validated row domain');
    onRenderableDraw(entry, submeshIndex, {
      lane: 'gpu',
      ready: true,
    });
  }
}
