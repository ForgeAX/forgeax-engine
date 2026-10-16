#!/usr/bin/env node
// check-pack-schema-dist-fresh — assert packages/pack/dist/schema.mjs reflects
// the CURRENT packages/pack/schema/meta.schema.json source (not a stale build).
//
// Why: tsup compiles the schema JSON in via `import metaSchemaJson from
// '../schema/meta.schema.json' with { type: 'json' }`, baking the JSON into
// dist/schema.mjs as a JS literal. If the dist was built before a schema-source
// edit, the runtime AJV validator silently uses the OLD enum membership. In
// practice this exactly happened: feat-20260608 #316 added "texture" to
// subAssets[].kind.enum, but a local checkout's dist/schema.mjs predated the
// edit. Sponza's 69 `kind: 'texture'` subassets were AJV-rejected with
// pack-malformed-meta, vite-plugin-pack/buildCatalog graceful-degraded to [],
// dist/pack-index.json shipped 0 entries, and the runtime loadByGuid<SceneAsset>
// surfaced as `asset-not-imported` even though the source schema accepted them.
//
// Scope: gate ONLY the load-bearing `subAssets[].kind.enum` array. A full byte
// diff would false-positive on description tweaks. If a future drift hits
// another enum (e.g. importer keys, schemaVersion), extend the gate.
//
// Pattern: zero-dep stdio mirror of scripts/grep/check-no-entity-array-literal.mjs.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const SOURCE = join(REPO_ROOT, 'packages/pack/schema/meta.schema.json');
const DIST = join(REPO_ROOT, 'packages/pack/dist/schema.mjs');

if (!existsSync(SOURCE)) {
  console.error(`[check-pack-schema-dist-fresh] source not found: ${SOURCE}`);
  process.exit(2);
}
if (!existsSync(DIST)) {
  console.error(
    `[check-pack-schema-dist-fresh] dist not found: ${DIST}\n` +
      "Run 'pnpm -F @forgeax/engine-pack build' to produce it.",
  );
  process.exit(1);
}

const sourceJson = JSON.parse(readFileSync(SOURCE, 'utf8'));
const sourceKinds = sourceJson?.$defs?.subAsset?.properties?.kind?.enum;
if (!Array.isArray(sourceKinds)) {
  // feat-20260629: subAssets[].kind is no longer a closed enum — D-1 opened it
  // to `{ type: 'string', minLength: 1 }` so host importers declare their own
  // kinds. With no enum, there is no enum-membership to drift between source and
  // dist (runtime AJV validates `type: string` regardless of build freshness),
  // so the load-bearing check this gate was built for is moot. Pass cleanly.
  const kindShape = sourceJson?.$defs?.subAsset?.properties?.kind;
  if (kindShape?.type === 'string') {
    console.log(
      `[check-pack-schema-dist-fresh] OK — subAssets[].kind is open string (no enum to keep fresh).`,
    );
    process.exit(0);
  }
  console.error(
    `[check-pack-schema-dist-fresh] source schema missing $defs.subAsset.properties.kind.enum:\n` +
      `  ${SOURCE}\n` +
      `  expected an array (closed enum) or { type: 'string' } (open kind); got ${JSON.stringify(kindShape)}`,
  );
  process.exit(2);
}

const distContent = readFileSync(DIST, 'utf8');
// The dist embeds the JSON-source as a JS object literal. The kind enum block
// looks roughly like:
//   kind: {
//     type: "string",
//     enum: ["mesh", "material", "scene", ...],
//     description: "Closed sub-asset kind enum. ..."
//   }
// Anchor on the literal `kind: {`, then the nearest `enum: [...]` after it.
const kindBlock = distContent.match(/kind:\s*\{[\s\S]{0,200}?enum:\s*\[([^\]]+)\]/);
if (kindBlock === null) {
  console.error(
    `[check-pack-schema-dist-fresh] could not locate subAssets[].kind.enum in dist:\n` +
      `  ${DIST}\n` +
      `  the dist shape may have changed (tsup / esbuild upgrade) — extend this gate's regex.`,
  );
  process.exit(2);
}

const distKinds = kindBlock[1]
  .split(',')
  .map((s) => s.trim().replace(/^"|"$/g, ''))
  .filter((s) => s.length > 0);

const sourceSet = new Set(sourceKinds);
const distSet = new Set(distKinds);
const missingFromDist = [...sourceSet].filter((k) => !distSet.has(k));
const extraInDist = [...distSet].filter((k) => !sourceSet.has(k));

if (missingFromDist.length > 0 || extraInDist.length > 0) {
  console.error(
    `[check-pack-schema-dist-fresh] packages/pack/dist/schema.mjs is out of sync with packages/pack/schema/meta.schema.json:`,
  );
  if (missingFromDist.length > 0) {
    console.error(`  missing from dist (source has, dist lacks): ${missingFromDist.join(', ')}`);
  }
  if (extraInDist.length > 0) {
    console.error(`  extra in dist (dist has, source lacks): ${extraInDist.join(', ')}`);
  }
  console.error(
    `\nFix: pnpm -F @forgeax/engine-pack build\n` +
      `\nRoot cause class: derived-artefact-shadows-source SSOT drift\n` +
      `(bug-20260609-derived-artefact-ssot-drift). The dist embeds the JSON\n` +
      `source as a JS literal at tsup-build time; runtime AJV reads the dist,\n` +
      `not the JSON source, so a stale dist silently rejects new kinds.`,
  );
  process.exit(1);
}

console.log(
  `[check-pack-schema-dist-fresh] OK — packages/pack/dist/schema.mjs subAssets[].kind enum (${distKinds.length}) matches source.`,
);
