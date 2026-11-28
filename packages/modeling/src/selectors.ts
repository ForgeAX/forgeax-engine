import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf } from './arrays';
import { TriangleBvh } from './compute/bvh';
import { cos, hypot3, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import {
  type Axis,
  axisVector,
  cross,
  dot,
  faceArea,
  faceCentroid,
  faceNormal,
  normalize,
  type SignedAxis,
  sub,
  type Tuple3,
  triangulateLoop,
} from './geom';
import {
  EDGE_SEAM,
  EDGE_SHARP,
  type EditMesh,
  FACE_MIRRORED,
  NONE,
  type PartRole,
  partRole,
} from './mesh';
import { faceThickness } from './thickness';
import { edgeLoop, edgeRing } from './walk';

export type Domain = 'face' | 'edge' | 'vert';

/** Face, edge or vertex rule used by inclusion conversions. */
export type Inclusion = 'touching' | 'contained';

/** Which face vertices decide a geometric predicate. */
export type HitRule = 'all' | 'centroid' | 'any';

export type Cardinality =
  | { readonly kind: 'nonEmpty' }
  | { readonly kind: 'exactly'; readonly count: number }
  | { readonly kind: 'atLeast'; readonly count: number };

/** Pure-data selector AST (serializable across JS <-> Rust/WASM without closures). */
export type SelectorAst =
  | { readonly op: 'all'; readonly domain: Domain }
  | { readonly op: 'tag'; readonly name: string }
  | { readonly op: 'createdBy'; readonly label: string; readonly role?: string }
  | { readonly op: 'material'; readonly slot: string }
  | { readonly op: 'mirrored' }
  | { readonly op: 'facing'; readonly axis: SignedAxis; readonly degrees: number }
  | { readonly op: 'extreme'; readonly axis: SignedAxis }
  | { readonly op: 'inBox'; readonly min: Tuple3; readonly max: Tuple3; readonly by: HitRule }
  | { readonly op: 'side'; readonly point: Tuple3; readonly normal: Tuple3; readonly by: HitRule }
  | { readonly op: 'near'; readonly point: Tuple3; readonly count: number }
  | { readonly op: 'thin'; readonly maxWidth: number }
  | { readonly op: 'dihedral'; readonly compare: '>' | '<'; readonly degrees: number }
  | { readonly op: 'meshBoundary' }
  | { readonly op: 'parallel'; readonly axis: Axis; readonly degrees: number }
  | { readonly op: 'perpendicular'; readonly axis: Axis; readonly degrees: number }
  | { readonly op: 'concave' }
  | { readonly op: 'sharp' }
  | { readonly op: 'seam' }
  | { readonly op: 'not'; readonly domain: Domain; readonly src: SelectorAst }
  | { readonly op: 'largest'; readonly src: SelectorAst }
  | { readonly op: 'smallest'; readonly src: SelectorAst }
  | { readonly op: 'grow'; readonly src: SelectorAst; readonly steps: number }
  | { readonly op: 'shrink'; readonly src: SelectorAst; readonly steps: number }
  | { readonly op: 'connected'; readonly src: SelectorAst; readonly across: 'any' | 'smooth' }
  | { readonly op: 'toEdges'; readonly src: SelectorAst; readonly include: Inclusion }
  | { readonly op: 'boundary'; readonly src: SelectorAst }
  | { readonly op: 'toVerts'; readonly src: SelectorAst; readonly include: Inclusion }
  | { readonly op: 'toFaces'; readonly src: SelectorAst }
  | { readonly op: 'loop'; readonly src: SelectorAst }
  | { readonly op: 'ring'; readonly src: SelectorAst }
  | {
      readonly op: 'and';
      readonly domain: Domain;
      readonly a: SelectorAst;
      readonly b: SelectorAst;
    }
  | { readonly op: 'or'; readonly domain: Domain; readonly a: SelectorAst; readonly b: SelectorAst }
  | {
      readonly op: 'minus';
      readonly domain: Domain;
      readonly a: SelectorAst;
      readonly b: SelectorAst;
    }
  | {
      readonly op: 'custom';
      readonly domain: Domain;
      readonly description: string;
      readonly evaluator: Evaluate;
    };

/** One resolved selector argument of an operation: its text, what it matched and what it asserted. */
export interface SelectorUse {
  readonly text: string;
  readonly domain: Domain;
  readonly matched: number;
  readonly assert: Cardinality;
  /**
   * Matched faces (edges: both sides, vertices: incident faces) per `label/role:count`, sorted;
   * more than 16 keys end in `+N#hash` over the whole key list, so no difference is dropped.
   */
  readonly provenance: readonly string[];
  /**
   * Geometry of the matched elements, comparable across parameter sets: the sign classes of
   * their face normals (a component within 0.4 of zero counts as zero) and the `label/role` of
   * the faces across their edges. Selections of more than 512 elements record `n[*] a[*]`.
   */
  readonly signature: string;
}

/** Selector uses of the operation being recorded; bounded so a looping operation stays small. */
export interface SelectorLog {
  readonly uses: SelectorUse[];
  truncated: boolean;
}

const MAX_SELECTOR_USES = 256;
let activeLog: SelectorLog | undefined;

/** Run `body` with `log` collecting every `Selector.resolve`; nested recordings restore the outer one. */
export function recordSelectors<T>(log: SelectorLog, body: () => T): T {
  const outer = activeLog;
  activeLog = log;
  try {
    return body();
  } finally {
    activeLog = outer;
  }
}

type Evaluate = (mesh: EditMesh) => number[];

// ---- Binary codec for SelectorAst (FXSL v1) -----------------------------------------------

const FXSL_MAGIC = 0x4c535846; // "FXSL" little-endian
const FXSL_VERSION = 1;

const OP = {
  all: 1,
  tag: 2,
  createdBy: 3,
  material: 4,
  mirrored: 5,
  facing: 6,
  extreme: 7,
  inBox: 8,
  side: 9,
  near: 10,
  thin: 11,
  dihedral: 12,
  meshBoundary: 13,
  parallel: 14,
  perpendicular: 15,
  concave: 16,
  sharp: 17,
  seam: 18,
  not: 20,
  largest: 21,
  smallest: 22,
  grow: 23,
  shrink: 24,
  connected: 25,
  toEdges: 26,
  boundary: 27,
  toVerts: 28,
  toFaces: 29,
  loop: 30,
  ring: 31,
  and: 40,
  or: 41,
  minus: 42,
} as const;

const DOMAINS: readonly Domain[] = ['face', 'edge', 'vert'];
const SIGNED_AXES: readonly SignedAxis[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
const AXES: readonly Axis[] = ['x', 'y', 'z'];
const HIT_RULES: readonly HitRule[] = ['all', 'centroid', 'any'];
const INCLUSIONS: readonly Inclusion[] = ['touching', 'contained'];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class ByteWriter {
  private buf = new Uint8Array(128);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.length) return;
    let nextCap = this.buf.length * 2;
    while (nextCap < this.pos + extra) nextCap *= 2;
    const next = new Uint8Array(nextCap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }

  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  vec3(v: Tuple3): void {
    this.f64(v[0]);
    this.f64(v[1]);
    this.f64(v[2]);
  }

  str(s: string): void {
    const bytes = textEncoder.encode(s);
    this.u32(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

class ByteReader {
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number {
    return this.buf.byteLength - this.pos;
  }

  u8(): number | undefined {
    if (this.remaining < 1) return undefined;
    return this.buf[this.pos++];
  }

  u32(): number | undefined {
    if (this.remaining < 4) return undefined;
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number | undefined {
    if (this.remaining < 8) return undefined;
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  vec3(): Tuple3 | undefined {
    const x = this.f64();
    const y = this.f64();
    const z = this.f64();
    if (x === undefined || y === undefined || z === undefined) return undefined;
    return [x, y, z];
  }

  str(): string | undefined {
    const len = this.u32();
    if (len === undefined || this.remaining < len) return undefined;
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return textDecoder.decode(slice);
  }
}

function writeAstNode(w: ByteWriter, ast: SelectorAst): Result<void, ModelingError> {
  switch (ast.op) {
    case 'all':
      w.u8(OP.all);
      w.u8(DOMAINS.indexOf(ast.domain));
      return ok(undefined);
    case 'tag':
      w.u8(OP.tag);
      w.str(ast.name);
      return ok(undefined);
    case 'createdBy':
      w.u8(OP.createdBy);
      w.str(ast.label);
      if (ast.role === undefined) {
        w.u8(0);
      } else {
        w.u8(1);
        w.str(ast.role);
      }
      return ok(undefined);
    case 'material':
      w.u8(OP.material);
      w.str(ast.slot);
      return ok(undefined);
    case 'mirrored':
      w.u8(OP.mirrored);
      return ok(undefined);
    case 'facing':
      w.u8(OP.facing);
      w.u8(SIGNED_AXES.indexOf(ast.axis));
      w.f64(ast.degrees);
      return ok(undefined);
    case 'extreme':
      w.u8(OP.extreme);
      w.u8(SIGNED_AXES.indexOf(ast.axis));
      return ok(undefined);
    case 'inBox':
      w.u8(OP.inBox);
      w.vec3(ast.min);
      w.vec3(ast.max);
      w.u8(HIT_RULES.indexOf(ast.by));
      return ok(undefined);
    case 'side':
      w.u8(OP.side);
      w.vec3(ast.point);
      w.vec3(ast.normal);
      w.u8(HIT_RULES.indexOf(ast.by));
      return ok(undefined);
    case 'near':
      w.u8(OP.near);
      w.vec3(ast.point);
      w.u32(ast.count);
      return ok(undefined);
    case 'thin':
      w.u8(OP.thin);
      w.f64(ast.maxWidth);
      return ok(undefined);
    case 'dihedral':
      w.u8(OP.dihedral);
      w.u8(ast.compare === '>' ? 0 : 1);
      w.f64(ast.degrees);
      return ok(undefined);
    case 'meshBoundary':
      w.u8(OP.meshBoundary);
      return ok(undefined);
    case 'parallel':
      w.u8(OP.parallel);
      w.u8(AXES.indexOf(ast.axis));
      w.f64(ast.degrees);
      return ok(undefined);
    case 'perpendicular':
      w.u8(OP.perpendicular);
      w.u8(AXES.indexOf(ast.axis));
      w.f64(ast.degrees);
      return ok(undefined);
    case 'concave':
      w.u8(OP.concave);
      return ok(undefined);
    case 'sharp':
      w.u8(OP.sharp);
      return ok(undefined);
    case 'seam':
      w.u8(OP.seam);
      return ok(undefined);
    case 'not':
      w.u8(OP.not);
      w.u8(DOMAINS.indexOf(ast.domain));
      return writeAstNode(w, ast.src);
    case 'largest':
      w.u8(OP.largest);
      return writeAstNode(w, ast.src);
    case 'smallest':
      w.u8(OP.smallest);
      return writeAstNode(w, ast.src);
    case 'grow':
      w.u8(OP.grow);
      w.u32(ast.steps);
      return writeAstNode(w, ast.src);
    case 'shrink':
      w.u8(OP.shrink);
      w.u32(ast.steps);
      return writeAstNode(w, ast.src);
    case 'connected':
      w.u8(OP.connected);
      w.u8(ast.across === 'any' ? 0 : 1);
      return writeAstNode(w, ast.src);
    case 'toEdges':
      w.u8(OP.toEdges);
      w.u8(INCLUSIONS.indexOf(ast.include));
      return writeAstNode(w, ast.src);
    case 'boundary':
      w.u8(OP.boundary);
      return writeAstNode(w, ast.src);
    case 'toVerts':
      w.u8(OP.toVerts);
      w.u8(INCLUSIONS.indexOf(ast.include));
      return writeAstNode(w, ast.src);
    case 'toFaces':
      w.u8(OP.toFaces);
      return writeAstNode(w, ast.src);
    case 'loop':
      w.u8(OP.loop);
      return writeAstNode(w, ast.src);
    case 'ring':
      w.u8(OP.ring);
      return writeAstNode(w, ast.src);
    case 'and':
    case 'or':
    case 'minus': {
      w.u8(ast.op === 'and' ? OP.and : ast.op === 'or' ? OP.or : OP.minus);
      w.u8(DOMAINS.indexOf(ast.domain));
      const a = writeAstNode(w, ast.a);
      if (!a.ok) return a;
      return writeAstNode(w, ast.b);
    }
    case 'custom':
      return err(
        modelingError(
          'model-invalid-argument',
          'selector AST contains only serializable built-in operations',
          { op: 'custom', description: ast.description },
        ),
      );
  }
}

function decodeError(reason: string): Result<never, ModelingError> {
  return err(
    modelingError('model-invalid-argument', `valid FXSL v1 selector bytes: ${reason}`, { reason }),
  );
}

function readAstNode(r: ByteReader): Result<SelectorAst, ModelingError> {
  const code = r.u8();
  if (code === undefined) return decodeError('unexpected end of input');
  switch (code) {
    case OP.all: {
      const d = r.u8();
      const domain = d === undefined ? undefined : DOMAINS[d];
      return domain === undefined ? decodeError('invalid domain') : ok({ op: 'all', domain });
    }
    case OP.tag: {
      const name = r.str();
      return name === undefined ? decodeError('invalid tag name') : ok({ op: 'tag', name });
    }
    case OP.createdBy: {
      const label = r.str();
      const hasRole = r.u8();
      if (label === undefined || (hasRole !== 0 && hasRole !== 1))
        return decodeError('invalid createdBy');
      if (hasRole === 0) return ok({ op: 'createdBy', label });
      const role = r.str();
      return role === undefined
        ? decodeError('invalid createdBy role')
        : ok({ op: 'createdBy', label, role });
    }
    case OP.material: {
      const slot = r.str();
      return slot === undefined
        ? decodeError('invalid material slot')
        : ok({ op: 'material', slot });
    }
    case OP.mirrored:
      return ok({ op: 'mirrored' });
    case OP.facing: {
      const a = r.u8();
      const axis = a === undefined ? undefined : SIGNED_AXES[a];
      const degrees = r.f64();
      return axis === undefined || degrees === undefined
        ? decodeError('invalid facing')
        : ok({ op: 'facing', axis, degrees });
    }
    case OP.extreme: {
      const a = r.u8();
      const axis = a === undefined ? undefined : SIGNED_AXES[a];
      return axis === undefined ? decodeError('invalid extreme') : ok({ op: 'extreme', axis });
    }
    case OP.inBox: {
      const min = r.vec3();
      const max = r.vec3();
      const b = r.u8();
      const by = b === undefined ? undefined : HIT_RULES[b];
      return min === undefined || max === undefined || by === undefined
        ? decodeError('invalid inBox')
        : ok({ op: 'inBox', min, max, by });
    }
    case OP.side: {
      const point = r.vec3();
      const normal = r.vec3();
      const b = r.u8();
      const by = b === undefined ? undefined : HIT_RULES[b];
      return point === undefined || normal === undefined || by === undefined
        ? decodeError('invalid side')
        : ok({ op: 'side', point, normal, by });
    }
    case OP.near: {
      const point = r.vec3();
      const count = r.u32();
      return point === undefined || count === undefined
        ? decodeError('invalid near')
        : ok({ op: 'near', point, count });
    }
    case OP.thin: {
      const maxWidth = r.f64();
      return maxWidth === undefined ? decodeError('invalid thin') : ok({ op: 'thin', maxWidth });
    }
    case OP.dihedral: {
      const c = r.u8();
      const degrees = r.f64();
      if ((c !== 0 && c !== 1) || degrees === undefined) return decodeError('invalid dihedral');
      return ok({ op: 'dihedral', compare: c === 0 ? '>' : '<', degrees });
    }
    case OP.meshBoundary:
      return ok({ op: 'meshBoundary' });
    case OP.parallel:
    case OP.perpendicular: {
      const a = r.u8();
      const axis = a === undefined ? undefined : AXES[a];
      const degrees = r.f64();
      if (axis === undefined || degrees === undefined) return decodeError('invalid axis angle op');
      return ok({ op: code === OP.parallel ? 'parallel' : 'perpendicular', axis, degrees });
    }
    case OP.concave:
      return ok({ op: 'concave' });
    case OP.sharp:
      return ok({ op: 'sharp' });
    case OP.seam:
      return ok({ op: 'seam' });
    case OP.not: {
      const d = r.u8();
      const domain = d === undefined ? undefined : DOMAINS[d];
      if (domain === undefined) return decodeError('invalid not domain');
      const src = readAstNode(r);
      return src.ok ? ok({ op: 'not', domain, src: src.value }) : src;
    }
    case OP.largest:
    case OP.smallest:
    case OP.boundary:
    case OP.toFaces:
    case OP.loop:
    case OP.ring: {
      const src = readAstNode(r);
      if (!src.ok) return src;
      const op =
        code === OP.largest
          ? 'largest'
          : code === OP.smallest
            ? 'smallest'
            : code === OP.boundary
              ? 'boundary'
              : code === OP.toFaces
                ? 'toFaces'
                : code === OP.loop
                  ? 'loop'
                  : 'ring';
      return ok({ op, src: src.value });
    }
    case OP.grow:
    case OP.shrink: {
      const steps = r.u32();
      if (steps === undefined) return decodeError('invalid grow/shrink steps');
      const src = readAstNode(r);
      return src.ok ? ok({ op: code === OP.grow ? 'grow' : 'shrink', steps, src: src.value }) : src;
    }
    case OP.connected: {
      const a = r.u8();
      if (a !== 0 && a !== 1) return decodeError('invalid connected across');
      const src = readAstNode(r);
      return src.ok
        ? ok({ op: 'connected', across: a === 0 ? 'any' : 'smooth', src: src.value })
        : src;
    }
    case OP.toEdges:
    case OP.toVerts: {
      const inc = r.u8();
      const include = inc === undefined ? undefined : INCLUSIONS[inc];
      if (include === undefined) return decodeError('invalid inclusion');
      const src = readAstNode(r);
      return src.ok
        ? ok({ op: code === OP.toEdges ? 'toEdges' : 'toVerts', include, src: src.value })
        : src;
    }
    case OP.and:
    case OP.or:
    case OP.minus: {
      const d = r.u8();
      const domain = d === undefined ? undefined : DOMAINS[d];
      if (domain === undefined) return decodeError('invalid set op domain');
      const a = readAstNode(r);
      if (!a.ok) return a;
      const b = readAstNode(r);
      if (!b.ok) return b;
      const op = code === OP.and ? 'and' : code === OP.or ? 'or' : 'minus';
      return ok({ op, domain, a: a.value, b: b.value });
    }
    default:
      return decodeError(`unknown opcode ${code}`);
  }
}

/** Encode a pure-data SelectorAst and cardinality into compact FXSL v1 bytes. */
export function encodeSelectorAst(
  ast: SelectorAst,
  cardinality: Cardinality = { kind: 'nonEmpty' },
): Result<Uint8Array, ModelingError> {
  const w = new ByteWriter();
  w.u32(FXSL_MAGIC);
  w.u8(FXSL_VERSION);
  if (cardinality.kind === 'nonEmpty') {
    w.u8(0);
  } else {
    w.u8(cardinality.kind === 'exactly' ? 1 : 2);
    w.u32(cardinality.count);
  }
  const written = writeAstNode(w, ast);
  if (!written.ok) return written;
  return ok(w.finish());
}

/** Decode FXSL v1 selector bytes back into a pure-data SelectorAst and cardinality. */
export function decodeSelectorAst(
  bytes: Uint8Array,
): Result<{ readonly ast: SelectorAst; readonly cardinality: Cardinality }, ModelingError> {
  const r = new ByteReader(bytes);
  const magic = r.u32();
  if (magic !== FXSL_MAGIC) return decodeError('invalid magic');
  const version = r.u8();
  if (version !== FXSL_VERSION) return decodeError(`unsupported version ${version}`);
  const cKind = r.u8();
  let cardinality: Cardinality;
  if (cKind === 0) {
    cardinality = { kind: 'nonEmpty' };
  } else if (cKind === 1 || cKind === 2) {
    const count = r.u32();
    if (count === undefined) return decodeError('missing cardinality count');
    cardinality = { kind: cKind === 1 ? 'exactly' : 'atLeast', count };
  } else {
    return decodeError('invalid cardinality kind');
  }
  const ast = readAstNode(r);
  if (!ast.ok) return ast;
  if (r.remaining !== 0) return decodeError(`trailing ${r.remaining} bytes`);
  return ok({ ast: ast.value, cardinality });
}

/** Whether an AST contains only serializable built-in nodes (no custom JS closures). */
export function isPureSelectorAst(ast: SelectorAst): boolean {
  switch (ast.op) {
    case 'custom':
      return false;
    case 'and':
    case 'or':
    case 'minus':
      return isPureSelectorAst(ast.a) && isPureSelectorAst(ast.b);
    case 'not':
    case 'largest':
    case 'smallest':
    case 'grow':
    case 'shrink':
    case 'connected':
    case 'toEdges':
    case 'boundary':
    case 'toVerts':
    case 'toFaces':
    case 'loop':
    case 'ring':
      return isPureSelectorAst(ast.src);
    default:
      return true;
  }
}

/** Evaluate a SelectorAst in ascending id order against an EditMesh. */
export function evaluateSelectorAst(mesh: EditMesh, ast: SelectorAst): number[] {
  switch (ast.op) {
    case 'custom':
      return ast.evaluator(mesh);
    case 'all':
      return domainIds(mesh, ast.domain);
    case 'tag': {
      const t = mesh.tagIndex(ast.name, false);
      if (t < 0) return [];
      const word = t >> 5;
      const mask = 1 << (t & 31);
      const selected: number[] = [];
      for (let f = 0; f < mesh.faceHighWater; f++) {
        if (((mesh.fTags[f * mesh.tagWords + word] as number) & mask) !== 0 && mesh.isFaceAlive(f))
          selected.push(f);
      }
      return selected;
    }
    case 'createdBy': {
      const l = mesh.labelNames.indexOf(ast.label);
      if (l <= 0) return [];
      if (ast.role === undefined)
        return mesh.faces().filter((f) => (mesh.fLabel[f] as number) === l);
      const r = mesh.roleNames.indexOf(ast.role);
      if (r < 0) return [];
      return mesh
        .faces()
        .filter((f) => (mesh.fLabel[f] as number) === l && (mesh.fRole[f] as number) === r);
    }
    case 'material': {
      const m = mesh.materialNames.indexOf(ast.slot);
      return m < 0 ? [] : mesh.faces().filter((f) => (mesh.fMaterial[f] as number) === m);
    }
    case 'mirrored':
      return mesh.faces().filter((f) => ((mesh.fFlags[f] as number) & FACE_MIRRORED) !== 0);
    case 'facing': {
      const direction = axisVector(ast.axis);
      const limit = cos((ast.degrees * Math.PI) / 180);
      return mesh.faces().filter((f) => dot(faceNormal(mesh, f), direction) >= limit - 1e-12);
    }
    case 'extreme': {
      const direction = axisVector(ast.axis);
      const faces = mesh.faces();
      const reach = faces.map((f) => dot(faceCentroid(mesh, f), direction));
      const max = maxOf(reach);
      return faces.filter((_, i) => (reach[i] as number) >= max - 1e-9);
    }
    case 'inBox': {
      const { min, max, by } = ast;
      const inside = (p: Tuple3) =>
        p[0] >= min[0] &&
        p[0] <= max[0] &&
        p[1] >= min[1] &&
        p[1] <= max[1] &&
        p[2] >= min[2] &&
        p[2] <= max[2];
      return mesh.faces().filter((f) => hit(mesh, f, by, inside));
    }
    case 'side': {
      const { point, normal, by } = ast;
      return mesh
        .faces()
        .filter((f) =>
          hit(
            mesh,
            f,
            by,
            (p) => dot([p[0] - point[0], p[1] - point[1], p[2] - point[2]], normal) >= 0,
          ),
        );
    }
    case 'largest':
    case 'smallest': {
      const largest = ast.op === 'largest';
      let best = NONE;
      let bestArea = largest ? -Infinity : Infinity;
      for (const f of evaluateSelectorAst(mesh, ast.src)) {
        const area = faceArea(mesh, f);
        if (largest ? area > bestArea : area < bestArea) {
          best = f;
          bestArea = area;
        }
      }
      return best === NONE ? [] : [best];
    }
    case 'grow': {
      const set = new Set(evaluateSelectorAst(mesh, ast.src));
      for (let i = 0; i < ast.steps; i++) {
        for (const f of [...set]) for (const g of faceNeighbors(mesh, f, 'any')) set.add(g);
      }
      return [...set].sort((a, b) => a - b);
    }
    case 'shrink': {
      let set = new Set(evaluateSelectorAst(mesh, ast.src));
      for (let i = 0; i < ast.steps; i++) {
        const current = set;
        set = new Set(
          [...current].filter((f) =>
            mesh.faceHalves(f).every((h) => {
              const g = mesh.hFace[h ^ 1] as number;
              return g === NONE || current.has(g);
            }),
          ),
        );
      }
      return [...set].sort((a, b) => a - b);
    }
    case 'connected': {
      const set = new Set(evaluateSelectorAst(mesh, ast.src));
      const stack = [...set];
      while (stack.length > 0) {
        const f = stack.pop() as number;
        for (const g of faceNeighbors(mesh, f, ast.across)) {
          if (!set.has(g)) {
            set.add(g);
            stack.push(g);
          }
        }
      }
      return [...set].sort((a, b) => a - b);
    }
    case 'toEdges': {
      const faces = new Set(evaluateSelectorAst(mesh, ast.src));
      const out = new Set<number>();
      for (const f of faces) {
        for (const h of mesh.faceHalves(f)) {
          const other = mesh.hFace[h ^ 1] as number;
          if (ast.include === 'touching' || other === NONE || faces.has(other)) out.add(h >> 1);
        }
      }
      return [...out].sort((a, b) => a - b);
    }
    case 'boundary': {
      const faces = new Set(evaluateSelectorAst(mesh, ast.src));
      const out: number[] = [];
      for (const e of mesh.edges()) {
        const a = faces.has(mesh.hFace[e * 2] as number);
        const b = faces.has(mesh.hFace[e * 2 + 1] as number);
        if (a !== b) out.push(e);
      }
      return out;
    }
    case 'toVerts': {
      const faces = new Set(evaluateSelectorAst(mesh, ast.src));
      const out = new Set<number>();
      for (const f of faces) for (const v of mesh.faceVertices(f)) out.add(v);
      if (ast.include === 'contained') {
        for (const f of mesh.faces()) {
          if (faces.has(f)) continue;
          for (const v of mesh.faceVertices(f)) out.delete(v);
        }
      }
      return [...out].sort((a, b) => a - b);
    }
    case 'near': {
      const { point, count } = ast;
      return mesh
        .faces()
        .map((f) => {
          const c = faceCentroid(mesh, f);
          return { f, d: hypot3(c[0] - point[0], c[1] - point[1], c[2] - point[2]) };
        })
        .sort((a, b) => a.d - b.d || a.f - b.f)
        .slice(0, count)
        .map(({ f }) => f)
        .sort((a, b) => a - b);
    }
    case 'thin': {
      const widths = faceThickness(mesh, ast.maxWidth);
      return mesh.faces().filter((f) => (widths.get(f) ?? Infinity) < ast.maxWidth);
    }
    case 'dihedral': {
      const limit = cos((ast.degrees * Math.PI) / 180);
      return mesh.edges().filter((e) => {
        const a = mesh.hFace[e * 2] as number;
        const b = mesh.hFace[e * 2 + 1] as number;
        if (a === NONE || b === NONE) return false;
        const cosine = dot(faceNormal(mesh, a), faceNormal(mesh, b));
        return ast.compare === '>' ? cosine < limit - 1e-12 : cosine > limit + 1e-12;
      });
    }
    case 'meshBoundary':
      return mesh.edges().filter((e) => mesh.isBoundaryEdge(e));
    case 'parallel': {
      const direction = axisVector(ast.axis);
      const limit = cos((ast.degrees * Math.PI) / 180);
      return mesh.edges().filter((e) => {
        const [a, b] = mesh.edgeVertices(e);
        const d = normalize(sub(mesh.position(b), mesh.position(a)));
        return Math.abs(dot(d, direction)) >= limit - 1e-12;
      });
    }
    case 'perpendicular': {
      const direction = axisVector(ast.axis);
      const limit = sin((ast.degrees * Math.PI) / 180);
      return mesh.edges().filter((e) => {
        const [a, b] = mesh.edgeVertices(e);
        const d = normalize(sub(mesh.position(b), mesh.position(a)));
        return Math.abs(dot(d, direction)) <= limit + 1e-12;
      });
    }
    case 'concave':
      return mesh.edges().filter((e) => {
        const a = mesh.hFace[e * 2] as number;
        const b = mesh.hFace[e * 2 + 1] as number;
        if (a === NONE || b === NONE) return false;
        const p = mesh.position(mesh.hVert[e * 2 + 1] as number);
        const q = mesh.position(mesh.hVert[e * 2] as number);
        const inward = cross(faceNormal(mesh, b), normalize(sub(q, p)));
        return dot(faceNormal(mesh, a), inward) > 1e-9;
      });
    case 'loop': {
      const out = new Set<number>();
      for (const e of evaluateSelectorAst(mesh, ast.src))
        for (const x of edgeLoop(mesh, e)) out.add(x);
      return [...out].sort((a, b) => a - b);
    }
    case 'ring': {
      const out = new Set<number>();
      for (const e of evaluateSelectorAst(mesh, ast.src))
        for (const x of edgeRing(mesh, e).edges) out.add(x);
      return [...out].sort((a, b) => a - b);
    }
    case 'sharp':
      return mesh.edges().filter((e) => ((mesh.eFlags[e] as number) & EDGE_SHARP) !== 0);
    case 'seam':
      return mesh.edges().filter((e) => ((mesh.eFlags[e] as number) & EDGE_SEAM) !== 0);
    case 'toFaces': {
      const out = new Set<number>();
      for (const e of evaluateSelectorAst(mesh, ast.src)) {
        for (const h of [e * 2, e * 2 + 1]) {
          const f = mesh.hFace[h] as number;
          if (f !== NONE) out.add(f);
        }
      }
      return [...out].sort((a, b) => a - b);
    }
    case 'and': {
      const b = new Set(evaluateSelectorAst(mesh, ast.b));
      return evaluateSelectorAst(mesh, ast.a).filter((id) => b.has(id));
    }
    case 'or':
      return sortedUnique([
        ...evaluateSelectorAst(mesh, ast.a),
        ...evaluateSelectorAst(mesh, ast.b),
      ]);
    case 'minus': {
      const b = new Set(evaluateSelectorAst(mesh, ast.b));
      return evaluateSelectorAst(mesh, ast.a).filter((id) => !b.has(id));
    }
    case 'not': {
      const excluded = new Set(evaluateSelectorAst(mesh, ast.src));
      return domainIds(mesh, ast.domain).filter((id) => !excluded.has(id));
    }
  }
}

/**
 * Selector expression. Holds a pure-data `SelectorAst` re-evaluated on every
 * operation call so it never refers to stale element ids and can be serialized
 * directly across JS <-> Rust/WASM boundaries.
 */
export class Selector<D extends Domain> {
  readonly domain: D;
  readonly description: string;
  readonly ast: SelectorAst;
  readonly cardinality: Cardinality;
  private readonly sources: readonly Selector<Domain>[];
  private readonly argumentError: ModelingError | undefined;
  private encodedCache: Result<Uint8Array, ModelingError> | undefined;

  constructor(
    domain: D,
    description: string,
    astOrEvaluator: SelectorAst | Evaluate,
    cardinality: Cardinality = { kind: 'nonEmpty' },
    sources: readonly Selector<Domain>[] = [],
    argumentError?: ModelingError,
  ) {
    this.domain = domain;
    this.description = description;
    this.ast =
      typeof astOrEvaluator === 'function'
        ? { op: 'custom', domain, description, evaluator: astOrEvaluator }
        : astOrEvaluator;
    this.cardinality = cardinality;
    this.sources = sources;
    this.argumentError = argumentError;
  }

  /** Whether this expression is 100% pure data with no custom JS evaluator closures. */
  isPureAst(): boolean {
    return isPureSelectorAst(this.ast);
  }

  /** Lazily cached compact FXSL v1 binary encoding for FFI transfer. */
  encode(): Result<Uint8Array, ModelingError> {
    const invalid = this.invalid();
    if (invalid !== undefined) return err(invalid);
    if (this.encodedCache === undefined) {
      this.encodedCache = encodeSelectorAst(this.ast, this.cardinality);
    }
    return this.encodedCache;
  }

  /** The first invalid argument anywhere in this expression, if any. */
  invalid(): ModelingError | undefined {
    if (this.argumentError !== undefined) return this.argumentError;
    for (const source of this.sources) {
      const found = source.invalid();
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Raw evaluation in ascending id order; does not check cardinality. Invalid expressions match nothing. */
  evaluate(mesh: EditMesh): number[] {
    if (this.invalid() !== undefined) return [];
    return evaluateSelectorAst(mesh, this.ast);
  }

  and(other: Selector<D>): Selector<D> {
    return new Selector(
      this.domain,
      `(${this.description} and ${other.description})`,
      { op: 'and', domain: this.domain, a: this.ast, b: other.ast },
      undefined,
      [this, other],
    );
  }

  or(other: Selector<D>): Selector<D> {
    return new Selector(
      this.domain,
      `(${this.description} or ${other.description})`,
      { op: 'or', domain: this.domain, a: this.ast, b: other.ast },
      undefined,
      [this, other],
    );
  }

  minus(other: Selector<D>): Selector<D> {
    return new Selector(
      this.domain,
      `(${this.description} minus ${other.description})`,
      { op: 'minus', domain: this.domain, a: this.ast, b: other.ast },
      undefined,
      [this, other],
    );
  }

  not(): Selector<D> {
    return new Selector(
      this.domain,
      `not ${this.description}`,
      { op: 'not', domain: this.domain, src: this.ast },
      undefined,
      [this],
    );
  }

  one(): Selector<D> {
    return this.withCardinality({ kind: 'exactly', count: 1 });
  }

  exactly(count: number): Selector<D> {
    return this.withCardinality({ kind: 'exactly', count });
  }

  atLeast(count: number): Selector<D> {
    return this.withCardinality({ kind: 'atLeast', count });
  }

  largest(this: FaceSelector): FaceSelector {
    return faceSel.largest(this);
  }

  smallest(this: FaceSelector): FaceSelector {
    return faceSel.smallest(this);
  }

  grow(this: FaceSelector, steps: number): FaceSelector {
    return faceSel.grow(this, steps);
  }

  /** Drop faces that touch an unselected face across an edge, `steps` times. */
  shrink(this: FaceSelector, steps: number): FaceSelector {
    return faceSel.shrink(this, steps);
  }

  /** Vertices of the selected faces: all of them, or only those whose faces are all selected. */
  toVerts(this: FaceSelector, include: Inclusion): VertSelector {
    return faceSel.toVerts(this, include);
  }

  /** Extend each selected edge along its edge loop (straight through valence-4 vertices). */
  loop(this: EdgeSelector): EdgeSelector {
    return edgeSel.loop(this);
  }

  /** Extend each selected edge along its edge ring (opposite edges of even-sided faces). */
  ring(this: EdgeSelector): EdgeSelector {
    return edgeSel.ring(this);
  }

  /** Flood across neighbors; `'smooth'` stops at sharp edges (a smoothing region). */
  connected(this: FaceSelector, across: 'any' | 'smooth'): FaceSelector {
    return faceSel.connected(this, across);
  }

  toEdges(this: FaceSelector, include: Inclusion): EdgeSelector {
    return faceSel.toEdges(this, include);
  }

  boundary(this: FaceSelector): EdgeSelector {
    return faceSel.boundary(this);
  }

  toFaces(this: EdgeSelector): FaceSelector {
    return edgeSel.toFaces(this);
  }

  /** Check the declared cardinality and return the evaluated ids. */
  resolve(mesh: EditMesh): Result<number[], ModelingError> {
    const invalid = this.invalid();
    if (invalid !== undefined) return err(invalid);
    const ids = this.evaluate(mesh);
    const c = this.cardinality;
    if (activeLog !== undefined) {
      if (activeLog.uses.length < MAX_SELECTOR_USES) {
        activeLog.uses.push({
          text: this.description,
          domain: this.domain,
          matched: ids.length,
          assert: c,
          provenance: provenanceCounts(mesh, this.domain, ids),
          signature: signatureOf(mesh, this.domain, ids),
        });
      } else {
        activeLog.truncated = true;
      }
    }
    if (ids.length === 0 && (c.kind === 'nonEmpty' || c.count > 0)) {
      return err(
        modelingError(
          'model-selection-empty',
          `selector ${this.description} matches at least one ${this.domain}`,
          {
            selector: this.description,
            ...emptySelectionHints(mesh, this.description),
          },
        ),
      );
    }
    if (
      (c.kind === 'exactly' && ids.length !== c.count) ||
      (c.kind === 'atLeast' && ids.length < c.count)
    ) {
      return err(
        modelingError(
          'model-selection-cardinality',
          `selector ${this.description} matches ${c.kind === 'exactly' ? 'exactly' : 'at least'} ${c.count}`,
          { selector: this.description, matched: ids.length },
        ),
      );
    }
    return ok(ids);
  }

  private withCardinality(cardinality: Cardinality): Selector<D> {
    return new Selector(this.domain, this.description, this.ast, cardinality, [this]);
  }
}

export type FaceSelector = Selector<'face'>;
export type EdgeSelector = Selector<'edge'>;
export type VertSelector = Selector<'vert'>;

function sortedUnique(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

const MAX_PROVENANCE_KEYS = 16;
const SIGNATURE_LIMIT = 512;
const NORMAL_ZERO_BAND = 0.4;

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The first keys in full, then one `+N#hash` element covering the rest, so equal lists compare equal. */
function boundedList(keys: readonly string[]): string[] {
  if (keys.length <= MAX_PROVENANCE_KEYS) return [...keys];
  const rest = keys.slice(MAX_PROVENANCE_KEYS);
  return [...keys.slice(0, MAX_PROVENANCE_KEYS), `+${rest.length}#${fnv1a(rest.join('|'))}`];
}

function bump(counts: Int32Array, i: number): void {
  counts[i] = (counts[i] as number) + 1;
}

function provenanceCounts(mesh: EditMesh, domain: Domain, ids: readonly number[]): string[] {
  const roles = mesh.roleNames.length;
  const counts = new Int32Array(mesh.labelNames.length * roles);
  const { fLabel, fRole, hFace } = mesh;
  if (domain === 'face') {
    for (let i = 0; i < ids.length; i++) {
      const f = ids[i] as number;
      bump(counts, (fLabel[f] as number) * roles + (fRole[f] as number));
    }
  } else if (domain === 'edge') {
    for (let i = 0; i < ids.length; i++) {
      for (let side = 0; side < 2; side++) {
        const f = hFace[(ids[i] as number) * 2 + side] as number;
        if (f !== NONE) bump(counts, (fLabel[f] as number) * roles + (fRole[f] as number));
      }
    }
  } else {
    for (const f of incidentFaces(mesh, ids)) {
      bump(counts, (fLabel[f] as number) * roles + (fRole[f] as number));
    }
  }
  const keys: string[] = [];
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i] as number;
    if (n > 0) {
      keys.push(`${mesh.labelNames[Math.floor(i / roles)]}/${mesh.roleNames[i % roles]}:${n}`);
    }
  }
  return boundedList(keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Alive faces that use any of the vertices, in ascending id order. */
function incidentFaces(mesh: EditMesh, verts: readonly number[]): number[] {
  const mark = new Uint8Array(mesh.vertexHighWater);
  for (const v of verts) mark[v] = 1;
  const found = new Set<number>();
  for (let h = 0; h < mesh.halfHighWater; h++) {
    const f = mesh.hFace[h] as number;
    if (f !== NONE && mark[mesh.hVert[h] as number] === 1 && mesh.isEdgeAlive(h >> 1)) found.add(f);
  }
  return [...found].sort((a, b) => a - b);
}

function normalClass(n: Tuple3): string {
  let out = '';
  const names = ['x', 'y', 'z'];
  for (let a = 0; a < 3; a++) {
    const c = n[a] as number;
    if (c >= NORMAL_ZERO_BAND) out += `+${names[a]}`;
    else if (c <= -NORMAL_ZERO_BAND) out += `-${names[a]}`;
  }
  return out === '' ? '0' : out;
}

function signatureOf(mesh: EditMesh, domain: Domain, ids: readonly number[]): string {
  if (ids.length > SIGNATURE_LIMIT) return 'n[*] a[*]';
  let faces: number[];
  if (domain === 'face') faces = [...ids];
  else if (domain === 'edge') {
    faces = [];
    for (const id of ids) {
      for (const h of [id * 2, id * 2 + 1]) {
        const f = mesh.hFace[h] as number;
        if (f !== NONE) faces.push(f);
      }
    }
  } else faces = incidentFaces(mesh, ids);
  const classes = new Set<string>();
  const across = new Set<string>();
  for (const f of new Set(faces)) {
    classes.add(normalClass(faceNormal(mesh, f)));
    for (const h of mesh.faceHalves(f)) {
      const g = mesh.hFace[h ^ 1] as number;
      if (g !== NONE) {
        across.add(
          `${mesh.labelNames[mesh.fLabel[g] as number] ?? ''}/${mesh.roleNames[mesh.fRole[g] as number] ?? ''}`,
        );
      }
    }
  }
  const sorted = (set: Set<string>) => [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `n[${sorted(classes).join(' ')}] a[${boundedList(sorted(across)).join(' ')}]`;
}

function domainIds(mesh: EditMesh, domain: Domain): number[] {
  return domain === 'face' ? mesh.faces() : domain === 'edge' ? mesh.edges() : mesh.vertices();
}

function emptySelectionHints(mesh: EditMesh, description: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    availableTags: [...mesh.tagNames],
    availableLabels: mesh.labelNames.slice(1),
  };
  const facing =
    /facing\(([+-][xyz])/.exec(description) ?? /extreme\(([+-][xyz])/.exec(description);
  if (facing?.[1]?.endsWith('z')) {
    const sign = facing[1][0] as '+' | '-';
    const up = `${sign}y` as SignedAxis;
    const hits = faceSel.facing(up, 1).evaluate(mesh).length;
    if (hits > 0) {
      out.coordinateHint = `the engine is Y-up; facing('${up}') matches ${hits} faces`;
    }
  }
  return out;
}

function hit(mesh: EditMesh, f: number, by: HitRule, test: (p: Tuple3) => boolean): boolean {
  if (by === 'centroid') return test(faceCentroid(mesh, f));
  const points = mesh.faceVertices(f).map((v) => mesh.position(v));
  return by === 'all' ? points.every(test) : points.some(test);
}

function faceNeighbors(mesh: EditMesh, f: number, across: 'any' | 'smooth'): number[] {
  const out: number[] = [];
  for (const h of mesh.faceHalves(f)) {
    if (across === 'smooth' && ((mesh.eFlags[h >> 1] as number) & EDGE_SHARP) !== 0) continue;
    const g = mesh.hFace[h ^ 1] as number;
    if (g !== NONE) out.push(g);
  }
  return out;
}

/** Argument check for selector parameters; an invalid selector resolves to this error. */
function badArgument(name: string, value: unknown, expected: string): ModelingError {
  return modelingError('model-invalid-argument', `${name} is ${expected}`, { [name]: value });
}

function stepsError(steps: number): ModelingError | undefined {
  return Number.isInteger(steps) && steps >= 1
    ? undefined
    : badArgument('steps', steps, 'an integer >= 1');
}

/** Face selector constructors and modifiers. */
export const faceSel = {
  all(): FaceSelector {
    return new Selector('face', 'all()', { op: 'all', domain: 'face' });
  },
  tag(name: string): FaceSelector {
    return new Selector('face', `tag('${name}')`, { op: 'tag', name });
  },
  createdBy(label: string, role?: string): FaceSelector {
    return new Selector(
      'face',
      `createdBy('${label}'${role === undefined ? '' : `, '${role}'`})`,
      role === undefined ? { op: 'createdBy', label } : { op: 'createdBy', label, role },
    );
  },
  material(slot: string): FaceSelector {
    return new Selector('face', `material('${slot}')`, { op: 'material', slot });
  },
  mirrored(): FaceSelector {
    return new Selector('face', 'mirrored()', { op: 'mirrored' });
  },
  /** Faces whose part role is `role` (`m.markRole`); unmarked faces are `form`. */
  role(role: PartRole): FaceSelector {
    return new Selector('face', `role('${role}')`, {
      op: 'custom',
      domain: 'face',
      description: `role('${role}')`,
      evaluator: (mesh) => mesh.faces().filter((f) => partRole(mesh, f) === role),
    });
  },
  /** Faces whose normal is within `degrees` of the axis. */
  facing(axis: SignedAxis, degrees = 1): FaceSelector {
    return new Selector('face', `facing(${axis}, ${degrees})`, { op: 'facing', axis, degrees });
  },
  /** Faces whose centroid is farthest along the axis (ties within 1e-9 m are kept). */
  extreme(axis: SignedAxis): FaceSelector {
    return new Selector('face', `extreme(${axis})`, { op: 'extreme', axis });
  },
  inBox(min: Tuple3, max: Tuple3, options: { readonly by?: HitRule } = {}): FaceSelector {
    const by = options.by ?? 'all';
    return new Selector('face', `inBox([${min}], [${max}], ${by})`, {
      op: 'inBox',
      min: [min[0], min[1], min[2]],
      max: [max[0], max[1], max[2]],
      by,
    });
  },
  /** Faces on the positive side of the plane through `point` with `normal`. */
  side(point: Tuple3, normal: Tuple3, options: { readonly by?: HitRule } = {}): FaceSelector {
    const by = options.by ?? 'all';
    return new Selector('face', `side([${point}], [${normal}], ${by})`, {
      op: 'side',
      point: [point[0], point[1], point[2]],
      normal: [normal[0], normal[1], normal[2]],
      by,
    });
  },
  largest(source: FaceSelector): FaceSelector {
    return new Selector(
      'face',
      `${source.description}.largest()`,
      { op: 'largest', src: source.ast },
      undefined,
      [source],
    );
  },
  smallest(source: FaceSelector): FaceSelector {
    return new Selector(
      'face',
      `${source.description}.smallest()`,
      { op: 'smallest', src: source.ast },
      undefined,
      [source],
    );
  },
  grow(source: FaceSelector, steps: number): FaceSelector {
    return new Selector(
      'face',
      `${source.description}.grow(${steps})`,
      { op: 'grow', src: source.ast, steps },
      undefined,
      [source],
      stepsError(steps),
    );
  },
  connected(source: FaceSelector, across: 'any' | 'smooth'): FaceSelector {
    return new Selector(
      'face',
      `${source.description}.connected(${across})`,
      { op: 'connected', src: source.ast, across },
      undefined,
      [source],
    );
  },
  /** Edges of the selected faces. */
  toEdges(source: FaceSelector, include: Inclusion): EdgeSelector {
    return new Selector(
      'edge',
      `${source.description}.toEdges(${include})`,
      { op: 'toEdges', src: source.ast, include },
      undefined,
      [source],
    );
  },
  /** Edges with exactly one adjacent face in the selection. */
  boundary(source: FaceSelector): EdgeSelector {
    return new Selector(
      'edge',
      `${source.description}.boundary()`,
      { op: 'boundary', src: source.ast },
      undefined,
      [source],
    );
  },
  toVerts(source: FaceSelector, include: Inclusion): VertSelector {
    return new Selector(
      'vert',
      `${source.description}.toVerts(${include})`,
      { op: 'toVerts', src: source.ast, include },
      undefined,
      [source],
    );
  },
  shrink(source: FaceSelector, steps: number): FaceSelector {
    return new Selector(
      'face',
      `${source.description}.shrink(${steps})`,
      { op: 'shrink', src: source.ast, steps },
      undefined,
      [source],
      stepsError(steps),
    );
  },
  /** The `count` faces whose centroids are nearest to `point` (ties keep lower ids). */
  near(point: Tuple3, count = 1): FaceSelector {
    const error =
      !Number.isInteger(count) || count < 1
        ? badArgument('count', count, 'an integer >= 1')
        : point.every(Number.isFinite)
          ? undefined
          : badArgument('point', point, 'three finite coordinates');
    return new Selector(
      'face',
      `near([${point}], ${count})`,
      { op: 'near', point: [point[0], point[1], point[2]], count },
      undefined,
      [],
      error,
    );
  },
  /**
   * Faces whose opposite surface lies closer than `maxWidth` behind them (measured
   * from the face centroid against its normal), such as thin walls and fins.
   */
  thin(maxWidth: number): FaceSelector {
    const error =
      Number.isFinite(maxWidth) && maxWidth > 0
        ? undefined
        : badArgument('maxWidth', maxWidth, 'a finite distance > 0');
    return new Selector(
      'face',
      `thin(${maxWidth})`,
      { op: 'thin', maxWidth },
      undefined,
      [],
      error,
    );
  },
  /**
   * Faces no direction of a fixed 26-direction set (cube faces, edges and corners) can see
   * from outside: a ray from the centroid, lifted off the face, leaves the model in none of
   * the directions that look at the face. Interior walls, buried joints and faces under
   * another part are hidden; a face showing only through a gap narrower than the
   * directions resolve is hidden too.
   */
  hidden(): FaceSelector {
    return new Selector('face', 'hidden()', (mesh) => hiddenFaces(mesh));
  },
};

/** Edge selector constructors. */
export const edgeSel = {
  all(): EdgeSelector {
    return new Selector('edge', 'edges.all()', { op: 'all', domain: 'edge' });
  },
  /** Interior edges whose dihedral angle compares to `degrees`; boundary edges never match. */
  dihedral(compare: '>' | '<', degrees: number): EdgeSelector {
    return new Selector('edge', `dihedral(${compare} ${degrees})`, {
      op: 'dihedral',
      compare,
      degrees,
    });
  },
  meshBoundary(): EdgeSelector {
    return new Selector('edge', 'meshBoundary()', { op: 'meshBoundary' });
  },
  /** Edges whose direction is within `degrees` of the axis (either sense). */
  parallel(axis: Axis, degrees = 1): EdgeSelector {
    return new Selector('edge', `parallel(${axis}, ${degrees})`, {
      op: 'parallel',
      axis,
      degrees,
    });
  },
  /** Edges whose direction is within `degrees` of perpendicular to the axis. */
  perpendicular(axis: Axis, degrees = 1): EdgeSelector {
    return new Selector('edge', `perpendicular(${axis}, ${degrees})`, {
      op: 'perpendicular',
      axis,
      degrees,
    });
  },
  /** Interior edges where the surface folds inward (valleys). */
  concave(): EdgeSelector {
    return new Selector('edge', 'concave()', { op: 'concave' });
  },
  loop(source: EdgeSelector): EdgeSelector {
    return new Selector(
      'edge',
      `${source.description}.loop()`,
      { op: 'loop', src: source.ast },
      undefined,
      [source],
    );
  },
  ring(source: EdgeSelector): EdgeSelector {
    return new Selector(
      'edge',
      `${source.description}.ring()`,
      { op: 'ring', src: source.ast },
      undefined,
      [source],
    );
  },
  sharp(): EdgeSelector {
    return new Selector('edge', 'sharp()', { op: 'sharp' });
  },
  /**
   * Sharp edges that border a smooth group (faces connected across non-sharp edges) of at most
   * `maxFaces` faces on either side; `markSharp(..., false)` merges such fragments into their
   * neighbors so they stop costing a UV island each.
   */
  smallGroupBorder(maxFaces: number): EdgeSelector {
    return new Selector('edge', `smallGroupBorder(${maxFaces})`, (mesh) => {
      const parent = Array.from({ length: mesh.faceHighWater }, (_, i) => i);
      const find = (a: number): number => {
        let r = a;
        while (parent[r] !== r) r = parent[r] as number;
        for (let x = a; parent[x] !== r; ) {
          const next = parent[x] as number;
          parent[x] = r;
          x = next;
        }
        return r;
      };
      const sharp = (e: number) => ((mesh.eFlags[e] as number) & EDGE_SHARP) !== 0;
      for (const e of mesh.edges()) {
        const f = mesh.hFace[e * 2] as number;
        const g = mesh.hFace[e * 2 + 1] as number;
        if (f !== NONE && g !== NONE && !sharp(e)) parent[find(f)] = find(g);
      }
      const size = new Map<number, number>();
      for (const f of mesh.faces()) size.set(find(f), (size.get(find(f)) ?? 0) + 1);
      return mesh.edges().filter((e) => {
        const f = mesh.hFace[e * 2] as number;
        const g = mesh.hFace[e * 2 + 1] as number;
        if (f === NONE || g === NONE || !sharp(e)) return false;
        return Math.min(size.get(find(f)) as number, size.get(find(g)) as number) <= maxFaces;
      });
    });
  },
  /** Edges marked as UV seams (`markSeam`). */
  seam(): EdgeSelector {
    return new Selector('edge', 'seam()', { op: 'seam' });
  },
  /** Faces adjacent to the selected edges. */
  toFaces(source: EdgeSelector): FaceSelector {
    return new Selector(
      'face',
      `${source.description}.toFaces()`,
      { op: 'toFaces', src: source.ast },
      undefined,
      [source],
    );
  },
};

/** The `sel` namespace authors write against. */
export const sel = {
  ...faceSel,
  edges: edgeSel,
};

const OCCLUSION_DIRECTIONS: readonly Tuple3[] = (() => {
  const out: Tuple3[] = [];
  for (const x of [-1, 0, 1]) {
    for (const y of [-1, 0, 1]) {
      for (const z of [-1, 0, 1]) {
        if (x !== 0 || y !== 0 || z !== 0) out.push(normalize([x, y, z]));
      }
    }
  }
  return out;
})();

/** A direction counts as looking at a face when it is this far (cosine) above the face plane. */
const OCCLUSION_FACING = 0.15;
/** Ray origin lift off the face, over the model's bounding diagonal. */
const OCCLUSION_LIFT = 1e-5;

function hiddenFaces(mesh: EditMesh): number[] {
  const positions: number[] = [];
  const indices: number[] = [];
  const lo: Tuple3 = [Infinity, Infinity, Infinity];
  const hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
  const faces = mesh.faces();
  for (const f of faces) {
    const points = mesh.faceVertices(f).map((v) => mesh.position(v));
    const tri = triangulateLoop(points);
    if (tri === undefined) continue;
    const base = positions.length / 3;
    for (const p of points) {
      positions.push(p[0], p[1], p[2]);
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c] as number, p[c] as number);
        hi[c] = Math.max(hi[c] as number, p[c] as number);
      }
    }
    for (const i of tri) indices.push(base + i);
  }
  if (indices.length === 0) return [];
  const lift = OCCLUSION_LIFT * Math.max(1e-9, hypot3(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
  const reach = 4 * (lift / OCCLUSION_LIFT) + 1;
  const bvh = new TriangleBvh(positions, indices);
  return faces.filter((f) => {
    const n = faceNormal(mesh, f);
    const c = faceCentroid(mesh, f);
    const o = [c[0] + n[0] * lift, c[1] + n[1] * lift, c[2] + n[2] * lift];
    for (const d of OCCLUSION_DIRECTIONS) {
      if (dot(d, n) < OCCLUSION_FACING) continue;
      if (bvh.raycast(o, d, reach, true) === undefined) return false;
    }
    return true;
  });
}
