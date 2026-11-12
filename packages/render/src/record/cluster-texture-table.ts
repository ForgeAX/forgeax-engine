import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import {
  type DirectLightSnapshot,
  packDirectLightSlot,
  type ReflectedDirectLightSlotLayout,
} from '../light-buffer-layout';
import type { StandardClusterTextureLayout } from '../pipeline/standard-lighting/texture';

/** Persistent CPU image for the WebGL2 Cluster texture's host-owned regions. */
export class ClusterTextureTable {
  readonly words: Uint32Array;
  private readonly sources: (DirectLightSnapshot | undefined)[] = [];
  private readonly projector: (boolean | undefined)[] = [];
  private uploadValid = false;
  private packedLightSlots = 0;
  private uploadedBytes = 0;
  private usedRows = 0;
  private rowBytes = 0;

  constructor(width: number, height: number, lightSlotCount: number) {
    this.words = new Uint32Array(width * height * 4);
    this.sources.length = lightSlotCount;
    this.projector.length = lightSlotCount;
  }

  write(input: {
    readonly device: RhiDevice;
    readonly texture: Texture;
    readonly layout: StandardClusterTextureLayout;
    readonly local: readonly { readonly source?: DirectLightSnapshot | undefined }[];
    readonly projectorSlot?: number | undefined;
    readonly clusterGrid: Uint32Array;
    readonly lightIndices: Uint32Array;
    readonly lightIndexCount: number;
    readonly slotLayout: ReflectedDirectLightSlotLayout;
  }):
    | { readonly ok: true }
    | { readonly ok: false; readonly error: import('@forgeax/engine-rhi').RhiError } {
    this.packedLightSlots = 0;
    this.uploadedBytes = 0;
    this.usedRows = 0;
    this.rowBytes = 0;
    const { layout } = input;
    const rowWords = layout.width * 4;
    const dirtyRows = new Uint8Array(layout.height);
    const markWords = (offset: number, length: number): void => {
      if (length <= 0) return;
      const first = Math.floor(offset / rowWords);
      const end = Math.ceil((offset + length) / rowWords);
      dirtyRows.fill(1, first, Math.min(end, dirtyRows.length));
    };
    const slotLayout = input.slotLayout;
    for (let slot = 0; slot < input.local.length; slot += 1) {
      const source = input.local[slot]?.source;
      if (source === undefined) continue;
      const selected = input.projectorSlot === undefined ? undefined : input.projectorSlot === slot;
      if (this.sources[slot] === source && this.projector[slot] === selected) continue;
      this.sources[slot] = source;
      this.projector[slot] = selected;
      const packed = new Uint32Array(packDirectLightSlot(source, slotLayout, selected).buffer);
      const wordOffset = slot * slotLayout.floatCount;
      let changed = false;
      for (let index = 0; index < packed.length; index += 1) {
        const word = packed[index] as number;
        if (this.words[wordOffset + index] === word) continue;
        this.words[wordOffset + index] = word;
        changed = true;
      }
      this.packedLightSlots += 1;
      if (changed) markWords(wordOffset, packed.length);
    }
    this.updateWords(layout.gridOffset, input.clusterGrid, markWords);
    this.updateWords(
      layout.indexOffset,
      input.lightIndices.subarray(0, input.lightIndexCount),
      markWords,
    );
    const clusterEnd = layout.indexOffset + input.lightIndexCount;
    const usedRows = Math.ceil(clusterEnd / rowWords);
    this.usedRows = usedRows;
    this.rowBytes = layout.width * 16;
    if (!this.uploadValid) dirtyRows.fill(1, 0, usedRows);
    let row = 0;
    while (row < usedRows) {
      while (row < usedRows && dirtyRows[row] !== 1) row += 1;
      if (row >= usedRows) break;
      const first = row;
      while (row < usedRows && dirtyRows[row] === 1) row += 1;
      const rows = row - first;
      const result = input.device.queue.writeTexture(
        { texture: input.texture, origin: { x: 0, y: first, z: 0 } },
        this.words.subarray(first * rowWords, row * rowWords),
        { bytesPerRow: layout.width * 16, rowsPerImage: rows },
        { width: layout.width, height: rows, depthOrArrayLayers: 1 },
      );
      if (!result.ok) {
        this.uploadValid = false;
        return { ok: false, error: result.error };
      }
      this.uploadedBytes += rows * layout.width * 16;
    }
    this.uploadValid = true;
    return { ok: true };
  }

  inspect(): {
    readonly packedLightSlots: number;
    readonly uploadedBytes: number;
    readonly usedRows: number;
    readonly rowBytes: number;
  } {
    return Object.freeze({
      packedLightSlots: this.packedLightSlots,
      uploadedBytes: this.uploadedBytes,
      usedRows: this.usedRows,
      rowBytes: this.rowBytes,
    });
  }

  private updateWords(
    offset: number,
    source: Uint32Array,
    markWords: (offset: number, length: number) => void,
  ): void {
    let dirtyStart = -1;
    for (let index = 0; index < source.length; index += 1) {
      const word = source[index] as number;
      if (this.words[offset + index] === word) {
        if (dirtyStart >= 0) {
          markWords(offset + dirtyStart, index - dirtyStart);
          dirtyStart = -1;
        }
        continue;
      }
      this.words[offset + index] = word;
      if (dirtyStart < 0) dirtyStart = index;
    }
    if (dirtyStart >= 0) markWords(offset + dirtyStart, source.length - dirtyStart);
  }
}
