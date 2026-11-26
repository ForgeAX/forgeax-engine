import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import {
  refineTextureClusterMembership,
  type TextureClusterMembershipScratch,
} from '../cluster-binner';
import {
  DirectLightSlotWriter,
  type DirectLightSnapshot,
  type ReflectedDirectLightSlotLayout,
} from '../light-buffer-layout';
import type { PreparedStandardLighting } from '../pipeline/standard-lighting/prepare';
import type { StandardClusterTextureLayout } from '../pipeline/standard-lighting/texture';

/** Persistent CPU image for the WebGL2 Cluster texture's host-owned regions. */
export class ClusterTextureTable {
  readonly words: Uint32Array;
  private readonly sources: (DirectLightSnapshot | undefined)[] = [];
  private readonly projector: (boolean | undefined)[] = [];
  private readonly channelMappings: Uint32Array;
  private readonly writer: DirectLightSlotWriter;
  private readonly dirtyRows: Uint8Array;
  private readonly rowWords: number;
  private uploadValid = false;
  private packedLightSlots = 0;
  private uploadedBytes = 0;
  private usedRows = 0;
  private rowBytes = 0;

  private readonly membershipScratch: TextureClusterMembershipScratch = {};
  private membership:
    | {
        readonly bounds: symbol;
        readonly reservation: Uint32Array;
        readonly near: number;
        readonly far: number;
        readonly grid: Uint32Array;
        readonly indices: Uint32Array;
      }
    | undefined;

  constructor(
    width: number,
    height: number,
    private readonly slotLayout: ReflectedDirectLightSlotLayout,
  ) {
    this.words = new Uint32Array(width * height * 4);
    this.writer = new DirectLightSlotWriter(slotLayout);
    this.dirtyRows = new Uint8Array(height);
    this.rowWords = width * 4;
    this.channelMappings = new Uint32Array(slotLayout.capacity);
  }

  /** Cache against the exact producer bounds, including cone/orientation edits. */
  prepareMembership(prepared: PreparedStandardLighting): {
    readonly grid: Uint32Array;
    readonly indices: Uint32Array;
  } {
    const reservation = prepared.clusterGrid;
    const camera = prepared.camera;
    const bounds = prepared.publication?.bounds.id;
    const previous = this.membership;
    if (
      bounds !== undefined &&
      previous?.bounds === bounds &&
      previous.reservation === reservation &&
      previous.near === camera?.near &&
      previous.far === camera?.far
    ) {
      return previous;
    }
    const payload = prepared.boundsColumn?.uploadWords() ?? prepared.lightBounds;
    if (camera === undefined || payload[5] !== 1 || prepared.membershipEntryCount === 0)
      return { grid: reservation, indices: prepared.lightIndexList };
    const refined = refineTextureClusterMembership(
      payload,
      prepared.membershipLightCount,
      prepared.layout.grid,
      reservation,
      prepared.membershipEntryCount,
      camera.near,
      camera.far,
      prepared.clusterEntryCapK === undefined ? prepared.lightIndexList : undefined,
      this.membershipScratch,
    );
    if (bounds !== undefined) {
      this.membership = { bounds, reservation, near: camera.near, far: camera.far, ...refined };
    }
    return refined;
  }

  write(input: {
    readonly device: RhiDevice;
    readonly texture: Texture;
    readonly layout: StandardClusterTextureLayout;
    readonly local: readonly { readonly source?: DirectLightSnapshot | undefined }[];
    readonly projectorSlot?: number | undefined;
    readonly channelMapping?: number;
    readonly clusterGrid: Uint32Array;
    readonly lightIndices: Uint32Array;
    readonly lightIndexCount: number;
  }):
    | { readonly ok: true }
    | { readonly ok: false; readonly error: import('@forgeax/engine-rhi').RhiError } {
    this.packedLightSlots = 0;
    this.uploadedBytes = 0;
    this.usedRows = 0;
    this.rowBytes = 0;
    const { layout } = input;
    const rowWords = this.rowWords;
    const dirtyRows = this.dirtyRows;
    dirtyRows.fill(0);
    const previousUploadValid = this.uploadValid;
    this.uploadValid = false;
    if (this.sources.length > input.local.length) this.sources.length = input.local.length;
    const slotLayout = this.slotLayout;
    const channelMapping = input.channelMapping ?? 0;
    for (let slot = 0; slot < input.local.length; slot += 1) {
      const source = input.local[slot]?.source;
      if (source === undefined) {
        this.sources[slot] = undefined;
        continue;
      }
      const selected = input.projectorSlot === undefined ? undefined : input.projectorSlot === slot;
      if (
        this.sources[slot] === source &&
        this.projector[slot] === selected &&
        this.channelMappings[slot] === channelMapping
      )
        continue;
      this.writer.write(source, selected, channelMapping);
      const wordOffset = slot * slotLayout.floatCount;
      if (this.writer.copyChanged(this.words, wordOffset))
        this.markWords(wordOffset, slotLayout.floatCount);
      this.sources[slot] = source;
      this.projector[slot] = selected;
      this.channelMappings[slot] = channelMapping;
      this.packedLightSlots += 1;
    }
    this.updateWords(layout.gridOffset, input.clusterGrid, input.clusterGrid.length);
    this.updateWords(layout.indexOffset, input.lightIndices, input.lightIndexCount);
    const clusterEnd = layout.indexOffset + input.lightIndexCount;
    const usedRows = Math.ceil(clusterEnd / rowWords);
    this.usedRows = usedRows;
    this.rowBytes = layout.width * 16;
    if (!previousUploadValid) dirtyRows.fill(1, 0, usedRows);
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

  private markWords(offset: number, length: number): void {
    const first = Math.floor(offset / this.rowWords);
    const end = Math.ceil((offset + length) / this.rowWords);
    this.dirtyRows.fill(1, first, end);
  }

  private updateWords(offset: number, source: Uint32Array, length: number): void {
    let dirtyStart = -1;
    for (let index = 0; index < length; index += 1) {
      const word = source[index] as number;
      if (this.words[offset + index] === word) {
        if (dirtyStart >= 0) {
          this.markWords(offset + dirtyStart, index - dirtyStart);
          dirtyStart = -1;
        }
        continue;
      }
      this.words[offset + index] = word;
      if (dirtyStart < 0) dirtyStart = index;
    }
    if (dirtyStart >= 0) this.markWords(offset + dirtyStart, length - dirtyStart);
  }
}
