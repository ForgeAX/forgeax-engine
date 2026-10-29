import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { inspectRequiredOutputs } from '../check-required-output.mjs';

const root = '/required-output-test';
function inspect(body, file = 'packages/math/src/main.ts') {
  const path = resolve(root, file);
  const source = `interface Vec3 { readonly length: 3; [index: number]: number; }\ndeclare function allocate(): Vec3;\n${body}`;
  const host = ts.createCompilerHost({ noLib: true });
  host.fileExists = (name) => name === path;
  host.readFile = (name) => (name === path ? source : undefined);
  host.getSourceFile = (name, version) =>
    name === path ? ts.createSourceFile(name, source, version, true) : undefined;
  const program = ts.createProgram(
    [path],
    { target: ts.ScriptTarget.ES2022, noLib: true, strict: true },
    host,
  );
  return inspectRequiredOutputs(program, [path], root);
}
function codes(body, file) {
  return inspect(body, file).map((entry) => entry.code);
}

test('requires caller-supplied output storage in implementations and function type signatures', () => {
  for (const parameter of [
    'out?: Vec3',
    'out: Vec3 = allocate()',
    'out: Vec3 | undefined',
    'out: Vec3 | null',
    '...out: Vec3[]',
  ])
    assert.deepEqual(codes(`function write(${parameter}): void {}`), ['optional-output']);
  assert.deepEqual(codes('type Sampler = (out?: Vec3) => Vec3;'), ['optional-output']);
  assert.equal(inspect('function write(outPosition?: Vec3) {}')[0]?.parameter, 'outPosition');
});

test('returning the same supplied output, forwarding it and returning independent status remain legal', () => {
  assert.deepEqual(
    codes(`
    function write(out: Vec3): Vec3 { out[0] = 2; return out; }
    function forward(out: Vec3): Vec3 { return write(out); }
    function valid(out: Vec3): boolean { out[0] = 1; return true; }
    function flags(out: Vec3) { return { behind: out[0] < 0, onScreen: true }; }
    function decode(out: Vec3) { return { kind: 'f32', data: out }; }
    type Sampler = (out: Vec3) => Vec3;
  `),
    [],
  );
});

test('rejects implicit output replacement through nullish/logical fallback and stable aliases', () => {
  for (const body of [
    'return out ?? allocate();',
    'return out || allocate();',
    'out ??= allocate();',
    'out ||= allocate();',
    'const target = out; return (target as Vec3) ?? allocate();',
  ])
    assert.deepEqual(codes(`function write(out: Vec3) { ${body} }`), ['implicit-output-fallback']);
});

test('rejects allocating absence branches while allowing explicit boundary errors and scalar defaults', () => {
  for (const body of [
    'return out ? out : allocate();',
    'return out === undefined ? allocate() : out;',
    'if (out === undefined) return allocate(); return out;',
    'if (out !== undefined) return out; return allocate();',
  ])
    assert.deepEqual(codes(`function write(out: Vec3) { ${body} }`), ['implicit-output-fallback']);
  assert.deepEqual(
    codes(
      'function write(out: Vec3) { if (out === undefined) throw new Error("out required"); return out[0] ?? 0; }',
    ),
    [],
  );
});

test('rejects output replacement assignments in absence branches, including local aliases', () => {
  for (const body of [
    'if (!out) out = allocate(); return out;',
    'if (out === undefined) { out = allocate(); } return out;',
    'if (out !== undefined) return out; else out = allocate(); return out;',
    'let target = out; if (!target) target = allocate(); return target;',
    'let target = out; const alias = target; if (!alias) target = allocate(); return target;',
    'const alias = out; if (alias === undefined) out = allocate(); return out;',
    'if (out) return out; out = allocate(); return out;',
  ])
    assert.deepEqual(
      codes(`function write(out: Vec3) { ${body} }`),
      ['implicit-output-fallback'],
      body,
    );
});

test('recognizes typeof absence and presence checks in either operand order through aliases and casts', () => {
  for (const body of [
    'return typeof out === "undefined" ? allocate() : out;',
    'return "undefined" == typeof out ? allocate() : out;',
    'return typeof out !== "undefined" ? out : allocate();',
    'if (typeof out === "undefined") out = allocate(); return out;',
    'if (typeof out !== "undefined") return out; return allocate();',
    'let target = out; if ("undefined" === typeof (target as Vec3)) target = allocate(); return target;',
    'if (!(typeof out !== "undefined")) out = allocate(); return out;',
  ])
    assert.deepEqual(
      codes(`function write(out: Vec3) { ${body} }`),
      ['implicit-output-fallback'],
      body,
    );
});

test('absence checks preserve same-output returns, independent statuses and unrelated explicit storage', () => {
  for (const body of [
    'if (!out) return out; return out;',
    'const alias = out; return out === undefined ? alias : out;',
    'if (!out) out = out; return out;',
    'if (typeof out === "undefined") return false; out[0] = 1; return true;',
    'if (typeof out === "undefined") return { ok: false }; out[0] = 1; return { ok: true };',
    'if (typeof out === "undefined") throw new Error("output required"); return out;',
    'let scratch = out; if (!out) scratch = out; return out;',
    'let scratch: Vec3; if (!out) scratch = allocate(); return out;',
    'const scratch = allocate(); out[0] = scratch[0]; return out;',
    'if (!out) { const later = () => { out = allocate(); }; return false; } return true;',
  ])
    assert.deepEqual(codes(`function write(out: Vec3) { ${body} }`), [], body);
});

test('named factories may allocate explicitly when they have no output parameter', () => {
  assert.deepEqual(
    codes(
      'function create(): Vec3 { return allocate(); } function clone(value: Vec3): Vec3 { return allocate(); }',
    ),
    [],
  );
  assert.ok(
    codes('function create(out?: Vec3) { return out ?? allocate(); }').includes('optional-output'),
  );
});

test('custom output records are included and primitive output-directory configuration is excluded', () => {
  assert.deepEqual(
    codes('interface Selection { shader: string } function read(out?: Selection) {}'),
    ['optional-output'],
  );
  assert.deepEqual(codes('function path(outDir = "/tmp"): string { return outDir; }'), []);
});

test('comments and source ownership cannot waive missing output storage', () => {
  assert.deepEqual(
    codes(
      '// required-output: intentional factory\nfunction read(out?: Vec3) {}',
      'packages/render/src/owned.ts',
    ),
    ['optional-output'],
  );
});

test('apps, tests and fixtures are outside the shipping implementation policy', () => {
  for (const file of [
    'apps/demo/src/main.ts',
    'packages/math/src/__tests__/case.ts',
    'packages/math/src/__fixtures__/case.ts',
  ])
    assert.deepEqual(codes('function write(out?: Vec3) {}', file), []);
});
