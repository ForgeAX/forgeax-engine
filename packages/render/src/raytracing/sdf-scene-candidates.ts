import { SDF_SURFACE_POOL_LAYOUT as LAYOUT } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { rayReferenceFailure } from './scene';
import type { SdfPlacementBounds } from './sdf-transform-certificate';

interface CandidateRow {
  readonly row: number;
  readonly bounds: SdfPlacementBounds | undefined;
}
interface CandidateNode {
  readonly row: number | undefined;
  readonly bounds: SdfPlacementBounds | undefined;
  escape: number;
}
const LEAF = 0x80000000,
  ENCLOSED = 0x40000000;

function mergeBounds(rows: readonly CandidateRow[]): SdfPlacementBounds | undefined {
  if (rows.some((row) => row.bounds === undefined)) return undefined;
  const min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const row of rows) {
    if (!row.bounds) return undefined;
    for (const axis of [0, 1, 2] as const) {
      min[axis] = Math.min(min[axis], row.bounds.min[axis]);
      max[axis] = Math.max(max[axis], row.bounds.max[axis]);
    }
  }
  return { min, max };
}
function center(row: CandidateRow, axis: number) {
  return row.bounds ? (row.bounds.min[axis] ?? 0) * 0.5 + (row.bounds.max[axis] ?? 0) * 0.5 : 0;
}
function appendNodes(rows: readonly CandidateRow[], nodes: CandidateNode[]) {
  const index = nodes.length,
    bounds = mergeBounds(rows);
  nodes.push({ row: rows.length === 1 ? rows[0]?.row : undefined, bounds, escape: 0 });
  if (rows.length > 1) {
    const span = [0, 1, 2].map(
        (axis) =>
          Math.max(...rows.map((row) => center(row, axis))) -
          Math.min(...rows.map((row) => center(row, axis))),
      ),
      axis = span.indexOf(Math.max(...span)),
      sorted = [...rows].sort((a, b) => center(a, axis) - center(b, axis) || a.row - b.row),
      middle = Math.floor(sorted.length / 2);
    appendNodes(sorted.slice(0, middle), nodes);
    appendNodes(sorted.slice(middle), nodes);
  }
  const node = nodes[index];
  if (!node) throw Error('Object candidate node allocation failed');
  node.escape = nodes.length;
}
function writeBounds(
  view: DataView,
  word: number,
  bounds: SdfPlacementBounds | undefined,
  tag: number,
) {
  for (const axis of [0, 1, 2] as const) {
    view.setFloat32((word + axis) * 4, bounds?.min[axis] ?? 0, true);
    view.setFloat32((word + axis + 4) * 4, bounds?.max[axis] ?? 0, true);
  }
  view.setUint32((word + 3) * 4, tag, true);
}
function validBounds(bounds: SdfPlacementBounds) {
  return (
    bounds.min.length === 3 &&
    bounds.max.length === 3 &&
    [...bounds.min, ...bounds.max].every(
      (value) =>
        Number.isFinite(value) &&
        Math.fround(value) === value &&
        (value === 0 || Math.abs(value) >= 2 ** -126),
    ) &&
    bounds.min.every((value, axis) => value <= (bounds.max[axis] ?? -Infinity))
  );
}

/** Optional index only: the original geometry allocation is never truncated.
 * Unknown envelopes remain explicit leaves; no index is a complete-roster fallback. */
export function packSdfSceneCandidates(
  bounds: readonly (SdfPlacementBounds | undefined)[],
  instances: Uint8Array,
  capacity: number,
  availableWords: number,
) {
  if (
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > LAYOUT.maxRows ||
    bounds.length > capacity ||
    instances.byteLength !== capacity * LAYOUT.instanceWords * 4 ||
    !Number.isSafeInteger(availableWords) ||
    availableWords < 0
  )
    return rayReferenceFailure('invalid canonical object candidate source span');
  const words =
    capacity * LAYOUT.candidateRowWords + (2 * capacity - 1) * LAYOUT.candidateNodeWords;
  const source = new DataView(instances.buffer, instances.byteOffset, instances.byteLength),
    rows: CandidateRow[] = [];
  for (const [row, envelope] of bounds.entries()) {
    if (envelope && !validBounds(envelope))
      return rayReferenceFailure('invalid canonical placement enclosure');
    const mask = source.getUint32((row * LAYOUT.instanceWords + 19) * 4, true);
    if (mask > 255) return rayReferenceFailure('invalid canonical candidate instance mask');
    if (mask !== 0) rows.push({ row, bounds: envelope });
  }
  if (words > availableWords) return ok(undefined);
  const nodes: CandidateNode[] = [];
  if (rows.length) appendNodes(rows, nodes);
  const data = new Uint32Array(words),
    view = new DataView(data.buffer);
  bounds.forEach((envelope, row) => {
    writeBounds(view, row * LAYOUT.candidateRowWords, envelope, Number(envelope !== undefined));
  });
  const first = capacity * LAYOUT.candidateRowWords;
  nodes.forEach((node, index) => {
    const tag =
        ((node.row === undefined ? 0 : LEAF | node.row) | (node.bounds ? ENCLOSED : 0)) >>> 0,
      word = first + index * LAYOUT.candidateNodeWords;
    writeBounds(view, word, node.bounds, tag);
    view.setUint32((word + 7) * 4, node.escape, true);
  });
  const admitted = validateSdfSceneCandidateRegion(data, nodes.length, bounds, instances, capacity);
  if (!admitted.ok) return admitted;
  return ok({ words: data, nodeCount: nodes.length, rowLimit: bounds.length });
}

function decodedBounds(
  data: Uint32Array,
  first: number,
  valid: boolean,
): SdfPlacementBounds | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength),
    min = [0, 1, 2].map((axis) => view.getFloat32((first + axis) * 4, true)) as [
      number,
      number,
      number,
    ],
    max = [0, 1, 2].map((axis) => view.getFloat32((first + axis + 4) * 4, true)) as [
      number,
      number,
      number,
    ];
  if (!valid)
    return [...min, ...max].every((value) => Object.is(value, 0))
      ? undefined
      : { min: [NaN, 0, 0], max: [0, 0, 0] };
  return { min, max };
}
function sameBounds(left: SdfPlacementBounds | undefined, right: SdfPlacementBounds | undefined) {
  if (!left || !right) return left === right;
  return (
    validBounds(left) &&
    validBounds(right) &&
    [...left.min, ...left.max].every((value, axis) =>
      Object.is(value, [...right.min, ...right.max][axis]),
    )
  );
}
function containsBounds(
  parent: SdfPlacementBounds | undefined,
  child: SdfPlacementBounds | undefined,
) {
  if (!parent) return true;
  return (
    !!child &&
    validBounds(parent) &&
    validBounds(child) &&
    [0, 1, 2].every(
      (axis) =>
        (parent.min[axis] ?? Infinity) <= (child.min[axis] ?? -Infinity) &&
        (parent.max[axis] ?? -Infinity) >= (child.max[axis] ?? Infinity),
    )
  );
}
function validCandidateNode(
  data: Uint32Array,
  first: number,
  index: number,
  count: number,
  bounds: readonly (SdfPlacementBounds | undefined)[],
  seen: Set<number>,
) {
  const at = first + index * LAYOUT.candidateNodeWords,
    flags = data[at + 3] ?? 0,
    escapeIndex = data[at + 7] ?? 0,
    leaf = (flags & LEAF) !== 0,
    box = decodedBounds(data, at, (flags & ENCLOSED) !== 0);
  if (
    escapeIndex <= index ||
    escapeIndex > count ||
    (flags & ~(LEAF | ENCLOSED | (LAYOUT.maxRows - 1))) !== 0 ||
    (box && !validBounds(box))
  )
    return false;
  if (leaf) {
    const row = flags & (LAYOUT.maxRows - 1);
    if (
      row >= bounds.length ||
      seen.has(row) ||
      escapeIndex !== index + 1 ||
      !sameBounds(box, bounds[row])
    )
      return false;
    seen.add(row);
    return true;
  }
  if ((flags & (LAYOUT.maxRows - 1)) !== 0 || index + 1 >= escapeIndex) return false;
  return candidateChildrenEnclosed(data, first, index, escapeIndex, box);
}
function candidateChildrenEnclosed(
  data: Uint32Array,
  first: number,
  index: number,
  escapeIndex: number,
  box: SdfPlacementBounds | undefined,
) {
  const left = first + (index + 1) * LAYOUT.candidateNodeWords,
    rightIndex = data[left + 7] ?? 0,
    right = first + rightIndex * LAYOUT.candidateNodeWords;
  if (rightIndex <= index + 1 || rightIndex >= escapeIndex || data[right + 7] !== escapeIndex)
    return false;
  const a = decodedBounds(data, left, ((data[left + 3] ?? 0) & ENCLOSED) !== 0),
    b = decodedBounds(data, right, ((data[right + 3] ?? 0) & ENCLOSED) !== 0);
  return (
    containsBounds(box, a) &&
    containsBounds(box, b) &&
    (box !== undefined) === (a !== undefined && b !== undefined)
  );
}

function candidateMembershipValid(
  data: Uint32Array,
  bounds: readonly (SdfPlacementBounds | undefined)[],
  instances: Uint8Array,
  seen: ReadonlySet<number>,
) {
  const source = new DataView(instances.buffer, instances.byteOffset, instances.byteLength);
  for (const [row, envelope] of bounds.entries()) {
    const at = row * LAYOUT.candidateRowWords,
      flag = data[at + 3] ?? 0,
      mask = source.getUint32((row * LAYOUT.instanceWords + 19) * 4, true);
    if (
      flag > 1 ||
      data[at + 7] !== 0 ||
      !sameBounds(decodedBounds(data, at, flag === 1), envelope) ||
      mask > 255 ||
      seen.has(row) !== (mask !== 0)
    )
      return false;
  }
  for (let row = bounds.length; row < instances.byteLength / (LAYOUT.instanceWords * 4); row++)
    if (source.getUint32((row * LAYOUT.instanceWords + 19) * 4, true) !== 0) return false;
  return true;
}

/** Complete producer-owned admission before immutable publication. Per-ray GPU
 * traversal checks visited nodes, rather than repeating this complete scan. */
export function validateSdfSceneCandidateRegion(
  data: Uint32Array,
  nodeCount: number,
  bounds: readonly (SdfPlacementBounds | undefined)[],
  instances: Uint8Array,
  capacity: number,
) {
  const first = capacity * LAYOUT.candidateRowWords,
    expected = first + (2 * capacity - 1) * LAYOUT.candidateNodeWords;
  if (
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > LAYOUT.maxRows ||
    bounds.length > capacity ||
    data.length !== expected ||
    instances.byteLength !== capacity * LAYOUT.instanceWords * 4 ||
    !Number.isInteger(nodeCount) ||
    nodeCount < 0 ||
    nodeCount > Math.max(0, 2 * bounds.length - 1)
  )
    return rayReferenceFailure('invalid candidate tree allocation or count');
  const seen = new Set<number>();
  for (let node = 0; node < nodeCount; node++)
    if (!validCandidateNode(data, first, node, nodeCount, bounds, seen))
      return rayReferenceFailure('candidate tree topology, leaf identity or enclosure is invalid');
  if (nodeCount && data[first + 7] !== nodeCount)
    return rayReferenceFailure('candidate root does not cover the complete node span');
  if (!candidateMembershipValid(data, bounds, instances, seen))
    return rayReferenceFailure('candidate table, membership or complete row coverage is invalid');
  for (let word = bounds.length * LAYOUT.candidateRowWords; word < first; word++)
    if (data[word] !== 0) return rayReferenceFailure('candidate headroom is not zero');
  for (let word = first + nodeCount * LAYOUT.candidateNodeWords; word < data.length; word++)
    if (data[word] !== 0) return rayReferenceFailure('candidate node headroom is not zero');
  return ok(undefined);
}

export interface SdfSceneCandidateDirectory {
  readonly geometryEnd: number;
  readonly first: number;
  readonly words: number;
  readonly nodeCount: number;
  readonly rowLimit: number;
  readonly epoch: number;
}

function candidateMembers(instances: Uint8Array, rows: number, capacity: number) {
  if (rows > capacity || instances.byteLength !== capacity * LAYOUT.instanceWords * 4)
    return rayReferenceFailure('candidate source rows exceed their actual canonical instance span');
  const view = new DataView(instances.buffer, instances.byteOffset, instances.byteLength);
  let members = 0;
  for (let row = 0; row < rows; row++) {
    const mask = view.getUint32((row * LAYOUT.instanceWords + 19) * 4, true);
    if (mask > 255) return rayReferenceFailure('canonical candidate masks must remain u8');
    if (mask !== 0) members++;
  }
  for (let row = rows; row < capacity; row++)
    if (view.getUint32((row * LAYOUT.instanceWords + 19) * 4, true) !== 0)
      return rayReferenceFailure(
        'canonical candidate source has active rows beyond its declared highwater',
      );
  return ok(members);
}

/** Closed private formats only. A base packet has no footer and no index. */
export function readSdfSceneCandidateDirectory(words: Uint32Array) {
  const capacity = words[2] ?? 0,
    used = words[3] ?? 0,
    reserved = LAYOUT.sceneWords + capacity * (LAYOUT.rowWords + LAYOUT.coverageRecordWords);
  if (
    words[0] !== LAYOUT.magic ||
    capacity < 1 ||
    capacity > LAYOUT.maxRows ||
    used < reserved ||
    used > words.length ||
    words.length > LAYOUT.maxBytes / 4
  )
    return rayReferenceFailure('invalid canonical candidate scene header');
  if (words[1] === LAYOUT.version) return ok(undefined);
  if (words[1] !== LAYOUT.indexedVersion || used < reserved + LAYOUT.candidateFooterWords)
    return rayReferenceFailure('unknown canonical candidate scene format');
  return readCandidateFooter(words, used - LAYOUT.candidateFooterWords, reserved, capacity);
}
function readCandidateFooter(words: Uint32Array, at: number, reserved: number, capacity: number) {
  const geometryEnd = words[at + 1] ?? 0,
    first = words[at + 2] ?? 0,
    span = words[at + 3] ?? 0,
    nodeCount = words[at + 4] ?? 0,
    rowLimit = words[at + 5] ?? 0,
    epoch = words[at + 6] ?? 0,
    expected = capacity * LAYOUT.candidateRowWords + (2 * capacity - 1) * LAYOUT.candidateNodeWords;
  if (
    words[at] !== LAYOUT.candidateMagic ||
    words[at + 7] !== 0 ||
    epoch === 0 ||
    rowLimit > capacity ||
    nodeCount > Math.max(0, 2 * rowLimit - 1) ||
    geometryEnd < reserved ||
    geometryEnd > first ||
    first % 4 ||
    first > at ||
    span !== expected ||
    span !== at - first
  )
    return rayReferenceFailure('invalid canonical candidate directory or nonoverlapping spans');
  return ok(
    Object.freeze({
      geometryEnd,
      first,
      words: span,
      nodeCount,
      rowLimit,
      epoch,
    } satisfies SdfSceneCandidateDirectory),
  );
}

/** Append only after every legacy segment has been charged to the same 16 MiB.
 * No source epoch means no admitted index. The caller owns this clock. */
export function appendSdfSceneCandidates(
  geometry: Uint32Array,
  instances: Uint8Array,
  bounds: readonly (SdfPlacementBounds | undefined)[],
  epoch: number | undefined,
) {
  const base = readSdfSceneCandidateDirectory(geometry);
  if (!base.ok) return base;
  if (base.value)
    return rayReferenceFailure('candidate publication requires one base canonical pool');
  if (epoch === undefined) return ok({ words: geometry, directory: undefined });
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > 0xffffffff)
    return rayReferenceFailure('canonical candidates require the accepted source owner epoch');
  const members = candidateMembers(instances, bounds.length, geometry[2] ?? 0);
  if (!members.ok) return members;
  // A single complete object has no object hierarchy to accelerate. Keep the
  // existing full-roster path rather than adding an unmeasured extra slab.
  if (members.value <= 1) return ok({ words: geometry, directory: undefined });
  const first = Math.ceil(geometry.length / 4) * 4,
    available = LAYOUT.maxBytes / 4 - first - LAYOUT.candidateFooterWords,
    capacity = geometry[2] ?? 0;
  // Full legal geometry remains unchanged when even the optional footer cannot fit.
  if (available < 0) return ok({ words: geometry, directory: undefined });
  const candidate = packSdfSceneCandidates(bounds, instances, capacity, available);
  if (!candidate.ok) return candidate;
  if (!candidate.value) return ok({ words: geometry, directory: undefined });
  const footer = first + candidate.value.words.length,
    result = new Uint32Array(footer + LAYOUT.candidateFooterWords);
  result.set(geometry);
  result.set(candidate.value.words, first);
  result.set(
    [
      LAYOUT.candidateMagic,
      geometry[3] ?? 0,
      first,
      candidate.value.words.length,
      candidate.value.nodeCount,
      bounds.length,
      epoch,
      0,
    ],
    footer,
  );
  result[1] = LAYOUT.indexedVersion;
  result[3] = result.length;
  const checked = readSdfSceneCandidateDirectory(result);
  if (!checked.ok) return checked;
  return ok({ words: result, directory: checked.value });
}
