import { resolve } from 'node:path';
import * as naga from '@forgeax/engine-naga';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { prepareShaderProgramCompiler } from '@forgeax/engine-shader-compiler';
import { expect, it, vi } from 'vitest';
import { forgeaxShader } from '../index.js';

it('publishes native Engine sources through the Vite build without composing unused Engine or Pack materials', async () => {
  const compose = vi.spyOn(naga, 'composeShader');
  const emitted: { fileName: string; source: string | Uint8Array }[] = [];
  const plugin = forgeaxShader({
    publication: 'source',
    publishAuthoredMaterialShaders: false,
    compressManifest: false,
    materialPackages: [
      resolve('apps/learn-render/4.advanced-opengl/3.blending/src/alpha-test.pack.json'),
    ],
  });
  const context = {
    emitFile(asset: { fileName: string; source: string | Uint8Array }) {
      emitted.push(asset);
      return asset.fileName;
    },
    error(error: unknown): never {
      throw error;
    },
  };
  try {
    await plugin.buildStart.call(context as never);
    await plugin.generateBundle.call(context as never);
    const asset = emitted.find((asset) => asset.fileName === 'shaders/manifest.json');
    expect(asset).toBeDefined();
    const wire = JSON.parse(String(asset?.source));
    expect(wire.schemaVersion).toBe('7.0.0');
    expect(wire.entries.length).toBeGreaterThan(50);
    expect(
      wire.materialShaders.some(
        (row: { identifier: string }) => row.identifier === 'learn_render::alpha_test',
      ),
    ).toBe(false);
    expect(JSON.stringify(wire)).not.toContain('composedWgsl');
    expect(compose).not.toHaveBeenCalled();
  } finally {
    compose.mockRestore();
    await plugin.closeBundle?.();
  }
}, 60_000);

it('publishes transformed raw shader inputs with a working original lookup handle', async () => {
  const emitted: { fileName: string; source: string | Uint8Array }[] = [];
  const plugin = forgeaxShader({
    publication: 'source',
    engineEntries: false,
    publishAuthoredMaterialShaders: false,
    compressManifest: false,
  });
  const context = {
    emitFile(asset: { fileName: string; source: string | Uint8Array }) {
      emitted.push(asset);
      return asset.fileName;
    },
    error(error: unknown): never {
      throw error;
    },
  };
  try {
    await plugin.buildStart.call(context as never);
    const source = '@compute @workgroup_size(1) fn main() {}';
    const result = await plugin.transform.call(
      context as never,
      source,
      '/tmp/native-template-compute.wgsl',
    );
    expect(result?.code).toContain('export default');
    await plugin.generateBundle.call(context as never);
    const wire = JSON.parse(
      String(emitted.find((asset) => asset.fileName === 'shaders/manifest.json')?.source),
    );
    expect(wire.schemaVersion).toBe('7.0.0');
    expect(wire.entries).toHaveLength(1);
    const row = wire.entries.find(
      (row: { identifier: string }) => row.identifier === '/tmp/native-template-compute.wgsl',
    );
    expect(row).toBeDefined();
    expect(result?.code).toContain(row.hash);
    let gpuCode: string | undefined;
    const registry = new ShaderRegistry({
      manifestUrl: '/built',
      readText: async () => JSON.stringify(wire),
      programCompiler: (await prepareShaderProgramCompiler()).unwrap(),
      device: {
        createShaderModule(descriptor) {
          gpuCode = descriptor.code;
          return { ok: true, value: {} } as never;
        },
      },
    });
    (await registry.loadManifest()).unwrap();
    expect(registry.programTemplateInspection().selections).toBe(0);
    expect(registry.get(row.hash).ok).toBe(true);
    expect(gpuCode).toContain('fn main');
    expect(registry.programTemplateInspection().selections).toBe(1);
  } finally {
    await plugin.closeBundle?.();
  }
}, 60_000);
