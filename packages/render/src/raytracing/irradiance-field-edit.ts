import { mat4 } from '@forgeax/engine-math';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { type FieldEdit, type FieldEditBounds, fieldEditBounds, worldBounds } from './field-edit';
import { packGlobalSdfComposition } from './global-sdf';
import type { IndexRun } from './index-allocator';
import type { ProbeCardCapture } from './renderer-probe-cards';
import type { ProbeGlobalRegion } from './renderer-probe-global';
import { SDF_INSTANCE_STRIDE } from './sdf-query';
import { packCardProjection } from './surface-cards';

export type { IndexRun } from './index-allocator';

const CARD_PROJECTION_BYTES = 80;
const BOUNDS_ROW_BYTES = 48;

/** Sorted, merged runs; adjacency and overlap coalesce. */
export function mergeRuns(runs: readonly IndexRun[]): IndexRun[] {
  const sorted = [...runs].filter((r) => r.end > r.first).sort((a, b) => a.first - b.first);
  const out: { first: number; end: number }[] = [];
  for (const run of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && run.first <= last.end) last.end = Math.max(last.end, run.end);
    else out.push({ ...run });
  }
  return out;
}

function scales(t: ArrayLike<number>): number[] {
  const s = [0, 4, 8].map((a) => Math.hypot(t[a] ?? 0, t[a + 1] ?? 0, t[a + 2] ?? 0));
  return [...s, Math.min(...s)];
}

/** Result of one written edit; `added` lists each add's owned Global row. */
export interface WrittenFieldEdit {
  /** Every Card tile run the edit invalidated, merged. */
  readonly tiles: IndexRun[];
  /** Tile runs that adds installed (a subset of `tiles`). */
  readonly addedTiles: IndexRun[];
  /** World boxes whose Global SDF changed. */
  readonly bounds: FieldEditBounds[];
  /** World boxes whose probes see different surfaces: SDF boxes plus material changes. */
  readonly probeBounds: FieldEditBounds[];
  readonly added: number[];
}

/**
 * Writes one in-place edit into a prepared field's Global SDF rows and Card
 * capture, in order: moves, removals (rows and tiles freed), material changes
 * (draws replaced on the same tiles), then adds (rows, field words and tiles
 * allocated from headroom). Throws when the edit needs a rebuild, including
 * exhausted headroom; the caller then discards the whole field.
 */
export function writeFieldEdit(
  device: RhiDevice,
  region: Pick<ProbeGlobalRegion, 'input' | 'grid' | 'headroom'>,
  cards: ProbeCardCapture,
  edit: FieldEdit,
): WrittenFieldEdit {
  const queue = device.queue;
  const tiles: IndexRun[] = [];
  const addedTiles: IndexRun[] = [];
  const write = (target: { readonly buffer: Buffer }, offset: number, data: ArrayBufferView) =>
    queue
      .writeBuffer(
        target.buffer,
        offset,
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      )
      .unwrap();
  const writeProjections = (instanceId: number, run: { first: number; count: number }) => {
    const entry = cards.capture.entries.find((e) => e.instanceId === instanceId);
    if (entry === undefined || entry.projections.length !== run.count)
      throw new Error('field edit lost its Card entry');
    const bytes = new Uint8Array(run.count * CARD_PROJECTION_BYTES);
    const view = new DataView(bytes.buffer);
    entry.projections.forEach((p, i) => {
      bytes.set(packCardProjection(p), i * CARD_PROJECTION_BYTES);
      view.setUint32(i * CARD_PROJECTION_BYTES + 64, instanceId, true);
      view.setUint32(i * CARD_PROJECTION_BYTES + 68, 1, true);
    });
    write(cards.projections, run.first * CARD_PROJECTION_BYTES, bytes);
    tiles.push({ first: run.first, end: run.first + run.count });
  };
  for (const move of edit.moved) {
    const inverse = mat4.invert(mat4.create(), mat4.clone(Array.from(move.to)));
    if (!Array.from(inverse).every(Number.isFinite))
      throw new Error('field edit transform is singular');
    const resident = cards.capture.has(move.index);
    const run = resident ? cards.capture.retransform(move.index, move.to).unwrap() : undefined;
    write(region.input.instances, move.index * SDF_INSTANCE_STRIDE, new Float32Array(inverse));
    write(
      region.input.bounds,
      move.index * BOUNDS_ROW_BYTES + 32,
      new Float32Array(scales(move.to)),
    );
    if (run !== undefined) writeProjections(move.index, run);
  }
  const headroom = region.headroom;
  for (const removal of edit.removed) {
    // ids.w is the instance mask; zero removes it from composition and traces.
    write(region.input.instances, removal.index * SDF_INSTANCE_STRIDE + 76, new Uint32Array([0]));
    headroom?.rows.free({ first: removal.index, end: removal.index + 1 });
    // A non-resident instance (Card residency) owns no tiles.
    if (!cards.capture.has(removal.index)) continue;
    const run = cards.capture.remove(removal.index).unwrap();
    const bytes = new Uint8Array(run.count * CARD_PROJECTION_BYTES);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < run.count; i++)
      view.setUint32(i * CARD_PROJECTION_BYTES + 64, 0xffffffff, true);
    write(cards.projections, run.first * CARD_PROJECTION_BYTES, bytes);
    tiles.push({ first: run.first, end: run.first + run.count });
  }
  const probeBounds: FieldEditBounds[] = [];
  for (const change of edit.rematerialized) {
    if (cards.capture.has(change.index)) {
      const lowered = cards.lower(change.source, change.instance, change.index);
      writeProjections(change.index, cards.capture.rematerialize(change.index, lowered).unwrap());
    }
    probeBounds.push(worldBounds(change.local, change.instance.transform));
  }
  const added: number[] = [];
  if (edit.added.length > 0 && headroom === undefined)
    throw new Error('field adds require a region prepared with headroom');
  for (const add of edit.added) {
    if (headroom === undefined) break;
    const rowRun = headroom.rows.allocate(1);
    if (rowRun === undefined) throw new Error('Global SDF instance headroom is exhausted');
    const row = rowRun.first;
    let geometryId = headroom.geometryIds.get(add.source.mesh);
    if (geometryId === undefined) {
      geometryId = headroom.geometryIds.size;
      headroom.geometryIds.set(add.source.mesh, geometryId);
    }
    const packed = packGlobalSdfComposition(
      [{ ...add.instance, instanceId: row, geometryId }],
      region.grid,
    ).unwrap();
    const instanceRow = packed.data.instances.slice(0, SDF_INSTANCE_STRIDE);
    const rowView = new DataView(instanceRow.buffer);
    if (rowView.getUint32(80, true) !== 0xffffffff) {
      let offset = headroom.fieldOffsets.get(add.source.field);
      if (offset === undefined) {
        const words = packed.data.fields.byteLength / 4;
        if (headroom.fieldWords + words > headroom.fieldCapacity)
          throw new Error('Global SDF field headroom is exhausted');
        offset = headroom.fieldWords;
        write(region.input.fields, offset * 4, packed.data.fields);
        headroom.fieldWords += words;
        headroom.fieldOffsets.set(add.source.field, offset);
      }
      rowView.setUint32(80, offset, true);
    }
    const lowered = cards.lower(add.source, add.instance, row);
    const installed = cards.capture.add(lowered);
    // Under Card residency an add past the Card ceilings joins as non-resident.
    if (
      !installed.ok &&
      (cards.capture.residency === undefined || installed.error.code !== 'ray-reference-limit')
    )
      installed.unwrap();
    write(region.input.instances, row * SDF_INSTANCE_STRIDE, instanceRow);
    write(
      region.input.bounds,
      row * BOUNDS_ROW_BYTES,
      packed.data.bounds.slice(0, BOUNDS_ROW_BYTES),
    );
    if (installed.ok) {
      writeProjections(row, installed.value);
      addedTiles.push({
        first: installed.value.first,
        end: installed.value.first + installed.value.count,
      });
    }
    added.push(row);
    headroom.instanceCount = Math.max(headroom.instanceCount, row + 1);
  }
  if (added.length > 0 && headroom !== undefined) {
    // settings.w bounds every instance loop; the Card count bounds every tile loop.
    write(region.input.settings, 28, new Uint32Array([headroom.instanceCount]));
    write(cards.settings, 0, new Uint32Array([cards.capture.allocatedTiles]));
  }
  const bounds = fieldEditBounds(edit);
  return {
    tiles: mergeRuns(tiles),
    addedTiles,
    bounds,
    probeBounds: [...bounds, ...probeBounds],
    added,
  };
}
