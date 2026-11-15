import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const path = new URL(
  '../../../packages/render/src/transmission/__tests__/standard-transmission.dawn.test.ts',
  import.meta.url,
);
const source = ts.createSourceFile(
  path.pathname,
  readFileSync(path, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const declaration = source.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'selectTransmissionProfile',
);
const factory = source.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'createTransmissionHost',
);
assert.ok(declaration, 'the real native fixture owns profile selection');
assert.ok(factory, 'the real native fixture owns initial installation state');
const javascript = ts.transpileModule(
  `${factory.getText(source)}\n${declaration.getText(source)}`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  },
).outputText;

async function host(renderPath) {
  const installed = [];
  const renderer = {
    setProfile(profile) {
      installed.push(profile.renderPath);
      return { ok: true };
    },
  };
  // CPU policy evidence executes both real fixture functions; native acceptance
  // remains in the unchanged Dawn commands.
  const gpu = { requestAdapter: async () => ({ requestDevice: async () => ({}) }) };
  const fixture = runInNewContext(
    `${javascript}\n({ createTransmissionHost, selectTransmissionProfile })`,
    {
      DEFAULT_STANDARD_PROFILE: { renderPath: 'forward', ssao: true },
      navigator: { gpu },
      nativeDeviceRequests: 0,
      WIDTH: 32,
      HEIGHT: 32,
      ENGINE_MANIFEST_URL: 'fixture://shader-manifest',
      DAWN_BACKEND: {},
      expect: (value) => ({ toBe: (expected) => assert.equal(value, expected) }),
      constructRendererHost: async () => {
        const adapter = await gpu.requestAdapter();
        await adapter.requestDevice();
        return { ok: true, value: { renderer } };
      },
    },
  );
  return {
    ...(await fixture.createTransmissionHost({ renderPath })),
    installed,
    select: fixture.selectTransmissionProfile,
  };
}

test('same-path parameter samples retain the explicitly installed native host configuration', async () => {
  const fixture = await host();
  for (const path of [undefined, 'forward', undefined, 'forward']) fixture.select(fixture, path);
  assert.deepEqual(fixture.installed, ['forward']);
  assert.equal(fixture.renderPath, 'forward');
});

test('both Standard paths and the default transition still install their actual profiles', async () => {
  const fixture = await host();
  for (const path of ['deferred', 'deferred', undefined, 'forward', 'deferred'])
    fixture.select(fixture, path);
  assert.deepEqual(fixture.installed, ['deferred', 'forward', 'deferred']);
  assert.equal(fixture.renderPath, 'deferred');
});

test('the first deferred sample explicitly installs before subsequent reuse and a real switch', async () => {
  const fixture = await host('deferred');
  fixture.select(fixture, 'deferred');
  fixture.select(fixture, 'deferred');
  assert.deepEqual(fixture.installed, ['deferred']);
  fixture.select(fixture, undefined);
  assert.deepEqual(fixture.installed, ['deferred', 'forward']);
  assert.equal(fixture.renderPath, 'forward');
});

test('a failed profile installation preserves the last accepted path and retries the transition', async () => {
  const fixture = await host();
  fixture.select(fixture, 'forward');
  fixture.installed.length = 0;
  const failure = new Error('profile rejected');
  fixture.renderer.setProfile = () => ({ ok: false, error: failure });
  assert.throws(
    () => fixture.select(fixture, 'deferred'),
    (error) => error === failure,
  );
  assert.equal(fixture.renderPath, 'forward');
  fixture.renderer.setProfile = (profile) => {
    fixture.installed.push(profile.renderPath);
    return { ok: true };
  };
  fixture.select(fixture, 'deferred');
  assert.deepEqual(fixture.installed, ['deferred']);
  assert.equal(fixture.renderPath, 'deferred');
});

test('a failed initial installation remains uninstalled until the original path succeeds', async () => {
  const fixture = await host();
  const failure = new Error('initial profile rejected');
  fixture.renderer.setProfile = () => ({ ok: false, error: failure });
  assert.throws(
    () => fixture.select(fixture, undefined),
    (error) => error === failure,
  );
  assert.equal(fixture.renderPath, undefined);
  fixture.renderer.setProfile = (profile) => {
    fixture.installed.push(profile.renderPath);
    return { ok: true };
  };
  fixture.select(fixture, undefined);
  fixture.select(fixture, 'forward');
  assert.deepEqual(fixture.installed, ['forward']);
  assert.equal(fixture.renderPath, 'forward');
});
