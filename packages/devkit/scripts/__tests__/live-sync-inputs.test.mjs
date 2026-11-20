import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createLiveSyncProjectDirectory, prepareLiveSyncSharedInputs } from '../live-sync-inputs.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-live-sync-inputs-'));
  const sourceRoot = join(root, 'engine');
  const projectRoot = join(root, 'temporary-project');
  const payload = 'shared-app-inputs/shaders/manifest.json';
  const catalog = 'shared-app-inputs/assets/catalog.json';
  const manifestPath = join(sourceRoot, 'shared-app-inputs/manifest.json');
  const wrapper = {
    schemaVersion: 1,
    producer: 'shared-app-inputs',
    inputFingerprint: 'sha256:retained-inputs',
    inventory: [catalog, payload],
    payload: { engineShaderManifest: payload, assetCatalog: catalog },
  };
  for (const [path, bytes] of [[payload, '{"publication":"sealed"}'], [catalog, '{"assets":[]}']]) {
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
    await writeFile(join(sourceRoot, path), bytes);
  }
  await writeFile(manifestPath, JSON.stringify(wrapper));
  try {
    await run({sourceRoot, projectRoot, manifestPath, wrapper, payload, catalog});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

test('temporary live project consumes the exact declared shared publication tree', async () => {
  await fixture(async ({sourceRoot, projectRoot, manifestPath, wrapper, payload, catalog}) => {
    const prepared = await prepareLiveSyncSharedInputs({sourceRoot, projectRoot, manifestPath});
    assert.deepEqual(await readFile(prepared), await readFile(manifestPath));
    assert.deepEqual(JSON.parse(await readFile(prepared)), wrapper);
    for (const path of [payload, catalog])
      assert.deepEqual(await readFile(join(projectRoot, path)), await readFile(join(sourceRoot, path)));
  });
});

test('temporary project refuses a declared missing publication payload', async () => {
  await fixture(async ({sourceRoot, projectRoot, manifestPath, payload}) => {
    await rm(join(sourceRoot, payload));
    await assert.rejects(prepareLiveSyncSharedInputs({sourceRoot, projectRoot, manifestPath}), {code: 'ENOENT'});
  });
});

test('temporary project refuses a payload outside the declared inventory', async () => {
  await fixture(async ({sourceRoot, projectRoot, manifestPath, wrapper}) => {
    await writeFile(manifestPath, JSON.stringify({...wrapper, inventory: []}));
    await assert.rejects(prepareLiveSyncSharedInputs({sourceRoot, projectRoot, manifestPath}), /inventory/);
  });
});

test('temporary project refuses inventory paths outside the two explicit roots', async () => {
  await fixture(async ({sourceRoot, projectRoot, manifestPath, wrapper}) => {
    await writeFile(manifestPath, JSON.stringify({...wrapper, inventory: [...wrapper.inventory, '../outside.json']}));
    await assert.rejects(prepareLiveSyncSharedInputs({sourceRoot, projectRoot, manifestPath}), /outside/);
  });
});

test('temporary project retains schema2 provenance and its declared payload inventory', async () => {
  await fixture(async ({sourceRoot, projectRoot, manifestPath, wrapper}) => {
    const path = 'shared-app-inputs/compiler/compiler.wasm';
    await mkdir(dirname(join(sourceRoot, path)), {recursive:true});
    await writeFile(join(sourceRoot, path), new Uint8Array([0, 97, 115, 109]));
    const producer = {...wrapper, schemaVersion:2, producer:'repo-build-inputs', shaderBuild:{inputFingerprint:'sha256:accepted',outputFingerprint:'sha256:sealed'}, payloadInventory:[path]};
    await writeFile(manifestPath, JSON.stringify(producer));
    const prepared=await prepareLiveSyncSharedInputs({sourceRoot,projectRoot,manifestPath});
    assert.deepEqual(await readFile(prepared), await readFile(manifestPath));
    assert.deepEqual(await readFile(join(projectRoot,path)), await readFile(join(sourceRoot,path)));
  });
});

test('live-sync adapter prepares the selected publication before starting its child', async () => {
  const source=await readFile(new URL('../check-live-sync.mjs',import.meta.url),'utf8');
  assert.match(source,/FORGEAX_SHARED_APP_INPUTS_MANIFEST: await prepareLiveSyncSharedInputs\(/);
  const prepare=source.indexOf('FORGEAX_SHARED_APP_INPUTS_MANIFEST: await prepareLiveSyncSharedInputs(');
  const start=source.indexOf("command('start'");
  assert.ok(start>prepare, 'preparation must precede the real CLI startup');
  assert.match(source,/sourceRoot: fileURLToPath\(new URL\('\.\.\/\.\.\/\.\.\/', import.meta.url\)\)/);
});

test('formal parent-relative publication keeps exact bytes inside its disposable owner', async () => {
  await fixture(async ({sourceRoot, wrapper}) => {
    const payload = '../formal/shaders/manifest.json';
    const manifestPath = join(sourceRoot, '../formal/manifest.json');
    await mkdir(dirname(manifestPath), {recursive:true});
    await mkdir(dirname(join(sourceRoot,payload)), {recursive:true});
    await writeFile(join(sourceRoot,payload), '{"sealed":"external"}');
    await writeFile(manifestPath, JSON.stringify({...wrapper,schemaVersion:2,producer:'repo-build-inputs',inventory:[payload],payload:{engineShaderManifest:payload}}));
    const {root,temporaryRoot} = await createLiveSyncProjectDirectory('forgeax-external-inputs-',sourceRoot,manifestPath);
    try {
      assert.equal(temporaryRoot, await realpath(temporaryRoot));
      assert.equal(root, await realpath(root));
      const selected=await prepareLiveSyncSharedInputs({sourceRoot,projectRoot:root,temporaryRoot,manifestPath});
      assert.deepEqual(await readFile(selected),await readFile(manifestPath));
      assert.deepEqual(await readFile(join(root,payload)),await readFile(join(sourceRoot,payload)));
      assert.ok(selected.startsWith(temporaryRoot));
      await assert.rejects(prepareLiveSyncSharedInputs({sourceRoot,projectRoot:root,manifestPath}),/outside/);
    } finally {await rm(temporaryRoot,{recursive:true,force:true});}
  });
});
