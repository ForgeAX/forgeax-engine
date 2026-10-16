import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const repositoryRoot = resolve(import.meta.dirname, '..');
const fixtureEntry = resolve(repositoryRoot, 'apps/view-fixture-host/src/main.ts');
const fixturePanelsEntry = resolve(repositoryRoot, 'apps/view-fixture-host/scripts/diagnostic-panels-entry.mjs');
const viewerConfig = resolve(repositoryRoot, 'packages/viewer/vite.config.ts');

function parseArguments(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let fixture = false;
  let viewHost;
  let port;
  let host;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--fixture') fixture = true;
    else if (argument === '--view-host') viewHost = args[++index];
    else if (argument.startsWith('--view-host=')) viewHost = argument.slice('--view-host='.length);
    else if (argument === '--port') port = Number(args[++index]);
    else if (argument.startsWith('--port=')) port = Number(argument.slice('--port='.length));
    else if (argument === '--host') host = args[++index];
    else if (argument.startsWith('--host=')) host = argument.slice('--host='.length);
    else throw new Error(`Unknown dev option: ${argument}`);
  }
  if (fixture && viewHost) throw new Error('--fixture and --view-host cannot be combined');
  if (!fixture && !viewHost) throw new Error('Specify --view-host <http-origin> or use pnpm dev:ui');
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('Invalid --port');
  return { fixture, viewHost, port, host };
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('--view-host must be an HTTP origin');
  }
  return url.origin;
}

async function waitForHealth(origin, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Fixture Host exited (${child.exitCode}) before becoming healthy`);
    try {
      const response = await fetch(`${origin}/__forgeax/view/health`, { signal: AbortSignal.timeout(1500) });
      if (response.status === 204) return;
    } catch { /* The Host may still be opening its listener. */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Fixture Host did not become healthy within 20 seconds');
}

async function startFixture() {
  const child = spawn(process.execPath, [fixtureEntry, '--port', '0', '--scenario', 'default'], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  startingFixture = child;
  const announcement = await new Promise((resolve, reject) => {
    let pending = '';
    let announced = false;
    const finish = (callback, value) => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      callback(value);
    };
    const onError = (error) => finish(reject, error);
    const onExit = (code) => finish(reject, new Error(`Fixture Host exited before announcing its origin (${code})`));
    const timer = setTimeout(() => finish(reject, new Error('Fixture Host did not announce its origin')), 120_000);
    const onData = (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!announced) {
          let candidate;
          try { candidate = JSON.parse(line); }
          catch { /* Host startup logs may precede the announcement. */ }
          if (candidate && typeof candidate === 'object'
            && typeof candidate.origin === 'string'
            && typeof candidate.scenario === 'string' && candidate.scenario.length > 0) {
            try {
              normalizeOrigin(candidate.origin);
              announced = true;
              finish(resolve, candidate);
              continue;
            } catch { /* Other JSON output is a normal Host log. */ }
          }
        }
        process.stdout.write(`${line}\n`);
      }
    };
    child.on('error', onError);
    child.on('exit', onExit);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stdout.on('end', () => { if (pending) process.stdout.write(pending); });
  }).catch((error) => { child.kill(); throw error; });
  try {
    const origin = normalizeOrigin(announcement.origin);
    await waitForHealth(origin, child);
    startingFixture = undefined;
    return { child, origin };
  } catch (error) {
    child.kill();
    throw error;
  }
}

let fixture;
let startingFixture;
let server;
let closing = false;

async function close() {
  if (closing) return;
  closing = true;
  (fixture?.child ?? startingFixture)?.kill();
  await server?.close();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void close().then(() => { process.exitCode = 0; }); });
}

try {
  const options = parseArguments(process.argv.slice(2));
  fixture = options.fixture ? await startFixture() : undefined;
  const origin = fixture?.origin ?? normalizeOrigin(options.viewHost);
  process.env.FORGEAX_VIEW_DEV_HOST_ORIGIN = origin;
  if (fixture) {
    const enginePackage = fileURLToPath(import.meta.resolve('@forgeax/engine/package.json'));
    const engineRoot = resolve(dirname(enginePackage), '../..');
    process.env.FORGEAX_VIEW_PANELS_ENTRY = fixturePanelsEntry;
    process.env.FORGEAX_VIEW_FRONTEND_PLUGINS_ENTRY = resolve(engineRoot, 'tools/view-plugins/integration/frontend-plugins.ts');
    process.env.FORGEAX_VIEW_INPUT_ROOTS = JSON.stringify([
      resolve(repositoryRoot, 'apps/view-fixture-host/src'),
      resolve(engineRoot, 'tools/view-plugins'),
      resolve(engineRoot, 'apps/rhi-debug-viewer/src'),
    ]);
  }
  server = await createServer({
    configFile: viewerConfig,
    server: {
      port: options.port,
      host: options.host,
      strictPort: options.fixture,
      ...(fixture ? { proxy: {
        '/__forgeax/view/bootstrap': { target: origin, changeOrigin: true },
        '/__forgeax/view/health': { target: origin, changeOrigin: true },
        '/fixture-artifacts': { target: origin, changeOrigin: true },
      } } : {}),
    },
  });
  await server.listen();
  server.printUrls();
  console.info(`View Host: ${origin}`);
  fixture?.child.on('exit', (code) => {
    if (closing) return;
    console.error(`Fixture Host exited (${code}); stopping Viewer dev server.`);
    void close().then(() => { process.exitCode = code || 1; });
  });
} catch (error) {
  console.error(error);
  await close();
  process.exitCode = 1;
}
