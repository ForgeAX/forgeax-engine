import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = readFileSync(fileURLToPath(new URL('../scripts/smoke-ui-authoring.mjs', import.meta.url)), 'utf8');

describe('UI authoring smoke startup contract', () => {
  it('keeps a bounded 180-second cold Vite readiness window', () => {
    expect(script).toMatch(/const MAX_SERVER_TIMEOUT_MS = 180_000;/);
    expect(script).toMatch(/FORGEAX_PREVIEW_SERVER_TIMEOUT_MS \?\? '180000'/);
    expect(script).toMatch(/const SERVER_TIMEOUT_MS = Math\.min\(/);
    expect(script).toMatch(/Date\.now\(\) \+ SERVER_TIMEOUT_MS/);
    expect(script).toMatch(/within \$\{SERVER_TIMEOUT_MS\}ms/);
  });
});
