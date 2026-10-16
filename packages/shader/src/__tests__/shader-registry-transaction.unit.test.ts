import type { ShaderModule } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { type ManifestEntry, ShaderRegistry, type ShaderRegistryDevice } from '../index.js';

const FIRST_ENTRY: ManifestEntry = {
  hash: 'first123',
  wgsl: 'first-wgsl',
  glsl: undefined,
  bindings: '[]',
};

const SECOND_ENTRY: ManifestEntry = {
  hash: 'second12',
  wgsl: 'second-wgsl',
  glsl: '',
  bindings: '[]',
};

const CORRECTED_MATERIAL_SHADER = {
  identifier: 'my-game::corrected',
  sourcePath: 'src/corrected.wgsl',
  composedWgsl: 'corrected-wgsl',
  paramSchema: '[]',
  variants: [],
};

const CORRECTED_MANIFEST = {
  entries: [SECOND_ENTRY, FIRST_ENTRY],
  materialShaders: [
    CORRECTED_MATERIAL_SHADER,
    { ...CORRECTED_MATERIAL_SHADER, identifier: 'my-game::another' },
  ],
};

function createTrackingDevice(): { device: ShaderRegistryDevice; created: string[] } {
  const created: string[] = [];
  const device: ShaderRegistryDevice = {
    createShaderModule({ code }) {
      created.push(code);
      return {
        ok: true,
        value: {} as ShaderModule,
      } as ReturnType<ShaderRegistryDevice['createShaderModule']>;
    },
  };
  return { device, created };
}

function dataUrl(): string {
  return 'data:application/json,shader-registry-transaction';
}

describe('ShaderRegistry public manifest transaction', () => {
  it.each([
    {
      name: 'a malformed later entry',
      manifest: {
        entries: [FIRST_ENTRY, { ...SECOND_ENTRY, bindings: 42 }],
        materialShaders: [CORRECTED_MATERIAL_SHADER],
      },
    },
    {
      name: 'a malformed material row',
      manifest: {
        entries: [FIRST_ENTRY, SECOND_ENTRY],
        materialShaders: [{ identifier: 'my-game::malformed' }],
      },
    },
    {
      name: 'a duplicate material identifier',
      manifest: {
        entries: [FIRST_ENTRY, SECOND_ENTRY],
        materialShaders: [CORRECTED_MATERIAL_SHADER, CORRECTED_MATERIAL_SHADER],
      },
    },
  ])('refuses $name atomically and retries the same source on the same registry', async ({
    manifest,
  }) => {
    let currentManifest: unknown = manifest;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(currentManifest), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const { device, created } = createTrackingDevice();
    const manifestUrl = dataUrl();
    const registry = new ShaderRegistry({ device, manifestUrl });

    try {
      const refused = await registry.loadManifest();
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error.code).toBe('manifest-malformed');
      expect(Array.from(registry.entries())).toEqual([]);
      expect(Array.from(registry.materialShaderManifestEntries())).toEqual([]);
      expect(
        registry.materialShaderManifestEntry(CORRECTED_MATERIAL_SHADER.identifier),
      ).toBeUndefined();
      expect(registry.get(FIRST_ENTRY.hash).ok).toBe(false);
      expect(created).toEqual([]);

      currentManifest = CORRECTED_MANIFEST;
      const repaired = await registry.loadManifest();
      expect(repaired.ok).toBe(true);
      expect(Array.from(registry.entries()).map((entry) => entry.hash)).toEqual([
        SECOND_ENTRY.hash,
        FIRST_ENTRY.hash,
      ]);
      expect(
        Array.from(registry.materialShaderManifestEntries()).map((entry) => entry.identifier),
      ).toEqual([CORRECTED_MATERIAL_SHADER.identifier, 'my-game::another']);
      expect(registry.materialShaderManifestEntry(CORRECTED_MATERIAL_SHADER.identifier)).toBe(
        registry.materialShaderManifestEntries().next().value,
      );
      expect(registry.materialShaderManifestEntry('missing')).toBeUndefined();

      const module = registry.get(SECOND_ENTRY.hash);
      expect(module.ok).toBe(true);
      expect(created).toEqual([SECOND_ENTRY.wgsl]);

      const reloaded = await registry.loadManifest();
      expect(reloaded.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(Array.from(registry.entries()).map((entry) => entry.hash)).toEqual([
        SECOND_ENTRY.hash,
        FIRST_ENTRY.hash,
      ]);
      expect(created).toEqual([SECOND_ENTRY.wgsl]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

it('loads CPU shader metadata without a GPU and forks the same manifest into a device owner', async () => {
  const registry = new ShaderRegistry({
    manifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(CORRECTED_MANIFEST))}`,
  });
  expect((await registry.loadManifest()).ok).toBe(true);
  expect(registry.findMaterialArtifact('my-game::corrected')).toBeDefined();
  const unavailable = registry.get(FIRST_ENTRY.hash);
  expect(unavailable.ok).toBe(false);
  if (!unavailable.ok) expect(unavailable.error.code).toBe('rhi-not-available');
  const { device, created } = createTrackingDevice();
  const fork = registry.forkForDevice(device);
  expect(fork.materialShaderManifestEntry(CORRECTED_MATERIAL_SHADER.identifier)).toBe(
    registry.materialShaderManifestEntry(CORRECTED_MATERIAL_SHADER.identifier),
  );
  expect(fork.get(FIRST_ENTRY.hash).ok).toBe(true);
  expect(created).toEqual(['first-wgsl']);
});
