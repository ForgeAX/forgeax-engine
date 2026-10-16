import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(resolve(root, 'tools/view/package.json'));
const { build } = require('esbuild');
const entry = resolve(root, 'tools/view-plugins/profiler/frontend.ts');
const options = {
  entryPoints: [entry],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  logLevel: 'silent',
};
await build(options);
const manifestPath = require.resolve('@forgeax/engine-profiler/package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const producerEntry = resolve(dirname(manifestPath), manifest.exports['.'].import);
const producerSource = await readFile(producerEntry, 'utf8');
let removed = 0;
const missingExport = producerSource.replace(/export\s*\{([^}]+)\}/g, (statement, members) => {
  const exports = members.split(',').map((member) => member.trim());
  const retained = exports.filter((member) => member !== 'buildProfileModel');
  removed += exports.length - retained.length;
  return `export { ${retained.join(', ')} }`;
});
assert.equal(removed, 1, 'remove exactly the consumed export from the actual producer entry');
let rejected;
try {
  await build({
    ...options,
    plugins: [
      {
        name: 'remove-consumed-engine-export',
        setup(builder) {
          builder.onLoad({ filter: /\.mjs$/ }, (args) =>
            args.path === producerEntry ? { contents: missingExport, loader: 'js' } : undefined,
          );
        },
      },
    ],
  });
} catch (error) {
  rejected = error.errors?.find((value) => value.text.includes('buildProfileModel'));
}
assert.ok(rejected, 'removing the consumed Engine export must fail the actual native plugin build');
await mkdir(resolve(root, 'artifacts/view-integration'), { recursive: true });
await writeFile(
  resolve(root, 'artifacts/view-integration/export-falsifier.json'),
  JSON.stringify(
    {
      ok: true,
      export: 'buildProfileModel',
      producerEntry: relative(root, producerEntry),
      mutation: 'only the named export is removed; all other producer bytes remain',
      intactBuild: 'passed',
      removedExportBuild: 'rejected',
      error: rejected,
    },
    null,
    2,
  ),
);
console.log('Consumed Engine export falsifier passed');
