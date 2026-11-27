#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const viewRoot = import.meta.dirname;
const help = `Usage: node start.mjs [--project <directory>] [--new-instance] [--root <directory>]

Starts View in the foreground using its installed Engine and built presentation.
Omit --project to choose a project in the page. Default startup shares one
temporary backend workspace per installation; --new-instance allocates its own.
An explicit --root takes precedence. Open the returned URL and keep this terminal
running. Ctrl+C closes the presentation; the Engine backend keeps its own lifetime.
The URL means the Shell is listening; Backend/project readiness appears in the page.
SDK outputs are built already; its tool runtime is initialized on first use.
This file emits JSON directly; --json is not a supported flag. --help starts no services.
`;

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--new-instance') options.newInstance = true;
    else if (flag === '--project' || flag === '--root') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a directory.`);
      options[flag.slice(2)] = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

export function defaultBackendRoot(engine, view, temporary = tmpdir()) {
  const digest = createHash('sha256')
    .update(JSON.stringify([engine, view]))
    .digest('hex')
    .slice(0, 16);
  return resolve(temporary, 'forgeax/view-start', digest);
}

/** The View file selects its own installation, never the caller's cwd. */
export async function resolveStartup(options = {}) {
  let view = await realpath(options.viewRoot ?? viewRoot);
  const sdk = resolve(view, '../..');
  const sdkManifest = await readFile(join(sdk, 'sdk-manifest.json'), 'utf8').then(
    (text) => JSON.parse(text),
    (cause) => { if (cause.code !== 'ENOENT') throw cause; },
  );
  if (sdkManifest && view === join(sdk, 'tools/view')) {
    const { ensureSdkRuntime } = await import(pathToFileURL(join(sdk, 'bin/forgeax.mjs')).href);
    const runtime = await ensureSdkRuntime();
    view = await realpath(join(runtime, 'node_modules/@forgeax/view'));
  }
  const require = createRequire(join(view, 'package.json'));
  const enginePackage = await realpath(dirname(require.resolve('@forgeax/engine/package.json')));
  let engine = enginePackage;
  if (basename(dirname(enginePackage)) === 'packages') {
    const checkout = resolve(enginePackage, '../..');
    const source = await readFile(join(checkout, 'package.json'), 'utf8').then(
      (text) => JSON.parse(text),
      () => undefined,
    );
    if (source?.name === 'forgeax-engine') engine = checkout;
  }
  // Check outputs before allocating an instance; source preparation has its own helper.
  const required = ['host.pack.json', 'dist/modules/service.mjs', 'dist/viewer/index.html'];
  for (const file of required) {
    try {
      await realpath(join(view, file));
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      throw Object.assign(
        new Error(
          `Missing View output ${join(view, file)}. Install a complete matching SDK distribution. Source contributors must prepare their checkout explicitly.`,
          { cause },
        ),
        { code: 'view-installation-incomplete' },
      );
    }
  }
  const hostPack = await realpath(join(view, 'host.pack.json'));
  let root = options.root === undefined ? defaultBackendRoot(engine, view) : resolve(options.root);
  if (options.root === undefined && options.newInstance) {
    const parent = resolve(tmpdir(), 'forgeax/view-instances');
    await mkdir(parent, { recursive: true });
    root = await mkdtemp(join(parent, 'instance-'));
  }
  return { root, hostPack, enginePackage, viewRoot: view };
}

export async function startView(options = {}) {
  const installation = await resolveStartup(options);
  const { root, hostPack, viewRoot: view } = installation;
  if (view !== await realpath(viewRoot)) {
    const installed = await import(pathToFileURL(join(view, 'start.mjs')).href);
    return installed.startView({ ...options, root, viewRoot: view });
  }
  const { ensureDevKitView } = await import('@forgeax/engine/devkit');
  const { serveView } = await import(pathToFileURL(join(view, 'dist/modules/service.mjs')).href);
  const service = await serveView({
    root,
    hostPack,
    ...(options.project === undefined ? {} : { project: resolve(options.project) }),
    ensure: (project, signal) =>
      ensureDevKitView(root, {
        hostPack,
        ...(project === undefined ? {} : { project }),
        ...(signal === undefined ? {} : { signal }),
      }),
  });
  return {
    ...service,
    enginePackage: installation.enginePackage,
    viewRoot: view,
    project: options.project === undefined ? null : resolve(options.project),
  };
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(help);
    else {
      const service = await startView(options);
      process.stdout.write(`${JSON.stringify({
        url: service.url,
        root: service.root,
        hostPack: service.hostPack,
        enginePackage: service.enginePackage,
        viewRoot: service.viewRoot,
        project: service.project,
        phase: 'preparing',
      })}\n`);
    }
  } catch (error) {
    process.stderr.write(`[view-start] ${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 1;
  }
}
