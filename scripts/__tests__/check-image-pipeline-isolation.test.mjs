// w7 -- self-test fixture for scripts/check-image-pipeline-isolation.mjs
// Path (a) algorithm rewrite (forbidden implementation symbols + import
// requirement + legacy filename rejection).
//
// Reference:
//   - plan-strategy section 2 D-4 ("forbidden symbol clause + import
//     requirement"): four-clause Path (a) replacement of the literal grep
//     used by feat-20260515 AC-15a.
//   - plan-strategy section 5.3 ("grep gate self-test: runtime
//     `function decodeImage(...)` must FAIL; runtime
//     `import { parseImage } from '@forgeax/engine-image'` must PASS").
//   - requirements section 6 AC-08 ("runtime does not re-implement
//     PNG/JPG decoding inside its own source").
//
// TDD red: this file lands BEFORE the script rewrite (w8). Against the
// pre-rewrite literal-grep script the assertions on the new stderr / stdout
// markers do not match, so vitest reports red. After w8 lands the new
// script emits the expected markers and the four cases turn green.
//
// The script is invoked with `--root <fixture>` (a CLI flag added by w8 to
// mirror scripts/check-concern-reverse-coupling.mjs); the production CI
// invocation `node scripts/check-image-pipeline-isolation.mjs` keeps its
// `process.cwd()` default unchanged.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const scriptPath = resolve(repoRoot, 'scripts/check-image-pipeline-isolation.mjs');
const fixturesDir = resolve(here, 'check-image-pipeline-isolation.fixtures');

function run(root) {
  const r = spawnSync('node', [scriptPath, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

// w27 (feat-20260603-asset-import-loader-injection M3): the a.2 clause was
// inverted from "runtime MUST import the decoder" to "runtime must NOT static-
// import the decoder + the build-time imageImporter holds parseImage". Case
// (b) now asserts the decoder-stripped runtime PASSES; case (e) asserts a
// runtime that regrows a static engine-image import FAILS.
describe('check-image-pipeline-isolation Path (a) -- forbidden symbols + decoder-strip req', () => {
  it('(a) runtime re-defines `function decodeImage` -> exit 1 + forbidden-symbol marker', () => {
    const fixtureRoot = resolve(fixturesDir, 'runtime-redefines-decode-image');
    const r = run(fixtureRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AC-15 \(a\) FAIL/);
    expect(r.stderr).toMatch(/forbidden implementation symbol/);
    expect(r.stderr).toMatch(/function decodeImage/);
  });

  it('(b) runtime decoder stripped (no engine-image import) + imageImporter holds parseImage -> exit 0', () => {
    const fixtureRoot = resolve(fixturesDir, 'runtime-decoder-stripped');
    const r = run(fixtureRoot);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/AC-15 \(a\) OK/);
    expect(r.stdout).toMatch(/no static @forgeax\/engine-image import/);
    expect(r.stdout).toMatch(/imageImporter holds parseImage/);
  });

  it('(e) runtime static-imports a decoder from @forgeax/engine-image -> exit 1 + decoder-strip marker', () => {
    const fixtureRoot = resolve(fixturesDir, 'runtime-static-imports-decoder');
    const r = run(fixtureRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AC-15 \(a\) FAIL/);
    expect(r.stderr).toMatch(/decoder-strip requirement/);
    expect(r.stderr).toMatch(/runtime static import of @forgeax\/engine-image/);
  });

  it('(c) runtime declares `class CustomDecoder` -> exit 1 + forbidden-symbol marker', () => {
    const fixtureRoot = resolve(fixturesDir, 'runtime-redefines-custom-decoder');
    const r = run(fixtureRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AC-15 \(a\) FAIL/);
    expect(r.stderr).toMatch(/forbidden implementation symbol/);
    expect(r.stderr).toMatch(/CustomDecoder/);
  });

  it('(d) legacy `image-decoders.d.ts` filename regrows -> exit 1 + legacy-filename marker', () => {
    const fixtureRoot = resolve(fixturesDir, 'legacy-image-decoders-filename');
    const r = run(fixtureRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AC-15 \(a\) FAIL/);
    expect(r.stderr).toMatch(/legacy filename/);
    expect(r.stderr).toMatch(/image-decoders\.d\.ts/);
  });
});

// w27-w28 (feat-20260706-asset-compression-base-zstd-and-ktx2-container-uni M5):
// Path (d) isolates @forgeax/engine-codec/encode (build-time encoding subpath)
// from runtime. Runtime may import the main @forgeax/engine-codec entry
// (decompressZstd / parseKtx2 / errors) but must not import the encode subpath.
describe('check-image-pipeline-isolation Path (d) -- runtime codec encode isolation', () => {
  it('(d-neg) runtime imports @forgeax/engine-codec/encode -> exit 1 + path d violation marker', () => {
    const fixtureRoot = resolve(fixturesDir, 'runtime-static-imports-codec-encode');
    const r = run(fixtureRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AC-15 \(d\) FAIL/);
    expect(r.stderr).toMatch(/runtime static import of @forgeax\/engine-codec\/encode/);
  });

  it('(d-pos) runtime imports @forgeax/engine-codec main entry -> exit 0', () => {
    const fixtureRoot = resolve(fixturesDir, 'runtime-imports-codec-main');
    const r = run(fixtureRoot);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/AC-15 \(d\) OK/);
    expect(r.stdout).toMatch(/no @forgeax\/engine-codec\/encode import/);
  });

  it('(d-bound) runtime imports @forgeax/engine-codec/other-subpath -> exit 0 (not blocked)', () => {
    const fixtureRoot = resolve(fixturesDir, 'runtime-imports-codec-other-subpath');
    const r = run(fixtureRoot);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/AC-15 \(d\) OK/);
  });

  it('(d-regress) existing path a still catches runtime engine-image import after path d addition', () => {
    const fixtureRoot = resolve(fixturesDir, 'runtime-static-imports-decoder');
    const r = run(fixtureRoot);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AC-15 \(a\) FAIL/);
    expect(r.stderr).toMatch(/decoder-strip requirement/);
    expect(r.stderr).toMatch(/runtime static import of @forgeax\/engine-image/);
  });
});
