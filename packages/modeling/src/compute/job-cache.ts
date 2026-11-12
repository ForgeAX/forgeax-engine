import { sha256 } from './sha256';

/** The cached part of a successful job: everything its result carries except the report identity. */
export interface CachedJob {
  readonly status: 'ok' | 'partial';
  readonly outputs: readonly Uint8Array[];
  readonly provenance: unknown;
  readonly locations: readonly unknown[];
  readonly metrics: Readonly<Record<string, number>>;
}

const MAGIC = 0x434a5846; // 'FXJC' little-endian
const VERSION = 1;
const HEADER = 4 + 4 + 32;

const Tag = {
  Undefined: 0,
  Null: 1,
  False: 2,
  True: 3,
  Number: 4,
  String: 5,
  Array: 6,
  Object: 7,
  Typed: 8,
} as const;

const TYPED = [
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  Uint8ClampedArray,
] as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

class Writer {
  readonly chunks: Uint8Array[] = [];
  length = 0;
  private push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }
  u8(value: number): void {
    this.push(Uint8Array.of(value));
  }
  u32(value: number): void {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    this.push(out);
  }
  f64(value: number): void {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, value, true);
    this.push(out);
  }
  bytes(value: Uint8Array): void {
    this.u32(value.length);
    this.push(value);
  }
}

/** False when the value holds something the format cannot reproduce exactly. */
function write(w: Writer, value: unknown): boolean {
  if (value === undefined) w.u8(Tag.Undefined);
  else if (value === null) w.u8(Tag.Null);
  else if (value === false) w.u8(Tag.False);
  else if (value === true) w.u8(Tag.True);
  else if (typeof value === 'number') {
    w.u8(Tag.Number);
    w.f64(value);
  } else if (typeof value === 'string') {
    w.u8(Tag.String);
    w.bytes(encoder.encode(value));
  } else if (Array.isArray(value)) {
    w.u8(Tag.Array);
    w.u32(value.length);
    for (let i = 0; i < value.length; i++) if (!(i in value) || !write(w, value[i])) return false;
  } else if (ArrayBuffer.isView(value)) {
    const kind = TYPED.indexOf(value.constructor as (typeof TYPED)[number]);
    if (kind < 0) return false;
    w.u8(Tag.Typed);
    w.u8(kind);
    w.bytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  } else if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    const keys = Object.keys(value);
    w.u8(Tag.Object);
    w.u32(keys.length);
    for (const key of keys) {
      w.bytes(encoder.encode(key));
      if (!write(w, (value as Record<string, unknown>)[key])) return false;
    }
  } else return false;
  return true;
}

class Reader {
  offset = HEADER;
  private readonly view: DataView;
  readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  need(n: number): void {
    if (this.offset + n > this.data.length) throw new RangeError('truncated');
  }
  u8(): number {
    this.need(1);
    return this.data[this.offset++] as number;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }
  bytes(): Uint8Array {
    const n = this.u32();
    this.need(n);
    const out = this.data.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
}

function read(r: Reader): unknown {
  switch (r.u8()) {
    case Tag.Undefined:
      return undefined;
    case Tag.Null:
      return null;
    case Tag.False:
      return false;
    case Tag.True:
      return true;
    case Tag.Number:
      return r.f64();
    case Tag.String:
      return decoder.decode(r.bytes());
    case Tag.Array: {
      const n = r.u32();
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) out.push(read(r));
      return out;
    }
    case Tag.Typed: {
      const ctor = TYPED[r.u8()];
      if (ctor === undefined) throw new RangeError('typed array kind');
      const bytes = r.bytes();
      if (bytes.length % ctor.BYTES_PER_ELEMENT !== 0) throw new RangeError('typed array length');
      return new ctor(bytes.buffer as ArrayBuffer, 0, bytes.length / ctor.BYTES_PER_ELEMENT);
    }
    case Tag.Object: {
      const n = r.u32();
      const out: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        const key = decoder.decode(r.bytes());
        out[key] = read(r);
      }
      return out;
    }
    default:
      throw new RangeError('tag');
  }
}

function digestOf(key: string, body: Uint8Array): Uint8Array {
  const keyBytes = encoder.encode(key);
  const all = new Uint8Array(keyBytes.length + body.length);
  all.set(keyBytes);
  all.set(body, keyBytes.length);
  const hex = sha256(all);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The cache entry of a job under `key`: header, the digest of key and body, then the
 * tagged body. Undefined when the result holds a value the format would not reproduce
 * exactly (the job is then simply not cached).
 */
export function encodeJobEntry(key: string, job: CachedJob): Uint8Array | undefined {
  const w = new Writer();
  if (!write(w, job)) return undefined;
  const out = new Uint8Array(HEADER + w.length);
  let offset = HEADER;
  for (const chunk of w.chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  out.set(digestOf(key, out.subarray(HEADER)), 8);
  return out;
}

/** The job of a verified entry for `key`; undefined for a missing, foreign or corrupt one. */
export function decodeJobEntry(key: string, bytes: Uint8Array | undefined): CachedJob | undefined {
  if (bytes === undefined || bytes.length < HEADER) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== VERSION) return undefined;
  const digest = digestOf(key, bytes.subarray(HEADER));
  for (let i = 0; i < 32; i++) if (bytes[8 + i] !== digest[i]) return undefined;
  try {
    const r = new Reader(bytes);
    const job = read(r) as CachedJob;
    if (r.offset !== bytes.length) return undefined;
    if (
      (job?.status !== 'ok' && job?.status !== 'partial') ||
      !Array.isArray(job.outputs) ||
      !job.outputs.every((o) => o instanceof Uint8Array) ||
      !Array.isArray(job.locations) ||
      typeof job.metrics?.work !== 'number'
    )
      return undefined;
    return job;
  } catch {
    return undefined;
  }
}
