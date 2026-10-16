import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const view = resolve(root, 'tools/view');
const identity = resolve(root, 'scripts/ci/verify-view-dependency-identity.mjs');
const selected = process.argv.indexOf('--identity');
const gate = selected === -1 ? identity : resolve(process.argv[selected + 1]);
const check = () => execFileSync(process.execPath, [gate], { cwd: root, encoding: 'utf8' });
const rejected = (message) => {
  let failure;
  try {
    check();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `the actual identity gate must reject ${message}`);
  assert.match(String(failure.stderr), new RegExp(message));
};
const saved = await mkdtemp(resolve(tmpdir(), 'view-panels-falsifier-'));
const paths = ['modules', 'native-build.json', 'build-revision.json'];
const panels = resolve(view, 'dist/viewer/panels.js');
const served = await readFile(panels);
let savedAll = false;
try {
  check();
  for (const path of paths)
    await cp(resolve(view, 'dist', path), resolve(saved, path), { recursive: true });
  savedAll = true;
  try {
    await writeFile(
      panels,
      Buffer.concat([served, Buffer.from('\n// served-only same-export mutation\n')]),
    );
    rejected('served viewer bytes must match the selected native build');
  } finally {
    await writeFile(panels, served);
  }
  check();
  execFileSync(process.execPath, ['scripts/build-package.mjs'], {
    cwd: view,
    stdio: 'pipe',
    env: {
      ...process.env,
      FORGEAX_VIEW_INPUT_ROOTS: JSON.stringify([
        resolve(root, 'tools/view-plugins'),
        resolve(root, 'apps/rhi-debug-viewer/src'),
      ]),
      FORGEAX_VIEW_PANELS_ENTRY: resolve(view, 'packages/viewer/src/panels-entry.tsx'),
      FORGEAX_VIEW_FRONTEND_PLUGINS_ENTRY: resolve(
        root,
        'tools/view-plugins/integration/frontend-plugins.ts',
      ),
    },
  });
  rejected('resident and embedded roots must be built from the same selected inputs');
} finally {
  await writeFile(panels, served);
  if (savedAll)
    for (const path of paths) {
      await rm(resolve(view, 'dist', path), { recursive: true, force: true });
      await cp(resolve(saved, path), resolve(view, 'dist', path), { recursive: true });
    }
  await rm(saved, { recursive: true, force: true });
}
check();
await mkdir(resolve(root, 'artifacts/view-integration'), { recursive: true });
await writeFile(
  resolve(root, 'artifacts/view-integration/panels-falsifier.json'),
  JSON.stringify(
    {
      ok: true,
      intact: 'passed',
      sameExportServedMutation: 'rejected-by-viewer-digest',
      nativeDefaultWithServedComposition: 'rejected-by-selected-inputs',
      restored: 'passed',
    },
    null,
    2,
  ),
);
console.log('Actual served and embedded panel mismatch falsifiers passed');
