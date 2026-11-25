import { execFile as execute, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { checkEngineAuthoringPackageSize } from './engine-authoring-package.mjs';
import { exportRepository, repositoryProducerDigest } from './export-repository.mjs';
import { assertChannelAdvance, releasePolicy } from './release-policy.mjs';
import {
  assertMirrorPreflight,
  assertMirrorTarget,
  MIRROR_PREFLIGHT_CHECKS,
  mirrorApi,
  publishExport,
  verifyExport,
  verifyExportFiles,
  verifyMirrorTransport,
} from './repository-mirror.mjs';
import { streamFile, waitForNpmPublications } from './sdk-lib.mjs';

const execFile = promisify(execute);
const name = '@forgeax/engine';
const registry = 'https://registry.npmjs.org';
const namePath = `/${encodeURIComponent(name)}`;
const sha = (algorithm, bytes, encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);

async function packageArchive(directory, version, source) {
  if (
    releasePolicy(version).channel !== 'next' ||
    !/^[0-9a-f]{40}$/.test(source) ||
    !version.endsWith(`.${source.slice(0, 12)}`)
  )
    throw new Error('engine-release-source-version-mismatch');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.tgz'));
  const file = `forgeax-engine-${version}.tgz`;
  if (files.length !== 1 || files[0] !== file)
    throw new Error('engine-release-single-tarball-required');
  const archive = resolve(directory, file);
  const bytes = await readFile(archive);
  const sha256 = sha('sha256', bytes);
  checkEngineAuthoringPackageSize(bytes.length);
  const readMember = async (path) => (await execFile('tar', ['-xOzf', archive, path])).stdout;
  const manifest = JSON.parse(await readMember('package/package.json'));
  const authoring = JSON.parse(await readMember('package/authoring/engine-authoring.json'));
  const receipt = JSON.parse(await readFile(resolve(directory, 'engine-package.json'), 'utf8'));
  if (
    manifest.name !== name ||
    manifest.version !== version ||
    authoring.engineCommit !== source ||
    authoring.sdkVersion !== version ||
    receipt.ok !== true ||
    receipt.package !== name ||
    receipt.version !== version ||
    receipt.engineCommit !== source ||
    receipt.bytes !== bytes.length ||
    receipt.sha256 !== sha256
  )
    throw new Error('engine-release-producer-identity-mismatch');
  if (
    authoring.skills.some(({ id }) => id === 'forgeax-engine-sdk') ||
    (await execFile('tar', ['-tzf', archive], { maxBuffer: 16 * 1024 * 1024 })).stdout.includes(
      '/forgeax-engine-sdk/',
    )
  )
    throw new Error('engine-release-legacy-skill-in-package');
  return {
    archive,
    manifest,
    name,
    version,
    source,
    bytes: bytes.length,
    sha256,
    integrity: `sha512-${sha('sha512', bytes, 'base64')}`,
    shasum: sha('sha1', bytes),
  };
}

async function startRegistry(item) {
  const tarball = `/${basename(item.archive)}`;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, registry).pathname;
    try {
      if (path === tarball) {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': item.bytes,
        });
        streamFile(item.archive, res);
        return;
      }
      const decoded = decodeURIComponent(path);
      const version = {
        ...item.manifest,
        dist: { tarball: `${url}${tarball}`, integrity: item.integrity, shasum: item.shasum },
      };
      if (decoded === `/${name}` || decoded === `/${name}/${item.version}`) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify(
            decoded === `/${name}`
              ? {
                  name,
                  'dist-tags': { latest: item.version, next: item.version },
                  versions: { [item.version]: version },
                }
              : version,
          ),
        );
        return;
      }
      if (decoded.startsWith(`${name}-`) || decoded.startsWith('/@forgeax/view')) {
        res.writeHead(404).end();
        return;
      }
      const upstream = await fetch(`${registry}${req.url}`, {
        headers: { accept: req.headers.accept ?? '*/*' },
        signal: AbortSignal.timeout(30_000),
      });
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      res.writeHead(502).end(String(error.message));
    }
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

async function consumer(item, local) {
  const work = await mkdtemp(resolve(tmpdir(), 'forgeax-engine-consumer-'));
  const proxy = local ? await startRegistry(item) : undefined;
  const url = proxy?.url ?? registry;
  const config = resolve(work, 'npmrc');
  const env = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: config,
    NPM_CONFIG_GLOBALCONFIG: config,
    NPM_CONFIG_CACHE: resolve(work, 'npm-cache'),
    NPM_CONFIG_REGISTRY: url,
    npm_config_registry: url,
    pnpm_config_registry: url,
    FORGEAX_DEV_HEADLESS: 'true',
  };
  for (const key of [
    'NODE_AUTH_TOKEN',
    'NPM_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'FORGEAX_GAMES_GITHUB_TOKEN',
  ])
    delete env[key];
  await writeFile(config, `registry=${url}\n@forgeax:registry=${url}\n`);
  const prefix = resolve(work, 'global');
  const cli = resolve(prefix, 'bin/forgeax');
  const run = async (command, args, cwd = work, capture = false) => {
    console.error(`[engine release] consumer ${basename(command)} ${args.join(' ')}`);
    if (capture)
      return (await execFile(command, args, { cwd, env, maxBuffer: 4 * 1024 * 1024 })).stdout;
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
    const [exit, signal] = await once(child, 'exit');
    if (exit !== 0)
      throw new Error(
        `engine-release-consumer-child: ${basename(command)} ${args[0]}: ${exit ?? signal}`,
      );
  };
  try {
    await run('npm', [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `${name}@${item.version}`,
    ]);
    for (const template of ['empty', 'game-3d']) {
      const project = resolve(work, template);
      await run(cli, ['project', 'new', project, '--template', template, '--json']);
      const game = JSON.parse(await readFile(resolve(project, 'package.json'), 'utf8'));
      if (game.dependencies?.[name] !== item.version || game.dependencies?.['@forgeax/engine-sdk'])
        throw new Error('engine-release-generated-dependency-mismatch');
      for (const guide of [
        'AGENTS.md',
        'AGENTS.zh-CN.md',
        'README.md',
        'skills/forgeax-engine-authoring/SKILL.md',
        'skills/forgeax-engine-authoring/SKILL.zh-CN.md',
      ]) {
        const content = await readFile(resolve(project, guide), 'utf8');
        if (/\bforgeax-engine-sdk\b|@forgeax\/engine-sdk|forgeax sdk install/.test(content))
          throw new Error(`engine-release-stale-install-doc: ${template}/${guide}`);
      }
      await run(cli, ['project', 'check', '--json'], project);
      await run(cli, ['project', 'build', '--json'], project);
      if (template === 'game-3d') {
        try {
          const view = JSON.parse(await run(cli, ['project', 'view', '--json'], project, true));
          if (view.ok !== true)
            throw new Error(`engine-release-view-failed: ${JSON.stringify(view.error)}`);
          const viewUrl = new URL(view.value.url);
          if (
            !['localhost', '127.0.0.1', '[::1]'].includes(viewUrl.hostname) ||
            !(await fetch(viewUrl, { signal: AbortSignal.timeout(10_000) })).ok
          )
            throw new Error('engine-release-view-http-failed');
        } finally {
          await run(cli, ['backend', 'stop', '--json'], project);
        }
      }
    }
    return {
      ok: true,
      templates: ['empty', 'game-3d'],
      view: true,
      registry: local ? 'isolated' : 'public',
    };
  } finally {
    proxy?.close();
    await rm(work, { recursive: true, force: true });
  }
}

const wait = (item, tag) =>
  waitForNpmPublications([item], {
    tag,
    onProgress: (event) => console.error(`[engine release] registry ${JSON.stringify(event)}`),
  });
const fetchRegistry = (path) =>
  fetch(`${registry}${path}`, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(15_000),
  });
export async function readEngineCandidate(directory, version, source) {
  const item = await packageArchive(directory, version, source);
  const proof = JSON.parse(await readFile(resolve(directory, 'engine-candidate.json'), 'utf8'));
  if (
    proof.ok !== true ||
    proof.package !== name ||
    proof.version !== version ||
    proof.engineCommit !== source ||
    proof.archive !== basename(item.archive) ||
    proof.sha256 !== item.sha256 ||
    proof.integrity !== item.integrity ||
    proof.consumer?.ok !== true
  )
    throw new Error('engine-release-sealed-candidate-mismatch');
  return item;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [stage, directory, version, source, ...extra] = process.argv.slice(2);
  if (stage === 'seal') {
    const item = await packageArchive(directory, version, source);
    const verified = await consumer(item, true);
    const proof = {
      ok: true,
      package: name,
      version,
      engineCommit: source,
      archive: basename(item.archive),
      bytes: item.bytes,
      sha256: item.sha256,
      integrity: item.integrity,
      consumer: verified,
    };
    await writeFile(
      resolve(directory, 'engine-candidate.json'),
      `${JSON.stringify(proof, null, 2)}\n`,
    );
    console.log(JSON.stringify(proof));
  } else {
    const item = await readEngineCandidate(directory, version, source);
    if (stage === 'mirror-preflight' || stage === 'mirror-publish') {
      await mirror(stage, directory, item, extra);
      process.exit(0);
    }
    const tags = await fetchRegistry(`/-/package/${encodeURIComponent(name)}/dist-tags`);
    if (!tags.ok) throw new Error(`engine-release-dist-tags-http-${tags.status}`);
    const { next: channel } = await tags.json();
    if (typeof channel !== 'string') throw new Error('engine-release-next-tag-required');
    assertChannelAdvance(version, channel);
    if (stage === 'publish') {
      const current = await fetchRegistry(`${namePath}/${version}`);
      if (current.ok && (await current.json()).dist?.integrity !== item.integrity)
        throw new Error('engine-release-immutable-version-conflict');
      if (!current.ok) {
        if (current.status !== 404)
          throw new Error(`engine-release-registry-http-${current.status}`);
        try {
          await execFile(
            'npm',
            [
              'publish',
              item.archive,
              '--access',
              'public',
              '--tag',
              'candidate',
              '--registry',
              registry,
            ],
            { env: { ...process.env, NPM_CONFIG_LOGLEVEL: 'error' }, maxBuffer: 16 * 1024 * 1024 },
          );
          console.error(`[engine release] submitted ${name}@${version}`);
        } catch (cause) {
          if (!/previously staged/i.test(cause.stderr ?? '')) throw cause;
          console.error(`[engine release] ${name}@${version} already submitted`);
        }
      }
      const verified = await wait(item);
      const fresh = await consumer(item, false);
      console.log(
        JSON.stringify({
          ok: true,
          version,
          integrity: item.integrity,
          registry: verified,
          consumer: fresh,
        }),
      );
    } else if (stage === 'promote') {
      const proof = JSON.parse(await readFile(extra[0], 'utf8'));
      if (
        proof.ok !== true ||
        proof.version !== version ||
        proof.integrity !== item.integrity ||
        proof.registry?.verified !== 1 ||
        proof.consumer?.ok !== true ||
        proof.consumer.registry !== 'public'
      )
        throw new Error('engine-release-public-consumer-proof-required');
      const { tag } = releasePolicy(version);
      await wait(item);
      if (channel !== version)
        await execFile('npm', [
          'dist-tag',
          'add',
          `${name}@${version}`,
          tag,
          '--registry',
          registry,
        ]);
      console.log(JSON.stringify({ ok: true, version, tag, registry: await wait(item, tag) }));
    } else throw new Error(`engine-release-stage-invalid: ${stage}`);
  }
}

async function mirror(stage, directory, item, extra) {
  const { version, source } = item;
  const digest = sha('sha256', await readFile(resolve(directory, 'engine-candidate.json')));
  const expected = {
    source,
    version,
    candidateSha256: digest,
    producerSha256: await repositoryProducerDigest(),
  };
  const api = mirrorApi();
  if (stage === 'mirror-preflight') {
    const [root, runtimeRoot, output, receipt] = extra;
    await exportRepository({
      root,
      output,
      runtimeRoot,
      ref: source,
      version,
      init: true,
      engineCandidateSha256: digest,
      log: console.error,
    });
    const verification = await verifyExport(output);
    const target = await assertMirrorTarget(api, version, source, {
      ...verification,
      candidateSha256: digest,
    });
    await verifyMirrorTransport(target);
    await writeFile(
      receipt,
      `${JSON.stringify({ schema: 'forgeax-mirror-preflight/1', ok: true, checks: MIRROR_PREFLIGHT_CHECKS, ...expected, ...verification, target })}\n`,
      { flag: 'wx' },
    );
  } else {
    const [output, receipt] = extra;
    const proof = JSON.parse(await readFile(receipt, 'utf8'));
    assertMirrorPreflight(proof, expected);
    const exported = await verifyExportFiles(output, proof.manifestSha256);
    if (
      exported.manifest.release?.version !== version ||
      exported.manifest.release?.candidateSha256 !== digest ||
      (await execFile('git', ['write-tree'], { cwd: output })).stdout.trim() !== proof.tree
    )
      throw new Error('engine-release-source-mirror-mismatch');
    const publication = await publishExport(
      output,
      { manifestSha256: proof.manifestSha256, tree: proof.tree },
      { api },
    );
    console.log(JSON.stringify({ ok: true, source, version, publication }));
  }
}
