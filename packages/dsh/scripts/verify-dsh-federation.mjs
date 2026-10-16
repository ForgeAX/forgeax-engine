import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

import { createIntelligenceRuntime } from '@forgeax/engine-intelligence';
import { Context } from '@forgeax/engine-plugin';

import { connectDshRealm } from '../dist/engine-host.mjs';
import { createDshRealmIntelligenceProvider } from '../dist/intelligence.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dsh = process.env.DSH_EXECUTABLE ?? 'dsh';
const home = await mkdtemp(join(tmpdir(), 'forgeax-dsh-federation-'));
const fixture = await mkdtemp(join(tmpdir(), 'forgeax-dsh-community-'));

try {
  await materializeFixture(fixture);
  await verifyEngineCordisFixture(fixture);
  await run(dsh, ['plugin', '--profile', 'web', 'add', packageRoot], { DSH_HOME: home });
  await run(dsh, ['plugin', '--profile', 'web', 'add', fixture], { DSH_HOME: home });
  const profileBefore = await authorityFingerprint(join(home, 'profiles', 'web'));

  const attachedProcess = await launchDsh(dsh, home);
  const first = await status(attachedProcess.endpoint);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
  const second = await status(attachedProcess.endpoint);
  assert(second.engine.binding === 'embedded', 'native DSH should own the headless Engine fallback');
  assert(second.engine.tick > first.engine.tick, 'embedded Engine tick must advance');

  const attachedResult = await connectDshRealm({ endpoint: attachedProcess.endpoint });
  assert(attachedResult.ok, 'explicit endpoint should attach');
  const attached = attachedResult.value;
  assert(attached.connection.binding === 'attach', 'explicit endpoint must resolve to attach');
  assert(attached.connection.ownership === 'lease', 'attach must own only a lease');
  const community = await attached.connection.community();
  assert(community.value === 'loaded-by-dsh-native-loader', 'DSH native Loader community probe');

  const intelligence = createIntelligenceRuntime(
    createDshRealmIntelligenceProvider(attached.connection),
    { createSessionId: () => 'integration-session' },
  );
  const submitted = intelligence.submit({ input: 'integration' });
  assert(submitted.ok, 'federated Activity should be accepted');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
  const events = intelligence.poll();
  assert(events.at(-1)?.type === 'completed', 'federated Activity should complete');
  await intelligence.close();
  await attached.dispose();
  await attached.dispose();
  assert((await status(attachedProcess.endpoint)).leases === 0, 'attach dispose must release its lease');
  await attachedProcess.stop();

  const profileAfter = await authorityFingerprint(join(home, 'profiles', 'web'));
  assert(profileAfter === profileBefore, 'runtime mount/dispose must not mutate the DSH profile');

  const launchedResult = await connectDshRealm({
    executable: dsh,
    home,
    handshakeTimeoutMs: 10_000,
  });
  assert(launchedResult.ok, 'explicit executable should launch');
  const launched = launchedResult.value;
  assert(launched.connection.binding === 'external', 'explicit executable must launch external DSH');
  assert(launched.connection.ownership === 'instance', 'external launch must own its child instance');
  const launchedEndpoint = launched.connection.endpoint;
  await launched.dispose();
  assert(await unreachable(launchedEndpoint), 'external launch dispose must stop its child instance');

  const embeddedResult = await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      embeddedProbe(pathToFileURL(join(packageRoot, 'dist', 'engine-host.mjs')).href),
    ],
    { PATH: '' },
  );
  assert(embeddedResult.includes('embedded:instance:true'), 'packaged fallback must start and stop');

  await run(dsh, ['plugin', '--profile', 'web', 'remove', '@forgeax/engine-dsh'], {
    DSH_HOME: home,
  });
  const dumped = await run(dsh, ['--profile', 'web', '--dump-config'], { DSH_HOME: home });
  assert(!dumped.includes('forgeax-engine-federation'), 'native uninstall must remove the connector layer');

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      nativeLoader: community,
      sharedCordisPlugin: true,
      activityEvents: events.map((event) => event.type),
      embeddedTickDelta: second.engine.binding === 'embedded' && first.engine.binding === 'embedded'
        ? second.engine.tick - first.engine.tick
        : 0,
      profilePreserved: true,
      attachLeaseReleased: true,
      externalStopped: true,
      embeddedStopped: true,
      nativeUninstall: true,
    })}\n`,
  );
} finally {
  await rm(home, { recursive: true, force: true });
  await rm(fixture, { recursive: true, force: true });
}

async function materializeFixture(directory) {
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: '@forgeax-test/dsh-community-capability',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
      exports: {
        '.': './index.js',
        './cordis.patch.yml': './cordis.patch.yml',
        './package.json': './package.json',
      },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  );
  await writeFile(
    join(directory, 'index.js'),
    [
      'export const apply = (ctx) => {',
      "  ctx.provide('forgeaxFederationCapability', { inspect: () => ({ id: 'community-fixture', value: 'loaded-by-dsh-native-loader' }) });",
      "  ctx.provide('forgeaxIntelligenceCapability', { run: (input, sessionId) => ({ output: `DSH:${sessionId}:${input}` }) });",
      '};',
    ].join('\n'),
  );
  await writeFile(
    join(directory, 'cordis.patch.yml'),
    "- insert:\n    - id: forgeax-community-fixture\n      name: '@forgeax-test/dsh-community-capability'\n",
  );
}

async function verifyEngineCordisFixture(directory) {
  const module = await import(pathToFileURL(join(directory, 'index.js')).href);
  const context = new Context();
  const fiber = await context.plugin(module.apply);
  const capability = context.get('forgeaxFederationCapability');
  assert(
    capability?.inspect().value === 'loaded-by-dsh-native-loader',
    'the realm-neutral fixture should load in the Engine Cordis Context',
  );
  await fiber.dispose();
  assert(
    context.get('forgeaxFederationCapability') === undefined,
    'disposing the shared fixture Fiber should remove its Engine service',
  );
  await context.fiber.dispose();
}

async function launchDsh(command, dshHome) {
  const child = spawn(command, ['web', '--host', '127.0.0.1', '--port', '0'], {
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const endpoint = await new Promise((resolvePromise, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`DSH URL timeout: ${output}`)), 10_000);
    const onData = (chunk) => {
      output += chunk.toString('utf8');
      const match = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolvePromise(match[1]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`DSH exited before ready: ${code}: ${output}`));
    });
  });
  return {
    endpoint,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
      child.kill('SIGTERM');
      await exited;
    },
  };
}

async function status(endpoint) {
  const response = await fetch(`${endpoint}/forgeax-federation/v1/status`);
  assert(response.ok, `status route should answer: ${response.status}`);
  return response.json();
}

async function unreachable(endpoint) {
  try {
    await fetch(`${endpoint}/forgeax-federation/v1/status`);
    return false;
  } catch {
    return true;
  }
}

async function authorityFingerprint(root) {
  const hash = createHash('sha256');
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']) {
    hash.update(name);
    hash.update(await readFile(join(root, name)));
  }
  return hash.digest('hex');
}

function embeddedProbe(moduleUrl) {
  return `
    import { connectDshRealm } from ${JSON.stringify(moduleUrl)};
    const result = await connectDshRealm({ handshakeTimeoutMs: 5000 });
    if (!result.ok) throw result.error;
    const realm = result.value;
    const endpoint = realm.connection.endpoint;
    const binding = realm.connection.binding;
    const ownership = realm.connection.ownership;
    await realm.dispose();
    let stopped = false;
    try { await fetch(endpoint + '/forgeax-federation/v1/status'); } catch { stopped = true; }
    console.log(binding + ':' + ownership + ':' + stopped);
  `;
}

function run(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.once('exit', (code) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${output}`));
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
