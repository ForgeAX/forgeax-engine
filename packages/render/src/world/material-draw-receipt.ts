import {
  appendedObservationBytes,
  MAX_INSPECTION_SAMPLES,
  MAX_RECEIPT_OBSERVATION_BYTES,
} from '../observation-budget';

/** Exact material source revision consumed by one actual submitted mesh draw. */
export interface MaterialSlotDrawReceiptFact {
  readonly worldIdentity: string;
  readonly entityKey: number;
  readonly submeshIndex: number;
  readonly materialSlot: number;
  readonly materialHandle: number;
  readonly sourceRevision: number;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
}

const empty: readonly MaterialSlotDrawReceiptFact[] = Object.freeze([]);
enum Field {
  Entity,
  Submesh,
  Slot,
  Handle,
  Revision,
  Device,
  Graph,
  Previous,
  Stride,
}

/** Fixed-size capture of scalar arguments. Indices are local to one view and frame. */
class MaterialDrawRows {
  frame: number | undefined;
  readonly numbers = new Float64Array(MAX_INSPECTION_SAMPLES * Field.Stride);
  readonly worlds: string[] = [];
  readonly lastByEntity = new Map<number, number>();
  textLength = 0;
  overflow = false;

  reset(frame?: number): void {
    this.worlds.length = 0;
    this.lastByEntity.clear();
    this.frame = frame;
    this.overflow = false;
    this.textLength = 0;
  }

  snapshot(): readonly MaterialSlotDrawReceiptFact[] {
    const frameId = this.frame;
    if (frameId === undefined || this.worlds.length === 0) return empty;
    const draws: MaterialSlotDrawReceiptFact[] = [];
    let bytes = 2;
    for (const worldIdentity of this.worlds) {
      const i = draws.length * Field.Stride,
        n = this.numbers;
      const fact = Object.freeze({
        worldIdentity,
        entityKey: n[i + Field.Entity] as number,
        submeshIndex: n[i + Field.Submesh] as number,
        materialSlot: n[i + Field.Slot] as number,
        materialHandle: n[i + Field.Handle] as number,
        sourceRevision: n[i + Field.Revision] as number,
        frameId,
        deviceGeneration: n[i + Field.Device] as number,
        graphGeneration: n[i + Field.Graph] as number,
      });
      bytes = appendedObservationBytes(bytes, fact);
      if (bytes > MAX_RECEIPT_OBSERVATION_BYTES) return empty;
      draws.push(fact);
    }
    return Object.freeze(draws);
  }
}

/** An accepted submission and the attempt being recorded have independent storage. */
export class MaterialDrawReceipt {
  private staged: MaterialDrawRows | undefined;
  private accepted: MaterialDrawRows | undefined;
  private published: readonly MaterialSlotDrawReceiptFact[] | undefined;

  record(
    frame: number,
    world: string,
    entity: number,
    submesh: number,
    slot: number,
    handle: number,
    revision: number,
    device: number,
    graph: number,
  ): void {
    const held = this.staged;
    if (held?.frame === frame && held.overflow) return;
    if (
      !world.length ||
      !Number.isSafeInteger(entity) ||
      !Number.isSafeInteger(submesh) ||
      !Number.isSafeInteger(slot) ||
      slot < 0 ||
      !Number.isSafeInteger(handle) ||
      handle <= 0 ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      !Number.isSafeInteger(device) ||
      device < 0 ||
      !Number.isSafeInteger(graph) ||
      graph < 0 ||
      Number.isNaN(frame)
    )
      return;
    this.staged ??= new MaterialDrawRows();
    const stage = this.staged;
    if (stage.frame !== frame) stage.reset(frame);
    const numbers = stage.numbers;
    const last = stage.lastByEntity.get(entity) ?? -1;
    for (let row = last; row >= 0; ) {
      const i = row * Field.Stride;
      if (
        stage.worlds[row] === world &&
        numbers[i + Field.Submesh] === submesh &&
        numbers[i + Field.Slot] === slot &&
        numbers[i + Field.Handle] === handle &&
        numbers[i + Field.Revision] === revision
      )
        return;
      row = numbers[i + Field.Previous] as number;
    }
    const row = stage.worlds.length;
    // UTF-16 code units are a lower bound on JSON's encoded UTF-8 bytes.
    // Bound retained input here; inspect the exact detached representation only on read.
    stage.textLength += world.length;
    if (row === MAX_INSPECTION_SAMPLES || stage.textLength > MAX_RECEIPT_OBSERVATION_BYTES) {
      stage.reset(frame);
      stage.overflow = true;
      return;
    }
    stage.worlds.push(world);
    stage.lastByEntity.set(entity, row);
    const i = row * Field.Stride;
    numbers[i + Field.Entity] = entity;
    numbers[i + Field.Submesh] = submesh;
    numbers[i + Field.Slot] = slot;
    numbers[i + Field.Handle] = handle;
    numbers[i + Field.Revision] = revision;
    numbers[i + Field.Device] = device;
    numbers[i + Field.Graph] = graph;
    numbers[i + Field.Previous] = last;
  }

  commit(frame: number): void {
    const previous = this.accepted;
    this.accepted = this.staged;
    this.staged = previous;
    previous?.reset();
    if (this.accepted?.frame !== frame) this.accepted?.reset();
    this.published = undefined;
  }

  discard(): void {
    this.staged?.reset();
    this.accepted?.reset();
    this.published = undefined;
  }

  get draws(): readonly MaterialSlotDrawReceiptFact[] {
    this.published ??= this.accepted?.snapshot() ?? empty;
    return this.published;
  }
}
