import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { bundleEngineArchive } from '../engine-bundle.mjs';
import { writePackageArchive } from '../sdk-lib.mjs';

const execute = promisify(execFile);
async function fixture(root, name, version, source, dependencies = {}) {
  await mkdir(root, { recursive: true });
  await writeFile(
    resolve(root, 'package.json'),
    JSON.stringify({
      name,
      version,
      type: 'module',
      exports: './index.mjs',
      dependencies,
    }),
  );
  await writeFile(resolve(root, 'index.mjs'), source);
}

test('npm and pnpm install one offline bundle with transitive and duplicate versions', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'engine-bundle-test-'));
  try {
    const stage = resolve(root, 'stage');
    const engine = resolve(stage, 'package');
    await fixture(
      engine,
      '@forgeax/engine',
      '1.2.3',
      "export { answer } from '@forgeax/engine-leaf';",
      { '@forgeax/engine-leaf': '1.2.3' },
    );
    const archive = resolve(root, 'engine.tgz');
    await writePackageArchive(stage, archive);
    const leaf = resolve(root, 'member/package');
    await fixture(
      leaf,
      '@forgeax/engine-leaf',
      '1.2.3',
      "import a from 'a'; import b from 'b'; export const answer=[a,b];",
      { a: '1.0.0', b: '1.0.0' },
    );
    await fixture(
      resolve(leaf, 'node_modules/a'),
      'a',
      '1.0.0',
      "import value from 'shared'; export default value;",
      { shared: '1.0.0' },
    );
    await fixture(
      resolve(leaf, 'node_modules/b'),
      'b',
      '1.0.0',
      "import value from 'shared'; export default value;",
      { shared: '2.0.0' },
    );
    await fixture(resolve(leaf, 'node_modules/shared'), 'shared', '1.0.0', 'export default 1;');
    await fixture(
      resolve(leaf, 'node_modules/b/node_modules/shared'),
      'shared',
      '2.0.0',
      'export default 2;',
    );
    const platformRoot = resolve(leaf, 'node_modules/foreign-platform-binary');
    await fixture(platformRoot, 'foreign-platform-binary', '1.0.0', 'export default 3;');
    const platformManifest = JSON.parse(await readFile(resolve(platformRoot, 'package.json')));
    platformManifest.os = [process.platform === 'linux' ? 'darwin' : 'linux'];
    await writeFile(resolve(platformRoot, 'package.json'), JSON.stringify(platformManifest));
    const leafManifest = JSON.parse(await readFile(resolve(leaf, 'package.json')));
    leafManifest.optionalDependencies = { 'foreign-platform-binary': '1.0.0' };
    await writeFile(resolve(leaf, 'package.json'), JSON.stringify(leafManifest));
    const memberArchive = resolve(root, 'member.tgz');
    // Source node_modules are deliberately excluded from the member archive.
    await execute('tar', [
      '--exclude=node_modules',
      '-czf',
      memberArchive,
      '-C',
      resolve(root, 'member'),
      'package',
    ]);
    await bundleEngineArchive({
      engineArchive: archive,
      members: [{ name: '@forgeax/engine-leaf', root: leaf, archive: memberArchive }],
      version: '1.2.3',
    });
    const first = await readFile(archive);
    await bundleEngineArchive({
      engineArchive: archive,
      members: [{ name: '@forgeax/engine-leaf', root: leaf, archive: memberArchive }],
      version: '1.2.3',
    });
    assert.deepEqual(await readFile(archive), first, 'repeat packaging preserves sealed bytes');
    for (const manager of ['npm', 'pnpm']) {
      const consumer = resolve(root, manager);
      await mkdir(consumer);
      await writeFile(resolve(consumer, 'package.json'), '{"private":true,"type":"module"}');
      const command =
        manager === 'npm'
          ? [
              'npm',
              ['install', archive, '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
            ]
          : [
              'corepack',
              [
                JSON.parse(
                  await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
                ).packageManager,
                'add',
                archive,
                '--offline',
                '--ignore-scripts',
              ],
            ];
      await execute(...command, {
        cwd: consumer,
        env: { ...process.env, npm_config_registry: 'http://127.0.0.1:1' },
      });
      const result = await execute(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import {answer} from '@forgeax/engine'; console.log(JSON.stringify(answer));",
        ],
        { cwd: consumer },
      );
      assert.equal(result.stdout.trim(), '[1,2]');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing required dependency blocks the tarball before publication', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'engine-bundle-missing-'));
  try {
    await fixture(resolve(root, 'stage/package'), '@forgeax/engine', '1.2.3', '');
    const archive = resolve(root, 'engine.tgz');
    await writePackageArchive(resolve(root, 'stage'), archive);
    await fixture(resolve(root, 'member'), '@forgeax/engine-leaf', '1.2.3', '', {
      'missing-bundle-proof': '1.0.0',
    });
    await assert.rejects(
      bundleEngineArchive({
        engineArchive: archive,
        members: [{ name: '@forgeax/engine-leaf', root: resolve(root, 'member') }],
        version: '1.2.3',
      }),
      /engine-bundle-dependency-missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('npm aliases occupy their import name once instead of duplicating the canonical package', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'engine-bundle-alias-'));
  try {
    await fixture(
      resolve(root, 'stage/package'),
      '@forgeax/engine',
      '1.2.3',
      "export {answer} from '@forgeax/engine-leaf';",
    );
    const leaf = resolve(root, 'member/package');
    await fixture(
      leaf,
      '@forgeax/engine-leaf',
      '1.2.3',
      "import answer from 'upstream'; export {answer};",
      { upstream: 'npm:canonical@1.0.0' },
    );
    await fixture(
      resolve(leaf, 'node_modules/upstream'),
      'canonical',
      '1.0.0',
      'export default 42;',
    );
    const memberArchive = resolve(root, 'member.tgz');
    await execute('tar', [
      '--exclude=node_modules',
      '-czf',
      memberArchive,
      '-C',
      resolve(root, 'member'),
      'package',
    ]);
    const archive = resolve(root, 'engine.tgz');
    await writePackageArchive(resolve(root, 'stage'), archive);
    await bundleEngineArchive({
      engineArchive: archive,
      members: [{ name: '@forgeax/engine-leaf', root: leaf, archive: memberArchive }],
      version: '1.2.3',
    });
    const manifest = JSON.parse(
      (await execute('tar', ['-xOf', archive, 'package/package.json'])).stdout,
    );
    assert.equal(manifest.dependencies.upstream, 'npm:canonical@1.0.0');
    assert.ok(!manifest.bundledDependencies.includes('canonical'));
    const consumer = resolve(root, 'consumer');
    await mkdir(consumer);
    await execute(
      'npm',
      ['install', archive, '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: consumer },
    );
    assert.equal(
      (
        await execute(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            "import {answer} from '@forgeax/engine'; console.log(answer)",
          ],
          { cwd: consumer },
        )
      ).stdout.trim(),
      '42',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('npm and pnpm install the exact platform dependency outside the atomic Engine bundle', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'engine-bundle-platform-'));
  let server;
  let engineManifest;
  let engineBytes;
  try {
    const native = resolve(
      root,
      'node_modules/.pnpm/native-fixture@1.0.0/node_modules/native-fixture',
    );
    await fixture(native, 'native-fixture', '1.0.0', 'export default 42;');
    const nativeManifest = JSON.parse(await readFile(resolve(native, 'package.json')));
    nativeManifest.os = [process.platform];
    nativeManifest.cpu = [process.arch];
    await writeFile(resolve(native, 'package.json'), JSON.stringify(nativeManifest));
    const nativeStage = resolve(root, 'native-stage');
    await mkdir(nativeStage);
    await execute('cp', ['-R', native, resolve(nativeStage, 'package')]);
    const nativeArchive = resolve(root, 'native.tgz');
    await writePackageArchive(nativeStage, nativeArchive);
    const bytes = await readFile(nativeArchive);
    server = createServer((request, response) => {
      if (request.url === '/native.tgz') {
        response.end(bytes);
        return;
      }
      if (request.url === '/engine.tgz') {
        response.end(engineBytes);
        return;
      }
      const engineRequest = request.url.includes('engine');
      const manifest = engineRequest ? engineManifest : nativeManifest;
      const tarball = engineRequest ? 'engine.tgz' : 'native.tgz';
      const payload = engineRequest ? engineBytes : bytes;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          name: manifest.name,
          'dist-tags': { latest: manifest.version },
          versions: {
            [manifest.version]: {
              ...manifest,
              dist: {
                tarball: `http://127.0.0.1:${server.address().port}/${tarball}`,
                integrity: `sha512-${createHash('sha512').update(payload).digest('base64')}`,
              },
            },
          },
        }),
      );
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const registry = `http://127.0.0.1:${server.address().port}`;
    const leaf = resolve(root, 'member/package');
    await fixture(
      leaf,
      '@forgeax/engine-leaf',
      '1.2.3',
      "import answer from 'native-fixture'; export {answer};",
    );
    await writeFile(
      resolve(leaf, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine-leaf',
        type: 'module',
        exports: './index.mjs',
        version: '1.2.3',
        optionalDependencies: { 'native-fixture': '^1.0.0' },
      }),
    );
    await mkdir(resolve(leaf, 'node_modules'));
    await symlink(native, resolve(leaf, 'node_modules/native-fixture'));
    const memberArchive = resolve(root, 'member.tgz');
    await execute('tar', [
      '--exclude=node_modules',
      '-czf',
      memberArchive,
      '-C',
      resolve(root, 'member'),
      'package',
    ]);
    await fixture(
      resolve(root, 'stage/package'),
      '@forgeax/engine',
      '1.2.3',
      "export {answer} from '@forgeax/engine-leaf';",
    );
    const archive = resolve(root, 'engine.tgz');
    await writePackageArchive(resolve(root, 'stage'), archive);
    const receipt = await bundleEngineArchive({
      engineArchive: archive,
      members: [{ name: '@forgeax/engine-leaf', root: leaf, archive: memberArchive }],
      version: '1.2.3',
    });
    assert.equal(receipt.registryDependencies, 1);
    const manifest = JSON.parse(
      (await execute('tar', ['-xOf', archive, 'package/package.json'])).stdout,
    );
    engineManifest = manifest;
    engineBytes = await readFile(archive);
    assert.deepEqual(manifest.optionalDependencies, { 'native-fixture': '1.0.0' });
    assert.ok(!manifest.bundledDependencies.includes('native-fixture'));
    for (const manager of ['npm', 'pnpm']) {
      const consumer = resolve(root, manager);
      await mkdir(consumer);
      await writeFile(resolve(consumer, 'package.json'), '{"private":true,"type":"module"}');
      const command =
        manager === 'npm'
          ? [
              'npm',
              [
                'install',
                '@forgeax/engine@1.2.3',
                '--ignore-scripts',
                '--install-strategy=nested',
                '--package-lock=false',
                '--no-audit',
                '--no-fund',
                '--install-strategy=linked',
                '--registry',
                registry,
              ],
            ]
          : [
              'corepack',
              [
                JSON.parse(await readFile(new URL('../../../package.json', import.meta.url)))
                  .packageManager,
                'add',
                '@forgeax/engine@1.2.3',
                '--ignore-scripts',
                '--registry',
                registry,
              ],
            ];
      await execute(...command, {
        cwd: consumer,
        env: { ...process.env, npm_config_registry: registry },
      });
      assert.equal(
        (
          await execute(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              "import {answer} from '@forgeax/engine'; console.log(answer)",
            ],
            { cwd: consumer },
          )
        ).stdout.trim(),
        '42',
      );
    }
  } finally {
    if (server) await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});

async function registryFixture(root, packages) {
  const archives = new Map();
  for (const [name, versions] of packages) {
    for (const [version, { source, dependencies = {} }] of versions) {
      const stage = resolve(root, 'registry-stage', `${name.replace('/', '+')}@${version}`);
      await fixture(resolve(stage, 'package'), name, version, source, dependencies);
      const archive = resolve(root, 'registry', `${name.replace('/', '+')}-${version}.tgz`);
      await mkdir(resolve(root, 'registry'), { recursive: true });
      await writePackageArchive(stage, archive);
      archives.set(`${name}@${version}`, {
        name,
        version,
        dependencies,
        bytes: await readFile(archive),
      });
    }
  }
  const server = createServer((request, response) => {
    const url = decodeURIComponent(request.url ?? '/');
    if (url.startsWith('/tarballs/')) {
      const item = archives.get(url.slice('/tarballs/'.length, -'.tgz'.length));
      if (item === undefined) return response.writeHead(404).end();
      return response.end(item.bytes);
    }
    const name = url.slice(1);
    const versions = [...archives.values()].filter((item) => item.name === name);
    if (versions.length === 0) return response.writeHead(404).end();
    const port = server.address().port;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        name,
        'dist-tags': { latest: versions.at(-1).version },
        versions: Object.fromEntries(
          versions.map((item) => [
            item.version,
            {
              name,
              version: item.version,
              type: 'module',
              exports: './index.mjs',
              dependencies: item.dependencies,
              dist: {
                tarball: `http://127.0.0.1:${port}/tarballs/${name}@${item.version}.tgz`,
                integrity: `sha512-${createHash('sha512').update(item.bytes).digest('base64')}`,
              },
            },
          ]),
        ),
      }),
    );
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, registry: `http://127.0.0.1:${server.address().port}` };
}

test('registry packages stay exact dependencies while Engine owners, patches and conflicts stay bundled', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'engine-bundle-registry-'));
  let server;
  try {
    const store = resolve(root, 'workspace/node_modules/.pnpm');
    const installed = async (directory, name, version, source, dependencies = {}) => {
      const path = resolve(store, directory, 'node_modules', name);
      await fixture(path, name, version, source, dependencies);
      return path;
    };
    const shared1 = await installed('shared@1.0.0', 'shared', '1.0.0', 'export default 1;');
    const shared2 = await installed('shared@2.0.0', 'shared', '2.0.0', 'export default 2;');
    const tool = await installed(
      'tool@1.0.0',
      'tool',
      '1.0.0',
      "import shared from 'shared'; export default shared * 10;",
      { shared: '1.0.0' },
    );
    await mkdir(resolve(store, 'tool@1.0.0/node_modules/tool/node_modules'), { recursive: true });
    await symlink(shared1, resolve(store, 'tool@1.0.0/node_modules/tool/node_modules/shared'));
    const patched = await installed(
      'patched@1.0.0_patch_hash=abc',
      'patched',
      '1.0.0',
      'export default 100;',
    );
    const memberSources = [
      [
        '@forgeax/engine-a',
        "import tool from 'tool'; import shared from 'shared'; import patched from 'patched'; export const a=[tool, shared, patched];",
        { tool: '1.0.0', shared: '1.0.0', patched: '1.0.0' },
        { tool, shared: shared1, patched },
      ],
      [
        '@forgeax/engine-b',
        "import shared from 'shared'; export const b=shared;",
        { shared: '2.0.0' },
        { shared: shared2 },
      ],
    ];
    const members = [];
    for (const [name, source, dependencies, links] of memberSources) {
      const directory = resolve(root, 'members', name.replace('/', '+'));
      const member = resolve(directory, 'package');
      await fixture(member, name, '1.2.3', source, dependencies);
      await mkdir(resolve(member, 'node_modules'));
      for (const [link, target] of Object.entries(links)) {
        await symlink(target, resolve(member, 'node_modules', link));
      }
      const archive = resolve(directory, 'member.tgz');
      await execute('tar', ['--exclude=node_modules', '-czf', archive, '-C', directory, 'package']);
      members.push({ name, root: member, archive });
    }
    await fixture(
      resolve(root, 'stage/package'),
      '@forgeax/engine',
      '1.2.3',
      "export {a} from '@forgeax/engine-a'; export {b} from '@forgeax/engine-b';",
      { '@forgeax/engine-a': '1.2.3', '@forgeax/engine-b': '1.2.3' },
    );
    const archive = resolve(root, 'engine.tgz');
    await writePackageArchive(resolve(root, 'stage'), archive);
    const receipt = await bundleEngineArchive({
      engineArchive: archive,
      members,
      version: '1.2.3',
    });
    const manifest = JSON.parse(
      (await execute('tar', ['-xOf', archive, 'package/package.json'])).stdout,
    );
    assert.deepEqual(manifest.dependencies, {
      '@forgeax/engine-a': '1.2.3',
      '@forgeax/engine-b': '1.2.3',
      patched: '1.0.0',
      shared: '1.0.0',
      tool: '1.0.0',
    });
    assert.deepEqual(manifest.bundledDependencies, [
      '@forgeax/engine-a',
      '@forgeax/engine-b',
      'patched',
    ]);
    assert.equal(receipt.registryDependencies, 2);
    const entries = (await execute('tar', ['-tzf', archive])).stdout.split('\n');
    assert.ok(
      entries.includes('package/node_modules/@forgeax/engine-b/node_modules/shared/package.json'),
    );
    assert.ok(!entries.some((entry) => entry.startsWith('package/node_modules/tool/')));
    assert.ok(!entries.includes('package/node_modules/shared/package.json'));
    ({ server } = await registryFixture(root, [
      ['shared', [['1.0.0', { source: 'export default 1;' }]]],
      [
        'tool',
        [
          [
            '1.0.0',
            {
              source: "import shared from 'shared'; export default shared * 10;",
              dependencies: { shared: '1.0.0' },
            },
          ],
        ],
      ],
    ]));
    const registry = `http://127.0.0.1:${server.address().port}`;
    for (const manager of ['npm', 'pnpm']) {
      const consumer = resolve(root, manager);
      await mkdir(consumer);
      await writeFile(resolve(consumer, 'package.json'), '{"private":true,"type":"module"}');
      const command =
        manager === 'npm'
          ? [
              'npm',
              [
                'install',
                archive,
                '--ignore-scripts',
                '--no-audit',
                '--no-fund',
                '--registry',
                registry,
              ],
            ]
          : [
              'corepack',
              [
                JSON.parse(await readFile(new URL('../../../package.json', import.meta.url)))
                  .packageManager,
                'add',
                archive,
                '--ignore-scripts',
                '--registry',
                registry,
              ],
            ];
      await execute(...command, {
        cwd: consumer,
        env: { ...process.env, npm_config_registry: registry },
      });
      assert.equal(
        (
          await execute(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              "import {a, b} from '@forgeax/engine'; console.log(JSON.stringify([a, b]))",
            ],
            { cwd: consumer },
          )
        ).stdout.trim(),
        '[[10,1,100],2]',
      );
    }
  } finally {
    if (server) await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
