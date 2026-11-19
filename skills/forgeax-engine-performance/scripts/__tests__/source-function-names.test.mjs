import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createSourceFunctionNameResolver } from '../source_function_names.mjs';

const ts = createRequire(import.meta.url)('typescript');
const resolve = createSourceFunctionNameResolver(ts);
const at = (text, marker, file = 'fixture.ts') => {
  const offset = text.indexOf(marker);
  assert(offset >= 0);
  const prefix = text.slice(0, offset).split('\n');
  return resolve({ text, file, line: prefix.length, column: prefix.at(-1).length + 1 });
};

test('recovers declared function, method, constructor and accessor names from original coordinates', () => {
  const text =
    'function drawFrame() { return 1; }\nclass Renderer { constructor() { this.init(); } record() { return 2; } get ready() { return true; } }';
  assert.equal(at(text, 'return 1'), 'drawFrame');
  assert.equal(at(text, 'this.init'), 'Renderer.constructor');
  assert.equal(at(text, 'return 2'), 'Renderer.record');
  assert.equal(at(text, 'return true'), 'get Renderer.ready');
});

test('preserves iterator ownership instead of mistaking a class-named V8 frame for its constructor', () => {
  const text = 'class Query { constructor() { this.x = 1; } *[Symbol.iterator]() { yield 2; } }';
  assert.equal(at(text, 'yield 2'), 'Query.[Symbol.iterator]');
  assert.equal(at(text, 'this.x'), 'Query.constructor');
});

test('names explicit arrow bindings but keeps anonymous nested callbacks anonymous', () => {
  const text =
    'const receive = (x: number) => { return x; }; function outer() { return [1].map(x => x + 1); }';
  assert.equal(at(text, 'receive'), 'receive');
  assert.equal(at(text, 'return x'), 'receive');
  assert.equal(at(text, 'x + 1'), null);
});

test('rejects unsupported text/coordinates and invalidates a same-file cache after content changes', () => {
  assert.equal(at('function first() { return 3; }', 'return'), 'first');
  assert.equal(at('function second() { return 4; }', 'return'), 'second');
  assert.equal(at('function broken( { return 5;', 'return'), null);
  assert.equal(resolve({ file: 'fixture.ts', text: 'const x = 1;', line: 10, column: 1 }), null);
  assert.equal(at('const x = 1;', 'x'), null);
});

test('uses declared system names for generic fn callbacks without guessing imported or shadowed constants', () => {
  const text = `const ENCODE = 'render-view-graph-encode';
function install() { defineSystem({ name: ENCODE, fn: () => { encode(); } }); }
defineSystem({ name: 'physics-step', fn() { step(); } });`;
  assert.equal(at(text, 'encode();'), 'render-view-graph-encode');
  assert.equal(at(text, 'step();'), 'physics-step');
  assert.equal(
    at(
      "import { NAME } from './other'; defineSystem({ name: NAME, fn: () => unknown() });",
      'unknown()',
    ),
    'fn',
  );
  assert.equal(
    at(
      "const NAME = 'outer'; function install(NAME) { defineSystem({ name: NAME, fn: () => shadowed() }); }",
      'shadowed()',
    ),
    'fn',
  );
  assert.equal(
    at("other({ name: 'not-a-system', fn: () => otherCallback() });", 'otherCallback()'),
    'fn',
  );
});
