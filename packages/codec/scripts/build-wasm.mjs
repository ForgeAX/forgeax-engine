#!/usr/bin/env node
// build-wasm.mjs -- Compile the pinned basis_universal C++ source into two
// self-contained WASM modules via bare emcc (plan-strategy D-1, path B):
//
//   1. transcoder (slim)  -> pkg/basis_transcoder.mjs + .wasm   (runtime-safe)
//   2. encoder            -> pkg/encode/basis_encoder.mjs + .wasm (build-time)
//
// Why bare emcc and not emcmake+cmake (D-1): CI has only the emsdk toolchain
// (emscripten-core/setup-emsdk@v16) and no cmake setup step; the fbx package
// already builds ufbx this way. The emcc flag set below is lifted verbatim from
// the upstream CMake build files and anchored to them in comments so a pin bump
// surfaces any flag drift at review time:
//   transcoder: vendor/basis/webgl/transcoder/CMakeLists.txt
//   encoder:    vendor/basis/webgl/encoder/CMakeLists.txt
//
// Prerequisites:
//   1. emcc on PATH (emsdk 6.0.2; see .github/workflows/ci.yml build-artifacts)
//   2. node scripts/fetch-basis.mjs  (vendors the pinned source)
//
// Usage: node packages/codec/scripts/build-wasm.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODEC_ROOT = join(__dirname, '..');
const VENDOR = join(CODEC_ROOT, 'vendor', 'basis');
const PKG = join(CODEC_ROOT, 'pkg');
const PKG_ENCODE = join(PKG, 'encode');
const REPRODUCIBLE_PATH = `-ffile-prefix-map=${CODEC_ROOT}=/forgeax/codec`;

if (!existsSync(join(VENDOR, 'transcoder', 'basisu_transcoder.cpp'))) {
  console.error('basis source not found. Run `node scripts/fetch-basis.mjs` first.');
  process.exit(1);
}

// --- Compile source lists (mirror upstream CMakeLists SRC_LIST) --------------
// Paths relative to VENDOR. C++ sources compiled by emcc directly; the C zstd
// source is pre-compiled to an object first (C++ std flag must not touch it).

// Transcoder SRC_LIST -- webgl/transcoder/CMakeLists.txt.
const TRANSCODER_CPP = [
  'transcoder/basisu_transcoder.cpp',
  'webgl/transcoder/basis_wrappers.cpp',
];
// zstddeclib.c (decompress-only) for the transcoder KTX2_ZSTANDARD path.
const TRANSCODER_C = 'zstd/zstddeclib.c';

// Encoder SRC_LIST -- webgl/encoder/CMakeLists.txt (non-threaded wasm32 target).
const ENCODER_CPP = [
  'webgl/transcoder/basis_wrappers.cpp',
  'transcoder/basisu_transcoder.cpp',
  'encoder/basisu_backend.cpp',
  'encoder/basisu_basis_file.cpp',
  'encoder/basisu_comp.cpp',
  'encoder/basisu_enc.cpp',
  'encoder/basisu_etc.cpp',
  'encoder/basisu_frontend.cpp',
  'encoder/basisu_gpu_texture.cpp',
  'encoder/basisu_pvrtc1_4.cpp',
  'encoder/basisu_resampler.cpp',
  'encoder/basisu_resample_filters.cpp',
  'encoder/basisu_ssim.cpp',
  'encoder/basisu_uastc_enc.cpp',
  'encoder/basisu_bc7e_scalar.cpp',
  'encoder/basisu_dds_export.cpp',
  'encoder/basisu_bc7enc.cpp',
  'encoder/basisu_kernels_sse.cpp',
  'encoder/basisu_opencl.cpp',
  'encoder/pvpngreader.cpp',
  'encoder/jpgd.cpp',
  'encoder/3rdparty/android_astc_decomp.cpp',
  'encoder/basisu_uastc_hdr_4x4_enc.cpp',
  'encoder/basisu_astc_hdr_6x6_enc.cpp',
  'encoder/basisu_astc_hdr_common.cpp',
  'encoder/basisu_astc_ldr_common.cpp',
  'encoder/basisu_astc_ldr_encode.cpp',
  'encoder/basisu_astc_ldr_fencode.cpp',
  'encoder/basisu_tinyexr.cpp',
  'encoder/basisu_xbc7_encode.cpp',
];
// Encoder needs the full zstd (compress + decompress), not the declib.
const ENCODER_C = 'zstd/zstd.c';

// --- Drift guard (D-1) -------------------------------------------------------
// Every .cpp we name must exist in the vendored tree; and every .cpp present in
// encoder/ (the upstream compile universe) must be either named above or
// explicitly excluded here. This turns a pin bump that adds/removes/renames an
// encoder source into a hard build error instead of a silent miscompile.
const ENCODER_EXCLUDED = new Set([
  // SSE kernels: BASISU_SUPPORT_SSE=0 for WASM (webgl/encoder/CMakeLists.txt).
  'encoder/basisu_bc15_spmd.cpp',
  'encoder/basisu_bc15_spmd_sse.cpp',
  // Standalone WASI C-API path (encoder/basisu_wasm_api.*): a different build
  // target from the webgl embind wrapper (basis_wrappers.cpp). Not in the
  // upstream webgl/encoder CMake SRC_LIST -- excluded from the embind build.
  'encoder/basisu_wasm_api.cpp',
  'encoder/basisu_wasm_transcoder_api.cpp',
  // OpenCL kernel source is header-embedded; basisu_opencl.cpp is the only unit.
]);

function assertSourcesExist(list) {
  for (const rel of list) {
    if (!existsSync(join(VENDOR, rel))) {
      throw new Error(`source drift: expected vendored file missing: ${rel}`);
    }
  }
}

function assertNoUnclaimedEncoderCpp() {
  const encDir = join(VENDOR, 'encoder');
  const named = new Set([...ENCODER_CPP.filter((p) => p.startsWith('encoder/')), ...ENCODER_EXCLUDED]);
  const found = [];
  for (const name of readdirSync(encDir)) {
    if (!name.endsWith('.cpp')) continue;
    found.push(`encoder/${name}`);
  }
  const unclaimed = found.filter((p) => !named.has(p));
  if (unclaimed.length > 0) {
    throw new Error(
      `source drift: encoder/*.cpp present in vendored tree but not in build list ` +
        `nor ENCODER_EXCLUDED: ${unclaimed.join(', ')}. Update build-wasm.mjs after a pin bump.`,
    );
  }
}

// --- Encoder source pixel-limit patch (CI-red fix, human decision) -----------
// The vendored basis_wrappers.cpp caps the encoder's total source texels for the
// non-wasm64 (wasm32) build at BASISU_ENCODER_MAX_SOURCE_IMAGE_PIXELS: default
// (1024*1024*4) = 4 Mpx, higher-limit (1024*1024*12) = 12 Mpx. A 4096x4096 game
// texture is 16.78 Mpx (= 1024*1024*16), above both, so encode() returns 0 bytes
// -> ktx2-encode-failed. Human decision: 4096^2 is a reasonable engine ceiling,
// so raise both non-wasm64 limits to (1024*1024*16), matching the wasm64 branch.
//
// vendor/basis is gitignored + re-fetched every build (fetch-basis.mjs), so the
// override must be applied at build time, not committed to the source file. A
// -D flag can NOT do this: the source uses `#define` (an unconditional macro
// definition), and a command-line -D of the same macro collides with the
// in-source #define (redefinition). So we deterministically rewrite the two
// #else-branch literals in place. Idempotent: after the first patch the old
// (1024*1024*4)/(1024*1024*12) literals no longer exist, so a re-run is a no-op.
const ENCODER_MAX_PIXELS_PATCH = [
  {
    from: '#define BASISU_ENCODER_MAX_SOURCE_IMAGE_PIXELS (1024*1024*4)',
    to: '#define BASISU_ENCODER_MAX_SOURCE_IMAGE_PIXELS (1024*1024*16)',
  },
  {
    from: '#define BASISU_ENCODER_MAX_SOURCE_IMAGE_PIXELS_HIGHER_LIMIT (1024*1024*12)',
    to: '#define BASISU_ENCODER_MAX_SOURCE_IMAGE_PIXELS_HIGHER_LIMIT (1024*1024*16)',
  },
];

function patchEncoderPixelLimit() {
  const wrappers = join(VENDOR, 'webgl', 'transcoder', 'basis_wrappers.cpp');
  let src = readFileSync(wrappers, 'utf8');
  let changed = false;
  for (const { from, to } of ENCODER_MAX_PIXELS_PATCH) {
    if (src.includes(from)) {
      src = src.replace(from, to);
      changed = true;
    } else if (!src.includes(to)) {
      // Neither the pre-patch literal nor the target is present: the upstream
      // source shape drifted (pin bump). Fail loud rather than silently skip.
      throw new Error(
        `encoder pixel-limit patch anchor missing in basis_wrappers.cpp: ${from}. ` +
          'Re-check the non-wasm64 BASISU_ENCODER_MAX_SOURCE_IMAGE_PIXELS defines after a pin bump.',
      );
    }
  }
  if (changed) {
    writeFileSync(wrappers, src);
    console.log('[patch] raised non-wasm64 encoder pixel limits to 1024*1024*16 (4096^2)');
  } else {
    console.log('[patch] encoder pixel limits already at 1024*1024*16, skipping');
  }
}

// --- emcc flag sets (anchored to upstream CMakeLists) ------------------------
const INCLUDE = ['-I', join(VENDOR, 'transcoder')];

// Transcoder compile defines -- webgl/transcoder/CMakeLists.txt
// target_compile_definitions. Slim: encoding off, HDR + BC7 + KTX2 + zstd on,
// ATC/PVRTC2/FXT1/EAC-RG11 off.
const TRANSCODER_DEFS = [
  '-DNDEBUG=1',
  '-DBASISD_SUPPORT_UASTC_HDR=1',
  '-DBASISD_SUPPORT_UASTC=1',
  '-DBASISD_SUPPORT_BC7=1',
  '-DBASISD_SUPPORT_ATC=0',
  '-DBASISD_SUPPORT_ASTC_HIGHER_OPAQUE_QUALITY=0',
  '-DBASISD_SUPPORT_PVRTC2=0',
  '-DBASISD_SUPPORT_FXT1=0',
  '-DBASISD_SUPPORT_ETC2_EAC_RG11=0',
  '-DBASISU_SUPPORT_ENCODING=0',
  '-DBASISD_ENABLE_DEBUG_FLAGS=1',
  '-DBASISD_SUPPORT_KTX2=1',
  '-DBASISD_SUPPORT_KTX2_ZSTD=1',
];

// Encoder compile defines -- webgl/encoder/CMakeLists.txt COMMON_DEFS.
// SSE off (no WASM SSE), encoding + XUASTC on. UASTC_HDR is implied on by the
// encoder unconditionally; KTX2 macros default on in the encoder path.
const ENCODER_DEFS = [
  '-DNDEBUG=1',
  '-DBASISD_SUPPORT_UASTC=1',
  '-DBASISD_SUPPORT_BC7=1',
  '-DBASISD_SUPPORT_ATC=0',
  '-DBASISD_SUPPORT_ASTC_HIGHER_OPAQUE_QUALITY=0',
  '-DBASISD_SUPPORT_PVRTC2=0',
  '-DBASISD_SUPPORT_FXT1=0',
  '-DBASISD_SUPPORT_ETC2_EAC_RG11=0',
  '-DBASISU_SUPPORT_ENCODING=1',
  '-DBASISU_SUPPORT_SSE=0',
  '-DBASISD_SUPPORT_XUASTC=1',
  '-DBASISD_SUPPORT_KTX2_ZSTD=1',
  '-DBASISU_SUPPORT_ASTCENC=0',
];

// Shared link flags. --bind (embind) + MODULARIZE factory named BASIS (upstream
// EXPORT_NAME) + ES6 output + web,node dual environment (fbx precedent).
// EXPORT_ES6 replaces the CMake .js suffix so node/vite consume a .mjs module.
const TRANSCODER_LINK = [
  '--bind',
  '-O3',
  // Mini-game runtimes can disable Function/eval. Emit Embind invokers at
  // build time so the runtime transcoder can initialize without them.
  '-s', 'DYNAMIC_EXECUTION=0',
  '-s', 'EMBIND_AOT=1',
  '-s', 'ALLOW_MEMORY_GROWTH=1',
  '-s', 'MALLOC=emmalloc',
  '-s', 'MODULARIZE=1',
  '-s', 'EXPORT_NAME=BASIS',
  '-s', 'EXPORT_ES6=1',
  '-s', 'ENVIRONMENT=web,node',
  '-s', 'ASSERTIONS=0',
  '-s', "EXPORTED_RUNTIME_METHODS=['HEAP8']",
];

// Encoder base link flags -- webgl/encoder/CMakeLists.txt LINK_BASE + Release
// CONFIG_LINK. Non-threaded target only (USE_PTHREADS omitted): determinism for
// byte-equal re-encode (R-11) and no worker infra needed. INITIAL_MEMORY 128MB
// + 2MB stack are upstream encoder requirements for real image sizes.
const ENCODER_LINK = [
  '--bind',
  '-O3',
  '-s', 'ALLOW_MEMORY_GROWTH=1',
  '-s', 'INITIAL_MEMORY=134217728',
  '-s', 'STACK_SIZE=2097152',
  '-s', 'MODULARIZE=1',
  '-s', 'EXPORT_NAME=BASIS',
  '-s', 'EXPORT_ES6=1',
  '-s', 'ENVIRONMENT=web,node',
  '-s', 'ASSERTIONS=0',
  '-s', "EXPORTED_RUNTIME_METHODS=['HEAP8']",
];

const COMMON_CFLAGS = ['-O3', REPRODUCIBLE_PATH, '-fno-strict-aliasing', '-std=c++17'];

function emcc(args, label) {
  console.log(`\n[${label}] emcc ${args.length} args ...`);
  execFileSync('emcc', args, { stdio: 'inherit', cwd: VENDOR });
}

function abs(list) {
  return list.map((rel) => join(VENDOR, rel));
}

function sizeKB(p) {
  return (statSync(p).size / 1024).toFixed(0);
}

function buildTranscoder() {
  mkdirSync(PKG, { recursive: true });
  // Compile the C zstd unit to an object first (C++ std flag excluded).
  const zstdObj = join(PKG, 'zstddeclib.transcoder.o');
  emcc(
    [
      '-O3',
      REPRODUCIBLE_PATH,
      '-fno-strict-aliasing',
      '-DNDEBUG=1',
      '-DBASISD_SUPPORT_KTX2_ZSTD=1',
      '-c',
      join(VENDOR, TRANSCODER_C),
      '-o',
      zstdObj,
    ],
    'transcoder:zstd',
  );
  emcc(
    [
      ...COMMON_CFLAGS,
      ...TRANSCODER_DEFS,
      ...INCLUDE,
      ...abs(TRANSCODER_CPP),
      zstdObj,
      ...TRANSCODER_LINK,
      '-o', join(PKG, 'basis_transcoder.mjs'),
    ],
    'transcoder:link',
  );
  const wasm = join(PKG, 'basis_transcoder.wasm');
  console.log(`  -> ${wasm} (${sizeKB(wasm)} KB)`);
}

function buildEncoder() {
  mkdirSync(PKG_ENCODE, { recursive: true });
  const zstdObj = join(PKG, 'zstd.encoder.o');
  emcc(
    [
      '-O3',
      REPRODUCIBLE_PATH,
      '-fno-strict-aliasing',
      '-DNDEBUG=1',
      '-c',
      join(VENDOR, ENCODER_C),
      '-o',
      zstdObj,
    ],
    'encoder:zstd',
  );
  emcc(
    [
      ...COMMON_CFLAGS,
      ...ENCODER_DEFS,
      ...INCLUDE,
      ...abs(ENCODER_CPP),
      zstdObj,
      ...ENCODER_LINK,
      '-o', join(PKG_ENCODE, 'basis_encoder.mjs'),
    ],
    'encoder:link',
  );
  const wasm = join(PKG_ENCODE, 'basis_encoder.wasm');
  console.log(`  -> ${wasm} (${sizeKB(wasm)} KB)`);
}

function main() {
  assertSourcesExist(TRANSCODER_CPP);
  assertSourcesExist(ENCODER_CPP);
  assertSourcesExist([TRANSCODER_C, ENCODER_C]);
  assertNoUnclaimedEncoderCpp();

  // Raise the non-wasm64 encoder source-pixel ceiling to 4096^2 before the
  // encoder compile so 4096x4096 game textures encode instead of returning 0.
  patchEncoderPixelLimit();

  buildTranscoder();
  buildEncoder();

  // Drop the intermediate emcc object files: they are recompiled from source on
  // every run (no .o-keyed caching) and are NOT part of the shipped runtime. The
  // release publisher packs pkg/ with `tar -C pkg .`, so leaving them here would
  // bloat the content-keyed tarball with non-runtime bytes. pkg/ then holds only
  // the four runtime files (basis_transcoder.{mjs,wasm} + encode/basis_encoder.
  // {mjs,wasm}) that fetch-wasm.mjs extracts back.
  for (const o of [join(PKG, 'zstddeclib.transcoder.o'), join(PKG, 'zstd.encoder.o')]) {
    rmSync(o, { force: true });
  }

  console.log('\nBuild complete:');
  console.log(`  ${join(PKG, 'basis_transcoder.mjs')} + .wasm`);
  console.log(`  ${join(PKG_ENCODE, 'basis_encoder.mjs')} + .wasm`);
}

try {
  main();
} catch (e) {
  console.error(`\nbuild-wasm failed: ${e.message}`);
  console.error('Is emcc on PATH? Install: https://emscripten.org/docs/getting_started/downloads.html');
  process.exit(1);
}
