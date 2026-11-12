import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { API_INDEX_MAX_BYTES, renderApiIndex } from '../sdk-api-index.mjs';
import { localSdkDiscoveryLinks } from '../sdk-lib.mjs';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const entries = [
  'AGENTS.md',
  'templates/AGENTS.md',
  'skills/forgeax-engine-sdk/SDK-AGENTS.md',
  'skills/forgeax-engine-sdk/SDK-README.md',
  ...readdirSync(resolve(root, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `skills/${entry.name}/SKILL.md`),
];

test('shipped entrypoints route narrative reference guides to the canonical Harness owner', () => {
  for (const entry of entries) {
    const source = readFileSync(resolve(root, entry), 'utf8');
    for (const match of source.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (!target.includes('/references/') && !target.startsWith('references/')) continue;
      assert.match(
        target,
        /^https:\/\/github\.com\/ForgeAX\/forgeax-engine-harness\/blob\/main\/docs\/engine\//,
        `${entry}: ${target}`,
      );
    }
    const prose = source.replaceAll(/\[[^\]]*\]\([^)]+\)/g, '');
    assert.doesNotMatch(prose, /`(?:skills\/forgeax-[^`]+\/)?references\/[^`]+\.md`/, entry);
  }
});

test('generated SDK discovery derives the optional guide route from its source entry', () => {
  const index = renderApiIndex();
  assert.ok(Buffer.byteLength(index) <= API_INDEX_MAX_BYTES);
  const entry = readFileSync(resolve(root, 'skills/forgeax-engine-sdk/SKILL.md'), 'utf8');
  const guide = entry.match(/\]\(([^)\s]*\/three-equivalents\.md)\)/)?.[1];
  if (guide === undefined) assert.doesNotMatch(index, /Three\.js names map/);
  else assert.ok(index.includes(`](${guide})`));
});

test('SDK and game entrypoints use release-local discovery while keeping narrative guides remote', () => {
  const base = 'https://docs.example/skills/forgeax-engine-sdk/references/';
  const source = `[API](${base}api-index.md) [Catalog](${base}feature-catalog.md) [Cookbook](${base}effects-cookbook.md)`;
  for (const prefix of ['references/', 'skills/forgeax-engine-sdk/references/']) {
    assert.equal(
      localSdkDiscoveryLinks(source, prefix),
      `[API](${prefix}api-index.md) [Catalog](${prefix}feature-catalog.md) [Cookbook](${base}effects-cookbook.md)`,
    );
  }
  const projected = 'Guide navigation is unavailable in this source projection.';
  assert.equal(localSdkDiscoveryLinks(projected, 'references/'), projected);
});
