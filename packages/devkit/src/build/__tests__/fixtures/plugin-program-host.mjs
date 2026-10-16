import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  discoverPluginAssets,
  executionWorkerEntries,
  pluginProgramsBuild,
  pluginRuntimeProjection,
} from '@forgeax/engine-devkit/plugin-build';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { build, createServer } from 'vite';

const mode = process.argv[2];
const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-plugin-host-')));
const host = resolve(root, 'host');
const content = resolve(root, 'content');
const packages = resolve(import.meta.dirname, '../../../../..');
let server;
try {
  await mkdir(resolve(host, 'node_modules/@forgeax'), { recursive: true });
  await mkdir(resolve(content, 'node_modules/@forgeax'), { recursive: true });
  await symlink(resolve(packages, 'engine'), resolve(host, 'node_modules/@forgeax/engine'), 'dir');
  await symlink(
    resolve(packages, 'scene'),
    resolve(content, 'node_modules/@forgeax/engine-scene'),
    'dir',
  );
  await writeFile(
    resolve(host, 'package.json'),
    '{"name":"fixture-host","type":"module","dependencies":{"@forgeax/engine":"0.0.0"}}',
  );
  await writeFile(
    resolve(content, 'package.json'),
    '{"name":"fixture-content","type":"module","dependencies":{"@forgeax/engine-scene":"0.0.0"}}',
  );
  assert.throws(() =>
    createRequire(resolve(content, 'package.json')).resolve('@forgeax/engine/package.json'),
  );
  await writeFile(
    resolve(content, 'behavior.js'),
    "import { Transform } from '@forgeax/engine-scene'; export default { apply(ctx) { ctx.probe = Transform; } };",
  );
  await writeFile(
    resolve(content, 'behavior.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: '01900000-0000-7000-8000-000000000883',
      assets: { main: { kind: 'plugin', payload: { module: { specifier: './behavior.js' } } } },
    }),
  );
  const inventory = await discoverPluginAssets({
    root: content,
    assetRoots: ['behavior.pack.json'],
  });
  const guid = [...inventory.assets.keys()][0];
  assert.ok(guid);
  const main = ['one', 'two']
    .map(
      (namespace) =>
        `import { createPrograms as ${namespace} } from 'virtual:forgeax/plugin-programs/${namespace}/engine'; globalThis.${namespace} = ${namespace}('session', '${namespace}', 1);`,
    )
    .join('\n');
  await writeFile(resolve(host, 'index.html'), '<script type="module" src="/main.js"></script>');
  await writeFile(resolve(host, 'main.js'), main);
  const config = {
    root: host,
    configFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      executionWorkerEntries([]),
      pluginRuntimeProjection(content, inventory.sourceInputs),
      ...['one', 'two'].map((namespace) =>
        pluginProgramsBuild({
          namespace,
          projectRoot: content,
          roots: { engine: guid },
          tools: [],
          inventory: async () => inventory,
          binding: createStandaloneRuntimeAssetBinding('host'),
          pack: {
            ready: async () => {},
            catalogSnapshot: () => [
              {
                guid,
                publication: { generation: 1, digest: 'fixture', outputSetDigest: 'fixture' },
              },
            ],
          },
        }),
      ),
    ],
  };
  let identity;
  function checkArchive(source) {
    const archive = JSON.parse(source);
    assert.equal(archive.error, undefined);
    const programs = Object.values(archive.programs);
    assert.equal(programs.length, 1);
    const current = programs[0].imports['@forgeax/engine-scene'];
    assert.match(current, /^sha256:[0-9a-f]{64}$/);
    if (identity) assert.equal(current, identity);
    identity = current;
  }
  if (mode === 'dev') {
    server = await createServer({
      ...config,
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, packages] } },
    });
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    const response = await fetch(new URL('main.js', origin));
    assert.equal(response.status, 200);
    const urls = [
      ...(await response.text()).matchAll(
        /from\s+"([^"]*virtual:forgeax\/plugin-programs\/[^"]+)"/g,
      ),
    ].map((match) => match[1]);
    assert.equal(urls.length, 2);
    for (const [index, url] of urls.entries()) {
      const moduleUrl = new URL(url, origin);
      const table = await fetch(moduleUrl);
      assert.equal(table.status, 200);
      assert.match(await table.text(), /createPrograms/);
      moduleUrl.pathname += `.programs-${index === 0 ? 'one' : 'two'}.json`;
      const archive = await fetch(moduleUrl);
      assert.equal(archive.status, 200);
      checkArchive(await archive.text());
    }
    const imports = await fetch(
      new URL('/@id/__x00__virtual:forgeax/pack-program-imports', origin),
    );
    assert.equal(imports.status, 200);
    assert.ok((await imports.text()).includes(identity));
  } else {
    assert.equal(mode, 'build');
    const output = await build({
      ...config,
      build: { write: false, minify: false, target: 'esnext' },
    });
    const archives = output.output.filter((item) =>
      /\.programs-(one|two)\.json$/.test(item.fileName),
    );
    assert.equal(archives.length, 2);
    for (const archive of archives) {
      assert.equal(archive.type, 'asset');
      checkArchive(String(archive.source));
    }
    assert.ok(output.output.some((item) => item.type === 'chunk' && item.code.includes(identity)));
  }
  process.stdout.write(`${JSON.stringify({ mode, namespaces: 2, identity })}\n`);
} finally {
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
