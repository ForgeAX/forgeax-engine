import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { discoverPluginAssets } from '@forgeax/engine-devkit/plugin-build';
import { createServer } from 'vite';

const mode = 'dev';
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
  const main = ['one']
    .map(
      (namespace) =>
        `import { createPrograms as ${namespace} } from 'virtual:forgeax/plugin-programs/${namespace}/engine'; globalThis.${namespace} = ${namespace}('session', '${namespace}', 1);`,
    )
    .join('\n');
  await writeFile(resolve(host, 'index.html'), '<script type="module" src="/main.js"></script>');
  await writeFile(resolve(host, 'main.js'), main);
  const configFile = resolve(host, 'vite.config.mjs');
  await writeFile(
    configFile,
    `
    import { discoverPluginAssets, executionWorkerEntries, pluginProgramsBuild, pluginRuntimeProjection } from ${JSON.stringify(import.meta.resolve('@forgeax/engine-devkit/plugin-build'))};
    import { pluginPack, reloadAssetHost } from ${JSON.stringify(import.meta.resolve('@forgeax/engine-vite-plugin-pack'))};
    import { createStandaloneRuntimeAssetBinding } from ${JSON.stringify(import.meta.resolve('@forgeax/engine-types'))};
    export default async () => {
      const facts={root:${JSON.stringify(content)},assetRoots:['behavior.pack.json']};
      const inventory=await discoverPluginAssets(facts);
      const binding=createStandaloneRuntimeAssetBinding('host');
      const pack=pluginPack({runtimeBinding:binding,roots:[${JSON.stringify(resolve(content, 'behavior.pack.json'))}],refresh:reloadAssetHost()});
      return {root:${JSON.stringify(host)},logLevel:'silent',optimizeDeps:{noDiscovery:true,include:[]},plugins:[executionWorkerEntries([]),pack,pluginRuntimeProjection(facts.root,inventory.sourceInputs),pluginProgramsBuild({namespace:'one',projectRoot:facts.root,roots:{engine:${JSON.stringify(guid)}},tools:[],inventory:()=>discoverPluginAssets(facts),binding,pack})],server:{host:'127.0.0.1',port:0,watch:process.platform==='darwin'?{usePolling:true,interval:100}:undefined,fs:{allow:${JSON.stringify([root, packages])}}}};
    };
  `,
  );
  const config = {
    root: host,
    configFile,
    plugins: [
      {
        name: 'fixture-current-server',
        configureServer(current) {
          // Watcher callbacks belong to the replacement server after a restart.
          // Observe that public generation rather than wrapping a retired facade.
          server = current;
        },
      },
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
  server = await createServer({
    ...config,
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, packages] } },
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  const response = await fetch(new URL('main.js?import', origin));
  assert.equal(response.status, 200);
  const mainSource = (await server.environments.client.transformRequest('/main.js')).code;
  const urls = [
    ...mainSource.matchAll(/from\s+"([^"]*virtual:forgeax\/plugin-programs\/[^"]+)"/g),
  ].map((match) => match[1]);
  assert.equal(urls.length, 1, mainSource);
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
  const oldUrl = new URL(urls[0], origin);
  const first = await (await fetch(oldUrl)).text();
  const behaviorPath = resolve(content, 'behavior.js');
  const behaviorSource =
    "import { Transform } from '@forgeax/engine-scene'; export default { apply(ctx) { ctx.probe = Transform; } };";
  function observeRestart() {
    let done;
    const completed = new Promise((resolve) => {
      done = resolve;
    });
    const restart = server.restart.bind(server);
    server.restart = async (...args) => {
      try {
        return await restart(...args);
      } finally {
        done();
      }
    };
    return completed;
  }
  async function waitForRestart(completed, timeout = 15000) {
    let timer;
    try {
      await Promise.race([
        completed,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('candidate restart was not observed')),
            timeout,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const failedRestart = observeRestart();
  await writeFile(behaviorPath, 'export default BROKEN CANDIDATE');
  await waitForRestart(failedRestart);
  assert.equal(
    (await fetch(oldUrl)).status,
    200,
    'failed candidate must retain the accepted session',
  );
  assert.equal(
    await (await fetch(oldUrl)).text(),
    first,
    'failed candidate must retain frozen program bytes',
  );
  process.stderr.write('[plugin-program-reimport] failed candidate retained\n');
  // Repair the same closure before the ordinary Pack publication below.
  const repairedRestart = observeRestart();
  await writeFile(behaviorPath, behaviorSource);
  await waitForRestart(repairedRestart);
  const repairedMain = (await server.environments.client.transformRequest('/main.js')).code;
  const repairedUrl = [
    ...repairedMain.matchAll(/from\s+"([^"]*virtual:forgeax\/plugin-programs\/[^"]+)"/g),
  ][0]?.[1];
  assert.ok(repairedUrl);
  const repairedProgram = await (await fetch(new URL(repairedUrl, origin))).text();
  process.stderr.write('[plugin-program-reimport] repaired generation published\n');
  const sourcePath = resolve(content, 'behavior.pack.json');
  const publicationRestart = observeRestart();
  const deadline = Date.now() + 15000;
  await writeFile(
    sourcePath,
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: '01900000-0000-7000-8000-000000000883',
      assets: {
        main: {
          kind: 'plugin',
          payload: { module: { specifier: './behavior.js' }, config: { mass: 5 } },
        },
      },
    }),
  );
  await waitForRestart(publicationRestart, Math.max(1, deadline - Date.now()));
  let nextUrl;
  while (Date.now() < deadline) {
    try {
      const fresh = (await server.environments.client.transformRequest('/main.js')).code;
      nextUrl = [
        ...fresh.matchAll(/from\s+"([^"]*virtual:forgeax\/plugin-programs\/[^"]+)"/g),
      ][0]?.[1];
      if (nextUrl && nextUrl !== repairedUrl) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.notEqual(
    nextUrl,
    repairedUrl,
    'a changed executable publication must acquire a new Host session',
  );
  assert.equal((await fetch(oldUrl)).status, 410, 'old executable session must retire');
  assert.equal(
    (await fetch(new URL(repairedUrl, origin))).status,
    410,
    'repaired session must retire after the next publication',
  );
  const replacement = await fetch(new URL(nextUrl, origin));
  assert.equal(replacement.status, 200);
  const replacementSource = await replacement.text();
  assert.notEqual(
    replacementSource,
    repairedProgram,
    'replacement program inventory must carry current accepted publication',
  );
  assert.match(
    replacementSource,
    /"mass"\s*:\s*5/,
    'replacement must contain the current authored configuration',
  );
  process.stderr.write('[plugin-program-reimport] mass publication replaced generation\n');
  const imports = await fetch(new URL('/@id/__x00__virtual:forgeax/pack-program-imports', origin));
  assert.equal(imports.status, 200);
  assert.ok((await imports.text()).includes(identity));
  process.stdout.write(
    `${JSON.stringify({ mode, namespaces: 1, failedCandidateRetained: true, retiredSession: true, identity })}\n`,
  );
} finally {
  await server?.close();
  process.stderr.write('[plugin-program-reimport] current server closed\n');
  await rm(root, { recursive: true, force: true });
}
