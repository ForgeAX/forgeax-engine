#!/usr/bin/env node
import { spawn } from 'node:child_process';
// bevy-demo.mjs — create Bevy demo app shells and derive their CI smoke membership.
//
// An app's package.json#forgeax.bevyExample + smokeInvocation is the one per-example
// spec. It already drives coverage; this command writes that existing contract rather
// than introducing a second ledger that every demo would need to synchronize.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  createPrebuildInvocation,
  createViteBuildInvocation,
  resolveViteCli,
  validateCanonicalAppBuild,
} from './lib/app-build-launcher.mjs';
import {
  readMemoryPressureDiagnostics,
  runnerResources,
  workspaceConcurrency,
} from './lib/runner-resources.mjs';

const VALID_STATUS = new Set(['partial', 'implemented', 'shelved']);
const STANDARD_SMOKE_COMMAND = 'node scripts/smoke-dawn.mjs';
const SMOKE_PASS_MARKER = '[smoke] PASS';
// Keep the build phase bounded on shared CI runners; native Dawn children are
// serialized in a separate phase below, preserving the complete three-shard
// roster and explicit concurrency flag without overlapping memory domains.
const AUTO_SMOKE_MAX_CONCURRENCY = 2;
const SMOKE_REAP_DELAY_MS = 50;
const SMOKE_LIFECYCLE_MODULE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'bevy-smoke-lifecycle.mjs',
);

function fail(code, expected, hint) {
  throw new Error(`[reason] ${code}: ${expected}\n[rerun]  pnpm bevy:validate\n[hint]   ${hint}`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail('bevy-demo-json-invalid', `${label} is valid JSON`, `${path}: ${String(error)}`);
  }
}

function validateSpec(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('bevy-demo-spec-invalid', `${label} is a JSON object`, `got ${JSON.stringify(value)}`);
  }
  const spec = value;
  if (typeof spec.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(spec.id)) {
    fail(
      'bevy-demo-id-invalid',
      `${label}.id is lowercase kebab-case`,
      `got ${JSON.stringify(spec.id)}`,
    );
  }
  if (typeof spec.name !== 'string' || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(spec.name)) {
    fail(
      'bevy-demo-name-invalid',
      `${label}.name is a Bevy example snake_case name`,
      `got ${JSON.stringify(spec.name)}`,
    );
  }
  if (typeof spec.category !== 'string' || spec.category.trim() === '') {
    fail(
      'bevy-demo-category-invalid',
      `${label}.category is a non-empty Bevy category`,
      `got ${JSON.stringify(spec.category)}`,
    );
  }
  if (typeof spec.title !== 'string' || spec.title.trim() === '') {
    fail(
      'bevy-demo-title-invalid',
      `${label}.title is non-empty`,
      `got ${JSON.stringify(spec.title)}`,
    );
  }
  const declaration = validateDeclaration(spec, label);
  return { id: spec.id, ...declaration, title: spec.title };
}

function validateDeclaration(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('bevy-demo-spec-invalid', `${label} is a JSON object`, `got ${JSON.stringify(value)}`);
  }
  const declaration = value;
  if (
    typeof declaration.name !== 'string' ||
    !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(declaration.name)
  ) {
    fail(
      'bevy-demo-name-invalid',
      `${label}.name is a Bevy example snake_case name`,
      `got ${JSON.stringify(declaration.name)}`,
    );
  }
  if (typeof declaration.category !== 'string' || declaration.category.trim() === '') {
    fail(
      'bevy-demo-category-invalid',
      `${label}.category is a non-empty Bevy category`,
      `got ${JSON.stringify(declaration.category)}`,
    );
  }
  const status = declaration.status ?? 'partial';
  if (!VALID_STATUS.has(status)) {
    fail(
      'bevy-demo-status-invalid',
      `${label}.status in {partial, implemented, shelved}`,
      `got ${JSON.stringify(status)}`,
    );
  }
  return { name: declaration.name, category: declaration.category, status };
}

function appDir(root, id) {
  return resolve(root, 'apps', 'bevy', id);
}

function packageName(spec) {
  return `@forgeax/bevy-${spec.id}`;
}

function smokeInvocation(packageNameValue) {
  return `pnpm --filter ${packageNameValue} smoke`;
}

function packageJson(spec) {
  const name = packageName(spec);
  const smoke = smokeInvocation(name);
  return {
    name,
    version: '0.0.0',
    private: true,
    type: 'module',
    license: 'Apache-2.0',
    description: `Scaffold for Bevy's \`${spec.name}\` example. Replace the placeholder scene and smoke before promoting this scaffold to forgeax.bevyExample.`,
    scripts: {
      dev: 'vite',
      typecheck: 'tsc --noEmit',
      build: 'vite build',
      preview: 'vite preview',
      smoke: STANDARD_SMOKE_COMMAND,
    },
    forgeax: {
      bevyExample: { name: spec.name, category: spec.category, status: spec.status },
      ...(spec.status === 'implemented' ? { smokeInvocation: smoke } : {}),
      metrics: {
        'bundle-size': {
          enabled: false,
          reason:
            'vite app bundle downstream of engine-runtime sizes already tracked at the package level',
        },
        fps: {
          enabled: false,
          reason: 'demo-specific fps evidence belongs to its completed reproduction',
        },
        bench: {
          enabled: false,
          reason: 'demo-specific benchmarks belong to its completed reproduction',
        },
        gate:
          spec.status === 'implemented'
            ? { enabled: true, command: smoke }
            : {
                enabled: false,
                reason: 'scaffold is not a front-door-verified Bevy reproduction yet',
              },
        'spike-report': { enabled: false, reason: 'not a spike app; Bevy example reproduction' },
      },
    },
    dependencies: {
      '@forgeax/engine-app': 'workspace:*',
      '@forgeax/engine-assets-runtime': 'workspace:*',
      '@forgeax/engine-ecs': 'workspace:*',
      '@forgeax/engine-math': 'workspace:*',
      '@forgeax/engine-runtime': 'workspace:*',
    },
    devDependencies: {
      '@forgeax/engine-vite-plugin-rhi-debug': 'workspace:*',
      '@forgeax/engine-vite-plugin-shader': 'workspace:*',
      '@webgpu/types': '^0.1.71',
      vite: '8.0.10',
      webgpu: '^0.4.0',
    },
  };
}

export function findAppPackageJsons(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    acc.push(pkgPath);
    return acc;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.'))
      continue;
    findAppPackageJsons(join(dir, entry.name), acc);
  }
  return acc;
}

function isDedicatedBevyApp(root, pkgPath) {
  const parts = relative(resolve(root, 'apps'), dirname(pkgPath)).split(sep);
  return parts.length === 2 && parts[0] === 'bevy';
}

function files(spec) {
  return {
    'index.html': `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>forgeax-engine - ${spec.title.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</title>
    <style>
      html, body { margin: 0; padding: 0; height: 100%; background: #000; }
      canvas { display: block; width: 100vw; height: 100vh; }
    </style>
  </head>
  <body>
    <canvas id="app"></canvas>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
    'tsconfig.json': `{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "../..",
    "noEmit": true,
    "emitDeclarationOnly": false,
    "types": ["@webgpu/types"]
  },
  "include": ["src/**/*"]
}
`,
    'vite.config.ts': `import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');

export default defineConfig({
  plugins: [forgeaxShader() as never, vitePluginRhiDebug()],
  server: { fs: { allow: [monorepoRoot] } },
  build: { target: 'esnext', rollupOptions: { input: { main: resolve(here, 'index.html') } } },
});
`,
    'src/vite-env.d.ts': `// apps/bevy/${spec.id} -- ambient declarations.
// virtual:forgeax/bundler is injected by the shader plugin for browser builds.

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
`,
    'src/main.ts': `const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-${spec.id}: missing <canvas id="app"> in index.html');

// This shell is deliberately not a reproduction yet. Build the shared scene,
// real Dawn smoke, and front-door evidence before promoting this app to
// forgeax.bevyExample.status = 'implemented'.
console.warn('[bevy-${spec.id}] scaffold ready; implement Bevy ${spec.name}');
`,
    'scripts/smoke-dawn.mjs': `#!/usr/bin/env node
console.error('[reason] bevy-demo-scaffold-unimplemented: ${spec.id} needs a real Dawn smoke before it can run in CI');
console.error('[rerun]  pnpm --filter ${packageName(spec)} smoke');
console.error('[hint]   implement the Bevy ${spec.name} scene and replace this placeholder before setting status to implemented');
process.exitCode = 1;
`,
  };
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function validateDemoApps(root, { includeNonDedicated = false } = {}) {
  const appsRoot = resolve(root, 'apps');
  if (!existsSync(appsRoot)) return [];
  const apps = [];
  for (const pkgPath of findAppPackageJsons(appsRoot)) {
    const app = dirname(pkgPath);
    const pkg = readJson(pkgPath, 'package.json');
    const be = pkg?.forgeax?.bevyExample;
    const dedicated = isDedicatedBevyApp(root, pkgPath);
    if (!dedicated && !includeNonDedicated) continue;
    if (!be || typeof be !== 'object' || (dedicated && Array.isArray(be))) {
      if (dedicated) {
        fail(
          'bevy-demo-spec-missing',
          `${relative(root, pkgPath)} has forgeax.bevyExample`,
          'new Bevy apps must use pnpm bevy:new-demo',
        );
      }
      continue;
    }
    const label = `${relative(root, pkgPath)}#forgeax.bevyExample`;
    const declarations = Array.isArray(be)
      ? be.map((value, index) => validateDeclaration(value, `${label}[${index}]`))
      : [
          dedicated
            ? validateSpec(
                { id: app.split(sep).at(-1), title: app.split(sep).at(-1), ...be },
                label,
              )
            : validateDeclaration(be, label),
        ];
    if (dedicated) {
      const spec = declarations[0];
      const expectedName = packageName(spec);
      if (pkg.name !== expectedName) {
        fail(
          'bevy-demo-projection-stale',
          `${relative(root, pkgPath)} has package name '${expectedName}'`,
          `got ${JSON.stringify(pkg.name)}`,
        );
      }
    }
    const hasImplemented = declarations.some((declaration) => declaration.status === 'implemented');
    if (hasImplemented && (typeof pkg.description !== 'string' || pkg.description.trim() === '')) {
      fail(
        'bevy-demo-description-missing',
        `${relative(root, pkgPath)} describes a real implemented reproduction`,
        'add a concise description before keeping status=implemented',
      );
    }
    if (hasImplemented && /\b(?:scaffold|placeholder)\b/i.test(pkg.description ?? '')) {
      fail(
        'bevy-demo-description-stale',
        `${relative(root, pkgPath)} describes a real implemented reproduction`,
        'replace scaffold/placeholder wording before keeping status=implemented',
      );
    }
    const dawnSmokePath = join(dirname(pkgPath), 'scripts', 'smoke-dawn.mjs');
    const dawnSmokeSource = existsSync(dawnSmokePath)
      ? readFileSync(dawnSmokePath, 'utf8')
      : undefined;
    if (hasImplemented && dawnSmokeSource?.includes('bevy-demo-scaffold-unimplemented')) {
      fail(
        'bevy-demo-smoke-stale',
        `${relative(root, dawnSmokePath)} is a real implemented smoke front door`,
        'replace the generated scaffold smoke with a real Dawn reproduction before keeping status=implemented',
      );
    }
    const expectedSmoke = smokeInvocation(pkg.name);
    const smoke = pkg?.forgeax?.smokeInvocation;
    const gate = pkg?.forgeax?.metrics?.gate?.command;
    const smokeCommand =
      typeof pkg?.scripts?.smoke === 'string' ? pkg.scripts.smoke.trim() : undefined;
    if (hasImplemented) {
      if (typeof pkg?.scripts?.smoke !== 'string' || pkg.scripts.smoke.trim() === '') {
        fail(
          'bevy-demo-smoke-script-missing',
          `${relative(root, pkgPath)} exposes the smoke script invoked by the fleet`,
          'add a package scripts.smoke command before keeping status=implemented',
        );
      }
      if (smokeCommand === STANDARD_SMOKE_COMMAND && !existsSync(dawnSmokePath)) {
        fail(
          'bevy-demo-smoke-entry-missing',
          `${relative(root, dawnSmokePath)} is the standard Dawn smoke entry point`,
          'add scripts/smoke-dawn.mjs or use a non-standard smoke command',
        );
      }
      if (
        smokeCommand === STANDARD_SMOKE_COMMAND &&
        !dawnSmokeSource?.includes(SMOKE_PASS_MARKER)
      ) {
        fail(
          'bevy-demo-smoke-pass-missing',
          `${relative(root, dawnSmokePath)} emits the standard smoke PASS marker`,
          'print [smoke] PASS after all evidence assertions pass',
        );
      }
      // Dedicated apps/bevy apps run in the Bevy fleet, which invokes the
      // standard smoke. Other apps own their smoke membership elsewhere (Dawn
      // roster, dedicated CI job), so any smoke* script of their own package
      // is valid as long as smoke and gate name the same command.
      const ownScript =
        typeof smoke === 'string' ? smoke.match(/^pnpm --filter (\S+) (smoke\S*)$/) : null;
      const valid = dedicated
        ? smoke === expectedSmoke
        : ownScript?.[1] === pkg.name && typeof pkg?.scripts?.[ownScript[2]] === 'string';
      if (!valid || gate !== smoke) {
        fail(
          'bevy-demo-projection-stale',
          `${relative(root, pkgPath)} derives smoke metadata from package identity`,
          `smoke=${JSON.stringify(smoke)} gate=${JSON.stringify(gate)} expected=${JSON.stringify(dedicated ? expectedSmoke : `pnpm --filter ${pkg.name} <smoke script>`)}`,
        );
      }
    } else if (smoke !== undefined || gate !== undefined) {
      fail(
        'bevy-demo-partial-has-smoke',
        `${relative(root, pkgPath)} partial/shelved app has no smoke membership`,
        'only a front-door-verified implemented demo may declare smokeInvocation and a smoke gate',
      );
    }
    apps.push({
      dir: app,
      pkg,
      spec: declarations[0],
      declarations,
      dedicated,
    });
  }
  return apps;
}

function commandNew(root, specPath) {
  if (!specPath)
    fail(
      'bevy-demo-spec-required',
      'new receives a JSON spec path',
      'pnpm bevy:new-demo -- ./my-demo.json',
    );
  const spec = validateSpec(readJson(resolve(specPath), 'input spec'), specPath);
  if (spec.status !== 'partial') {
    fail(
      'bevy-demo-scaffold-status-invalid',
      'a newly scaffolded demo has status "partial"',
      'a scaffold has no real scene or smoke yet; promote it only after a future demo round provides both',
    );
  }
  const dir = appDir(root, spec.id);
  if (existsSync(dir)) {
    fail(
      'bevy-demo-target-exists',
      `${relative(root, dir)} does not already exist`,
      'choose a new id; this command never overwrites an app',
    );
  }
  write(join(dir, 'package.json'), `${JSON.stringify(packageJson(spec), null, 2)}\n`);
  for (const [path, content] of Object.entries(files(spec))) write(join(dir, path), content);
  process.stdout.write(`[ok] created ${relative(root, dir)}\n`);
}

function commandValidate(root) {
  const apps = validateDemoApps(root, { includeNonDedicated: true });
  process.stdout.write(`[ok] ${apps.length} Bevy demo package specs are valid\n`);
}

function parseGroups(value) {
  const groups = Number(value);
  if (!Number.isInteger(groups) || groups < 1 || groups > 16) {
    fail(
      'bevy-demo-groups-invalid',
      'smoke groups is an integer from 1 to 16',
      `got ${JSON.stringify(value)}`,
    );
  }
  return groups;
}

function parseGroup(value, groups) {
  const group = Number(value);
  if (!Number.isInteger(group) || group < 0 || group >= groups) {
    fail(
      'bevy-demo-group-invalid',
      `smoke group is an integer from 0 to ${groups - 1}`,
      `got ${JSON.stringify(value)}`,
    );
  }
  return group;
}

export function autoSmokeConcurrency({ cpus, memoryBytes }) {
  return Math.min(
    AUTO_SMOKE_MAX_CONCURRENCY,
    workspaceConcurrency({ cpus, memoryBytes, reserveGB: 2, workerGB: 3 }),
  );
}

function parseConcurrency(value) {
  if (value === 'auto') {
    const { cpus, memoryBytes, containerized } = runnerResources();
    const concurrency = autoSmokeConcurrency({ cpus, memoryBytes });
    process.stderr.write(
      `[bevy-smoke] auto concurrency=${concurrency} (${cpus} cpu, ${Math.ceil(memoryBytes / 1024 ** 3)}GB, ${containerized ? 'cgroup' : 'host'})\n`,
    );
    return concurrency;
  }
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    fail(
      'bevy-demo-concurrency-invalid',
      'smoke concurrency is an integer from 1 to 16',
      `got ${JSON.stringify(value)}`,
    );
  }
  return concurrency;
}

function runPnpm(root, args) {
  return new Promise((resolveRun) => {
    const child = spawn('pnpm', args, { cwd: root, stdio: 'inherit' });
    child.once('error', (error) => resolveRun({ status: null, error }));
    child.once('exit', (code, signal) => resolveRun({ status: code, signal }));
  });
}

export function runNodeSmoke(root, app) {
  const script = 'scripts/smoke-dawn.mjs';
  process.stdout.write(
    `[bevy-smoke] ${process.execPath} ${relative(root, join(app.dir, script))}\n`,
  );
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--import', SMOKE_LIFECYCLE_MODULE, script], {
      cwd: app.dir,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let passObserved = false;
    let successExitObserved = false;
    let failureExitObserved = false;
    let reapRequested = false;
    let outputTail = '';
    let forceExitTimer;
    const requestReap = () => {
      if (reapRequested || child.exitCode !== null || child.signalCode !== null) return;
      reapRequested = true;
      child.kill('SIGKILL');
    };
    const forward = (chunk, stream) => {
      const text = chunk.toString();
      stream.write(text);
      const searchable = outputTail + text;
      outputTail = searchable.slice(-128);
      if (!passObserved && searchable.includes(SMOKE_PASS_MARKER)) {
        passObserved = true;
        // A native WebGPU child can keep Node alive after its evidence gate.
        // The lifecycle control pipe normally gives us an exact exit boundary;
        // retain a short fallback for test modules that only print PASS.
        if (failureExitObserved) return;
        if (successExitObserved) {
          requestReap();
          return;
        }
        forceExitTimer = setTimeout(requestReap, SMOKE_REAP_DELAY_MS);
        forceExitTimer.unref();
      }
    };
    child.stdout.on('data', (chunk) => forward(chunk, process.stdout));
    child.stderr.on('data', (chunk) => forward(chunk, process.stderr));
    child.stdio[3]?.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (line === '0') {
          successExitObserved = true;
          if (passObserved) requestReap();
        } else if (line !== '' && Number.isInteger(Number(line))) {
          failureExitObserved = true;
          if (forceExitTimer) clearTimeout(forceExitTimer);
        }
      }
    });
    child.once('error', (error) => resolveRun({ status: null, error }));
    child.once('close', (code, signal) => {
      if (forceExitTimer) clearTimeout(forceExitTimer);
      const status = passObserved && signal === 'SIGKILL' ? 0 : code === 0 ? 1 : code;
      resolveRun({ status, signal });
    });
  });
}

async function buildApp(root, app) {
  const task = { directory: app.dir, manifest: app.pkg };
  validateCanonicalAppBuild(task);
  const invocations = [
    createPrebuildInvocation({ app: task }),
    createViteBuildInvocation({ app: task, viteCliPath: resolveViteCli(root) }),
  ];
  for (const invocation of invocations) {
    if (invocation === null) continue;
    process.stdout.write(
      `[bevy-smoke] build ${app.pkg.name}: ${invocation.command} ${invocation.args.join(' ')}\n`,
    );
    await new Promise((resolveBuild, rejectBuild) => {
      const child = spawn(invocation.command, invocation.args, invocation.options);
      child.once('error', rejectBuild);
      child.once('close', (code, signal) => {
        if (code === 0) resolveBuild();
        else
          rejectBuild(
            new Error(`[bevy-smoke] ${app.pkg.name} build failed with ${signal ?? code}`),
          );
      });
    });
  }
}

async function runSmokeApp(root, app) {
  const pkg = app.pkg;
  const smokeArgs = ['--filter', pkg.name, 'smoke'];
  let result;
  // Standard Dawn smokes are already direct Node entry points. Running them
  // outside pnpm avoids a package-manager lifecycle wrapper retaining native
  // Dawn descendants after the smoke has emitted its PASS evidence.
  if (pkg.scripts?.smoke?.trim() === STANDARD_SMOKE_COMMAND) {
    result = await runNodeSmoke(root, app);
  } else {
    process.stdout.write(`[bevy-smoke] pnpm ${smokeArgs.join(' ')}\n`);
    result = await runPnpm(root, smokeArgs);
  }
  if (result.status !== 0) {
    const cgroupMemory = result.signal === 'SIGKILL' ? readMemoryPressureDiagnostics() : undefined;
    const detail = cgroupMemory ? `; cgroup-memory=${JSON.stringify(cgroupMemory)}` : '';
    throw new Error(
      `[bevy-smoke] ${pkg.name} smoke failed with ${result.error?.message ?? result.signal ?? result.status}${detail}`,
    );
  }
}

/**
 * Keep Vite builds bounded in parallel, then serialize native WebGPU smokes.
 * Builds and Dawn children have different memory profiles; overlapping them
 * lets two lavapipe devices push a 16 GB runner into the cgroup OOM killer.
 */
export async function runSmokeStages(root, apps, concurrency, runners = {}) {
  const build = runners.build ?? buildApp;
  const smoke = runners.smoke ?? runSmokeApp;
  let next = 0;
  let firstError;
  async function buildWorker() {
    while (firstError === undefined) {
      const app = apps[next++];
      if (app === undefined) return;
      try {
        await build(root, app);
      } catch (error) {
        firstError = error;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, apps.length) }, () => buildWorker()),
  );
  if (firstError !== undefined) throw firstError;
  for (const app of apps) await smoke(root, app);
}

export function bevySmokeApps(root) {
  return validateDemoApps(root).filter((app) => app.dedicated && app.spec.status === 'implemented');
}

async function commandSmokes(root, dryRun, concurrency, group, groups) {
  const allApps = bevySmokeApps(root);
  const apps = allApps.filter((_, index) => index % groups === group);
  if (dryRun) {
    for (const { pkg } of apps) {
      process.stdout.write(`[bevy-smoke] pnpm --filter ${pkg.name} build\n`);
      process.stdout.write(`[bevy-smoke] pnpm --filter ${pkg.name} smoke\n`);
    }
  } else {
    await runSmokeStages(root, apps, concurrency);
  }
  process.stdout.write(
    `[ok] ${apps.length}/${allApps.length} implemented Bevy demo smoke entries completed${dryRun ? ' (dry run)' : ''} with concurrency=${concurrency} group=${group}/${groups}\n`,
  );
}

async function main() {
  const argv = process.argv.slice(2).filter((argument) => argument !== '--');
  let root = process.cwd();
  let dryRun = false;
  let concurrency = 1;
  let groupValue = '0';
  let groupsValue = '1';
  for (let i = 0; i < argv.length; ) {
    if (argv[i] === '--root') {
      const value = argv[i + 1];
      if (!value)
        fail('bevy-demo-root-required', '--root has a directory', 'pass --root <repo-root>');
      root = resolve(value);
      argv.splice(i, 2);
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
      argv.splice(i, 1);
    } else if (argv[i] === '--concurrency') {
      const value = argv[i + 1];
      if (value === undefined)
        fail(
          'bevy-demo-concurrency-required',
          '--concurrency has a value',
          'pass --concurrency <N>',
        );
      concurrency = parseConcurrency(value);
      argv.splice(i, 2);
    } else if (argv[i] === '--group') {
      const value = argv[i + 1];
      if (value === undefined)
        fail('bevy-demo-group-required', '--group has a value', 'pass --group <N>');
      groupValue = value;
      argv.splice(i, 2);
    } else if (argv[i] === '--groups') {
      const value = argv[i + 1];
      if (value === undefined)
        fail('bevy-demo-groups-required', '--groups has a value', 'pass --groups <N>');
      groupsValue = value;
      argv.splice(i, 2);
    } else {
      i++;
    }
  }
  const groups = parseGroups(groupsValue);
  const group = parseGroup(groupValue, groups);
  const [command, argument] = argv;
  if (command === 'new') commandNew(root, argument);
  else if (command === 'validate') commandValidate(root);
  else if (command === 'smokes') await commandSmokes(root, dryRun, concurrency, group, groups);
  else
    fail(
      'bevy-demo-command-unknown',
      'command in {new, validate, smokes}',
      `got ${JSON.stringify(command)}`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
