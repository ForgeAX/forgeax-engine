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

test('compiled programs retain the native module metadata of their published ESM driver', async () => {
  const artifact = preparePackProgram({ entry: 'entry.mjs', export: 'meta', modules: {
    'entry.mjs': 'export const meta = { url: import.meta.url, resolve: import.meta.resolve };',
  } }).unwrap();
  const source = await bundlePackProgram({ program: artifact, imports: {}, bindingId: 'meta-fixture', exports: {} });
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { default: driver } = await import(url);
  assert.equal(Object.isFrozen(driver), true);
  const loaded = driver.load('entry.mjs');
  assert.equal(loaded.meta.url, url);
  assert.equal(typeof loaded.meta.resolve, 'function');
});

test('native program host loads its verified blob through the borrowed realm importer', async () => {
  const previousImport = globalThis.__fxMcpImport;
  const imported = [];
  let count = 3;
  class Constructor {}
  const nativeDefault = {};
  globalThis.__fxMcpImport = async url => {
    imported.push(url);
    const source = await (await fetch(url)).text();
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  };
  const hosts = createMcpProgramHosts(globalThis, async input => ({ source: new TextEncoder().encode(await bundlePackProgram(input)) }), async ref => ref.source);
  try {
    const host = hosts.create(imports, async () => ({ Constructor, default: nativeDefault, get counter() { return count; } }));
    const url = await host.publish(program(), imports);
    const namespace = await host.importModule(url);
    assert.deepEqual(imported, [url.split('#')[0]]);
    assert.strictEqual(namespace.Constructor, Constructor);
    assert.strictEqual(namespace.nativeDefault, nativeDefault);
    assert.deepEqual(namespace.read(), [3, 7]);
    count = 8;
    assert.deepEqual(namespace.read(), [8, 7]);
    const foreign = hosts.create(imports, async () => ({}));
    await assert.rejects(foreign.importModule(url), /outside this MCP program host/);
    assert.equal(imported.length, 1);
  } finally {
    hosts.dispose();
    if (previousImport === undefined) delete globalThis.__fxMcpImport;
    else globalThis.__fxMcpImport = previousImport;
  }
});

test('native program host reports a missing realm importer for an owned published module', async () => {
  const hosts = createMcpProgramHosts({}, async () => ({ source: new TextEncoder().encode('export default { load() { return {}; } };') }), async ref => ref.source);
  try {
    const host = hosts.create({}, async () => ({}));
    const url = await host.publish(preparePackProgram({ entry: 'entry.mjs', export: 'default', modules: { 'entry.mjs': 'export default 1;' } }).unwrap(), {});
    await assert.rejects(host.importModule(url), /MCP native module loader is unavailable/);
  } finally { hosts.dispose(); }
});

test('retiring a program host prevents a pending native import from executing its entry', async () => {
  let finishImport;
  let executions = 0;
  const realm = { __fxMcpImport: () => new Promise(resolve => { finishImport = resolve; }) };
  const hosts = createMcpProgramHosts(realm, async () => ({ source: new TextEncoder().encode('export default {};') }), async ref => ref.source);
  try {
    const host = hosts.create({}, async () => ({}));
    const url = await host.publish(preparePackProgram({ entry: 'entry.mjs', export: 'default', modules: { 'entry.mjs': 'export default 1;' } }).unwrap(), {});
    const importing = host.importModule(url);
    const rejected = assert.rejects(importing, /retired/);
    hosts.dispose();
    finishImport({ default: { load() { executions++; return {}; } } });
    await rejected;
    assert.equal(executions, 0);
  } finally { hosts.dispose(); }
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
