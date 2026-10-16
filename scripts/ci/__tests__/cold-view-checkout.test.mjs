import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { submoduleGitEnvironment } from '../submodule-git-environment.mjs';

const entry = fileURLToPath(new URL('../prepare-view-checkout.mjs', import.meta.url));
const assetsEntry = fileURLToPath(new URL('../prepare-assets-checkout.mjs', import.meta.url));
test('cold private View fetch receives existing parent authorization and preserves WIP', async () => {
  const root = mkdtempSync(join(tmpdir(), 'roi1819-cold-view-488-'));
  const source = join(root, 'source');
  const engine = join(root, 'engine');
  const bare = join(root, 'view.git');
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const execute = (cmd, args, cwd, env = process.env) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
      let output = '';
      child.stdout.on('data', (d) => (output += d));
      child.stderr.on('data', (d) => (output += d));
      child.on('close', (status) => resolve({ status, output }));
    });
  let unauthorized = 0,
    authorized = 0,
    duplicateAuthorization = 0;
  const dummy = `Basic ${Buffer.from('fixture:fixture-only').toString('base64')}`;
  const server = createServer((req, res) => {
    const authorizationCount = req.rawHeaders.filter(
      (header, index) => index % 2 === 0 && header.toLowerCase() === 'authorization',
    ).length;
    if (authorizationCount > 1) {
      duplicateAuthorization++;
      res.writeHead(400);
      res.end('Duplicate header: Authorization');
      return;
    }
    if (req.headers.authorization !== dummy) {
      unauthorized++;
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' });
      res.end();
      return;
    }
    authorized++;
    const uri = new URL(req.url, 'http://fixture');
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: uri.pathname,
        QUERY_STRING: uri.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: 'fixture',
      },
    });
    let header = Buffer.alloc(0),
      body = false;
    child.stdout.on('data', (chunk) => {
      if (body) {
        res.write(chunk);
        return;
      }
      header = Buffer.concat([header, chunk]);
      const split = header.indexOf('\r\n\r\n');
      if (split < 0) return;
      const headers = {};
      let status = 200;
      for (const line of header.subarray(0, split).toString().split('\r\n')) {
        const colon = line.indexOf(':');
        const key = line.slice(0, colon),
          value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
        else headers[key] = value;
      }
      res.writeHead(status, headers);
      res.write(header.subarray(split + 4));
      body = true;
    });
    child.stdout.on('end', () => res.end());
    child.stderr.resume();
    req.pipe(child.stdin);
  });
  try {
    for (const p of [source, engine]) {
      mkdirSync(p);
      git(p, 'init', '-q');
      git(p, 'config', 'user.name', 'Cold View fixture');
      git(p, 'config', 'user.email', 'fixture@example.invalid');
    }
    writeFileSync(join(source, 'package.json'), '{"name":"pinned-view","version":"1.0.0"}\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'pin');
    const pin = git(source, 'rev-parse', 'HEAD');
    git(root, 'clone', '-q', '--bare', source, bare);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/view.git`;
    writeFileSync(
      join(engine, '.gitmodules'),
      `[submodule "tools/view"]\n path = tools/view\n url = ${url}\n`,
    );
    writeFileSync(join(engine, 'pnpm-lock.yaml'), 'frozen-fixture-lock\n');
    git(engine, 'add', '.');
    git(engine, 'update-index', '--add', '--cacheinfo', `160000,${pin},tools/view`);
    git(engine, 'commit', '-qm', 'parent');
    let head = git(engine, 'rev-parse', 'HEAD');
    const lock = readFileSync(join(engine, 'pnpm-lock.yaml'));
    let index = readFileSync(join(engine, '.git/index'));
    git(engine, 'config', `http.${url}.extraheader`, `Authorization: ${dummy}`);
    const red = await execute(
      'git',
      ['submodule', 'update', '--init', '--depth=1', '--', 'tools/view'],
      engine,
    );
    assert.notEqual(red.status, 0);
    assert.ok(unauthorized > 0);
    assert.equal(authorized, 0);
    const envBefore = { ...process.env };
    const green = await execute(process.execPath, [entry], engine);
    assert.equal(green.status, 0, green.output);
    assert.ok(authorized > 0);
    assert.equal(git(join(engine, 'tools/view'), 'rev-parse', 'HEAD'), pin);
    assert.equal(git(engine, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(readFileSync(join(engine, 'pnpm-lock.yaml')), lock);
    assert.deepEqual(readFileSync(join(engine, '.git/index')), index);
    assert.deepEqual({ ...process.env }, envBefore);
    assert.ok(!green.output.includes(dummy));

    // A persistent submodule can retain its own header while its new pin is absent.
    writeFileSync(join(source, 'package.json'), '{"name":"next-view","version":"1.1.0"}\n');
    git(source, 'commit', '-qam', 'next remote pin');
    const nextPin = git(source, 'rev-parse', 'HEAD');
    git(bare, 'fetch', '-q', source, `HEAD:${git(source, 'symbolic-ref', 'HEAD')}`);
    const view = join(engine, 'tools/view');
    git(view, 'config', `http.${new URL(url).origin}/.extraheader`, `Authorization: ${dummy}`);
    git(engine, 'update-index', '--cacheinfo', `160000,${nextPin},tools/view`);
    git(engine, 'commit', '-qm', 'next View gitlink');
    head = git(engine, 'rev-parse', 'HEAD');
    index = readFileSync(join(engine, '.git/index'));
    const cached = await execute(process.execPath, [entry], engine);
    assert.equal(cached.status, 0, cached.output);
    assert.equal(duplicateAuthorization, 0, 'Git must send exactly one Authorization header');
    assert.equal(git(view, 'rev-parse', 'HEAD'), nextPin);
    assert.equal(git(engine, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(readFileSync(join(engine, '.git/index')), index);
    assert.deepEqual(readFileSync(join(engine, 'pnpm-lock.yaml')), lock);
    assert.deepEqual({ ...process.env }, envBefore);

    // Contributor assets use a relative URL resolved against the parent remote.
    const relativeEngine = join(root, 'engine-relative-assets');
    mkdirSync(relativeEngine);
    git(relativeEngine, 'init', '-q');
    git(relativeEngine, 'config', 'user.name', 'Cold assets fixture');
    git(relativeEngine, 'config', 'user.email', 'fixture@example.invalid');
    git(relativeEngine, 'remote', 'add', 'origin', `${new URL(url).origin}/engine.git`);
    git(
      relativeEngine,
      'config',
      `http.${new URL(url).origin}/.extraheader`,
      `Authorization: ${dummy}`,
    );
    writeFileSync(
      join(relativeEngine, '.gitmodules'),
      '[submodule "forgeax-engine-assets"]\n path = forgeax-engine-assets\n url = ../view.git\n',
    );
    writeFileSync(join(relativeEngine, 'pnpm-lock.yaml'), lock);
    git(relativeEngine, 'add', '.');
    git(
      relativeEngine,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${nextPin},forgeax-engine-assets`,
    );
    git(relativeEngine, 'commit', '-qm', 'relative asset pin');
    const relativeHead = git(relativeEngine, 'rev-parse', 'HEAD');
    const relativeIndex = readFileSync(join(relativeEngine, '.git/index'));
    // This synthetic repository has its own product identity; CI's outer identity
    // must remain in the parent environment and must still reject this fixture.
    const identityRejected = await execute(process.execPath, [assetsEntry], relativeEngine, {
      ...process.env,
      EXPECTED_PRODUCT_SHA: '0000000000000000000000000000000000000000',
    });
    assert.notEqual(identityRejected.status, 0);
    assert.match(identityRejected.output, /product mismatch expected=/);
    const relative = await execute(process.execPath, [assetsEntry], relativeEngine, {
      ...process.env,
      EXPECTED_PRODUCT_SHA: relativeHead,
    });
    assert.equal(relative.status, 0, relative.output);
    assert.equal(git(join(relativeEngine, 'forgeax-engine-assets'), 'rev-parse', 'HEAD'), nextPin);
    assert.equal(git(relativeEngine, 'rev-parse', 'HEAD'), relativeHead);
    assert.deepEqual(readFileSync(join(relativeEngine, '.git/index')), relativeIndex);
    assert.deepEqual(readFileSync(join(relativeEngine, 'pnpm-lock.yaml')), lock);
    assert.deepEqual({ ...process.env }, envBefore);
    assert.ok(!relative.output.includes(dummy));

    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'fixture.keep';
    process.env.GIT_CONFIG_VALUE_0 = 'retained';
    try {
      const environment = submoduleGitEnvironment(engine, 'tools/view');
      assert.equal(environment.GIT_CONFIG_COUNT, '3');
      assert.equal(environment.GIT_CONFIG_KEY_0, 'fixture.keep');
      assert.equal(environment.GIT_CONFIG_VALUE_0, 'retained');
      assert.equal(environment.GIT_CONFIG_KEY_1, `http.${new URL(url).origin}/.extraheader`);
      assert.equal(environment.GIT_CONFIG_VALUE_1, '');
      assert.equal(environment.GIT_CONFIG_KEY_2, environment.GIT_CONFIG_KEY_1);
      assert.equal(environment.GIT_CONFIG_VALUE_2, `Authorization: ${dummy}`);
      assert.equal(process.env.GIT_CONFIG_COUNT, '1');
    } finally {
      for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
        if (envBefore[key] === undefined) delete process.env[key];
        else process.env[key] = envBefore[key];
      }
    }
    git(view, 'config', 'user.name', 'Cold View fixture');
    git(view, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(view, 'package.json'), '{"name":"newer-view","version":"2.0.0"}\n');
    git(view, 'commit', '-qam', 'newer');
    const newer = git(view, 'rev-parse', 'HEAD');
    const work = '{ "name": "retained-user-WIP" }\n';
    writeFileSync(join(view, 'package.json'), work);
    const refused = await execute(process.execPath, [entry], engine);
    assert.notEqual(refused.status, 0);
    assert.equal(git(view, 'rev-parse', 'HEAD'), newer);
    assert.equal(readFileSync(join(view, 'package.json'), 'utf8'), work);
    assert.equal(git(engine, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(readFileSync(join(engine, 'pnpm-lock.yaml')), lock);
    assert.deepEqual(readFileSync(join(engine, '.git/index')), index);
    console.log(
      JSON.stringify({
        phase: 'production-path-regression',
        redExit: red.status,
        greenExit: green.status,
        cachedPinFetchExit: cached.status,
        relativeAssetsFetchExit: relative.status,
        wipRefusalExit: refused.status,
        unauthorized,
        authorized,
        duplicateAuthorization,
        headAndLockAndIndexUnchanged: true,
        noSecretInOutput: true,
      }),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
