import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

// Every DevKit test file and its child CLI processes use an exclusive durable store.
const original = process.env.FORGEAX_DATA_HOME;
const directory = mkdtempSync(join(tmpdir(), 'forgeax-devkit-catalogue-'));
process.env.FORGEAX_DATA_HOME = directory;
afterAll(() => {
  if (original === undefined) delete process.env.FORGEAX_DATA_HOME;
  else process.env.FORGEAX_DATA_HOME = original;
  rmSync(directory, { recursive: true, force: true });
});
