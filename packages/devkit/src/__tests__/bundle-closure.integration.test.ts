import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build as viteBuild } from 'vite';
import { describe, expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

describe('generated realm bundle closure', () => {
  it('keeps the generated entry and default platform free of server modules and host navigation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-bundle-closure-'));
    try {
      await mkdir(resolve(root, 'assets'));
      await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
      await symlink(
        resolve(import.meta.dirname, '../../../../packages/engine'),
        resolve(root, 'node_modules/@forgeax/engine'),
        'junction',
      );
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'bundle-closure',
            name: 'Bundle Closure',
            schemaVersion: '3.0.0',
            roots: {},
          })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"bundle-closure"}\n'),
        writeFile(
          resolve(root, 'main.ts'),
          "import { Update } from '@forgeax/engine/ecs'; export default () => Update;\n",
        ),
      ]);

      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;
      await createViteConfig(facts.value, 'build');
      const generated = await readFile(resolve(root, '.forgeax/generated/main.ts'), 'utf8');
      expect(generated).toContain('virtual:forgeax/plugin-programs/engine');
      expect(generated).not.toMatch(/\bnode:/);
      expect(generated).not.toContain('@forgeax/engine/compiler');
      expect(generated).not.toMatch(/(?:^|["'])[^"']*pack\.ts(?:["'])/);
      expect(generated).toContain('await frontendHost.activate');

      const platformEntry = resolve(root, 'platform-entry.ts');
      await writeFile(platformEntry, "export * from '@forgeax/engine/host/platform';\n");
      const output = await viteBuild({
        configFile: false,
        root,
        logLevel: 'warn',
        build: {
          target: 'esnext',
          write: false,
          lib: { entry: platformEntry, formats: ['es'] },
        },
      });
      const bundle = Array.isArray(output) ? output[0] : output;
      if (bundle === undefined || !('output' in bundle))
        throw new Error('expected a production platform bundle');
      const chunks = bundle.output.filter((item) => item.type === 'chunk');
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.code, chunk.fileName).not.toMatch(/\blocation\s*\.\s*(?:assign|replace)\s*\(/);
        expect(chunk.code, chunk.fileName).not.toContain('document navigation cancelled');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
