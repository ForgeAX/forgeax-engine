import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';
import { CORNER_CHANNEL_DIMENSIONS, type CornerChannelName, EditMesh } from './mesh';

/** Snapshots of poisoned sessions, by byte identity, with the session's first failure. */
const poisonedSnapshots = new WeakMap<Uint8Array, ModelingError>();

/** Record that `bytes` were taken from a poisoned session (its partial state). */
export function notePoisonedSnapshot(bytes: Uint8Array, cause: ModelingError): void {
  poisonedSnapshots.set(bytes, cause);
}

/**
 * Operands (append, array, booleans, shrinkwrap, bake) refuse a poisoned session's
 * snapshot as they refuse the session: its geometry is the partial state before the failure.
 */
export function checkSnapshotOperand(bytes: Uint8Array): Result<void, ModelingError> {
  const cause = poisonedSnapshots.get(bytes);
  if (cause === undefined) return ok(undefined);
  return err(
    modelingError(
      'model-precondition',
      'the operand snapshot comes from a session that is not poisoned',
      { cause: cause.code, expected: cause.expected },
      'fix the operand session first; its first failure is in detail.cause',
    ),
  );
}

/** FXEM snapshot format version written into the header. */
export const FXEM_VERSION = 1;

const MAGIC = 0x4d455846; // "FXEM" little-endian
const HEADER_BYTES = 64;
const ENTRY_BYTES = 24;

/** Section kinds are explicitly numbered; reordering this table never changes the format. */
const SECTION = {
  position: 1,
  halfVertex: 2,
  halfNext: 3,
  halfFace: 4,
  edgeFlags: 5,
  faceHalf: 6,
  faceLength: 7,
  faceMaterial: 8,
  faceLabel: 9,
  faceRole: 10,
  faceFlags: 11,
  faceTags: 12,
  strings: 13,
  channelValues: 100,
  channelSet: 200,
} as const;

const CHANNEL_CODES: readonly CornerChannelName[] = [
  'uv0',
  'uv1',
  'uv2',
  'uv3',
  'uv4',
  'uv5',
  'uv6',
  'uv7',
  'color',
];

type Payload = Float64Array | Float32Array | Int32Array | Uint32Array | Uint8Array;

interface Strings {
  readonly tags: readonly string[];
  readonly labels: readonly string[];
  readonly roles: readonly string[];
  readonly materials: readonly string[];
  readonly tagWords: number;
}

function align(n: number): number {
  return (n + 15) & ~15;
}

/**
 * Encode the canonical (compacted) form of a mesh. Equal meshes encode to equal
 * bytes regardless of edit history; holes, free lists and generations never persist.
 */
export function encodeSnapshot(source: EditMesh): Uint8Array {
  const mesh = source.compact().mesh;
  const v = mesh.vertexHighWater;
  const h = mesh.halfHighWater;
  const f = mesh.faceHighWater;
  const sections: [number, Payload][] = [
    [SECTION.position, mesh.pos.subarray(0, v * 3)],
    [SECTION.halfVertex, mesh.hVert.subarray(0, h)],
    [SECTION.halfNext, mesh.hNext.subarray(0, h)],
    [SECTION.halfFace, mesh.hFace.subarray(0, h)],
    [SECTION.edgeFlags, mesh.eFlags.subarray(0, h / 2)],
    [SECTION.faceHalf, mesh.fHalf.subarray(0, f)],
    [SECTION.faceLength, mesh.fLen.subarray(0, f)],
    [SECTION.faceMaterial, mesh.fMaterial.subarray(0, f)],
    [SECTION.faceLabel, mesh.fLabel.subarray(0, f)],
    [SECTION.faceRole, mesh.fRole.subarray(0, f)],
    [SECTION.faceFlags, mesh.fFlags.subarray(0, f)],
    [SECTION.faceTags, mesh.fTags.subarray(0, f * mesh.tagWords)],
  ];
  for (const [index, name] of CHANNEL_CODES.entries()) {
    const channel = mesh.channels.get(name);
    if (channel === undefined) continue;
    sections.push([SECTION.channelValues + index, channel.values.subarray(0, h * channel.dim)]);
    sections.push([SECTION.channelSet + index, channel.set.subarray(0, h)]);
  }
  const strings: Strings = {
    tags: mesh.tagNames,
    labels: mesh.labelNames,
    roles: mesh.roleNames,
    materials: mesh.materialNames,
    tagWords: mesh.tagWords,
  };
  sections.push([SECTION.strings, new TextEncoder().encode(JSON.stringify(strings))]);

  let offset = align(HEADER_BYTES + sections.length * ENTRY_BYTES);
  const placed = sections.map(([kind, payload]) => {
    const start = offset;
    offset = align(offset + payload.byteLength);
    return { kind, payload, start };
  });
  const bytes = new Uint8Array(offset);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, FXEM_VERSION, true);
  view.setUint32(8, v, true);
  view.setUint32(12, h, true);
  view.setUint32(16, f, true);
  view.setUint32(20, sections.length, true);
  for (const [i, { kind, payload, start }] of placed.entries()) {
    const entry = HEADER_BYTES + i * ENTRY_BYTES;
    view.setUint32(entry, kind, true);
    view.setUint32(entry + 4, payload.BYTES_PER_ELEMENT, true);
    view.setUint32(entry + 8, payload.length, true);
    view.setUint32(entry + 12, start, true);
    view.setUint32(entry + 16, payload.byteLength, true);
    bytes.set(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength), start);
  }
  return bytes;
}

function invalid(
  reason: string,
  detail: Record<string, unknown> = {},
): Result<never, ModelingError> {
  return err(
    modelingError(
      'model-precondition',
      `a valid FXEM v${FXEM_VERSION} snapshot (${reason})`,
      detail,
    ),
  );
}

/** Element type each numbered section must carry; the decoder never infers it from the bytes. */
type PayloadType = (new (b: ArrayBuffer) => Payload) & { readonly BYTES_PER_ELEMENT: number };

const SECTION_TYPES: Record<number, PayloadType> = {
  [SECTION.position]: Float64Array,
  [SECTION.halfVertex]: Int32Array,
  [SECTION.halfNext]: Int32Array,
  [SECTION.halfFace]: Int32Array,
  [SECTION.edgeFlags]: Uint8Array,
  [SECTION.faceHalf]: Int32Array,
  [SECTION.faceLength]: Int32Array,
  [SECTION.faceMaterial]: Int32Array,
  [SECTION.faceLabel]: Int32Array,
  [SECTION.faceRole]: Int32Array,
  [SECTION.faceFlags]: Uint8Array,
  [SECTION.faceTags]: Uint32Array,
  [SECTION.strings]: Uint8Array,
};
for (let i = 0; i < CHANNEL_CODES.length; i++) {
  SECTION_TYPES[SECTION.channelValues + i] = Float32Array;
  SECTION_TYPES[SECTION.channelSet + i] = Uint8Array;
}

function isNameTable(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((name) => typeof name === 'string');
}

function parseStrings(raw: Uint8Array): Strings | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { tags, labels, roles, materials, tagWords } = parsed as Record<string, unknown>;
  if (!isNameTable(tags) || !isNameTable(labels) || !isNameTable(roles) || !isNameTable(materials))
    return undefined;
  if (labels.length === 0 || roles.length === 0 || materials.length === 0) return undefined;
  if (typeof tagWords !== 'number') return undefined;
  return { tags, labels, roles, materials, tagWords };
}

/**
 * Decode a snapshot by replaying its faces, then restoring attributes, flags and corner values.
 * Every length, count, index and float is checked against the bytes actually present before it
 * sizes an allocation or a loop, so malformed input yields a structured error, never a throw.
 */
export function decodeSnapshot(bytes: Uint8Array): Result<EditMesh, ModelingError> {
  try {
    return decodeChecked(bytes);
  } catch (cause) {
    return invalid('unexpected decode failure', {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function decodeChecked(bytes: Uint8Array): Result<EditMesh, ModelingError> {
  if (bytes.byteLength < HEADER_BYTES) return invalid('truncated header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) return invalid('magic');
  const version = view.getUint16(4, true);
  if (version !== FXEM_VERSION) return invalid('version', { version });
  const v = view.getUint32(8, true);
  const h = view.getUint32(12, true);
  const f = view.getUint32(16, true);
  const count = view.getUint32(20, true);
  if (HEADER_BYTES + count * ENTRY_BYTES > bytes.byteLength)
    return invalid('truncated section table');
  const sections = new Map<number, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const entry = HEADER_BYTES + i * ENTRY_BYTES;
    const kind = view.getUint32(entry, true);
    const elem = view.getUint32(entry + 4, true);
    const length = view.getUint32(entry + 16, true);
    const start = view.getUint32(entry + 12, true);
    if (start + length > bytes.byteLength) return invalid('section out of range', { kind });
    if (sections.has(kind)) return invalid('duplicate section', { kind });
    const type = SECTION_TYPES[kind];
    if (type === undefined) continue;
    const size = type.BYTES_PER_ELEMENT;
    if (elem !== size || length % size !== 0 || view.getUint32(entry + 8, true) * size !== length)
      return invalid('section shape', { kind });
    sections.set(kind, bytes.slice(start, start + length));
  }
  const read = <T extends Payload>(kind: number, length: number): T | undefined => {
    const raw = sections.get(kind);
    if (raw === undefined) return undefined;
    const type = SECTION_TYPES[kind] as unknown as new (b: ArrayBuffer) => T;
    const out = new type(raw.buffer as ArrayBuffer);
    return out.length === length ? out : undefined;
  };
  const strings = parseStrings(sections.get(SECTION.strings) ?? new Uint8Array(0));
  if (strings === undefined) return invalid('strings section');
  const tagWords = Math.max(1, Math.ceil(strings.tags.length / 32));
  if (strings.tagWords !== tagWords) return invalid('tag words', { tagWords: strings.tagWords });
  if (v * 3 * 8 > bytes.byteLength || h * 4 > bytes.byteLength || f * 4 > bytes.byteLength)
    return invalid('element counts');

  const pos = read<Float64Array>(SECTION.position, v * 3);
  const hVert = read<Int32Array>(SECTION.halfVertex, h);
  const hNext = read<Int32Array>(SECTION.halfNext, h);
  const fHalf = read<Int32Array>(SECTION.faceHalf, f);
  const fLen = read<Int32Array>(SECTION.faceLength, f);
  const material = read<Int32Array>(SECTION.faceMaterial, f);
  const label = read<Int32Array>(SECTION.faceLabel, f);
  const role = read<Int32Array>(SECTION.faceRole, f);
  const flags = read<Uint8Array>(SECTION.faceFlags, f);
  const tags = read<Uint32Array>(SECTION.faceTags, f * tagWords);
  const edgeFlags = read<Uint8Array>(SECTION.edgeFlags, h / 2);
  if (!pos || !hVert || !hNext || !fHalf || !fLen) return invalid('missing section');
  if (!material || !label || !role || !flags || !tags || !edgeFlags)
    return invalid('missing attribute section');
  if (h % 2 !== 0) return invalid('half-edge count');
  for (let i = 0; i < pos.length; i++) {
    if (!Number.isFinite(pos[i])) return invalid('finite positions', { index: i });
  }
  for (let i = 0; i < h; i++) {
    const to = hVert[i] as number;
    const next = hNext[i] as number;
    if (to < 0 || to >= v) return invalid('half-edge vertex', { half: i });
    if (next < -1 || next >= h) return invalid('half-edge link', { half: i });
  }
  let used = 0;
  for (let i = 0; i < f; i++) {
    const length = fLen[i] as number;
    const half = fHalf[i] as number;
    if (length < 3 || half < 0 || half >= h) return invalid('face loop', { face: i });
    used += length;
    if (used > h) return invalid('face lengths exceed half-edges', { face: i });
    if (
      (material[i] as number) < 0 ||
      (material[i] as number) >= strings.materials.length ||
      (label[i] as number) < 0 ||
      (label[i] as number) >= strings.labels.length ||
      (role[i] as number) < 0 ||
      (role[i] as number) >= strings.roles.length
    )
      return invalid('name index', { face: i });
  }
  const spare = strings.tags.length % 32;
  const spareMask = spare === 0 ? 0 : ~((1 << spare) - 1) >>> 0;
  for (let i = 0; i < f; i++) {
    if (((tags[i * tagWords + tagWords - 1] as number) & spareMask) !== 0)
      return invalid('tag bits', { face: i });
  }

  const mesh = new EditMesh();
  for (const name of strings.tags) mesh.tagNames.push(name);
  mesh.labelNames.length = 0;
  for (const name of strings.labels) mesh.labelNames.push(name);
  mesh.roleNames.length = 0;
  for (const name of strings.roles) mesh.roleNames.push(name);
  mesh.materialNames.length = 0;
  for (const name of strings.materials) mesh.materialNames.push(name);
  for (let i = 0; i < v; i++)
    mesh.addVertex(pos[i * 3] as number, pos[i * 3 + 1] as number, pos[i * 3 + 2] as number);
  mesh.reserveTagWords(tagWords);
  for (let face = 0; face < f; face++) {
    const loop: number[] = [];
    let half = fHalf[face] as number;
    const length = fLen[face] as number;
    for (let i = 0; i < length; i++) {
      if (half < 0) return invalid('face loop', { face });
      loop.push(hVert[half] as number);
      half = hNext[half] as number;
    }
    const added = mesh.addFace(loop, material[face] as number);
    if (!added.ok) return invalid('face replay', { face, cause: added.error.code });
    if (added.value !== face) return invalid('face order', { face });
    mesh.fLabel[face] = label[face] as number;
    mesh.fRole[face] = role[face] as number;
    mesh.fFlags[face] = flags[face] as number;
    for (let w = 0; w < tagWords; w++) {
      mesh.fTags[face * mesh.tagWords + w] = tags[face * tagWords + w] as number;
    }
  }
  if (mesh.halfHighWater !== h) return invalid('edge replay');
  for (let i = 0; i < h; i++) {
    if ((mesh.hVert[i] as number) !== (hVert[i] as number))
      return invalid('half-edge order', { half: i });
  }
  mesh.eFlags.set(edgeFlags);
  for (const [index, name] of CHANNEL_CODES.entries()) {
    const dim = CORNER_CHANNEL_DIMENSIONS[name];
    const values = read<Float32Array>(SECTION.channelValues + index, h * dim);
    const set = read<Uint8Array>(SECTION.channelSet + index, h);
    if (sections.has(SECTION.channelValues + index) !== sections.has(SECTION.channelSet + index))
      return invalid('channel pair', { channel: name });
    if (sections.has(SECTION.channelValues + index) && (!values || !set))
      return invalid('channel length', { channel: name });
    if (!values || !set) continue;
    for (let i = 0; i < h; i++) {
      if ((set[i] as number) === 0) continue;
      const corner = values.subarray(i * dim, (i + 1) * dim);
      for (let k = 0; k < dim; k++) {
        if (!Number.isFinite(corner[k])) return invalid('finite corner values', { channel: name });
      }
      mesh.setCorner(name, i, corner);
    }
  }
  return ok(mesh);
}
