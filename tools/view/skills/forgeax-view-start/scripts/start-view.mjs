#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultView = resolve(skillRoot, '../..');
const usage = `Usage: node skills/forgeax-view-start/scripts/start-view.mjs --project <absolute-path> --engine <checkout> [options]

Options:
  --view <checkout>       View checkout (default: the checkout containing this script)
  --root <directory>      Backend workspace (default: a managed cache per project)
  --build auto|always|never  Build stale Engine/View outputs (default: auto)
  --profile <name>        Shader profile (default: base-ssao)
  --restart               Restart a compatible managed backend
  --help                  Show this help

The last stdout line is one JSON result. Progress and command diagnostics go to stderr.
The script does not open a browser or start Play.`;

function fail(stage, message, detail) {
  const error = new Error(message);
  error.stage = stage;
  error.detail = detail;
  throw error;
}

function parseArgs(argv) {
  const options = { build: 'auto', profile: 'base-ssao', view: defaultView, restart: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') { options.help = true; continue; }
    if (arg === '--restart') { options.restart = true; continue; }
    if (!['--project', '--engine', '--view', '--root', '--build', '--profile'].includes(arg)) fail('arguments', `Unknown option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail('arguments', `Missing value for ${arg}`);
    options[arg.slice(2)] = value;
  }
  if (!options.help && (!options.project || !options.engine)) fail('arguments', 'Both --project and --engine are required.');
  if (!['auto', 'always', 'never'].includes(options.build)) fail('arguments', '--build must be auto, always, or never.');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(options.profile)) fail('arguments', 'Invalid shader profile.');
  return options;
}

async function run(file, args, { cwd, stage, json = false } = {}) {
  process.stderr.write(`\n[view-start] ${stage}: ${file} ${args.join(' ')}\n`);
  const child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; if (!json) process.stderr.write(chunk); });
  child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
  const code = await new Promise((done, reject) => {
    child.on('error', reject);
    child.on('close', done);
  });
  if (json) {
    let result;
    try { result = JSON.parse(stdout.trim().split('\n').at(-1)); }
    catch { fail(stage, `Command did not return JSON (exit ${code}).`, { stdout: stdout.slice(-3000), stderr: stderr.slice(-3000) }); }
    if (code !== 0 || !result.ok) fail(stage, result.error?.message ?? result.error?.code ?? `Command exited ${code}.`, result.error ?? result);
    return result.value;
  }
  if (code !== 0) fail(stage, `Command exited ${code}.`, { stderr: stderr.slice(-3000) });
  return stdout.trim();
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function isNonempty(path) {
  try { return (await stat(path)).size > 0; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function gitState(root) {
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: root, stage: 'git head' });
  const dirty = await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, stage: 'git status' });
  const timestamp = Number(await run('git', ['log', '-1', '--format=%ct'], { cwd: root, stage: 'git timestamp' })) * 1000;
  return { head, dirty: Boolean(dirty), timestamp };
}

async function cli(entry, root, stage, ...args) {
  return run(process.execPath, [entry, ...args, '--root', root, '--json'], { cwd: root, stage, json: true });
}

async function ensureLink(link, target, stage) {
  let current = null;
  try { current = await realpath(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current === target) return false;
  if (current) fail(stage, `${link} resolves to ${current}; expected ${target}. Resolve this package conflict first.`);
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link, 'dir');
  return true;
}

async function ensureHost(root, project, enginePackage, view, explicit) {
  const markerPath = join(root, '.forgeax-view-start.json');
  const marker = await readJson(markerPath);
  if (marker && (marker.project !== project || marker.enginePackage !== enginePackage || marker.view !== view)) {
    fail('host', `Managed workspace ${root} belongs to another project, Engine, or View.`, marker);
  }
  if (!marker && existsSync(root)) {
    const contents = await readdir(root);
    if (contents.length) fail('host', `${root} is not an empty managed workspace; choose another --root.`);
  }
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'forgeax-view-start-host', private: true, type: 'module', dependencies: { '@forgeax/engine': '*', '@forgeax/view': '*' } }, null, 2) + '\n');
  await ensureLink(join(root, 'node_modules/@forgeax/engine'), enginePackage, 'host Engine link');
  await ensureLink(join(root, 'node_modules/@forgeax/view'), view, 'host View link');
  if (!marker) await writeFile(markerPath, JSON.stringify({ schemaVersion: 1, project, enginePackage, view, explicit }, null, 2) + '\n');
  return markerPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(`${usage}\n`); return; }
  const project = await realpath(resolve(options.project));
  const engine = await realpath(resolve(options.engine));
  const view = await realpath(resolve(options.view));
  const embeddedView = await realpath(join(engine, 'tools/view'));
  if (view !== embeddedView) fail('view', 'Use the fixed tools/view source from the selected Engine checkout.');
  if (!(await isNonempty(join(project, 'forge.json')))) fail('project', `${project} has no forge.json.`);
  const enginePackage = join(engine, 'packages/engine');
  const entry = join(enginePackage, 'dist/bin/forgeax.mjs');
  const hostPack = join(view, 'host.pack.json');
  if (!(await isNonempty(hostPack))) fail('view', `Missing ${hostPack}.`);
  const digest = createHash('sha256').update(JSON.stringify([project, engine, view])).digest('hex').slice(0, 16);
  const root = resolve(options.root ?? join(homedir(), '.cache/forgeax/view-start', digest));
  if (root === project || root.startsWith(project + sep)) fail('host', 'Backend workspace must be outside the game project.');

  const engineGit = await gitState(engine);
  const viewGit = await gitState(view);
  const provenance = await readJson(join(engine, 'node_modules/.cache/forgeax-build/engine-provenance.json'));
  const engineReady = await isNonempty(entry) && provenance?.source?.head === engineGit.head && !engineGit.dirty && provenance?.source?.trackedClean === true;
  const viewOutputs = ['dist/modules/plugin.mjs', 'dist/modules/commands.mjs', 'dist/viewer/index.html'];
  const viewStats = await Promise.all(viewOutputs.map(path => stat(join(view, path)).catch(() => null)));
  const viewReady = !viewGit.dirty && viewStats.every(value => value?.size > 0 && value.mtimeMs >= viewGit.timestamp);
  const buildEngine = options.build === 'always' || (options.build === 'auto' && !engineReady);
  const buildView = options.build === 'always' || (options.build === 'auto' && !viewReady);
  if (options.build === 'never' && (!engineReady || !viewReady)) fail('build', 'Built Engine or View output is missing or stale; rerun with --build auto.');

  const markerPath = join(root, '.forgeax-view-start.json');
  const marker = await readJson(markerPath);
  let backend = null;
  if (existsSync(entry) && existsSync(root)) backend = await cli(entry, root, 'backend status', 'backend', 'status');
  if (backend?.phase === 'ready') {
    if (!marker) fail('backend', `Running backend at ${root} is not owned by this script.`);
    if (await realpath(backend.hostPack).catch(() => backend.hostPack) !== hostPack) fail('backend', `Backend uses ${backend.hostPack}; expected ${hostPack}.`);
    if (options.restart || buildEngine || buildView) {
      const viewStatus = await cli(entry, root, 'view status', 'view', 'status');
      if (viewStatus.phase === 'ready') await cli(entry, root, 'view stop', 'view', 'stop');
      await cli(entry, root, 'backend stop', 'backend', 'stop');
      backend = null;
    }
  }

  if (buildEngine && !existsSync(join(engine, 'node_modules'))) await run('pnpm', ['install', '--frozen-lockfile'], { cwd: engine, stage: 'install Engine dependencies' });
  if (buildEngine) await run('pnpm', ['build:engine'], { cwd: engine, stage: 'build Engine' });
  if (!(await isNonempty(entry))) fail('build Engine', `Missing ${entry}.`);
  if (buildView && !existsSync(join(view, 'node_modules'))) await run('pnpm', ['install', '--frozen-lockfile'], { cwd: engine, stage: 'install shared workspace dependencies' });
  if (buildView) await run('pnpm', ['build:tools'], { cwd: engine, stage: 'build Engine tools' });
  for (const output of viewOutputs) if (!(await isNonempty(join(view, output)))) fail('build View', `Missing ${join(view, output)}.`);

  const profileRoot = join(engine, 'packages/vite-plugin-shader/dist/engine-inputs', options.profile);
  const profileReady = await Promise.all(['manifest.json', 'imports.json'].map(name => isNonempty(join(profileRoot, name))));
  if (options.build === 'always' || buildEngine || profileReady.some(ready => !ready)) {
    if (options.build === 'never') fail('shader profile', `${options.profile} shader inputs are missing; rerun with --build auto.`);
    await run(process.execPath, ['scripts/forgeax/prepare-shader-release-inputs.mjs', '--build', '--profile', options.profile], { cwd: engine, stage: 'prepare shader profile' });
  }
  for (const name of ['manifest.json', 'imports.json']) if (!(await isNonempty(join(profileRoot, name)))) fail('shader profile', `Missing ${join(profileRoot, name)}.`);

  const projectLink = join(project, 'node_modules/@forgeax/engine');
  await ensureLink(projectLink, enginePackage, 'project Engine link');
  const binding = await cli(entry, project, 'project engine status', 'project', 'engine', 'status');
  if (binding.mode !== 'local' || binding.resolved?.root !== engine) await cli(entry, project, 'project engine use-local', 'project', 'engine', 'use-local', engine);
  const checked = await run(process.execPath, [entry, 'project', 'engine', 'check', '--root', project, '--json'], { cwd: project, stage: 'project engine check', json: true }).catch(error => {
    if (error.detail?.code === 'engine-project-workspace-dependency' && project.startsWith(engine + sep)) return { workspaceTemplate: true };
    throw error;
  });
  if (!checked.healthy && !checked.workspaceTemplate) fail('project engine check', 'Engine binding is not healthy.', checked);

  await ensureHost(root, project, enginePackage, view, Boolean(options.root));
  if (!backend || backend.phase !== 'ready') backend = await cli(entry, root, 'backend start', 'backend', 'start', '--host-pack', hostPack);
  const started = await cli(entry, root, 'view start', 'view', 'start', '--project', project);
  if (!started.url) fail('view start', 'View returned no URL.', started);
  const url = new URL(started.url);
  if (url.searchParams.get('project') !== project) fail('view start', 'View URL does not carry the requested project.', { url: started.url });
  const response = await fetch(new URL('/__forgeax/view/bootstrap', url), { signal: AbortSignal.timeout(10_000) }).catch(error => fail('view health', error.message));
  if (!response.ok) fail('view health', `View bootstrap returned HTTP ${response.status}.`);
  process.stdout.write(JSON.stringify({ ok: true, url: started.url, project, root, engineEntry: entry, hostPack, backend: { phase: backend.phase, pid: backend.pid }, view: { phase: started.phase ?? 'ready' }, built: { engine: buildEngine, view: buildView }, shaderProfile: options.profile }) + '\n');
}

main().catch(error => {
  process.stderr.write(`[view-start] ${error.stage ?? 'unexpected'}: ${error.message}\n`);
  process.stdout.write(JSON.stringify({ ok: false, stage: error.stage ?? 'unexpected', error: error.message, detail: error.detail }) + '\n');
  process.exitCode = 1;
});
