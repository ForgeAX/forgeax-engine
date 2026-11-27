import { ok } from '@forgeax/engine-types';
import { rayReferenceFailure } from './scene';
import { SDF_INSTANCE_STRIDE } from './sdf-query';

/** Transient derived GPU data, not a published scene or asset wire format. */
export const WORLD_BOUNDS_POOL_MAGIC = 0x57425031;
export const WORLD_BOUNDS_POOL_VERSION = 1;
export const WORLD_BOUNDS_HEADER_BYTES = 96;
export const WORLD_BOUNDS_ROW_BYTES = 48;
const MAX_AXIS = 32;
const MAX_REFERENCES = 262_144;
const MAX_OVERSIZED = 128;
const MAX_ROW_CELLS = 256;
export const WORLD_BOUNDS_POOL_MAX_BYTES =
  WORLD_BOUNDS_HEADER_BYTES +
  1024 * WORLD_BOUNDS_ROW_BYTES +
  4 * (32772 + MAX_REFERENCES + MAX_OVERSIZED + 2048);
export function isWorldBoundsPoolSpan(bytes: number, rows: number) {
  return (
    Number.isInteger(rows) &&
    rows >= 1 &&
    rows <= 1024 &&
    Number.isSafeInteger(bytes) &&
    bytes % 16 === 0 &&
    bytes >= WORLD_BOUNDS_HEADER_BYTES + rows * WORLD_BOUNDS_ROW_BYTES &&
    bytes <= WORLD_BOUNDS_POOL_MAX_BYTES
  );
}
const ROUNDING = 32 * 2 ** -23;
type V = readonly [number, number, number];
interface Box {
  readonly lo: V;
  readonly hi: V;
}
type RowCellCoverage = Box | 'oversized';
interface Csr {
  readonly origin: V;
  readonly spacing: number;
  readonly dimensions: V;
  readonly offsets: Uint32Array;
  readonly references: Uint32Array;
  readonly oversized: Uint32Array;
  readonly coverage: readonly (RowCellCoverage | undefined)[];
}

/** Immutable producer proof for the exact cell lists already uploaded. */
export interface WorldBoundsIndexCoverage {
  retains(row: number, bounds: Uint8Array, instance: Uint8Array): boolean;
}

export interface WorldBoundsPoolOptions {
  /** The caller admits this entire pool against its allocation/device budgets. */
  readonly maxBytes: number;
  /** Canonical capacity includes spare rows outside the admitted roster. */
  readonly rowCapacity: number;
  readonly index: boolean;
  /** The exact candidate radius of this composition; not a query-distance heuristic. */
  readonly candidateRadius: number;
}

/** All readers use the same typed pool; index failure never changes canonical rows. */
export const WORLD_BOUNDS_POOL_WGSL = `
struct ObjectBounds { lo:vec4f, hi:vec4f, scale:vec4f }
fn worldBoundsWord(word:u32)->u32 {return bounds[word>>2u][word&3u];}
fn worldBoundsValid(count:u32)->bool {
 if(arrayLength(&bounds)<6u){return false;}
 let a=bounds[0];let b=bounds[1];let words=arrayLength(&bounds)*4u;
 return a.x==${WORLD_BOUNDS_POOL_MAGIC}u&&a.y==${WORLD_BOUNDS_POOL_VERSION}u&&a.z==count&&
  count<=a.w&&a.w<=1024u&&count<=arrayLength(&instances)&&b.x==6u&&b.y==max(1u,a.w)*3u&&b.z==1u&&
  (b.x+b.y)*4u<=words&&bounds[5].w==words&&words<=${WORLD_BOUNDS_POOL_MAX_BYTES / 4}u;
}
fn worldBoundsAt(row:u32)->ObjectBounds {
 let first=bounds[1].x+row*3u;
 return ObjectBounds(bitcast<vec4f>(bounds[first]),bitcast<vec4f>(bounds[first+1u]),bitcast<vec4f>(bounds[first+2u]));
}
fn worldBoundsIndexValid(count:u32,radius:f32)->bool {
 if(!worldBoundsValid(count)||bounds[1].w!=1u){return false;}
 let shape=bounds[2];let grid=bitcast<vec4f>(bounds[3]);let spans=bounds[4];let tail=bounds[5];
 if(any(shape.xyz<vec3u(1u))||any(shape.xyz>vec3u(32u))||bitcast<f32>(shape.w)!=radius||
  !all(abs(grid.xyz)<=vec3f(3.402823466e+38))||!(grid.w>0.0)||grid.w>3.402823466e+38){return false;}
 let cells=shape.x*shape.y*shape.z;let first=(bounds[1].x+bounds[1].y)*4u;
 if(any((vec4u(spans.x,spans.y,spans.w,tail.y)&vec4u(3u))!=vec4u(0u))){return false;}
 return spans.x>=first&&spans.x<=tail.w&&cells+1u<=tail.w-spans.x&&
  spans.y>=spans.x+cells+1u&&spans.y<=tail.w&&spans.z<=262144u&&spans.z<=tail.w-spans.y&&
  spans.w>=spans.y+spans.z&&spans.w<=tail.w&&tail.x<=128u&&tail.x<=tail.w-spans.w&&
  tail.y>=spans.w+tail.x&&tail.y<=tail.w&&tail.z<=count&&tail.z*2u<=tail.w-tail.y;
}
// x=0: full roster [y,z). x=1: remaining CSR [y,z), next oversized index w.
fn worldBoundsCursor(position:vec3f,count:u32,radius:f32)->vec4u {
 let scan=vec4u(0u,0u,count,0u);
 if(!worldBoundsIndexValid(count,radius)){return scan;}
 let dims=bounds[2].xyz;let grid=bitcast<vec4f>(bounds[3]);let q=(position-grid.xyz)/grid.w;
 // Outside the admitted index domain retains the complete original scan.
 if(!all(abs(q)<=vec3f(3.402823466e+38))||any(q<vec3f(0))||any(q>=vec3f(dims))){return scan;}
 let cell=vec3u(floor(q));let linear=(cell.z*dims.y+cell.y)*dims.x+cell.x;
 let start=worldBoundsWord(bounds[4].x+linear);let end=worldBoundsWord(bounds[4].x+linear+1u);
 if(start>end||end>bounds[4].z){return scan;}
 for(var k=0u;k<bounds[5].x;k++){if(worldBoundsWord(bounds[4].w+k)>=count){return scan;}}
 for(var k=start;k<end;k++){if(worldBoundsWord(bounds[4].y+k)>=count){return scan;}}
 return vec4u(1u,start,end,0u);
}
fn worldBoundsCursorCount(cursor:vec4u)->u32 {
 if(cursor.x==0u){return cursor.z-cursor.y;}
 return cursor.z-cursor.y+bounds[5].x-cursor.w;
}
fn worldBoundsCursorRow(cursor:ptr<function,vec4u>)->u32 {
 let current=*cursor;
 if(current.x==0u){(*cursor).y++;return current.y;}
 var extra=0xffffffffu;var regular=0xffffffffu;
 if(current.w<bounds[5].x){extra=worldBoundsWord(bounds[4].w+current.w);}
 if(current.y<current.z){regular=worldBoundsWord(bounds[4].y+current.y);}
 // Both streams are canonical-row sorted. Merge without changing tie order.
 if(extra<regular){(*cursor).w++;return extra;}
 (*cursor).y++;return regular;
}
fn worldBoundsRowForId(id:u32,count:u32,radius:f32)->u32 {
 if(!worldBoundsValid(count)){return 0xffffffffu;}
 if(worldBoundsIndexValid(count,radius)){
  var lo=0u;var hi=bounds[5].z;
  while(lo<hi){let mid=lo+(hi-lo)/2u;let key=worldBoundsWord(bounds[5].y+mid*2u);if(key<id){lo=mid+1u;}else{hi=mid;}}
  if(lo<bounds[5].z&&worldBoundsWord(bounds[5].y+lo*2u)==id){
   let row=worldBoundsWord(bounds[5].y+lo*2u+1u);
   if(row<count&&sdfInstanceWord(row,16u)==id){return row;}
  }
 }
 // Incomplete/malformed identity acceleration never hides a canonical instance.
 for(var i=0u;i<count;i++){if(sdfInstanceWord(i,16u)==id){return i;}}
 return 0xffffffffu;
}
`;

const triple = (values: readonly number[]): V => [
  values[0] ?? NaN,
  values[1] ?? NaN,
  values[2] ?? NaN,
];
const sum = (row: readonly number[], value: V) =>
  row.reduce((out, x, i) => out + x * (value[i] ?? NaN), 0);
const identity = (row: number, column: number) => Number(row === column);
const scratch = new DataView(new ArrayBuffer(4));
function outward(value: number, up: boolean) {
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded)) return rounded;
  if (rounded === 0) return up ? 2 ** -149 : -(2 ** -149);
  scratch.setFloat32(0, rounded, true);
  const bits = scratch.getUint32(0, true);
  scratch.setUint32(0, bits + (up === rounded > 0 ? 1 : -1), true);
  return scratch.getFloat32(0, true);
}

/** Invert the stored f32 linear map, then retain its f32 residual explicitly. */
function inverse(a: readonly V[]): readonly V[] | undefined {
  const x = a[0],
    y = a[1],
    z = a[2];
  if (!x || !y || !z) return;
  const determinant =
    x[0] * (y[1] * z[2] - y[2] * z[1]) -
    x[1] * (y[0] * z[2] - y[2] * z[0]) +
    x[2] * (y[0] * z[1] - y[1] * z[0]);
  if (!Number.isFinite(determinant) || determinant === 0) return;
  const result = [
    triple([
      (y[1] * z[2] - y[2] * z[1]) / determinant,
      (x[2] * z[1] - x[1] * z[2]) / determinant,
      (x[1] * y[2] - x[2] * y[1]) / determinant,
    ]),
    triple([
      (y[2] * z[0] - y[0] * z[2]) / determinant,
      (x[0] * z[2] - x[2] * z[0]) / determinant,
      (x[2] * y[0] - x[0] * y[2]) / determinant,
    ]),
    triple([
      (y[0] * z[1] - y[1] * z[0]) / determinant,
      (x[1] * z[0] - x[0] * z[1]) / determinant,
      (x[0] * y[1] - x[1] * y[0]) / determinant,
    ]),
  ].map((row) => triple(row.map(Math.fround)));
  return result.every((row) => row.every(Number.isFinite)) ? result : undefined;
}

/** If the GPU's local box test can admit a point, this envelope must contain it.
 * |w| <= |B| |p-t| + (|I-BA| + gamma |B||A|)|w| + gamma |B||t|.
 * A large residual/rounding envelope disables the whole index, never one row. */
function candidateBox(
  bounds: DataView,
  instances: DataView,
  row: number,
  radius: number,
): Box | undefined {
  const first = row * SDF_INSTANCE_STRIDE,
    base = row * WORLD_BOUNDS_ROW_BYTES;
  const a = [0, 1, 2].map((i) =>
    triple([0, 1, 2].map((j) => instances.getFloat32(first + (j * 4 + i) * 4, true))),
  );
  const b = inverse(a);
  if (!b) return;
  const translation = triple([0, 1, 2].map((i) => instances.getFloat32(first + 48 + i * 4, true)));
  const expandedRadius = outward(radius / (1 - ROUNDING), true);
  const localPadding = [0, 1, 2].map(
    (i) =>
      ROUNDING *
        (Math.max(
          Math.abs(bounds.getFloat32(base + i * 4, true)),
          Math.abs(bounds.getFloat32(base + 16 + i * 4, true)),
        ) +
          expandedRadius / bounds.getFloat32(base + 32 + i * 4, true)) +
      1e-30,
  );
  const lo = triple(
    [0, 1, 2].map(
      (i) =>
        bounds.getFloat32(base + i * 4, true) -
        expandedRadius / bounds.getFloat32(base + 32 + i * 4, true) -
        (localPadding[i] ?? NaN),
    ),
  );
  const hi = triple(
    [0, 1, 2].map(
      (i) =>
        bounds.getFloat32(base + 16 + i * 4, true) +
        expandedRadius / bounds.getFloat32(base + 32 + i * 4, true) +
        (localPadding[i] ?? NaN),
    ),
  );
  const residual = b.map((r, i) =>
    triple(
      [0, 1, 2].map((j) => identity(i, j) - r.reduce((n, v, k) => n + v * (a[k]?.[j] ?? NaN), 0)),
    ),
  );
  const absoluteB = b.map((r) => triple(r.map(Math.abs))),
    absoluteA = a.map((r) => triple(r.map(Math.abs)));
  const contraction = absoluteB.map((r, i) =>
    triple(
      [0, 1, 2].map(
        (j) =>
          Math.abs(residual[i]?.[j] ?? NaN) +
          ROUNDING * r.reduce((n, v, k) => n + v * (absoluteA[k]?.[j] ?? NaN), 0),
      ),
    ),
  );
  const norm = Math.max(...contraction.map((r) => r.reduce((n, v) => n + v, 0)));
  if (!(norm < 0.125)) return;
  const local = triple(
    [0, 1, 2].map(
      (i) =>
        Math.max(
          Math.abs((lo[i] ?? NaN) - (translation[i] ?? NaN)),
          Math.abs((hi[i] ?? NaN) - (translation[i] ?? NaN)),
        ) +
        ROUNDING * Math.abs(translation[i] ?? NaN) +
        1e-30,
    ),
  );
  const extent = Math.max(...absoluteB.map((r) => sum(r, local))) / (1 - norm);
  const padding = contraction.map(
    (r, i) =>
      sum(r, [extent, extent, extent]) +
      ROUNDING * sum(absoluteB[i] ?? [], triple(translation.map(Math.abs))) +
      1e-30,
  );
  const points: V[] = [];
  for (let mask = 0; mask < 8; mask++) {
    const p = triple(
      [0, 1, 2].map(
        (i) => (((mask & (1 << i)) !== 0 ? hi[i] : lo[i]) ?? NaN) - (translation[i] ?? NaN),
      ),
    );
    points.push(triple(b.map((r) => sum(r, p))));
  }
  const box = {
    lo: triple(
      [0, 1, 2].map((i) =>
        outward(Math.min(...points.map((p) => p[i] ?? NaN)) - (padding[i] ?? NaN), false),
      ),
    ),
    hi: triple(
      [0, 1, 2].map((i) =>
        outward(Math.max(...points.map((p) => p[i] ?? NaN)) + (padding[i] ?? NaN), true),
      ),
    ),
  };
  return [...box.lo, ...box.hi].every(Number.isFinite) ? box : undefined;
}

function cellRange(box: Box, origin: V, spacing: number, dimensions: V) {
  // Two cells cover f32 subtraction/division rounding; no row is clipped out.
  return [box.lo, box.hi].map((point, side) =>
    triple(
      point.map((value, axis) =>
        Math.max(
          0,
          Math.min(
            (dimensions[axis] ?? 0) - 1,
            Math.floor((value - (origin[axis] ?? NaN)) / spacing) + (side === 0 ? -2 : 2),
          ),
        ),
      ),
    ),
  );
}

function buildCsr(boxes: readonly (Box | undefined)[], axisLimit: number): Csr | undefined {
  const active = boxes.flatMap((box, row) => (box ? [{ box, row }] : []));
  if (active.length === 0) return;
  const origin = triple(
    [0, 1, 2].map((i) => Math.min(...active.map(({ box }) => box.lo[i] ?? NaN))),
  );
  const high = triple([0, 1, 2].map((i) => Math.max(...active.map(({ box }) => box.hi[i] ?? NaN))));
  const spacing = outward(
    Math.max(...high.map((value, i) => value - (origin[i] ?? NaN))) / axisLimit,
    true,
  );
  if (!(spacing > 0) || !Number.isFinite(spacing)) return;
  const dimensions = triple(
    high.map((value, i) =>
      Math.max(1, Math.min(axisLimit, Math.ceil((value - (origin[i] ?? NaN)) / spacing))),
    ),
  );
  for (let axis = 0; axis < 3; axis++)
    for (let i = 1; i < (dimensions[axis] ?? 0); i++)
      if (
        !(
          Math.fround((origin[axis] ?? NaN) + Math.fround(i * spacing)) >
          Math.fround((origin[axis] ?? NaN) + Math.fround((i - 1) * spacing))
        )
      )
        return;
  const count = dimensions[0] * dimensions[1] * dimensions[2],
    cells = Array.from({ length: count }, () => [] as number[]),
    oversized: number[] = [],
    coverage = new Array<RowCellCoverage | undefined>(boxes.length);
  let references = 0;
  for (const { box, row } of active) {
    const [lo, hi] = cellRange(box, origin, spacing, dimensions);
    if (!lo || !hi) return;
    const size = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
    if (size > MAX_ROW_CELLS) {
      if (oversized.length === MAX_OVERSIZED) return;
      oversized.push(row);
      coverage[row] = 'oversized';
      continue;
    }
    references += size;
    if (references > MAX_REFERENCES) return;
    coverage[row] = { lo, hi };
    for (let z = lo[2]; z <= hi[2]; z++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let x = lo[0]; x <= hi[0]; x++)
          cells[(z * dimensions[1] + y) * dimensions[0] + x]?.push(row);
  }
  const offsets = new Uint32Array(count + 1),
    flat = new Uint32Array(references);
  let offset = 0;
  for (const [cell, rows] of cells.entries()) {
    offsets[cell] = offset;
    flat.set(rows, offset);
    offset += rows.length;
  }
  offsets[count] = offset;
  return {
    origin,
    spacing,
    dimensions,
    offsets,
    references: flat,
    oversized: Uint32Array.from(oversized),
    coverage,
  };
}

function inputsValid(
  canonical: Uint8Array,
  instances: Uint8Array,
  rowCount: number,
  options: WorldBoundsPoolOptions,
) {
  return (
    Number.isInteger(rowCount) &&
    rowCount >= 0 &&
    Number.isInteger(options.rowCapacity) &&
    options.rowCapacity >= rowCount &&
    options.rowCapacity <= 1024 &&
    canonical.byteLength >= Math.max(1, rowCount) * WORLD_BOUNDS_ROW_BYTES &&
    instances.byteLength >= Math.max(1, rowCount) * SDF_INSTANCE_STRIDE &&
    Number.isSafeInteger(options.maxBytes) &&
    Number.isFinite(options.candidateRadius) &&
    options.candidateRadius >= 0
  );
}

function canonicalRowValid(bounds: DataView, scene: DataView, row: number) {
  const first = row * SDF_INSTANCE_STRIDE,
    base = row * WORLD_BOUNDS_ROW_BYTES;
  const values = Array.from({ length: 12 }, (_, i) => bounds.getFloat32(base + i * 4, true));
  const affine = Array.from({ length: 16 }, (_, i) => scene.getFloat32(first + i * 4, true));
  return (
    affine.every(Number.isFinite) &&
    affine[3] === 0 &&
    affine[7] === 0 &&
    affine[11] === 0 &&
    affine[15] === 1 &&
    values.every(Number.isFinite) &&
    [0, 1, 2].every(
      (i) => (values[i] ?? NaN) <= (values[i + 4] ?? NaN) && (values[i + 8] ?? 0) > 0,
    ) &&
    (values[11] ?? 0) > 0
  );
}

function indexCoverage(
  { coverage, origin, spacing, dimensions }: Csr,
  radius: number,
): WorldBoundsIndexCoverage {
  return Object.freeze({
    retains(row: number, bounds: Uint8Array, instance: Uint8Array) {
      const admitted = coverage[row];
      if (
        !admitted ||
        bounds.byteLength !== WORLD_BOUNDS_ROW_BYTES ||
        instance.byteLength !== SDF_INSTANCE_STRIDE
      )
        return false;
      const b = new DataView(bounds.buffer, bounds.byteOffset, bounds.byteLength);
      const s = new DataView(instance.buffer, instance.byteOffset, instance.byteLength);
      if (!canonicalRowValid(b, s, 0)) return false;
      // Oversized rows are enumerated in every indexed cell.
      if (admitted === 'oversized') return true;
      const moved = candidateBox(b, s, 0, radius);
      if (!moved) return false;
      const [lo, hi] = cellRange(moved, origin, spacing, dimensions);
      return (
        lo !== undefined &&
        hi !== undefined &&
        ([0, 1, 2] as const).every(
          (axis) => lo[axis] >= admitted.lo[axis] && hi[axis] <= admitted.hi[axis],
        )
      );
    },
  });
}

function candidateRows(
  bounds: DataView,
  scene: DataView,
  rowCount: number,
  options: WorldBoundsPoolOptions,
) {
  const boxes: (Box | undefined)[] = [],
    ids: { id: number; row: number }[] = [],
    identities = new Set<number>();
  let usable = options.index;
  for (let row = 0; row < rowCount; row++) {
    const first = row * SDF_INSTANCE_STRIDE;
    if (scene.getUint32(first + 76, true) === 0) {
      boxes.push(undefined);
      continue;
    }
    if (!canonicalRowValid(bounds, scene, row))
      return rayReferenceFailure('invalid canonical world bounds row');
    const id = scene.getUint32(first + 64, true);
    if (identities.has(id))
      return rayReferenceFailure('duplicate canonical world instance identity');
    identities.add(id);
    ids.push({ id, row });
    const box = options.index
      ? candidateBox(bounds, scene, row, options.candidateRadius)
      : undefined;
    if (options.index && !box) usable = false;
    boxes.push(box);
  }
  ids.sort((a, b) => a.id - b.id);
  return ok({ boxes, ids, usable });
}

/** Index failure returns the complete canonical roster in the same typed pool.
 * Invalid canonical bounds reject before allocation; budget never truncates rows. */
export function packWorldBoundsPool(
  canonical: Uint8Array,
  instances: Uint8Array,
  rowCount: number,
  options: WorldBoundsPoolOptions,
) {
  if (!inputsValid(canonical, instances, rowCount, options))
    return rayReferenceFailure('invalid canonical world bounds pool input');
  const canonicalBytes = Math.max(1, options.rowCapacity) * WORLD_BOUNDS_ROW_BYTES,
    totalBase = WORLD_BOUNDS_HEADER_BYTES + canonicalBytes;
  if (totalBase > options.maxBytes)
    return rayReferenceFailure('canonical world bounds exceed the admitted pool budget', true);
  const collected = candidateRows(
    new DataView(canonical.buffer, canonical.byteOffset, canonical.byteLength),
    new DataView(instances.buffer, instances.byteOffset, instances.byteLength),
    rowCount,
    options,
  );
  if (!collected.ok) return collected;
  const { boxes, ids, usable } = collected.value;
  let index: Csr | undefined;
  const alignedWords = (count: number) => Math.ceil(count / 4) * 4;
  const indexBytes = (csr: Csr) =>
    4 *
    (alignedWords(csr.offsets.length) +
      alignedWords(csr.references.length) +
      alignedWords(csr.oversized.length) +
      alignedWords(ids.length * 2));
  // A fine grid can exhaust oversized/reference storage even when a complete
  // coarser grid fits. Each bounded attempt retains every original envelope;
  // failure still falls back to the complete canonical roster, never a prefix.
  for (let axis = MAX_AXIS; usable && axis >= 1; axis /= 2) {
    const candidate = buildCsr(boxes, axis);
    if (candidate && totalBase + indexBytes(candidate) <= options.maxBytes) {
      index = candidate;
      break;
    }
  }
  const bytes = new Uint8Array(totalBase + (index ? indexBytes(index) : 0)),
    header = new DataView(bytes.buffer);
  bytes.set(
    canonical.subarray(0, Math.max(1, rowCount) * WORLD_BOUNDS_ROW_BYTES),
    WORLD_BOUNDS_HEADER_BYTES,
  );
  const put = (word: number, value: number) => header.setUint32(word * 4, value, true);
  [
    WORLD_BOUNDS_POOL_MAGIC,
    WORLD_BOUNDS_POOL_VERSION,
    rowCount,
    options.rowCapacity,
    WORLD_BOUNDS_HEADER_BYTES / 16,
    canonicalBytes / 16,
    1,
    Number(index !== undefined),
  ].forEach((value, word) => {
    put(word, value);
  });
  put(23, bytes.byteLength / 4);
  if (index) {
    index.dimensions.forEach((value, i) => {
      put(8 + i, value);
    });
    // Cell count is derived from dimensions; bind the index's actual query radius.
    header.setFloat32(11 * 4, Math.fround(options.candidateRadius), true);
    [...index.origin, index.spacing].forEach((value, i) => {
      header.setFloat32((12 + i) * 4, value, true);
    });
    let offset = totalBase / 4;
    const append = (data: Uint32Array) => {
      const first = offset;
      new Uint32Array(bytes.buffer, offset * 4, data.length).set(data);
      offset += alignedWords(data.length);
      return first;
    };
    put(16, append(index.offsets));
    put(17, append(index.references));
    put(18, index.references.length);
    put(19, append(index.oversized));
    put(20, index.oversized.length);
    put(21, append(Uint32Array.from(ids.flatMap(({ id, row }) => [id, row]))));
    put(22, ids.length);
  }
  return ok({
    bytes,
    indexed: index !== undefined,
    rowCount,
    rowCapacity: options.rowCapacity,
    coverage: index === undefined ? undefined : indexCoverage(index, options.candidateRadius),
  });
}
