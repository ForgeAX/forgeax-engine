import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preparePackProgram } from '@forgeax/engine/pack/runtime';
import { bundlePackProgram } from '../../src/app/program-bundler.mjs';
import { PROGRAM_IMPORTS_SLOT } from '../../src/contract.ts';
import { createMcpProgramHosts } from '../../src/app/program-host.ts';

const imports = { 'engine-fixture': { identity: 'executing-engine', url: 'https://native.invalid/engine.mjs' } };
function program() {
  return preparePackProgram({ entry: 'entry.mjs', export: 'read', imports: { 'engine-fixture': 'executing-engine' }, modules: {
    'entry.mjs': `import nativeDefault, { Constructor, counter } from 'engine-fixture'; import { helper } from './cycle.mjs'; export { Constructor, nativeDefault }; export { counter } from 'engine-fixture'; export function read() { return [counter, helper()]; } let current = 0; export function next() { return ++current; } export function value() { return 7; }`,
    'other.mjs': `export { next } from './entry.mjs';`,
    'unused.mjs': `throw new Error('unused module executed'); export const result = 1;`,
    'cycle.mjs': `import { value } from './entry.mjs'; export function helper() { return value(); }`,
  } }).unwrap();
}
test('native Pack graph preserves cycles, constructor identity, default export and live Engine reads', async () => {
  let count = 1;
  class Constructor {}
  const nativeDefault = {};
  const namespace = { Constructor, default: nativeDefault, get counter() { return count; } };
  const key = Symbol.for(PROGRAM_IMPORTS_SLOT);
  globalThis[key] = new Map([['fixture', new Map([['engine-fixture', namespace]])]]);
  try {
    const source = await bundlePackProgram({ program: program(), imports, bindingId: 'fixture', exports: { 'engine-fixture': Object.keys(namespace) } });
    const driver = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
    const loaded = driver.load('entry.mjs');
    assert.strictEqual(loaded.Constructor, Constructor);
    assert.strictEqual(loaded.nativeDefault, nativeDefault);
    assert.deepEqual(loaded.read(), [1, 7]);
    count = 9;
    assert.deepEqual(loaded.read(), [9, 7]);
    assert.equal(loaded.counter, 9);
    assert.equal(loaded.next(), 1);
    assert.equal(driver.load('other.mjs').next(), 2);
    assert.throws(() => driver.load('unused.mjs'), /unused module executed/);
  } finally { delete globalThis[key]; }
});

test('program compiler rejects changed bytes, foreign import identities and oversized input', async () => {
  const input = { program: program(), imports, bindingId: 'fixture', exports: { 'engine-fixture': ['Constructor', 'counter', 'default'] } };
  await assert.rejects(bundlePackProgram({ ...input, program: { ...input.program, modules: { 'entry.mjs': 'export const read = 1;' } } }));
  await assert.rejects(bundlePackProgram({ ...input, imports: { 'engine-fixture': { ...imports['engine-fixture'], identity: 'other-engine' } } }));
  await assert.rejects(bundlePackProgram({ ...input, padding: 'x'.repeat(4 * 1024 * 1024) }), /byte bound/);
});

test('native program host borrows only its own Engine imports and retires namespace and URL leases', async () => {
  const realm = {};
  const calls = [];
  const hosts = createMcpProgramHosts(realm, async input => {
    calls.push(input);
    return { source: new TextEncoder().encode('export const read = 1;') };
  }, async ref => ref.source);
  const host = hosts.create(imports, async () => ({ Constructor: class {}, counter: 1, default: {} }));
  try {
    await assert.rejects(host.publish(program(), { 'engine-fixture': { ...imports['engine-fixture'], url: 'https://other.invalid/' } }), /executing Engine/);
    assert.equal(calls.length, 0);
    const url = await host.publish(program(), imports);
    const original = program();
    const other = preparePackProgram({ modules: original.modules, imports: original.imports, entry: 'other.mjs', export: 'next' }).unwrap();
    const otherUrl = await host.publish(other, imports);
    assert.equal(otherUrl.split('#')[0], url.split('#')[0]);
    assert.notEqual(otherUrl, url);
    const foreign = hosts.create(imports, async () => ({}));
    await assert.rejects(foreign.importModule(url), /outside this MCP program host/);
    assert.equal(await (await fetch(url)).text(), 'export const read = 1;');
    assert.equal(calls.length, 1);
    assert.equal(realm[Symbol.for(PROGRAM_IMPORTS_SLOT)].size, 2);
    hosts.dispose();
    assert.equal(realm[Symbol.for(PROGRAM_IMPORTS_SLOT)], undefined);
    await assert.rejects(fetch(url));
    await assert.rejects(host.publish(program(), imports), /retired/);
  } finally { hosts.dispose(); }
});
