import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const bevyRoot = join(process.cwd(), 'apps', 'bevy');

test('Bevy fleet prepares Chrome Beta before the Skybox WebGL2 smoke', () => {
  const skybox = JSON.parse(readFileSync(join(bevyRoot, 'skybox/package.json'), 'utf8'));
  assert.match(skybox.scripts.smoke, /smoke:webgl2/);
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const start = workflow.indexOf('\n  bevy-smoke-fleet:\n');
  const end = workflow.indexOf('\n  bevy-smoke-fleet-required-context:\n', start);
  assert.ok(start >= 0 && end > start, 'the complete Bevy matrix must remain explicit');
  const job = workflow.slice(start, end);
  const install = job.indexOf('uses: ./.github/actions/install-playwright-chrome-beta');
  const smoke = job.indexOf('run: pnpm bevy:smokes');
  assert.ok(install >= 0 && install < smoke, 'prepare the browser before the composite smoke');
  const step = job.slice(
    job.lastIndexOf('\n      - ', install),
    job.indexOf('\n      - ', install),
  );
  assert.ok(!step.includes('if:'), 'every Bevy lane must support package-derived membership');
  assert.ok(!step.includes('continue-on-error'), 'browser preparation must fail visibly');
});

test('Bevy smoke scripts declare every direct ForgeAX package import', () => {
  const missing = [];
  for (const app of readdirSync(bevyRoot, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const appRoot = join(bevyRoot, app.name);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);
    let scripts;
    try {
      scripts = readdirSync(join(appRoot, 'scripts'));
    } catch {
      continue;
    }
    for (const file of scripts.filter((name) => name.endsWith('.mjs'))) {
      const source = readFileSync(join(appRoot, 'scripts', file), 'utf8');
      const imports = source.matchAll(/(?:from\s+|import\()\s*['"](@forgeax\/[^/'"]+)/g);
      for (const match of imports) {
        const packageName = match[1];
        if (!declared.has(packageName)) missing.push(`${app.name}/${file}: ${packageName}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
