import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const shaderOptions: unknown[] = [];
vi.mock('@forgeax/engine-vite-plugin-shader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgeax/engine-vite-plugin-shader')>();
  return {
    ...actual,
    forgeaxShader: (options: Parameters<typeof actual.forgeaxShader>[0]) => {
      shaderOptions.push(options);
      return actual.forgeaxShader(options);
    },
  };
});

const { createViteConfig } = await import('../host.js');
const { readProjectFacts } = await import('../project.js');
const { findEngineWorkspaceRoot } = await import('../asset-libraries.js');

async function configFor(forgeax: Record<string, unknown>, resourcePreview = false) {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-shader-options-'));
  try {
    await mkdir(resolve(root, 'assets'), { recursive: true });
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'shader-options',
        name: 'Shader Options',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    );
    await writeFile(
      resolve(root, 'package.json'),
      JSON.stringify({ name: 'shader-options', forgeax }),
    );
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw new Error(JSON.stringify(facts.error));
    shaderOptions.length = 0;
    await createViteConfig(
      facts.value,
      'build',
      '/',
      resourcePreview ? { bootstrapRoot: 'resource-bootstrap' } : {},
    );
    return shaderOptions.at(-1) as
      | {
          engineEntries?: unknown;
          workspaceRoot?: string;
          publication?: string;
          publishAuthoredMaterialShaders?: boolean;
        }
      | undefined;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('DevKit shader build options', () => {
  it('retains the Engine producer workspace when the project is outside its source checkout', async () => {
    const workspaceRoot = findEngineWorkspaceRoot();
    expect(workspaceRoot).toBeDefined();
    expect((await configFor({}))?.workspaceRoot).toBe(workspaceRoot);
  }, 60_000);

  it('builds point-shadow Standard shaders only when package.json opts in', async () => {
    expect((await configFor({ pointShadows: true }))?.engineEntries).toEqual({
      pointShadows: true,
    });
    const defaults = await configFor({});
    expect(defaults).not.toHaveProperty('engineEntries');
    expect(defaults?.publication).toBe('source');
    expect(defaults?.publishAuthoredMaterialShaders).toBe(false);
  }, 60_000);

  it('routes an explicitly selected source publication through the ordinary project build', async () => {
    const options = await configFor({ shaderPublication: 'source' });
    expect(options?.publication).toBe('source');
    expect(options?.publishAuthoredMaterialShaders).toBe(false);
  }, 60_000);

  it('keeps explicit precompiled publication available', async () => {
    const options = await configFor({ shaderPublication: 'compiled' });
    expect(options?.publication).toBe('compiled');
    expect(options?.publishAuthoredMaterialShaders).toBe(true);
  }, 60_000);

  it('publishes tool-owned texture programs for resource previews with source-default projects', async () => {
    const options = await configFor({}, true);
    expect(options?.publication).toBe('source');
    expect(options?.publishAuthoredMaterialShaders).toBe(true);
    expect(options).toHaveProperty(
      'materialPackages',
      expect.arrayContaining([
        expect.stringMatching(/texture-view\/2d\.pack\.json$/),
        expect.stringMatching(/texture-view\/2d-array\.pack\.json$/),
        expect.stringMatching(/texture-view\/3d\.pack\.json$/),
      ]),
    );
  }, 60_000);

  it('rejects unknown shader publication formats before constructing the build', async () => {
    await expect(configFor({ shaderPublication: 'invalid' })).rejects.toThrow(
      'package-manifest-invalid',
    );
  }, 60_000);
});
