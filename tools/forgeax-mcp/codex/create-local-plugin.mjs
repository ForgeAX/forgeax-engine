#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { copyRuntime } from './copy-runtime.mjs';
import { APP_VERSION, MCP_SERVERS, VIEW_TITLE } from '../src/contract.ts';

const [sourceArg, outputArg, ...flags] = process.argv.slice(2);
if (!sourceArg || !outputArg) {
  console.error(
    'Usage: node create-local-plugin.mjs <engine-or-project-directory> <new-marketplace-directory> [--root <backend-directory>]',
  );
  process.exit(2);
}

if (flags.length && (flags.length !== 2 || flags[0] !== '--root' || !flags[1]))
  throw new TypeError('Expected an optional --root backend directory');
const sourceRoot = await realpath(resolve(sourceArg));
const project = await readFile(join(sourceRoot, 'forge.json'), 'utf8').then(JSON.parse, error => {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
});
if (project && typeof project.id !== 'string') throw new TypeError('Invalid project identity');
const projectRoot = project ? sourceRoot : undefined;
const sourcePackage = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
let viewRoot;
if (sourcePackage.name === 'forgeax-engine' || sourcePackage.name === '@forgeax/engine') {
  viewRoot = join(sourceRoot, 'tools/view');
  if (sourcePackage.name === '@forgeax/engine' && sourceRoot.endsWith('/packages/engine'))
    viewRoot = resolve(sourceRoot, '../../tools/view');
} else {
  const require = createRequire(join(sourceRoot, 'package.json'));
  const enginePackage = resolve(require.resolve('@forgeax/engine/package.json'), '..');
  viewRoot = enginePackage.endsWith('/packages/engine')
    ? resolve(enginePackage, '../../tools/view') : join(enginePackage, 'tools/view');
}
const { resolveStartup, defaultBackendRoot } = await import(pathToFileURL(join(viewRoot, 'start.mjs')).href);
const installation = await resolveStartup({ viewRoot });
const hostPack = await realpath(resolve(viewRoot, '../forgeax-mcp/host.app.pack.json'));
const root = flags.length ? resolve(flags[1]) : defaultBackendRoot(installation.enginePackage, hostPack);
await mkdir(root, { recursive: true });
const binding = { schemaVersion: 1, root: await realpath(root), enginePackage: installation.enginePackage,
  viewRoot: installation.viewRoot, hostPack };
// An explicit H remains a caller-managed fixed binding for non-native consumers.
let codexContext;
if (!flags.length) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    try { await access(candidate); codexContext = { command: await realpath(candidate), ...(process.env.CODEX_HOME ? { home: process.env.CODEX_HOME } : {}) }; break; }
    catch { /* Resolve the generating host's public CLI from PATH. */ }
  }
  if (!codexContext) throw new Error('Codex is required to resolve native chat working directories.');
}

const marketplaceRoot = resolve(outputArg);
const pluginName = 'forgeax-view-codex';
const marketplaceName = `forgeax-view-local-${createHash('sha256').update(JSON.stringify(binding)).digest('hex').slice(0, 12)}`;
const pluginRoot = join(marketplaceRoot, 'plugins', pluginName);
// Installation selects Engine/Host ownership; the retained View selects games.
await mkdir(marketplaceRoot);
await mkdir(pluginRoot, { recursive: true });
await mkdir(join(marketplaceRoot, '.agents', 'plugins'), { recursive: true });

const writeJson = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const nodeCommand = process.platform === 'win32' ? 'node' : './node-launcher';
if (process.platform !== 'win32') {
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    join(pluginRoot, 'node-launcher'),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`,
    { mode: 0o700 },
  );
}
await build({
  entryPoints: [join(import.meta.dirname, '../src/mcp-stdio.mjs')],
  outfile: join(pluginRoot, 'mcp-stdio.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'bundle',
  logLevel: 'silent',
});
// Native compiler packages resolve their own platform binary and filesystem paths.
const appRuntimePackages = ['vite', 'typescript', 'esbuild'];
await build({
  entryPoints: {
    'src/codex-app-server': join(import.meta.dirname, '../src/codex-app-server.mjs'),
    'src/app/program-bundler': join(import.meta.dirname, '../src/app/program-bundler.mjs'),
  },
  outdir: pluginRoot,
  outExtension: { '.js': '.mjs' },
  splitting: true,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'bundle',
  external: appRuntimePackages,
  logLevel: 'silent',
  banner: {
    js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);",
  },
});
await copyRuntime(resolve(import.meta.dirname, '..'), pluginRoot, appRuntimePackages);
await mkdir(join(pluginRoot, 'dist'), { recursive: true });
for (const name of ['carrier.html', 'full-view.html', 'codex-view.html', 'preview-runtime.mjs'])
  await cp(join(import.meta.dirname, '../dist', name), join(pluginRoot, 'dist', name));
await writeJson(join(pluginRoot, 'plugin.json'), {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: pluginName,
  version: APP_VERSION,
  description: 'ForgeAX View with progressive Engine startup, resource cards and Pack source viewing.',
});
await writeJson(join(pluginRoot, 'hosting.json'), { ...binding, ...(codexContext ? { codexContext } : {}) });
await writeJson(join(pluginRoot, 'mcp.json'), {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: {
    [MCP_SERVERS.tools]: {
      type: 'stdio',
      command: nodeCommand,
      args: ['${PLUGIN_ROOT}/mcp-stdio.mjs', '${PLUGIN_ROOT}/hosting.json'],
      env: { TMPDIR: tmpdir(), ...(process.env.FORGEAX_CONTEXT_PROBE ? { FORGEAX_CONTEXT_PROBE: process.env.FORGEAX_CONTEXT_PROBE } : {}) },
    },
    [MCP_SERVERS.view]: {
      type: 'stdio',
      command: nodeCommand,
      args: ['${PLUGIN_ROOT}/src/codex-app-server.mjs', '${PLUGIN_ROOT}/hosting.json'],
      env: { TMPDIR: tmpdir(), ...(process.env.FORGEAX_CONTEXT_PROBE ? { FORGEAX_CONTEXT_PROBE: process.env.FORGEAX_CONTEXT_PROBE } : {}) },
    },
  },
});
await writeJson(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
  name: marketplaceName,
  interface: { displayName: `${VIEW_TITLE} (local)` },
  plugins: [
    {
      name: pluginName,
      source: { source: 'local', path: `./plugins/${pluginName}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    },
  ],
});
console.log(JSON.stringify({ marketplaceRoot, marketplaceName, pluginName, root: binding.root,
  enginePackage: binding.enginePackage, ...(projectRoot ? { projectRoot } : {}) }));
