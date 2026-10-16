import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

describe('generated realm bundle closure', () => {
  it('emits an engine host without Node, compiler, or source pack modules', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-bundle-closure-'));
    try {
      await mkdir(resolve(root, 'assets'));
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
