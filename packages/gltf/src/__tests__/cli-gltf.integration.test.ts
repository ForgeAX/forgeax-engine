// packages/gltf/src/__tests__/cli-gltf.integration.test.ts
//
// Integration test: run `forgeax asset import import` against real
// glTF files and verify the written .meta.json sidecar contains texture
// sub-assets (feat-20260608 M6 w29 AC-18).
//
// Uses the BoxTextured fixture from forgeax-engine-assets.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCliGltf } from '../cli-gltf.js';

interface CapturedIO {
  stdout: string[];
  stderr: string[];
}

function makeIO(): CapturedIO {
  return { stdout: [], stderr: [] };
}

function ctxFor(io: CapturedIO) {
  return {
    stdoutWrite: (line: string): void => {
      io.stdout.push(line);
    },
    stderrWrite: (line: string): void => {
      io.stderr.push(line);
    },
  };
}

describe('cli-gltf integration (AC-18)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gltf-cli-int-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('produces texture sub-assets in .meta.json for BoxTextured.gltf (external-uri)', async () => {
    const assetsDir = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../../forgeax-engine-assets/khronos-gltf-samples',
    );
    const gltfDir = join(assetsDir, 'BoxTextured', 'glTF');
    const sourcePath = join(gltfDir, 'BoxTextured.gltf');

    // Verify the fixture exists.
    let fileStats: { isFile(): boolean } | undefined;
    try {
      fileStats = await stat(sourcePath);
    } catch {
      // Fixture not available; skip the test.
      return;
    }
    expect(fileStats.isFile()).toBe(true);

    // Symlink the fixture into a temp dir so the sidecar is written there.
    const dest = join(tempDir, 'BoxTextured.gltf');
    await writeFile(dest, await readFile(sourcePath));
    // Also copy sibling .bin and .png files needed for parseGltf.
    for (const siblingName of ['BoxTextured.bin', 'CesiumLogoFlat.png']) {
      const src = join(gltfDir, siblingName);
      try {
        await stat(src);
        await writeFile(join(tempDir, siblingName), await readFile(src));
      } catch {
        // Skip if missing.
      }
    }

    const io = makeIO();
    const code = await runCliGltf(['import', dest], ctxFor(io));
    expect(code).toBe(0);

    const metaPath = `${dest}.meta.json`;
    const metaRaw = await readFile(metaPath, 'utf-8');
    const meta = JSON.parse(metaRaw) as { subAssets?: Array<{ kind: string }> };
    expect(meta.subAssets).toBeDefined();

    const kinds = meta.subAssets?.map((s) => s.kind) ?? [];
    expect(kinds).toContain('texture');
  });

  it('produces texture sub-assets in .meta.json for BoxTextured.glb (bufferView)', async () => {
    const assetsDir = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../../forgeax-engine-assets/khronos-gltf-samples',
    );
    const sourcePath = join(assetsDir, 'BoxTextured', 'BoxTextured.glb');

    let fileStatsForGlb: { isFile(): boolean } | undefined;
    try {
      fileStatsForGlb = await stat(sourcePath);
    } catch {
      return;
    }
    expect(fileStatsForGlb.isFile()).toBe(true);

    const destGlb = join(tempDir, 'BoxTextured.glb');
    await writeFile(destGlb, await readFile(sourcePath));

    const io = makeIO();
    const code = await runCliGltf(['import', destGlb], ctxFor(io));
    expect(code).toBe(0);

    const metaPath = `${destGlb}.meta.json`;
    const metaRaw = await readFile(metaPath, 'utf-8');
    const meta = JSON.parse(metaRaw) as { subAssets?: Array<{ kind: string }> };
    expect(meta.subAssets).toBeDefined();

    const kinds = meta.subAssets?.map((s) => s.kind) ?? [];
    expect(kinds).toContain('texture');
  });
});
