// @forgeax/engine-remote/src/__tests__/execute-browser-safe — the ./execute
// subpath is the eval core reused by the browser DevKit live bridge (createApp
// dials a loopback relay; the page realm runs executeScript directly because a
// browser cannot bind a Node WS server). It MUST stay ws-free / node-built-in-
// free at the SOURCE level, else importing it in a browser bundle throws on the
// `ws` browser shim (WebSocketServer unsupported) — the exact failure that
// makes app.remote silently undefined in a real dev browser today.
//
// Guarding the source (not the dist bundle) keeps this test runnable in the
// unit project without a prior build step, and pins the invariant at the layer
// a human would break it (adding an import to execute.ts).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const EXECUTE_SRC = fileURLToPath(new URL('../execute.ts', import.meta.url));

describe('execute.ts browser safety (DevKit live bridge)', () => {
  const source = readFileSync(EXECUTE_SRC, 'utf8');
  // Match only real import statements, not prose in comments.
  const importLines = source
    .split('\n')
    .filter((line) => /^\s*import\b/.test(line) || /^\s*}\s*from\s*['"]/.test(line));

  it('imports no ws package', () => {
    expect(importLines.some((l) => /['"]ws['"]/.test(l))).toBe(false);
  });

  it('imports no node: built-in', () => {
    expect(importLines.some((l) => /['"]node:/.test(l))).toBe(false);
  });

  it('imports only its sibling error module', () => {
    // The single permitted runtime import is `./errors` (types-only chain).
    const fromClauses = importLines
      .map((l) => l.match(/from\s*['"]([^'"]+)['"]/)?.[1])
      .filter((s): s is string => typeof s === 'string');
    for (const spec of fromClauses) {
      expect(spec).toBe('./errors');
    }
  });
});
