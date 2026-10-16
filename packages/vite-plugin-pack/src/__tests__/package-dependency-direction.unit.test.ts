import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packagePath = resolve(import.meta.dirname, '../../package.json');

describe('vite-plugin-pack dependency direction', () => {
  it('does not depend on concrete asset producer packages', async () => {
    const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
      readonly dependencies?: Record<string, string>;
      readonly optionalDependencies?: Record<string, string>;
    };
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    };
    const forbidden = Object.keys(dependencies).filter((name) =>
      /engine-(animation|material|render|scene|shader|ui|vfx)/.test(name),
    );
    expect(forbidden).toEqual([]);
  });
});
