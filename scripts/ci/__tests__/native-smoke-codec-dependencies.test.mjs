import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseAllDocuments } from 'yaml';

const pnpm = Object.assign(
  {},
  ...parseAllDocuments(readFileSync('pnpm-lock.yaml', 'utf8')).map((document) => document.toJSON()),
);
for (const app of [
  'apps/hello/boss-lightning',
  'apps/hello/cinder-fall',
  'apps/learn-render/5.advanced-lighting/5.parallax-mapping',
]) {
  test(`${app} declares the Codec package imported by its native smoke`, () => {
    const manifest = JSON.parse(readFileSync(`${app}/package.json`, 'utf8'));
    assert.equal(manifest.devDependencies['@forgeax/engine-codec'], 'workspace:*');
    assert.equal(
      pnpm.importers[app].devDependencies['@forgeax/engine-codec'].specifier,
      'workspace:*',
    );
    assert.match(
      pnpm.importers[app].devDependencies['@forgeax/engine-codec'].version,
      /packages\/codec$/,
    );
  });
}

test('Bloom native smoke uses the maintained manifest reader without an unused Codec link', () => {
  const script = readFileSync(
    'apps/learn-render/5.advanced-lighting/7.bloom/scripts/smoke-dawn.mjs',
    'utf8',
  );
  assert.doesNotMatch(
    script,
    /import\s+\{\s*decodeDocumentText\s*\}\s+from\s+['"]@forgeax\/engine-codec['"]/,
  );
  assert.match(
    script,
    /import\s+\{\s*readShaderManifestText\s*\}\s+from\s+['"].*scripts\/lib\/shader-manifest\.mjs['"]/,
  );
  assert.match(script, /JSON\.parse\(readShaderManifestText\(DEMO_MANIFEST_PATH\)\)/);
});
