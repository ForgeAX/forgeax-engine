import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
const CONFIG_PATH = resolve(REPO_ROOT, 'packages/pack/tsconfig.json');

async function declarationProjectInputs(): Promise<readonly string[]> {
  const source = await readFile(CONFIG_PATH, 'utf8');
  const parsed = ts.parseJsonConfigFileContent(
    JSON.parse(source),
    ts.sys,
    dirname(CONFIG_PATH),
    undefined,
    CONFIG_PATH,
  );
  return parsed.fileNames.map((fileName) => relative(REPO_ROOT, fileName));
}

describe('Pack declaration project boundary', () => {
  it('keeps tests and emitted declarations out of production inputs', async () => {
    const inputs = await declarationProjectInputs();
    const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as {
      readonly exclude?: readonly string[];
    };

    expect(config.exclude).toEqual(expect.arrayContaining(['src/**/__tests__/**', 'dist/**']));
    expect(inputs.some((fileName) => fileName.startsWith('packages/pack/src/__tests__/'))).toBe(
      false,
    );
    expect(inputs.some((fileName) => fileName.startsWith('packages/pack/dist/'))).toBe(false);
  });
});
