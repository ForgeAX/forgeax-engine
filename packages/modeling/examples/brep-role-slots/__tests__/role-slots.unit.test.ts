import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderRoleSlots } from '../render.ts';

describe('role-slot bracket example', () => {
  it('exports one submesh per used role slot and renders the sheet', () => {
    const outDir = process.env.FORGEAX_ROLE_SLOTS_OUT ?? mkdtempSync(join(tmpdir(), 'role-slots-'));
    mkdirSync(outDir, { recursive: true });
    const r = renderRoleSlots(outDir);
    expect(r.slotNames).toEqual(['Default', 'body', 'boss', 'rib']);
    expect(r.submeshes).toBe(4);
    expect(r.triangles).toBeGreaterThan(0);
    expect(existsSync(r.sheet)).toBe(true);
  });
});
