import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { structureError } from './structure';
import { brepFail, deepFreeze, type Shape } from './types';

/** One value shape; the same table drives encoding and decoding, so the two cannot drift. */
type Spec =
  | { readonly t: 'num' }
  | { readonly t: 'int'; readonly min: number }
  | { readonly t: 'bool' }
  | { readonly t: 'str' }
  | { readonly t: 'lit'; readonly values: readonly (1 | -1)[] }
  | { readonly t: 'arr'; readonly of: Spec }
  | { readonly t: 'tuple'; readonly n: number }
  | { readonly t: 'obj'; readonly fields: Fields; readonly optional?: readonly string[] }
  | {
      readonly t: 'union';
      readonly name: string;
      readonly cases: Readonly<Record<string, Fields>>;
    };

type Fields = Readonly<Record<string, Spec>>;

const num: Spec = { t: 'num' };
const idx: Spec = { t: 'int', min: 0 };
const bool: Spec = { t: 'bool' };
const p2: Spec = { t: 'tuple', n: 2 };
const p3: Spec = { t: 'tuple', n: 3 };
const list = (of: Spec): Spec => ({ t: 'arr', of });
const obj = (fields: Fields, optional?: readonly string[]): Spec =>
  optional === undefined ? { t: 'obj', fields } : { t: 'obj', fields, optional };

const frame = obj({ o: p3, x: p3, y: p3, z: p3 });
const nurbsCurve = obj({ degree: idx, points: list(p3), weights: list(num), knots: list(num) }, [
  'weights',
]);
const nurbsSurface = obj(
  {
    degreeU: idx,
    degreeV: idx,
    points: list(list(p3)),
    weights: list(list(num)),
    knotsU: list(num),
    knotsV: list(num),
  },
  ['weights'],
);

const surface: Spec = {
  t: 'union',
  name: 'surface',
  cases: {
    plane: { frame },
    cylinder: { frame, radius: num },
    sphere: { frame, radius: num },
    cone: { frame, radius: num, halfAngle: num },
    torus: { frame, major: num, minor: num },
    nurbs: { surface: nurbsSurface },
  },
};
const curve: Spec = {
  t: 'union',
  name: 'curve',
  cases: {
    line: { o: p3, d: p3 },
    circle: { frame, radius: num },
    ellipse: { frame, a: num, b: num },
    nurbs: { curve: nurbsCurve },
  },
};
const pcurve: Spec = {
  t: 'union',
  name: 'pcurve',
  cases: {
    line: { o: p2, d: p2 },
    circle: { c: p2, r: num, phase: num, dir: { t: 'lit', values: [1, -1] } },
    nurbs: { curve: nurbsCurve },
  },
};

const shape: Spec = obj({
  tol: num,
  maxTol: num,
  vertices: list(obj({ p: p3, tol: num })),
  curves: list(curve),
  surfaces: list(surface),
  edges: list(obj({ curve: { t: 'int', min: -1 }, t0: num, t1: num, v0: idx, v1: idx, tol: num })),
  coedges: list(obj({ edge: idx, reversed: bool, pcurve })),
  loops: list(obj({ coedges: list(idx), outer: bool })),
  faces: list(
    obj({
      surface: idx,
      loops: list(idx),
      reversed: bool,
      label: { t: 'str' },
      role: { t: 'str' },
    }),
  ),
  shells: list(obj({ faces: list(idx) })),
});

/** Document tag; a reader refuses any other `format` and any `version` it does not know. */
export const BREP_JSON_FORMAT = 'forgeax-brep';
export const BREP_JSON_VERSION = 1;

class SchemaFailure {
  readonly reason: string;
  readonly path: string;
  readonly extra: Readonly<Record<string, unknown>>;
  constructor(reason: string, path: string, extra: Readonly<Record<string, unknown>> = {}) {
    this.reason = reason;
    this.path = path;
    this.extra = extra;
  }
}

const fail = (reason: string, path: string, extra?: Record<string, unknown>): never => {
  throw new SchemaFailure(reason, path, extra);
};

function record(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail('not-an-object', path);
  return v as Record<string, unknown>;
}

/** `-0` is not representable in JSON text, so it travels as the string "-0" and is restored exactly. */
function convert(spec: Spec, v: unknown, path: string, encode: boolean): unknown {
  switch (spec.t) {
    case 'num': {
      if (!encode && v === '-0') return -0;
      if (typeof v !== 'number') return fail('not-a-number', path, { got: typeof v });
      if (!Number.isFinite(v)) return fail('non-finite-number', path);
      return encode && Object.is(v, -0) ? '-0' : v;
    }
    case 'int':
      if (typeof v !== 'number' || !Number.isInteger(v) || v < spec.min)
        return fail('not-an-index', path, { min: spec.min });
      return v;
    case 'bool':
      if (typeof v !== 'boolean') return fail('not-a-boolean', path);
      return v;
    case 'str':
      if (typeof v !== 'string') return fail('not-a-string', path);
      return v;
    case 'lit':
      if (!(spec.values as readonly unknown[]).includes(v))
        return fail('bad-literal', path, { allowed: spec.values });
      return v;
    case 'arr': {
      if (!Array.isArray(v)) return fail('not-an-array', path);
      return v.map((x, i) => convert(spec.of, x, `${path}[${i}]`, encode));
    }
    case 'tuple': {
      if (!Array.isArray(v) || v.length !== spec.n)
        return fail('bad-tuple-length', path, { expected: spec.n });
      return v.map((x, i) => convert(num, x, `${path}[${i}]`, encode));
    }
    case 'obj':
      return convertFields(spec.fields, spec.optional ?? [], v, path, encode, undefined);
    case 'union': {
      const tag = record(v, path).kind;
      if (typeof tag !== 'string' || !Object.hasOwn(spec.cases, tag))
        return fail(`unknown-${spec.name}-kind`, `${path}.kind`, {
          kind: typeof tag === 'string' ? tag : typeof tag,
          known: Object.keys(spec.cases),
        });
      return convertFields(spec.cases[tag] as Fields, [], v, path, encode, tag);
    }
  }
}

function convertFields(
  fields: Fields,
  optional: readonly string[],
  v: unknown,
  path: string,
  encode: boolean,
  kind: string | undefined,
): Record<string, unknown> {
  const src = record(v, path);
  const out: Record<string, unknown> = kind === undefined ? {} : { kind };
  for (const [name, sub] of Object.entries(fields)) {
    const at = `${path}.${name}`;
    if (src[name] === undefined) {
      if (!optional.includes(name)) fail('missing-field', at);
      continue;
    }
    out[name] = convert(sub, src[name], at, encode);
  }
  for (const key of Object.keys(src))
    if (!Object.hasOwn(fields, key) && !(kind !== undefined && key === 'kind'))
      fail('unknown-field', `${path}.${key}`);
  return out;
}

function schemaError(f: SchemaFailure) {
  return brepFail<never>('brep-bad-argument', 'a forgeax-brep document this version can read', {
    reason: f.reason,
    path: f.path,
    ...f.extra,
  });
}

/**
 * The exact JSON text of a Shape: finite doubles print in the shortest form that parses back to the
 * same bits (and `-0` is kept), keys follow one fixed order, so equal Shapes give equal text and
 * a digest of the text is a digest of the Shape. Never reads a kind it does not know.
 */
export function serializeShape(value: Shape): Result<string, ModelingError> {
  try {
    const body = convert(shape, value, '$', true);
    return ok(
      JSON.stringify({ format: BREP_JSON_FORMAT, version: BREP_JSON_VERSION, shape: body }),
    );
  } catch (e) {
    if (e instanceof SchemaFailure) return schemaError(e);
    throw e;
  }
}

/**
 * Parse text from {@link serializeShape}. Strict: an unknown `format`, `version`, surface / curve /
 * pcurve kind, field or malformed value is a `model-invalid-argument` error whose `detail.reason`
 * and `detail.path` name it; a document that parses but is not an indexable Shape reports the
 * structural issue instead. The result is frozen.
 */
export function deserializeShape(text: string): Result<Shape, ModelingError> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return schemaError(new SchemaFailure('invalid-json', '$'));
  }
  try {
    const head = record(doc, '$');
    if (head.format !== BREP_JSON_FORMAT)
      fail('unknown-format', '$.format', { got: String(head.format) });
    if (head.version !== BREP_JSON_VERSION)
      fail('unsupported-version', '$.version', {
        got: String(head.version),
        supported: BREP_JSON_VERSION,
      });
    for (const key of Object.keys(head))
      if (key !== 'format' && key !== 'version' && key !== 'shape')
        fail('unknown-field', `$.${key}`);
    const decoded = deepFreeze(convert(shape, head.shape, '$.shape', false)) as Shape;
    const bad = structureError(decoded);
    return bad === undefined
      ? ok(decoded)
      : brepFail('brep-bad-argument', 'a structurally valid Shape', {
          reason: 'invalid-structure',
          cause: bad.detail,
        });
  } catch (e) {
    if (e instanceof SchemaFailure) return schemaError(e);
    throw e;
  }
}
