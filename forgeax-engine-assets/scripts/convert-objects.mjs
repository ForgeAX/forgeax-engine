#!/usr/bin/env node
// convert-objects.mjs
//
// Vendor-time offline tool: convert upstream .obj files (planet.obj, rock.obj,
// backpack.obj) to .gltf + .bin via obj2gltf@3.2.0, verify byte-level
// determinism with a double-run + diff, then copy verified outputs into the
// learn-opengl/objects/ vendor tree. Textures are copied from obj2gltf's own
// output (it re-encodes non-PNG sources, e.g. backpack's specular.jpg ->
// specular.png) so the vendored .gltf image URIs always resolve.
//
// Upstream: JoeyDeVries/LearnOpenGL @ a545a703f95893258d16dbe32f5ccbb6400fd213
//   resources/objects/planet/{planet.obj, planet.mtl, mars.png}
//   resources/objects/rock/{rock.obj, rock.mtl, rock.png}
//   resources/objects/backpack/{backpack.obj, backpack.mtl, diffuse.jpg,
//                               specular.jpg, normal.png}
//
// Vendor outputs (11 files):
//   learn-opengl/objects/planet/{planet.gltf, planet.bin, mars.png}
//   learn-opengl/objects/rock/{rock.gltf, rock.bin, rock.png}
//   learn-opengl/objects/backpack/{backpack.gltf, backpack.bin, diffuse.jpg,
//                                  specular.png, normal.png}
//
// Determinism contract (AC-02):
//   Each .obj is converted twice into separate tmp dirs. Byte-level diff on
//   .gltf + .bin pairs; any mismatch fails the script with a detailed report
//   (offset + length of differing regions). This guarantees reproducibility
//   even though obj2gltf upstream makes no byte-determinism promises.
//
// Required flags (D-1):
//   --separate                mandatory — separate buffers (.bin) and textures
//                             (.png) as external URIs. Without this, forgeax
//                             engine-gltf may silently drop embedded data.
//   --specularGlossiness OFF  forbidden — injects extensionsRequired[]
//   --unlit               OFF  forbidden — injects extensionsRequired[]
//   --binary              OFF  forbidden — requirement wants .gltf + .bin pair
//
// Usage:
//   node scripts/convert-objects.mjs                       # full conversion
//   node scripts/convert-objects.mjs --dry-run             # verify only, no copy
//   node scripts/convert-objects.mjs --upstream <dir>      # override upstream root
//   node scripts/convert-objects.mjs --help                # this message
//
// Exit codes:
//   0  success
//   1  upstream dir not found / missing required files
//   2  obj2gltf execution failed
//   3  byte-level diff failed (non-deterministic output)
//   4  copy to vendor dir failed
//   5  diff verification failed (internal)

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HELP = `convert-objects.mjs

Convert upstream .obj files to .gltf+.bin via obj2gltf@3.2.0,
verify byte-level determinism, then copy into the vendor tree.

Options:
  --dry-run          Run double-convert + diff verification only; do not copy
                     outputs into the vendor tree.
  --upstream <dir>   Override the upstream LearnOpenGL repository root
                     (default: /tmp/LearnOpenGL-full).
  --help             Show this message.
`;

const OBJ2GLTF_PIN = 'obj2gltf@3.2.0';
const OBJ2GLTF_FLAGS = ['--separate'];
const UPSTREAM_COMMIT = 'a545a703f95893258d16dbe32f5ccbb6400fd213';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const VENDOR_OBJECTS_DIR = join(REPO_ROOT, 'learn-opengl', 'objects');

const TARGETS = [
  {
    name: 'planet',
    obj: 'planet.obj',
    mtl: 'planet.mtl',
    textures: ['mars.png'],
    verifyGlb: 'planet.gltf',
    verifyBin: 'planet.bin',
  },
  {
    name: 'rock',
    obj: 'rock.obj',
    mtl: 'rock.mtl',
    textures: ['rock.png'],
    verifyGlb: 'rock.gltf',
    verifyBin: 'rock.bin',
  },
  {
    name: 'backpack',
    obj: 'backpack.obj',
    mtl: 'backpack.mtl',
    textures: ['diffuse.jpg', 'specular.png', 'normal.png'],
    verifyGlb: 'backpack.gltf',
    verifyBin: 'backpack.bin',
  },
];

function usageErr(msg) {
  process.stderr.write(`[convert-objects] ${msg}\n`);
  process.exit(1);
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function verifyUpstream(upstreamRoot) {
  if (!existsSync(upstreamRoot) || !existsSync(join(upstreamRoot, '.git'))) {
    return false;
  }
  for (const t of TARGETS) {
    const d = join(upstreamRoot, 'resources', 'objects', t.name);
    if (!existsSync(join(d, t.obj)) || !existsSync(join(d, t.mtl))) {
      return false;
    }
  }
  return true;
}

function runObj2gltf(objPath, outDir, outName) {
  ensureDir(outDir);
  const outPath = join(outDir, `${outName}.gltf`);
  const args = [
    OBJ2GLTF_PIN,
    '-i', objPath,
    '-o', outPath,
    ...OBJ2GLTF_FLAGS,
  ];
  const result = spawnSync('npx', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
  if (result.error) {
    process.stderr.write(
      `[convert-objects] npx obj2gltf spawn error for ${outName}: ${result.error.message}\n`,
    );
    return null;
  }
  if (result.status !== 0) {
    process.stderr.write(
      `[convert-objects] obj2gltf exited ${result.status} for ${outName}\n` +
        `[convert-objects] stderr: ${result.stderr.toString('utf8').slice(0, 500)}\n`,
    );
    return null;
  }
  return outPath;
}

function fileBytes(p) {
  return readFileSync(p);
}

function diffBytes(pathA, pathB, label) {
  const a = fileBytes(pathA);
  const b = fileBytes(pathB);
  const maxLen = Math.max(a.length, b.length);
  if (a.length !== b.length) {
    process.stderr.write(
      `[convert-objects] DIFF FAIL ${label}: size mismatch — ` +
        `a=${a.length} bytes, b=${b.length} bytes\n`,
    );
    return false;
  }
  const diffs = [];
  for (let i = 0; i < maxLen; i += 1) {
    if (a[i] !== b[i]) {
      let segStart = i;
      while (i < maxLen && a[i] !== b[i]) {
        i += 1;
      }
      diffs.push({ offset: segStart, length: i - segStart });
    }
  }
  if (diffs.length > 0) {
    process.stderr.write(
      `[convert-objects] DIFF FAIL ${label}: ${diffs.length} differing segment(s)\n`,
    );
    for (const d of diffs) {
      process.stderr.write(
        `  offset=${d.offset} length=${d.length} ` +
          `(bytes 0x${d.offset.toString(16)}–0x${(d.offset + d.length - 1).toString(16)})\n`,
      );
    }
    return false;
  }
  return true;
}

function verifyDeterminism(target, upstreamRoot) {
  const objPath = join(upstreamRoot, 'resources', 'objects', target.name, target.obj);
  const tmpA = join(tmpdir(), 'forgeax-obj2gltf-verify-a', target.name);
  const tmpB = join(tmpdir(), 'forgeax-obj2gltf-verify-b', target.name);

  process.stdout.write(`[convert-objects] run A: ${target.name}\n`);
  const gltfA = runObj2gltf(objPath, tmpA, target.name);
  if (!gltfA) return false;

  process.stdout.write(`[convert-objects] run B: ${target.name}\n`);
  const gltfB = runObj2gltf(objPath, tmpB, target.name);
  if (!gltfB) return false;

  const gltfOk = diffBytes(
    join(tmpA, `${target.name}.gltf`),
    join(tmpB, `${target.name}.gltf`),
    `${target.name}.gltf`,
  );
  if (!gltfOk) return false;

  const binOk = diffBytes(
    join(tmpA, `${target.name}.bin`),
    join(tmpB, `${target.name}.bin`),
    `${target.name}.bin`,
  );
  if (!binOk) return false;

  process.stdout.write(`[convert-objects] DETERMINISTIC: ${target.name} — both runs byte-identical\n`);
  return gltfA; // ret path to the verified gltf for subsequent copy
}

function copyToVendor(targetName, verifiedTmpDir) {
  const vendorDir = join(VENDOR_OBJECTS_DIR, targetName);
  ensureDir(vendorDir);

  const gltfSrc = join(verifiedTmpDir, `${targetName}.gltf`);
  const binSrc = join(verifiedTmpDir, `${targetName}.bin`);
  const gltfDst = join(vendorDir, `${targetName}.gltf`);
  const binDst = join(vendorDir, `${targetName}.bin`);

  try {
    cpSync(gltfSrc, gltfDst);
    cpSync(binSrc, binDst);
  } catch (err) {
    process.stderr.write(`[convert-objects] copy to vendor failed for ${targetName}: ${err.message}\n`);
    return false;
  }
  process.stdout.write(`[convert-objects] COPIED ${targetName}.gltf -> ${gltfDst}\n`);
  process.stdout.write(`[convert-objects] COPIED ${targetName}.bin  -> ${binDst}\n`);
  return true;
}

function copyTexture(targetName, texName, verifiedTmpDir) {
  // obj2gltf emits the textures it references (re-encoding non-PNG sources, e.g.
  // backpack's specular.jpg -> specular.png) into its own output dir. Copy from
  // there, not upstream, so the vendored .gltf's image URIs always resolve and
  // rock/planet stay byte-identical to upstream (their textures pass through
  // unchanged).
  const src = join(verifiedTmpDir, texName);
  const dst = join(VENDOR_OBJECTS_DIR, targetName, texName);
  try {
    cpSync(src, dst);
  } catch (err) {
    process.stderr.write(`[convert-objects] copy texture failed for ${texName}: ${err.message}\n`);
    return false;
  }
  process.stdout.write(`[convert-objects] COPIED ${texName} -> ${dst}\n`);
  return true;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }

  const dryRun = argv.includes('--dry-run');

  let upstreamRoot = '/tmp/LearnOpenGL-full';
  const upstreamIdx = argv.indexOf('--upstream');
  if (upstreamIdx !== -1 && upstreamIdx + 1 < argv.length) {
    upstreamRoot = argv[upstreamIdx + 1];
  }

  if (!verifyUpstream(upstreamRoot)) {
    process.stderr.write(
      `[convert-objects] upstream dir not found or missing required files: ${upstreamRoot}\n` +
        `[convert-objects] expected: resources/objects/planet/{planet.obj,planet.mtl,mars.png}\n` +
        `[convert-objects] expected: resources/objects/rock/{rock.obj,rock.mtl,rock.png}\n` +
        `[convert-objects] clone command: git clone --depth=1 https://github.com/JoeyDeVries/LearnOpenGL.git /tmp/LearnOpenGL-full\n`,
    );
    return 1;
  }

  // Phase 1: double-run + diff for each target
  const verifiedDirs = {};
  for (const target of TARGETS) {
    process.stdout.write(
      `[convert-objects] --- verifying byte determinism for ${target.name} ---\n`,
    );
    const verifiedPath = verifyDeterminism(target, upstreamRoot);
    if (!verifiedPath) {
      process.stderr.write(
        `[convert-objects] byte-determinism check FAILED for ${target.name}\n` +
          `[convert-objects] obj2gltf@3.2.0 produces non-deterministic output — aborting\n`,
      );
      return 3;
    }
    verifiedDirs[target.name] = dirname(verifiedPath);
  }

  if (dryRun) {
    process.stdout.write('[convert-objects] --dry-run: all verifications passed, skipping vendor copy\n');
    return 0;
  }

  // Phase 2: copy verified outputs + textures into vendor tree
  for (const target of TARGETS) {
    process.stdout.write(
      `[convert-objects] --- copying ${target.name} into vendor tree ---\n`,
    );
    if (!copyToVendor(target.name, verifiedDirs[target.name])) {
      return 4;
    }
    for (const tex of target.textures) {
      if (!copyTexture(target.name, tex, verifiedDirs[target.name])) {
        return 4;
      }
    }
  }

  process.stdout.write('[convert-objects] DONE: all targets converted and copied to vendor tree\n');
  return 0;
}

const code = main(process.argv.slice(2));
process.exit(code);
