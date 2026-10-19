import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sha = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');

export async function readSdkNpmArtifacts({ packageArchives, checksumsFile, expectedVersion }) {
  const packageRoot = resolve(packageArchives);
  const sumsPath = resolve(checksumsFile);
  const sumRoot = dirname(sumsPath);
  const sumRows = new Map((await readFile(sumsPath, 'utf8')).split(/\r?\n/).flatMap((line) => {
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line);
    return match === null ? [] : [[match[2], match[1]]];
  }));
  const names = (await readdir(packageRoot)).filter((name) => name.endsWith('.tgz')).sort();
  if (names.length === 0) throw new Error('sdk-npm-artifact-set-empty');
  const rows = [];
  const identities = new Set();
  for (const name of names) {
    const path = resolve(packageRoot, name);
    const relativePath = relative(sumRoot, path).split(sep).join('/');
    const bytes = await readFile(path);
    const sha256 = sha('sha256', bytes);
    if (sumRows.get(relativePath) !== sha256) throw new Error(`sdk-npm-artifact-checksum-mismatch: ${relativePath}`);
    const { stdout } = await execFileAsync('tar', ['-xOf', path, 'package/package.json'], { maxBuffer: 4 * 1024 * 1024 });
    const manifest = JSON.parse(stdout);
    if (manifest.version !== expectedVersion) throw new Error(`sdk-npm-artifact-version-mismatch: ${manifest.name}`);
    if (identities.has(manifest.name)) throw new Error(`sdk-npm-artifact-duplicate: ${manifest.name}`);
    identities.add(manifest.name);
    rows.push({
      name: manifest.name,
      version: manifest.version,
      archive: name,
      bytes: bytes.byteLength,
      sha256,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      shasum: sha('sha1', bytes),
      manifest,
      path,
    });
  }
  if (!identities.has('@forgeax/engine')) throw new Error('sdk-npm-umbrella-artifact-missing');
  for (const row of rows) {
    const bundled = new Set(row.manifest.bundledDependencies ?? []);
    if (bundled.size > 0) {
      const { stdout } = await execFileAsync('tar', ['-tzf', row.path], { maxBuffer: 64 * 1024 * 1024 });
      const entries = new Set(stdout.split('\n'));
      for (const name of bundled) {
        if (!entries.has(`package/node_modules/${name}/package.json`))
          throw new Error(`sdk-npm-bundled-package-missing: ${name}`);
      }
    }
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(row.manifest[section] ?? {})) {
        if (name !== '@forgeax/view' && !name.startsWith('@forgeax/engine')) continue;
        if (version !== expectedVersion || (!identities.has(name) && !bundled.has(name))) throw new Error(`sdk-npm-artifact-closure-mismatch: ${row.manifest.name} -> ${name}`);
      }
    }
  }
  return rows;
}

export async function startSdkNpmArtifactRegistry(options) {
  const artifacts = await readSdkNpmArtifacts(options);
  const byName = new Map(artifacts.map((item) => [item.name, item]));
  const byArchive = new Map(artifacts.map((item) => [item.archive, item]));
  const requests = [];
  const record = (request, status, source) => {
    if (requests.length < 1000) requests.push({
      method: request.method ?? 'GET',
      path: (request.url ?? '/').split('?', 1)[0],
      status,
      source,
    });
  };
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(requestUrl.pathname);
      const archive = pathname.startsWith('/tarballs/') || pathname.includes('/-/')
        ? byArchive.get(basename(pathname))
        : undefined;
      if (archive !== undefined) {
        const metadata = await stat(archive.path);
        record(request, 200, 'local-tarball');
        response.writeHead(200, { 'content-length': metadata.size, 'content-type': 'application/octet-stream' });
        await pipeline(createReadStream(archive.path), response);
        return;
      }
      const packageName = pathname.replace(/^\/+/, '');
      const artifact = byName.get(packageName);
      if (artifact !== undefined) {
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        const packument = {
          name: artifact.manifest.name,
          'dist-tags': { latest: artifact.version },
          versions: {
            [artifact.version]: {
              ...artifact.manifest,
              dist: {
                tarball: `http://127.0.0.1:${port}/tarballs/${artifact.archive}`,
                integrity: artifact.integrity,
                shasum: artifact.shasum,
              },
            },
          },
        };
        record(request, 200, 'local-metadata');
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(packument));
        return;
      }
      if (packageName.startsWith('@forgeax/engine') || packageName === '@forgeax/view') {
        record(request, 404, 'missing-exact-sdk-artifact');
        response.writeHead(404).end();
        return;
      }
      const upstream = await fetch(`https://registry.npmjs.org${request.url ?? '/'}`, {
        headers: { accept: request.headers.accept ?? 'application/json' },
      });
      const headers = Object.fromEntries([...upstream.headers.entries()].filter(
        ([key]) => !['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key),
      ));
      record(request, upstream.status, 'npmjs-upstream');
      response.writeHead(upstream.status, headers);
      if (request.method === 'HEAD' || upstream.body === null) response.end();
      else await pipeline(Readable.fromWeb(upstream.body), response);
    } catch (cause) {
      record(request, 502, 'registry-error');
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end(cause instanceof Error ? cause.message : String(cause));
    }
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    artifacts: artifacts.map(({ path, manifest, ...row }) => row),
    requests,
    close: () => new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept())),
  };
}
