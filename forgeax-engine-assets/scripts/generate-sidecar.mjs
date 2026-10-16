#!/usr/bin/env node
// generate-sidecar.mjs
//
// Idempotent generator of *.meta.json sidecars for vendored assets
// under learn-opengl/textures/ (image arm) + sfx/ (audio arm).
//
// Image arm (learn-opengl/textures/*.{png,jpg}):
//   - Scan learn-opengl/textures/*.{png,jpg}.
//   - For each binary, emit <basename>.meta.json next to it (importer: 'image').
//   - colorSpace heuristic by filename suffix:
//       *_normal.*    -> linear
//       *_specular*.* -> linear
//       *_disp.*      -> linear
//       otherwise     -> srgb
//
// Audio arm (sfx/*.{mp3,wav,ogg,flac}):
//   - Scan sfx/*.{mp3,wav,ogg,flac}.
//   - For each binary, emit <basename>.meta.json next to it (importer: 'audio').
//   - subAssets[0].kind='audio', importSettings={}.
//   - If the sfx/ directory does not exist, skip without error (no audio
//     assets to scan).
//
// GUID minted as RFC 9562 UUIDv7 (48-bit ms timestamp + version=7
// nibble + 12-bit rand + variant=10 + 62-bit rand).
// If the sidecar file already exists, skip it (do not overwrite the
// GUID). This is the idempotency contract: re-running the script
// produces an empty git diff (forgeax-engine architecture-principles
// #6 Idempotency).
//
// Usage:
//   node scripts/generate-sidecar.mjs              # write sidecars
//   node scripts/generate-sidecar.mjs --dry-run    # list planned writes
//   node scripts/generate-sidecar.mjs --help       # this message
//
// Exit codes:
//   0 success
//   1 unexpected error

import { randomBytes } from 'node:crypto';
import { readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `generate-sidecar.mjs
Generate *.meta.json sidecars for vendored assets:
  - Image arm:  learn-opengl/textures/*.{png,jpg} (importer: 'image')
  - Audio arm:  sfx/*.{mp3,wav,ogg,flac}           (importer: 'audio')

Options:
  --dry-run   List planned sidecar paths; do not write.
  --help      Show this message.
`;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const TEXTURES_DIR = join(REPO_ROOT, 'learn-opengl', 'textures');
const SFX_DIR = join(REPO_ROOT, 'sfx');
const OBJECTS_DIRS = [
  join(REPO_ROOT, 'learn-opengl', 'objects', 'planet'),
  join(REPO_ROOT, 'learn-opengl', 'objects', 'rock'),
];
// Recursive image trees (vendored mirror sub-dirs: pbr/*, skybox/, meshes/*).
// The flat TEXTURES_DIR + OBJECTS_DIRS arms above stay for back-compat; these
// dirs are walked depth-first so pbr/<material>/<map>.png and the per-model
// mesh textures get sidecars without enumerating every leaf dir by hand.
const IMAGE_TREE_DIRS = [
  join(REPO_ROOT, 'learn-opengl', 'textures'),
  join(REPO_ROOT, 'learn-opengl', 'meshes'),
];
// Audio mirror dir (breakout SFX); same arm as SFX_DIR but namespaced.
const AUDIO_DIRS = [SFX_DIR, join(REPO_ROOT, 'learn-opengl', 'audio')];

function classifyColorSpace(filename) {
  // Strip last extension, keep the stem for suffix matching. Non-color data
  // (normal / derivative-normal / specular / reflection / displacement /
  // metallic / roughness / ao) is linear; albedo / diffuse / emission and
  // everything else is srgb. Covers LearnOpenGL nanosuit (_showroom_ddn /
  // _spec / _refl), cyborg (_normal / _specular), and PBR (metallic /
  // roughness / ao / normal) naming.
  const stem = filename.replace(/\.(png|jpg|jpeg)$/i, '').toLowerCase();
  if (/(^|_)normal$/.test(stem)) return 'linear';
  if (/_ddn$/.test(stem)) return 'linear';
  if (/(^|_)spec(ular)?$/.test(stem)) return 'linear';
  if (/_specular(_[a-z0-9]+)?$/.test(stem)) return 'linear';
  if (/(^|_)refl$/.test(stem)) return 'linear';
  if (/_disp$/.test(stem)) return 'linear';
  if (/(^|_)metallic$/.test(stem)) return 'linear';
  if (/(^|_)roughness$/.test(stem)) return 'linear';
  if (/(^|_)ao$/.test(stem)) return 'linear';
  return 'srgb';
}

function walkImageBinaries(dir) {
  // Depth-first list of png/jpg/jpeg under dir, returned as paths relative to
  // dir (so the caller can join + name the sidecar next to each leaf).
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out = [];
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel ? join(rel, name) : name;
      if (statSync(childAbs).isDirectory()) {
        walk(childAbs, childRel);
      } else if (/\.(png|jpg|jpeg)$/i.test(name)) {
        out.push(childRel);
      }
    }
  };
  walk(dir, '');
  return out;
}

function mintUuidV7() {
  // 16 random bytes, then patch in version + variant per RFC 9562.
  const bytes = randomBytes(16);
  // 48-bit timestamp (ms since Unix epoch) into bytes 0..5 (big-endian).
  const tsMs = BigInt(Date.now());
  bytes[0] = Number((tsMs >> 40n) & 0xffn);
  bytes[1] = Number((tsMs >> 32n) & 0xffn);
  bytes[2] = Number((tsMs >> 24n) & 0xffn);
  bytes[3] = Number((tsMs >> 16n) & 0xffn);
  bytes[4] = Number((tsMs >> 8n) & 0xffn);
  bytes[5] = Number(tsMs & 0xffn);
  // Version = 7 in the high nibble of byte 6.
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Variant = 10b in the high two bits of byte 8.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

function buildSidecar(filename) {
  return {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source: filename,
    importSettings: {
      colorSpace: classifyColorSpace(filename),
      mipmap: 'auto',
      addressMode: 'repeat',
      filterMode: 'linear',
    },
    subAssets: [
      {
        guid: mintUuidV7(),
        sourceIndex: 0,
        kind: 'image',
      },
    ],
  };
}

function buildAudioSidecar(filename) {
  return {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'audio',
    source: filename,
    importSettings: {},
    subAssets: [
      {
        guid: mintUuidV7(),
        sourceIndex: 0,
        kind: 'audio',
      },
    ],
  };
}

function listTextureBinaries(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`textures dir does not exist: ${dir}`);
  }
  const entries = readdirSync(dir);
  return entries
    .filter((name) => /\.(png|jpg|jpeg)$/i.test(name))
    .sort();
}

function listAudioBinaries(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return [];
  }
  const entries = readdirSync(dir);
  return entries
    .filter((name) => /\.(mp3|wav|ogg|flac)$/i.test(name))
    .sort();
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const dryRun = argv.includes('--dry-run');

  // --- image arm ---
  const imageBinaries = listTextureBinaries(TEXTURES_DIR);
  if (imageBinaries.length === 0) {
    process.stderr.write(`no textures found under ${TEXTURES_DIR}\n`);
    return 1;
  }
  let totalWritten = 0;
  let totalSkipped = 0;
  for (const filename of imageBinaries) {
    const sidecarName = `${filename}.meta.json`;
    const sidecarPath = join(TEXTURES_DIR, sidecarName);
    if (existsSync(sidecarPath)) {
      totalSkipped += 1;
      if (dryRun) {
        process.stdout.write(`SKIP  ${sidecarPath} (exists)\n`);
      }
      continue;
    }
    if (dryRun) {
      process.stdout.write(`PLAN  ${sidecarPath}\n`);
      continue;
    }
    const sidecar = buildSidecar(filename);
    writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
    totalWritten += 1;
    process.stdout.write(`WROTE ${sidecarPath}\n`);
  }
  process.stdout.write(
    `image arm: binaries=${imageBinaries.length} written=${totalWritten} skipped=${totalSkipped}` +
      (dryRun ? ' (dry-run)' : '') +
      '\n',
  );

  // --- objects arm (PNG textures in learn-opengl/objects/{planet,rock}) ---
  for (const objectsDir of OBJECTS_DIRS) {
    if (!existsSync(objectsDir) || !statSync(objectsDir).isDirectory()) {
      continue;
    }
    const pngs = listTextureBinaries(objectsDir);
    if (pngs.length === 0) continue;
    let dirWritten = 0;
    let dirSkipped = 0;
    for (const filename of pngs) {
      const sidecarName = `${filename}.meta.json`;
      const sidecarPath = join(objectsDir, sidecarName);
      if (existsSync(sidecarPath)) {
        dirSkipped += 1;
        if (dryRun) {
          process.stdout.write(`SKIP  ${sidecarPath} (exists)\n`);
        }
        continue;
      }
      if (dryRun) {
        process.stdout.write(`PLAN  ${sidecarPath}\n`);
        continue;
      }
      const sidecar = buildSidecar(filename);
      writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
      dirWritten += 1;
      process.stdout.write(`WROTE ${sidecarPath}\n`);
    }
    totalWritten += dirWritten;
    totalSkipped += dirSkipped;
    process.stdout.write(
      `objects arm (${objectsDir}): binaries=${pngs.length} written=${dirWritten} skipped=${dirSkipped}` +
        (dryRun ? ' (dry-run)' : '') +
        '\n',
    );
  }

  // --- recursive image-tree arm (pbr/<material>/*, skybox/, meshes/<model>/*) ---
  for (const treeDir of IMAGE_TREE_DIRS) {
    const rels = walkImageBinaries(treeDir);
    if (rels.length === 0) continue;
    let treeWritten = 0;
    let treeSkipped = 0;
    for (const rel of rels) {
      const sidecarPath = join(treeDir, `${rel}.meta.json`);
      if (existsSync(sidecarPath)) {
        treeSkipped += 1;
        if (dryRun) process.stdout.write(`SKIP  ${sidecarPath} (exists)\n`);
        continue;
      }
      if (dryRun) {
        process.stdout.write(`PLAN  ${sidecarPath}\n`);
        continue;
      }
      // buildSidecar classifies colorSpace off the basename only.
      const sidecar = buildSidecar(rel.split(/[\\/]/).pop());
      sidecar.source = rel.split(/[\\/]/).pop();
      writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
      treeWritten += 1;
      process.stdout.write(`WROTE ${sidecarPath}\n`);
    }
    totalWritten += treeWritten;
    totalSkipped += treeSkipped;
    process.stdout.write(
      `image-tree arm (${treeDir}): binaries=${rels.length} written=${treeWritten} skipped=${treeSkipped}` +
        (dryRun ? ' (dry-run)' : '') +
        '\n',
    );
  }

  // --- audio arm (sfx/ + learn-opengl/audio/) ---
  for (const audioDir of AUDIO_DIRS) {
    const audioBinaries = listAudioBinaries(audioDir);
    if (audioBinaries.length === 0) continue;
    let audioWritten = 0;
    let audioSkipped = 0;
    for (const filename of audioBinaries) {
      const sidecarName = `${filename}.meta.json`;
      const sidecarPath = join(audioDir, sidecarName);
      if (existsSync(sidecarPath)) {
        audioSkipped += 1;
        if (dryRun) {
          process.stdout.write(`SKIP  ${sidecarPath} (exists)\n`);
        }
        continue;
      }
      if (dryRun) {
        process.stdout.write(`PLAN  ${sidecarPath}\n`);
        continue;
      }
      const sidecar = buildAudioSidecar(filename);
      writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
      audioWritten += 1;
      process.stdout.write(`WROTE ${sidecarPath}\n`);
    }
    totalWritten += audioWritten;
    totalSkipped += audioSkipped;
    process.stdout.write(
      `audio arm (${audioDir}): binaries=${audioBinaries.length} written=${audioWritten} skipped=${audioSkipped}` +
        (dryRun ? ' (dry-run)' : '') +
        '\n',
    );
  }

  return 0;
}

const code = main(process.argv.slice(2));
process.exit(code);
