import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../../..');

async function source(path) {
  return readFile(resolve(root, path), 'utf8');
}

test('SDK distribution has one final template collection', async () => {
  const sdkLib = await source('scripts/forgeax/sdk-lib.mjs');
  assert.match(sdkLib, /discoverSdkTemplates/);
  assert.doesNotMatch(sdkLib, /SDK_TEMPLATES\s*=\s*Object\.freeze\(\[\s*Object\.freeze/);
  assert.doesNotMatch(sdkLib, /templates\/game-empty/);
  assert.doesNotMatch(sdkLib, /templates\/game-default/);
});

test('npm consumer iterates the discovered template collection', async () => {
  const publisher = await source('scripts/forgeax/publish-sdk-npm.mjs');
  assert.match(publisher, /SDK_TEMPLATES/);
  assert.doesNotMatch(publisher, /\['empty',\s*'game-3d'\]/);
});

test('ZIP and npm carrier retain distinct offline store contracts', async () => {
  const builder = await source('scripts/forgeax/build-sdk.mjs');
  assert.match(builder, /sdkCarrier/);
  assert.match(builder, /filter: \(source\) => source !== resolve\(stage, 'store'\)/);
  assert.match(builder, /templates: SDK_TEMPLATES\.map/);
  assert.match(builder, /\['packages\/preview\/scripts\/build-canonical-kit\.mjs'\]/);
  assert.match(builder, /FORGEAX_CANONICAL_KIT_OUTPUT: canonicalKitRoot/);
  assert.match(
    builder,
    /canonicalKitPackageRoot = resolve\(root, 'packages\/preview\/assets\/canonical-kit'\)/,
  );
  assert.doesNotMatch(
    builder,
    /forgeax-engine-assets\/demo-assets\/template-game-default\/sky\.hdr/,
  );
});

test('archive verifier checks the final template and source closures', async () => {
  const verifier = await source('scripts/forgeax/verify-sdk.mjs');
  assert.match(verifier, /templates\/empty\/forge\.json/);
  assert.match(verifier, /templates\/game-3d\/README\.md/);
  assert.match(verifier, /verifySourceTemplate/);
  assert.match(verifier, /sdk-unmanifested-artifact/);
});

test('npm consumer uses the built carrier from an isolated temporary project', async () => {
  const consumer = await source('scripts/forgeax/check-sdk-npm-consumer.mjs');
  assert.match(consumer, /npm_config_registry: registryUrl/);
  assert.match(consumer, /'--install-strategy=linked'/);
  assert.match(consumer, /sdkInstall: \{ version: installedSdkManifest\.sdkVersion/);
  assert.match(consumer, /finally \{/);
});
