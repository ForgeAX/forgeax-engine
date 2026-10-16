import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { autoSmokeConcurrency, runNodeSmoke, runSmokeStages } from '../bevy-demo.mjs';

const repoRoot = resolve(__dirname, '..', '..');
const script = resolve(repoRoot, 'scripts/bevy-demo.mjs');
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-bevy-demo-'));
  mkdirSync(join(root, 'apps', 'bevy'), { recursive: true });
  roots.push(root);
  return root;
}

function run(root: string, ...args: string[]) {
  return spawnSync('node', [script, '--root', root, ...args], { encoding: 'utf8' });
}

function spec(root: string, id = 'tiny-demo') {
  const path = join(root, `${id}.json`);
  writeFileSync(
    path,
    JSON.stringify({ id, name: 'tiny_demo', category: 'Animation', title: 'Tiny Demo' }),
  );
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bevy-demo.mjs', () => {
  it('drains depth-of-field frames while preserving the 60-frame pixel falsifier', () => {
    const source = readFileSync(
      join(repoRoot, 'apps/bevy/depth-of-field/scripts/smoke-dawn.mjs'),
      'utf8',
    );
    expect(source).toMatch(/async function drawFrames\(count\)/);
    expect(source).toMatch(
      /drawSmokeFrame\(renderer, world\);\s*if \(!result\.ok\) failures \+= 1;\s*await sharedDevice\.queue\.onSubmittedWorkDone\(\);/,
    );
    expect(source.match(/drawErrors \+= await drawFrames\(/g)).toHaveLength(3);
    expect(source).toContain(
      "Math.max(Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10), 60)",
    );
    expect(source).toContain('const offPixels = await capturePixels()');
    expect(source).toContain('const onPixels = await capturePixels()');
    expect(source).toContain('diff.mean <= 0.05 || diff.changedPixels <= 100');
  });

  it('creates a partial app with the standard package, Vite, and smoke shell', () => {
    const root = tempRoot();
    const result = run(root, 'new', spec(root));
    expect(result.status, result.stderr).toBe(0);

    const dir = join(root, 'apps', 'bevy', 'tiny-demo');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@forgeax/bevy-tiny-demo');
    expect(pkg.forgeax.bevyExample).toEqual({
      name: 'tiny_demo',
      category: 'Animation',
      status: 'partial',
    });
    expect(pkg.forgeax.smokeInvocation).toBeUndefined();
    expect(pkg.forgeax.metrics.gate).toMatchObject({ enabled: false });
    expect(readFileSync(join(dir, 'vite.config.ts'), 'utf8')).toContain('forgeaxShader');
    expect(readFileSync(join(dir, 'vite.config.ts'), 'utf8')).toContain('vitePluginRhiDebug');
    expect(pkg.devDependencies['@forgeax/engine-vite-plugin-rhi-debug']).toBe('workspace:*');
    expect(readFileSync(join(dir, 'src', 'vite-env.d.ts'), 'utf8')).toContain(
      "declare module 'virtual:forgeax/bundler'",
    );
    expect(readFileSync(join(dir, 'scripts', 'smoke-dawn.mjs'), 'utf8')).toContain(
      'bevy-demo-scaffold-unimplemented',
    );
  });

  it('accepts pnpm’s forwarded -- separator before the spec path', () => {
    const root = tempRoot();
    const result = run(root, 'new', '--', spec(root));
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'apps', 'bevy', 'tiny-demo', 'package.json'), 'utf8')).toContain(
      '@forgeax/bevy-tiny-demo',
    );
  });

  it('refuses to overwrite an existing target', () => {
    const root = tempRoot();
    const input = spec(root);
    expect(run(root, 'new', input).status).toBe(0);
    const second = run(root, 'new', input);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('bevy-demo-target-exists');
  });

  it('identifies a malformed existing app by package path', () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'bad-demo');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: '@forgeax/bevy-bad-demo' }));

    const result = run(root, 'validate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/bevy/bad-demo/package.json has forgeax.bevyExample');
  });

  it('rejects invalid ids before creating an app', () => {
    const root = tempRoot();
    const input = join(root, 'invalid.json');
    writeFileSync(
      input,
      JSON.stringify({
        id: 'Not valid',
        name: 'tiny_demo',
        category: 'Animation',
        title: 'Tiny Demo',
      }),
    );
    const result = run(root, 'new', input);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bevy-demo-id-invalid');
    expect(result.stderr).toContain('[reason]');
    expect(result.stderr).toContain('[rerun]');
    expect(result.stderr).toContain('[hint]');
  });

  it('detects a stale smoke projection instead of silently running it', () => {
    const root = tempRoot();
    expect(run(root, 'new', spec(root)).status).toBe(0);
    const path = join(root, 'apps', 'bevy', 'tiny-demo', 'package.json');
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    pkg.forgeax.smokeInvocation = 'pnpm definitely-not-the-demo';
    writeFileSync(path, JSON.stringify(pkg));

    const result = run(root, 'validate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bevy-demo-partial-has-smoke');
  });

  it('rejects scaffold wording on an implemented app', () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'implemented-demo');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@forgeax/bevy-implemented-demo',
        description: 'Scaffold placeholder for the implemented demo.',
        forgeax: {
          bevyExample: { name: 'implemented_demo', category: 'Animation', status: 'implemented' },
          smokeInvocation: 'pnpm --filter @forgeax/bevy-implemented-demo smoke',
          metrics: {
            gate: { command: 'pnpm --filter @forgeax/bevy-implemented-demo smoke' },
          },
        },
      }),
    );

    const result = run(root, 'validate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bevy-demo-description-stale');
  });

  it('rejects a missing description on an implemented app', () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'implemented-demo');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@forgeax/bevy-implemented-demo',
        forgeax: {
          bevyExample: { name: 'implemented_demo', category: 'Animation', status: 'implemented' },
          smokeInvocation: 'pnpm --filter @forgeax/bevy-implemented-demo smoke',
          metrics: {
            gate: { command: 'pnpm --filter @forgeax/bevy-implemented-demo smoke' },
          },
        },
      }),
    );

    const result = run(root, 'validate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bevy-demo-description-missing');
  });

  it('validates implemented Bevy declarations outside the dedicated apps/bevy tree', () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'hello', 'implemented-demo');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@forgeax/hello-implemented-demo',
        forgeax: {
          bevyExample: { name: 'implemented_demo', category: 'Animation', status: 'implemented' },
          smokeInvocation: 'pnpm --filter @forgeax/hello-implemented-demo smoke',
          metrics: {
            gate: { command: 'pnpm --filter @forgeax/hello-implemented-demo smoke' },
          },
        },
      }),
    );

    const result = run(root, 'validate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bevy-demo-description-missing');
    expect(result.stderr).toContain('apps/hello/implemented-demo/package.json');
  });

  it('accepts an own smoke* script outside apps/bevy and rejects another package', () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'hello', 'aggregate-demo');
    mkdirSync(app, { recursive: true });
    const write = (smoke: string) =>
      writeFileSync(
        join(app, 'package.json'),
        JSON.stringify({
          name: '@forgeax/hello-aggregate-demo',
          description: 'Aggregate smoke demo.',
          scripts: { smoke: 'node scripts/custom.mjs', 'smoke:all': 'pnpm run smoke' },
          forgeax: {
            bevyExample: { name: 'aggregate_demo', category: 'Animation', status: 'implemented' },
            smokeInvocation: smoke,
            metrics: { gate: { command: smoke } },
          },
        }),
      );

    write('pnpm --filter @forgeax/hello-aggregate-demo smoke:all');
    expect(run(root, 'validate').status).toBe(0);

    write('pnpm --filter @forgeax/hello-other smoke:all');
    const foreign = run(root, 'validate');
    expect(foreign.status).toBe(1);
    expect(foreign.stderr).toContain('bevy-demo-projection-stale');

    write('pnpm --filter @forgeax/hello-aggregate-demo smoke:missing');
    expect(run(root, 'validate').stderr).toContain('bevy-demo-projection-stale');
  });

  it('rejects the generated scaffold smoke on an implemented app', () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'implemented-demo');
    mkdirSync(join(app, 'scripts'), { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@forgeax/bevy-implemented-demo',
        description: 'Reproduction of the implemented demo.',
        forgeax: {
          bevyExample: { name: 'implemented_demo', category: 'Animation', status: 'implemented' },
          smokeInvocation: 'pnpm --filter @forgeax/bevy-implemented-demo smoke',
          metrics: {
            gate: { command: 'pnpm --filter @forgeax/bevy-implemented-demo smoke' },
          },
        },
      }),
    );
    writeFileSync(
      join(app, 'scripts', 'smoke-dawn.mjs'),
      "console.error('[reason] bevy-demo-scaffold-unimplemented: implemented-demo');\n",
    );

    const result = run(root, 'validate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bevy-demo-smoke-stale');
  });

  it('rejects an implemented app without the smoke script invoked by the fleet', () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'implemented-demo');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@forgeax/bevy-implemented-demo',
        description: 'Reproduction of the implemented demo.',
        forgeax: {
          bevyExample: { name: 'implemented_demo', category: 'Animation', status: 'implemented' },
          smokeInvocation: 'pnpm --filter @forgeax/bevy-implemented-demo smoke',
          metrics: {
            gate: { command: 'pnpm --filter @forgeax/bevy-implemented-demo smoke' },
          },
        },
      }),
    );

    const result = run(root, 'validate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bevy-demo-smoke-script-missing');
  });

  it('rejects the standard smoke command when its entry point is missing', () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'implemented-demo');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@forgeax/bevy-implemented-demo',
        description: 'Reproduction of the implemented demo.',
        scripts: { smoke: 'node scripts/smoke-dawn.mjs' },
        forgeax: {
          bevyExample: { name: 'implemented_demo', category: 'Animation', status: 'implemented' },
          smokeInvocation: 'pnpm --filter @forgeax/bevy-implemented-demo smoke',
          metrics: {
            gate: { command: 'pnpm --filter @forgeax/bevy-implemented-demo smoke' },
          },
        },
      }),
    );

    const result = run(root, 'validate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bevy-demo-smoke-entry-missing');
  });

  it('rejects a standard smoke entry without the PASS marker', () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'implemented-demo');
    mkdirSync(join(app, 'scripts'), { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@forgeax/bevy-implemented-demo',
        description: 'Reproduction of the implemented demo.',
        scripts: { smoke: 'node scripts/smoke-dawn.mjs' },
        forgeax: {
          bevyExample: { name: 'implemented_demo', category: 'Animation', status: 'implemented' },
          smokeInvocation: 'pnpm --filter @forgeax/bevy-implemented-demo smoke',
          metrics: {
            gate: { command: 'pnpm --filter @forgeax/bevy-implemented-demo smoke' },
          },
        },
      }),
    );
    writeFileSync(join(app, 'scripts', 'smoke-dawn.mjs'), '');

    const result = run(root, 'validate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bevy-demo-smoke-pass-missing');
  });

  it('reaps a standard smoke whose module would exit normally after PASS', async () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'implemented-demo');
    mkdirSync(join(app, 'scripts'), { recursive: true });
    writeFileSync(join(app, 'scripts', 'smoke-dawn.mjs'), "console.log('[smoke] PASS');\n");

    const result = await runNodeSmoke(root, { dir: app });
    expect(result).toEqual({ status: 0, signal: 'SIGKILL' });
  });

  it('accepts a standard smoke only after PASS triggers SIGKILL reap', async () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'implemented-demo');
    mkdirSync(join(app, 'scripts'), { recursive: true });
    writeFileSync(
      join(app, 'scripts', 'smoke-dawn.mjs'),
      "console.log('[smoke] PASS');\nsetInterval(() => {}, 1000);\n",
    );

    const result = await runNodeSmoke(root, { dir: app });
    expect(result).toEqual({ status: 0, signal: 'SIGKILL' });
  });

  it('reaps when the lifecycle exit notice arrives before PASS output', async () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'implemented-demo');
    mkdirSync(join(app, 'scripts'), { recursive: true });
    writeFileSync(
      join(app, 'scripts', 'smoke-dawn.mjs'),
      "process.exit(0);\nconsole.log('[smoke] PASS');\n",
    );

    const result = await runNodeSmoke(root, { dir: app });
    expect(result).toEqual({ status: 0, signal: 'SIGKILL' });
  });

  it('rejects a standard smoke that reports PASS but exits nonzero', async () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'implemented-demo');
    mkdirSync(join(app, 'scripts'), { recursive: true });
    writeFileSync(
      join(app, 'scripts', 'smoke-dawn.mjs'),
      "console.log('[smoke] PASS');\nprocess.exitCode = 1;\n",
    );

    const result = await runNodeSmoke(root, { dir: app });
    expect(result.status).not.toBe(0);
    expect(result.signal).toBeNull();
  });

  it('refuses to claim a blank scaffold is implemented', () => {
    const root = tempRoot();
    const input = join(root, 'implemented.json');
    writeFileSync(
      input,
      JSON.stringify({
        id: 'implemented-demo',
        name: 'implemented_demo',
        category: 'Animation',
        title: 'Implemented Demo',
        status: 'implemented',
      }),
    );
    const result = run(root, 'new', input);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bevy-demo-scaffold-status-invalid');
  });

  it('accepts bounded smoke concurrency in a dry run', () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'tiny-demo');
    mkdirSync(join(app, 'scripts'), { recursive: true });
    writeFileSync(join(app, 'scripts', 'smoke-dawn.mjs'), "console.log('[smoke] PASS');\n");
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@forgeax/bevy-tiny-demo',
        description: 'Implemented smoke fixture.',
        scripts: { smoke: 'node scripts/smoke-dawn.mjs' },
        forgeax: {
          bevyExample: { name: 'tiny_demo', category: 'Animation', status: 'implemented' },
          smokeInvocation: 'pnpm --filter @forgeax/bevy-tiny-demo smoke',
          metrics: { gate: { command: 'pnpm --filter @forgeax/bevy-tiny-demo smoke' } },
        },
      }),
    );
    const result = run(root, 'smokes', '--concurrency', '4', '--dry-run');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('completed (dry run) with concurrency=4');
  });

  it('derives smoke concurrency from runner resources', () => {
    const root = tempRoot();
    const app = join(root, 'apps', 'bevy', 'tiny-demo');
    mkdirSync(join(app, 'scripts'), { recursive: true });
    writeFileSync(join(app, 'scripts', 'smoke-dawn.mjs'), "console.log('[smoke] PASS');\n");
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@forgeax/bevy-tiny-demo',
        description: 'Implemented smoke fixture.',
        scripts: { smoke: 'node scripts/smoke-dawn.mjs' },
        forgeax: {
          bevyExample: { name: 'tiny_demo', category: 'Animation', status: 'implemented' },
          smokeInvocation: 'pnpm --filter @forgeax/bevy-tiny-demo smoke',
          metrics: { gate: { command: 'pnpm --filter @forgeax/bevy-tiny-demo smoke' } },
        },
      }),
    );
    const result = run(root, 'smokes', '--concurrency', 'auto', '--dry-run');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/auto concurrency=\d+/);
    expect(result.stdout).toMatch(/completed \(dry run\) with concurrency=\d+/);
  });

  it('caps auto smoke concurrency for an 8 CPU, 16 GB cgroup', () => {
    expect(autoSmokeConcurrency({ cpus: 8, memoryBytes: 16 * 1024 ** 3 })).toBe(2);
  });

  it('builds with bounded workers before serializing native smoke children', async () => {
    const apps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const events: string[] = [];
    let activeBuilds = 0;
    let maxActiveBuilds = 0;
    let activeSmokes = 0;
    let maxActiveSmokes = 0;
    const smokeOrder: string[] = [];

    await runSmokeStages('root', apps, 2, {
      build: async (_root, app) => {
        activeBuilds += 1;
        maxActiveBuilds = Math.max(maxActiveBuilds, activeBuilds);
        events.push(`build:start:${app.id}`);
        await Promise.resolve();
        events.push(`build:end:${app.id}`);
        activeBuilds -= 1;
      },
      smoke: async (_root, app) => {
        activeSmokes += 1;
        maxActiveSmokes = Math.max(maxActiveSmokes, activeSmokes);
        events.push(`smoke:start:${app.id}`);
        smokeOrder.push(app.id);
        await Promise.resolve();
        events.push(`smoke:end:${app.id}`);
        activeSmokes -= 1;
      },
    });

    const firstSmoke = events.findIndex((event) => event.startsWith('smoke:start:'));
    expect(firstSmoke).toBeGreaterThan(-1);
    expect(events.slice(0, firstSmoke).every((event) => event.startsWith('build:'))).toBe(true);
    expect(maxActiveBuilds).toBe(2);
    expect(maxActiveSmokes).toBe(1);
    expect(smokeOrder).toEqual(['a', 'b', 'c']);
  });

  it('runs the default direct Dawn smoke runner after the build phase', async () => {
    const root = tempRoot();
    const appDir = join(root, 'apps', 'bevy', 'direct-smoke');
    mkdirSync(join(appDir, 'scripts'), { recursive: true });
    writeFileSync(
      join(appDir, 'scripts', 'smoke-dawn.mjs'),
      "console.log('[smoke] PASS'); setInterval(() => {}, 1000);\n",
    );
    const events: string[] = [];
    await runSmokeStages(
      root,
      [
        {
          dir: appDir,
          pkg: {
            name: '@forgeax/bevy-direct-smoke',
            scripts: { smoke: 'node scripts/smoke-dawn.mjs' },
          },
        },
      ],
      1,
      { build: async () => events.push('build') },
    );
    expect(events).toEqual(['build']);
  });

  it('selects one deterministic group without changing package order', () => {
    const root = tempRoot();
    for (const id of ['a-demo', 'b-demo', 'c-demo', 'd-demo', 'e-demo']) {
      const app = join(root, 'apps', 'bevy', id);
      mkdirSync(join(app, 'scripts'), { recursive: true });
      writeFileSync(join(app, 'scripts', 'smoke-dawn.mjs'), "console.log('[smoke] PASS');\n");
      writeFileSync(
        join(app, 'package.json'),
        JSON.stringify({
          name: `@forgeax/bevy-${id}`,
          description: 'Implemented smoke fixture.',
          scripts: { smoke: 'node scripts/smoke-dawn.mjs' },
          forgeax: {
            bevyExample: {
              name: id.replace('-', '_'),
              category: 'Animation',
              status: 'implemented',
            },
            smokeInvocation: `pnpm --filter @forgeax/bevy-${id} smoke`,
            metrics: { gate: { command: `pnpm --filter @forgeax/bevy-${id} smoke` } },
          },
        }),
      );
    }
    const result = run(root, 'smokes', '--group', '1', '--groups', '2', '--dry-run');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('@forgeax/bevy-b-demo');
    expect(result.stdout).toContain('@forgeax/bevy-d-demo');
    expect(result.stdout).not.toContain('@forgeax/bevy-a-demo');
    expect(result.stdout).toContain('2/5 implemented Bevy demo smoke entries');
  });

  it('rejects a group outside the configured matrix', () => {
    const root = tempRoot();
    const result = run(root, 'smokes', '--group', '3', '--groups', '3', '--dry-run');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bevy-demo-group-invalid');
  });
});
