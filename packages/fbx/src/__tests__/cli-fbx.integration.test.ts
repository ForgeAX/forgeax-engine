import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImporterRegistry, type RunImportMeta, runImport } from '@forgeax/engine-import';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCliFbx } from '../cli-fbx.js';
import { fbxImporter } from '../fbx-importer.js';

interface CapturedIo {
  readonly stdout: string[];
  readonly stderr: string[];
}

function io(): CapturedIo {
  return { stdout: [], stderr: [] };
}

function context(captured: CapturedIo) {
  return {
    stdoutWrite: (line: string): void => {
      captured.stdout.push(line);
    },
    stderrWrite: (line: string): void => {
      captured.stderr.push(line);
    },
  };
}

describe('FBX sidecar producer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forgeax-fbx-cli-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a GUID-stable sidecar from a real FBX source', async () => {
    const source = join(tempDir, 'lod-group.fbx');
    await writeFile(source, await readFile(new URL('./fixtures/lod-group.fbx', import.meta.url)));

    const firstIo = io();
    expect(await runCliFbx(['import', source], context(firstIo))).toBe(0);
    expect(firstIo.stderr).toEqual([]);
    const firstText = await readFile(`${source}.meta.json`, 'utf8');
    const first = JSON.parse(firstText) as {
      readonly importer: string;
      readonly subAssets: readonly { readonly guid: string; readonly kind: string }[];
    };
    expect(first.importer).toBe('fbx');
    expect(first.subAssets.map((entry) => entry.kind)).toEqual([
      'mesh',
      'mesh',
      'material',
      'scene',
    ]);

    const registry = new ImporterRegistry();
    registry.register(fbxImporter);
    const imported = await runImport(JSON.parse(firstText) as RunImportMeta, registry, {
      readSource: async () => ({
        ok: true as const,
        value: new Uint8Array(await readFile(source)),
      }),
    });
    expect(imported.ok).toBe(true);
    if (imported.ok && 'pack' in imported.value) {
      expect(imported.value.pack.assets.map((asset) => asset.kind)).toEqual([
        'mesh',
        'mesh',
        'material',
        'scene',
      ]);
    }

    const secondIo = io();
    expect(await runCliFbx(['import', source], context(secondIo))).toBe(0);
    expect(await readFile(`${source}.meta.json`, 'utf8')).toBe(firstText);
    const second = JSON.parse(await readFile(`${source}.meta.json`, 'utf8')) as {
      readonly subAssets: readonly { readonly guid: string }[];
    };
    expect(second.subAssets.map((entry) => entry.guid)).toEqual(
      first.subAssets.map((entry) => entry.guid),
    );
  });

  it('does not write a sidecar during dry-run', async () => {
    const source = join(tempDir, 'lod-group.fbx');
    await writeFile(source, await readFile(new URL('./fixtures/lod-group.fbx', import.meta.url)));
    const captured = io();
    expect(await runCliFbx(['import', '--dry-run', source], context(captured))).toBe(0);
    await expect(readFile(`${source}.meta.json`)).rejects.toThrow();
  });
});
