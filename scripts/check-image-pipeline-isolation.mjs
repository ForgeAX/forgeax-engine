#!/usr/bin/env node
// AC-15 image pipeline isolation gate.
//
// Three-path enforcement of the disk -> memory two-state separation
// (charter P5 producer / consumer split).
//
//   Path (a) -- runtime forbidden implementation symbols + import req
//     (rewrite from feat-20260517-vite-plugin-image-build-time-cook D-4;
//     supersedes feat-20260515 AC-15a literal grep).
//
//     Three sub-clauses, all must hold over `packages/runtime/src/`:
//
//       (a.1) forbidden implementation symbols -- AST-friendly regex
//             tripwire that fires when runtime re-declares a disk-side
//             decode symbol:
//                 \bfunction\s+decodeImage\b               (sync impl)
//                 \basync\s+function\s+decodeImage\b       (async impl)
//                 \bclass\s+\w*Decoder\b                   (custom decoder)
//             Imports of these names from the @forgeax/engine-image
//             public surface (parseImage / decodeImageFromFile /
//             decodeImageInBrowser) are NOT a declaration and never
//             match these forms.
//
//       (a.2) decoder-strip requirement (feat-20260603-asset-import-
//             loader-injection / w27, AC-15) -- inverted from the
//             pre-strip "runtime MUST import the decoder" anchor.
//             Two conjuncts:
//               (a.2-anti) NO file under `packages/runtime/src/` may
//                 carry a static `import` from `@forgeax/engine-image`
//                 (any subpath). The runtime no longer decodes disk
//                 images: the decoder moved to the build-time
//                 `imageImporter`, and the texture loader reads only a
//                 build-time-imported RGBA `.bin`. A static `engine-image`
//                 edge in runtime would re-bundle the decoder (regressing
//                 the bundle-size delta AC-16).
//                 Exception (tweak-20260714 M1): a single exact-path
//                 whitelist for `packages/assets-runtime/src/decode-image-
//                 bytes.ts` -- the runtime-facing SDK wrapper around
//                 `decodeImageInBrowser` (plan-strategy D-2). The
//                 whitelist is a Set of one absolute path, NOT a glob or
//                 directory softening; every other assets-runtime and
//                 runtime file remains banned.
//               (a.2-pos) `packages/image/src/image-importer.ts` MUST
//                 statically import `parseImage` (the build-time decoder
//                 it now holds). This anchors the new producer side: the
//                 disk decoder lives behind the build-time imageImporter,
//                 not the runtime.
//
//       (a.3) legacy filename rejection -- any file literally named
//             `image-decoders.d.ts` anywhere under `packages/runtime/`
//             is rejected. The pre-feat-20260515 d.ts shape lived at
//             that path; the migration deleted it, and this clause
//             prevents accidental regrowth.
//
//   Path (b) -- packages/image/src/ must NOT call `device.queue.writeTexture`.
//     `@forgeax/engine-image` is the disk-side decoder; it returns
//     DecodedImage POD and never touches GPU. A writeTexture call here
//     would mean the package is reaching across the divide.
//
//   Path (c) -- apps/learn-render/1.getting-started/4.textures/src/index.ts
//     File absent at the M3 milestone of the build-time image-import feat -> skip-not-fail
//     (M8 of feat-20260515 returns the regression check). When present,
//     it MUST contain `assets.loadByGuid` AND MUST NOT contain direct
//     `decodeImage` or `.uploadTexture(` calls -- the AI user reaches
//     textures only via the loadByGuid recipe (charter P4 consistent
//     abstraction).
//
//   Path (d) -- packages/runtime/src/ must NOT statically import from
//     `@forgeax/engine-codec/encode` (the build-time encoding subpath).
//     Runtime MAY import from `@forgeax/engine-codec` (the runtime-safe
//     main entry with decompressZstd / parseKtx2). The subpath-level
//     separation (D-1) lets the gate distinguish encode vs decode via a
//     static import string literal — encode is build-time only and must
//     not be bundled into the runtime.
//
// Production CI invocation: `node scripts/check-image-pipeline-isolation.mjs`
// (no flags, defaults `--root` to process.cwd()). The `--root <dir>` flag
// is for self-test fixtures; see scripts/__tests__/check-image-pipeline-
// isolation.test.mjs.
//
// Supersede chain:
//   - feat-20260515 AC-15a (literal grep on `decodeImage` /
//     `image-decode` strings) -> superseded by Path (a) here. The literal
//     grep conflated "do not re-implement" with "do not appear", which
//     blocked runtime from importing the legitimate public symbol.
//   - The `image-decode-failed` ImageErrorCode discriminator literal
//     remains benign (runtime constructs ImageError instances to surface
//     format / consistency-assertion failures); the new Path (a)
//     algorithm targets symbol declarations and the import edge, not
//     plain string occurrences.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const out = { root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      out.root = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

const { root } = parseArgs(process.argv.slice(2));

let totalFailures = 0;

// -- Path (a): packages/runtime/src/ -- forbidden symbols + import req --
// (a.1) forbidden implementation symbols
const runtimeSrc = join(root, 'packages/runtime/src');
const runtimeRootForFilename = join(root, 'packages/runtime');
// feat-20260705-runtime-tier2-decomposition M1 / w16 (D-9): the textureLoader
// (and the rest of the asset cluster) moved to @forgeax/engine-assets-runtime.
// The a.1 forbidden-symbol + a.2-anti no-engine-image-import invariants must
// now hold over BOTH package src roots, else the gate goes vacuous for the
// migrated files (plan-strategy 5.6 R10).
const assetsRuntimeSrc = join(root, 'packages/assets-runtime/src');
const pathAScanRoots = [runtimeSrc, assetsRuntimeSrc];

// Three forbidden forms, captured as separate regex patterns so the FAIL
// stderr can name the matched form for the AI user (better than a single
// banned-string blob).
const forbiddenForms = [
  { id: 'function decodeImage', re: /\bfunction\s+decodeImage\b/ },
  { id: 'async function decodeImage', re: /\basync\s+function\s+decodeImage\b/ },
  { id: 'class .+Decoder', re: /\bclass\s+\w*Decoder\b/ },
];

const forbiddenHits = [];
for (const scanRoot of pathAScanRoots) {
  walk(scanRoot, (p, content) => {
    for (const form of forbiddenForms) {
      const m = content.match(form.re);
      if (m) forbiddenHits.push({ path: p, form: form.id, match: m[0] });
    }
  });
}

// (a.2) decoder-strip requirement (w27, AC-15): inverted from the
// pre-strip "runtime MUST import the decoder" anchor.
//
// Static value `import ... from '@forgeax/engine-image'` (any subpath) line
// matcher; type-only imports do not create a runtime bundle edge.
const engineImageImportRe =
  /^\s*import\s+(?!type\b)[^\n;]*?from\s+['"]@forgeax\/engine-image(?:\/[^'"]+)?['"]\s*;?/gm;
const decoderStripFailures = [];

// (a.2-anti-whitelist) Runtime value imports from the image package are limited
// to the two existing owner seams. Keep both exact-path and symbol-scoped: a
// new decoder or a second assembly file must fail closed.
const engineImageImportAllowlist = new Map([
  [
    join(root, 'packages/runtime/src/asset-contributions.ts'),
    /\b(?:textureContribution|equirectContribution)\b/,
  ],
  [join(root, 'packages/assets-runtime/src/decode-image-bytes.ts'), /\bdecodeImageInBrowser\b/],
]);

// (a.2-anti) Only the exact owner assembly may import browser-safe image
// contributions. The runtime carries no disk decoder after the M3 strip;
// any other static edge would re-bundle an implementation (regressing the
// AC-16 delta).
for (const scanRoot of pathAScanRoots) {
  walk(scanRoot, (p, content) => {
    const importLines = content.match(engineImageImportRe) ?? [];
    for (const line of importLines) {
      const allowedSymbols = engineImageImportAllowlist.get(p);
      if (allowedSymbols?.test(line) === true) continue;
      decoderStripFailures.push(
        `runtime/assets-runtime static import of @forgeax/engine-image: ${p} (\`${line.trim()}\`) -- the runtime decoder was stripped (M3 AC-15); import images at build time via the imageImporter`,
      );
    }
  });
}

// (a.2-pos) the build-time imageImporter must statically import parseImage
// (the decoder it now holds on the producer side).
const imageImporterPath = join(root, 'packages/image/src/image-importer.ts');
if (!existsSync(imageImporterPath)) {
  decoderStripFailures.push(`missing build-time decoder holder: ${imageImporterPath}`);
} else {
  const content = readFileSync(imageImporterPath, 'utf8');
  const hasParseImageImport =
    /^\s*import\b[\s\S]*?\bparseImage\b[\s\S]*?from\s+['"][^'"]*parse-image(?:\.js)?['"]\s*;?/gm.test(
      content,
    );
  if (!hasParseImageImport) {
    decoderStripFailures.push(
      `${imageImporterPath} missing required build-time decoder import: ` +
        `imageImporter must statically import parseImage from './parse-image' ` +
        `(it holds the disk decoder on the producer side)`,
    );
  }
}

// (a.3) legacy filename rejection -- walk the whole runtime package, not
// just src/, because the legacy artefact lived under dist/.
const legacyFilenameHits = [];
walkAny(runtimeRootForFilename, (p) => {
  if (basename(p) === 'image-decoders.d.ts') legacyFilenameHits.push(p);
});

const pathAFailures = [];
if (forbiddenHits.length > 0) {
  for (const h of forbiddenHits) {
    pathAFailures.push(
      `forbidden implementation symbol: ${h.path} matches \`${h.form}\` (${h.match})`,
    );
  }
}
for (const f of decoderStripFailures) {
  pathAFailures.push(`decoder-strip requirement: ${f}`);
}
if (legacyFilenameHits.length > 0) {
  for (const p of legacyFilenameHits) {
    pathAFailures.push(`legacy filename: ${p}`);
  }
}

if (pathAFailures.length > 0) {
  process.stderr.write(`AC-15 (a) FAIL: packages/runtime/src violations\n`);
  for (const f of pathAFailures) process.stderr.write(`  - ${f}\n`);
  process.stderr.write(
    '[hint] @forgeax/engine-runtime carries no disk decoder after the M3 strip (AC-15). Only the exact owner assembly may import browser-safe image contributions; do not import parse/decode implementation symbols, re-declare a decode symbol or class .+Decoder, or regrow `image-decoders.d.ts`. The build-time imageImporter (packages/image/src/image-importer.ts) must statically import parseImage.\n',
  );
  totalFailures += 1;
} else {
  process.stdout.write(
    `AC-15 (a) OK: packages/runtime/src clean (forbidden symbols absent, owner-only image contribution import, imageImporter holds parseImage, no legacy filename)\n`,
  );
}

// -- Path (b): packages/image/src/ -- no device.queue.writeTexture --
const imageRoot = join(root, 'packages/image/src');
const imageBanned = /device\.queue\.writeTexture/;
const imageHits = [];
walk(imageRoot, (p, content) => {
  const m = content.match(imageBanned);
  if (m) imageHits.push({ path: p, hit: m[0] });
});

if (imageHits.length > 0) {
  process.stderr.write(`AC-15 (b) FAIL: ${imageRoot} contains banned strings:\n`);
  for (const h of imageHits) process.stderr.write(`  ${h.path}: ${h.hit}\n`);
  process.stderr.write(
    '[hint] @forgeax/engine-image is the disk-side decoder; it returns DecodedImage POD and must not touch GPU. The device.queue.writeTexture call belongs in @forgeax/engine-runtime AssetRegistry.uploadTexture.\n',
  );
  totalFailures += 1;
} else {
  process.stdout.write(`AC-15 (b) OK: ${imageRoot} grep clean (no device.queue.writeTexture)\n`);
}

// -- Path (c): apps/learn-render/1.getting-started/4.textures/src/index.ts --
const texturesEntry = join(root, 'apps/learn-render/1.getting-started/4.textures/src/index.ts');
if (!existsSync(texturesEntry)) {
  process.stdout.write(
    `AC-15 (c) SKIP-NOT-FAIL: ${texturesEntry} not present at this milestone (M8 of feat-20260515 returns the regression check).\n`,
  );
} else {
  const content = readFileSync(texturesEntry, 'utf8');
  // (c) regex: `\bassets\.loadByGuid\b` accepts the receiver-alias form
  // (`const assets = app.assets; assets.loadByGuid<T>(guid)`); the
  // `\.uploadTexture\s*\(` form matches actual method calls (skipping
  // doc-comment mentions of the architectural verb).
  const hasLoadByGuid = /\bassets\.loadByGuid\b/.test(content);
  const hasDirectDecode = /\bdecodeImage\b/.test(content);
  const hasDirectUpload = /\.uploadTexture\s*\(/.test(content);

  const failures = [];
  if (!hasLoadByGuid) {
    failures.push('missing required `assets.loadByGuid` call (AI user entry-point)');
  }
  if (hasDirectDecode) {
    failures.push('contains direct `decodeImage` call (must route via loadByGuid)');
  }
  if (hasDirectUpload) {
    failures.push('contains direct `.uploadTexture(` call (must route via loadByGuid)');
  }

  if (failures.length > 0) {
    process.stderr.write(`AC-15 (c) FAIL: ${texturesEntry} violations:\n`);
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.stderr.write(
      '[hint] The 4.textures example must consume textures only via `engine.assets.loadByGuid<TextureAsset>(guid)`; the disk-decode + GPU-upload steps are encapsulated by AssetRegistry (charter P4 consistent abstraction).\n',
    );
    totalFailures += 1;
  } else {
    process.stdout.write(
      `AC-15 (c) OK: ${texturesEntry} grep clean (loadByGuid only entry path)\n`,
    );
  }
}

// -- Path (d): packages/runtime/src/ -- must not import from @forgeax/engine-codec/encode --
// The codec package uses subpath-level separation (D-1): `@forgeax/engine-codec`
// is the runtime-safe main entry (decompressZstd / parseKtx2); `@forgeax/engine-codec/encode`
// is the build-time encoding subpath (compressZstd). Runtime must use only the main entry.
const codecEncodeImportRe =
  /^\s*import\b[\s\S]*?from\s+['"]@forgeax\/engine-codec\/encode['"]\s*;?/gm;
const pathDFailures = [];

// feat-20260705-runtime-tier2-decomposition M1 / w16 (D-9): textureLoader (the
// codec consumer) moved to assets-runtime; scan both roots so the encode-subpath
// ban does not go vacuous for the migrated loader.
for (const scanRoot of pathAScanRoots) {
  walk(scanRoot, (p, content) => {
    const importLines = content.match(codecEncodeImportRe) ?? [];
    for (const line of importLines) {
      pathDFailures.push(
        `runtime/assets-runtime static import of @forgeax/engine-codec/encode: ${p} (\`${line.trim()}\`) -- build-time only; use @forgeax/engine-codec main entry for runtime-safe decode`,
      );
    }
  });
}

if (pathDFailures.length > 0) {
  process.stderr.write(`AC-15 (d) FAIL: packages/runtime/src has encode subpath imports\n`);
  for (const f of pathDFailures) process.stderr.write(`  - ${f}\n`);
  process.stderr.write(
    '[hint] @forgeax/engine-codec/encode contains build-time zstd compression. ' +
      'Runtime code must import from @forgeax/engine-codec (main entry) instead, ' +
      'which exports runtime-safe decompressZstd / parseKtx2 / errors.\n',
  );
  totalFailures += 1;
} else {
  process.stdout.write(
    `AC-15 (d) OK: packages/runtime/src clean (no @forgeax/engine-codec/encode import)\n`,
  );
}

if (totalFailures > 0) {
  process.stderr.write(`\nAC-15 image pipeline isolation gate: ${totalFailures} failure(s)\n`);
  process.exit(1);
}
process.stdout.write('\nAC-15 image pipeline isolation gate: PASS (4 paths)\n');

function walk(dir, cb) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, cb);
    else if (p.endsWith('.ts') || p.endsWith('.mts') || p.endsWith('.tsx')) {
      cb(p, readFileSync(p, 'utf8'));
    }
  }
}

// Filename-only walk: visits every regular file under `dir`, no extension
// filter and no content read. Used by the legacy-filename clause which
// rejects by name alone. Skips `node_modules/` so a workspace-installed
// dependency that happens to ship `image-decoders.d.ts` (e.g. the
// migrated copy now living in @forgeax/engine-image) does not light up
// the runtime gate.
function walkAny(dir, cb) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkAny(p, cb);
    else cb(p);
  }
}
