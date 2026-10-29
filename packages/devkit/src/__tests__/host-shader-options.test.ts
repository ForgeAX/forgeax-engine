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

async function configFor(forgeax: Record<string, unknown>) {
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
    await createViteConfig(facts.value, 'build');
    return shaderOptions.at(-1) as { engineEntries?: unknown } | undefined;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('DevKit shader build options', () => {
  it('builds point-shadow Standard shaders only when package.json opts in', async () => {
    expect((await configFor({ pointShadows: true }))?.engineEntries).toEqual({
      pointShadows: true,
    });
    expect(await configFor({})).not.toHaveProperty('engineEntries');
  }, 60_000);
});
