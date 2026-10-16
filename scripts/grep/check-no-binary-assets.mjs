#!/usr/bin/env node
// Zero-binary invariant gate (docs/2026-05-30-repo-slimming-history-rewrite.md
// §1 Goal + §10.2). The engine main repo tracks NO binaries in working tree
// *or* history: all rendered baselines, demo source assets, vendor textures,
// and the wgpu wasm artefact live in the forgeax-engine-assets submodule or are
// rebuilt from Rust source. `.gitignore` blocks images/videos globally with no
// whitelist, but that only stops an accidental `git add .` — it does not stop a
// deliberate `git add -f`, a future `.gitignore` regression, or a binary
// committed under an unlisted extension. This gate makes the invariant an
// actively-enforced CI contract instead of a passive ignore.
//
// Two detection layers (both over `git ls-files`, the authoritative list of
// committed + staged tracked files — submodule contents appear only as gitlink
// pointers and ignored paths like node_modules / packages/*/pkg/*.wasm are
// excluded for free):
//
//   1. Extension blocklist — a broad roster of game / media binary extensions
//      (images, video, audio, 3D models, fonts, archives, native binaries, GPU
//      textures). Mirrors and widens the `.gitignore` `*.ext` blocks.
//   2. Content sniff backstop — any tracked regular file whose first 8 KiB
//      contains a NUL byte (0x00) is binary regardless of its extension. Catches
//      renamed / extensionless blobs (`texture.dat`, no-ext payloads) that slip
//      the extension list.
//
// TEXT_ALLOW exempts known text formats that look binary-adjacent by name or
// could otherwise be mis-flagged — notably `.gltf`, which is JSON text with a
// base64 `data:` URI buffer (the two committed `box.gltf` / `instanced-box.gltf`
// are intentionally kept; `.glb`, the binary container, stays banned).
//
// Zero npm deps; stdlib + `git`. exit 1 fails CI. Self-contained extension
// SSOT per the design decision (no .gitignore parsing coupling).
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import process from 'node:process';

// Binary extensions (without leading dot, lowercase). Ambiguous text-or-binary
// formats (obj / stl / ply / dae — ASCII variants exist) are deliberately
// omitted here; the content sniff catches their binary variants without
// false-flagging the text ones.
const BINARY_EXTS = new Set([
  // images
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'tiff',
  'tif',
  'webp',
  'ico',
  'heic',
  'heif',
  'avif',
  'raw',
  'cr2',
  'nef',
  'arw',
  'dng',
  'psd',
  'ai',
  // svg: XML text, but `.gitignore` blocks it and it carries no engine value
  'svg',
  // video
  'mp4',
  'avi',
  'mov',
  'mkv',
  'flv',
  'wmv',
  'webm',
  'm4v',
  'mpg',
  'mpeg',
  '3gp',
  // audio
  'mp3',
  'wav',
  'ogg',
  'flac',
  'aac',
  'm4a',
  'opus',
  'wma',
  'aiff',
  'mid',
  'midi',
  // 3D model containers (binary)
  'glb',
  'fbx',
  'blend',
  '3ds',
  'usdz',
  'abc',
  // fonts
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
  // archives
  'zip',
  'gz',
  'tgz',
  'tar',
  'rar',
  '7z',
  'bz2',
  'xz',
  'zst',
  'lz4',
  // native / compiled binaries
  'wasm',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'o',
  'a',
  'node',
  'class',
  'pyc',
  // GPU textures / HDR
  'dds',
  'ktx',
  'ktx2',
  'basis',
  'exr',
  'hdr',
  'tga',
  'astc',
  'pvr',
  // misc binary docs
  'pdf',
]);

// Text files that must NOT be flagged (extension-keyed). `.gltf` is JSON text.
const TEXT_ALLOW = new Set(['gltf']);

// FBX has both an auditable ASCII form and a binary form. Accept only the
// former; the NUL sniff below keeps binary FBX out of the engine repository.
const TEXT_OR_BINARY_EXTS = new Set(['fbx']);

const SNIFF_BYTES = 8192;

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0);
}

function extOf(p) {
  const slash = p.lastIndexOf('/');
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // no extension, or dotfile like `.gitignore`
  return base.slice(dot + 1).toLowerCase();
}

function hasNulByte(p) {
  let fd;
  try {
    fd = openSync(p, 'r');
  } catch {
    return false;
  }
  try {
    const buf = Buffer.allocUnsafe(SNIFF_BYTES);
    const n = readSync(fd, buf, 0, SNIFF_BYTES, 0);
    for (let i = 0; i < n; i += 1) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

const violations = [];

for (const p of trackedFiles()) {
  // Skip non-regular files: gitlinks (submodule pointers) statSync as
  // directories, symlinks resolve elsewhere. Only inspect real files.
  let st;
  try {
    st = statSync(p);
  } catch {
    continue; // gitlink to an uninitialised submodule, or transient
  }
  if (!st.isFile()) continue;

  const ext = extOf(p);
  if (TEXT_ALLOW.has(ext)) continue;

  if (TEXT_OR_BINARY_EXTS.has(ext) && !hasNulByte(p)) continue;

  if (BINARY_EXTS.has(ext)) {
    violations.push({ path: p, reason: `banned binary extension .${ext}` });
    continue;
  }
  if (hasNulByte(p)) {
    violations.push({ path: p, reason: 'NUL byte in first 8 KiB (binary content)' });
  }
}

if (violations.length > 0) {
  console.error(
    '[check-no-binary-assets] zero-binary invariant violated: ' +
      `${violations.length} tracked binary file(s) found in the engine repo:`,
  );
  for (const v of violations) {
    console.error(`  - ${v.path}  (${v.reason})`);
  }
  console.error(
    '\nThe engine main repo tracks NO binaries (see ' +
      'docs/2026-05-30-repo-slimming-history-rewrite.md §1 + §10). Move the ' +
      'file into the forgeax-engine-assets submodule (smoke-baselines/<demo>/, ' +
      'demo-assets/<demo>/, learn-opengl/, ...) and reference it from there, or ' +
      'rebuild it from source at CI time (wasm via packages/wgpu-wasm/build.sh). ' +
      'For a fixture, synthesise the bytes in-memory at test time instead of ' +
      'committing them (see packages/image/.../make-fixture.ts). If this is ' +
      'genuinely a text file mis-flagged by the content sniff, add its ' +
      'extension to TEXT_ALLOW in this gate.',
  );
  process.exit(1);
}

console.log(
  '[check-no-binary-assets] OK — zero binaries tracked in the engine repo ' +
    '(extension blocklist + NUL-byte content sniff over git ls-files).',
);
