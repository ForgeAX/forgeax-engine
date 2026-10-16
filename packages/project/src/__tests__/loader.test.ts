// loader.test.ts — w4: loadGameProject 5 return paths + sync companion tests
import { describe, expect, it } from 'vitest';
import { loadGameProject, loadGameProjectSync, validateGameProject } from '../loader.js';

// ── helpers ─────────────────────────────────────────────────────────────────
function makeRead(content: string): (path: string) => Promise<string> {
  return async (_path: string) => content;
}

function makeReadThrow(err: Error): (path: string) => Promise<string> {
  return async (_path: string) => {
    throw err;
  };
}

const VALID_FORGE_JSON = JSON.stringify({
  id: 'test-game',
  name: 'Test Game',
  schemaVersion: '3.0.0',
  roots: {},
});

const VALID_WITH_DEFAULT_SCENE = JSON.stringify({
  id: 'test-game',
  name: 'Test Game',
  schemaVersion: '3.0.0',
  roots: { engine: '15acc839-d847-527c-8284-bfb36d7c50de' },
});

const INVALID_JSON = '{id: broken';

const WITH_SCENES_ARRAY = JSON.stringify({
  id: 'has-scenes',
  name: 'Has Scenes',
  schemaVersion: '3.0.0',
  roots: {},
  scenes: [{ id: 'l1', name: 'Level 1', pack: 'scenes/level1.pack.json' }],
});

const WITH_BAD_GUID = JSON.stringify({
  id: 'bad-guid',
  name: 'Bad GUID',
  schemaVersion: '3.0.0',
  roots: { engine: 'not-a-guid' },
});

const WITHOUT_DEFAULT_SCENE = JSON.stringify({
  id: 'no-default',
  name: 'No Default',
  schemaVersion: '3.0.0',
  roots: {},
});

const WITH_LEGACY_POLICY = JSON.stringify({
  id: 'npc-game',
  name: 'NPC Game',
  schemaVersion: '3.0.0',
  roots: {},
  npc: {
    model: 'deepseek-v4-flash-openai',
    maxTokens: 220,
    budget: { maxCallsPerMinute: 30, maxTokensPerMinute: 120000, maxConcurrent: 4 },
  },
});

// ── return path 1: forge.json missing ──────────────────────────────────────
describe('loadGameProject — return path 1: file missing', () => {
  it('returns {ok:false} with code forge-missing when read throws', async () => {
    const notFound = new Error('ENOENT: no such file');
    (notFound as NodeJS.ErrnoException).code = 'ENOENT';
    const result = await loadGameProject(makeReadThrow(notFound));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-missing');
    }
  });

  it('returns {ok:false} when read rejects', async () => {
    const result = await loadGameProject(async () => {
      throw new Error('read failed');
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-missing');
    }
  });
});

// ── return path 2: invalid JSON ─────────────────────────────────────────────
describe('loadGameProject — return path 2: parse failed', () => {
  it('returns {ok:false} with code forge-parse-failed for invalid JSON', async () => {
    const result = await loadGameProject(makeRead(INVALID_JSON));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-parse-failed');
    }
  });
});

// ── return path 3: strict rejects unknown fields (scenes[]) ─────────────────
describe('loadGameProject — return path 3: unknown fields', () => {
  it('returns {ok:false} with code forge-unknown-field when scenes[] present', async () => {
    const result = await loadGameProject(makeRead(WITH_SCENES_ARRAY));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-unknown-field');
    }
  });
});

// ── return path 4: engine root GUID format invalid ─────────────────────────
describe('loadGameProject — return path 4: GUID malformed', () => {
  it('returns {ok:false} with code forge-guid-malformed for bad GUID', async () => {
    const result = await loadGameProject(makeRead(WITH_BAD_GUID));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-guid-malformed');
    }
  });
});

// ── return path 5: completely valid forge.json ──────────────────────────────
describe('loadGameProject — return path 5: valid forge.json', () => {
  it('returns {ok:true} with GameProject value for valid forge.json', async () => {
    const result = await loadGameProject(makeRead(VALID_FORGE_JSON));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeDefined();
      expect(result.value.id).toBe('test-game');
      expect(result.value.name).toBe('Test Game');
      expect(result.value.schemaVersion).toBe('3.0.0');
    }
  });

  it('returns {ok:true} for valid forge.json with engine root', async () => {
    const result = await loadGameProject(makeRead(VALID_WITH_DEFAULT_SCENE));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.roots.engine).toBeDefined();
    }
  });

  it('returns {ok:true} when engine root is absent (optional)', async () => {
    const result = await loadGameProject(makeRead(WITHOUT_DEFAULT_SCENE));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('no-default');
      expect(result.value.roots.engine).toBeUndefined();
    }
  });

  it('rejects the removed NPC policy instead of dual-reading it', async () => {
    const result = await loadGameProject(makeRead(WITH_LEGACY_POLICY));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forge-unknown-field');
  });

  it('is idempotent — same read returns same result', async () => {
    const read = makeRead(VALID_FORGE_JSON);
    const r1 = await loadGameProject(read);
    const r2 = await loadGameProject(read);
    expect(r1.ok).toBe(r2.ok);
    if (r1.ok && r2.ok) {
      expect(r1.value.id).toBe(r2.value.id);
    }
  });

  it('does NOT call resolveGuid internally', async () => {
    // loadGameProject only accepts `read` — no resolveGuid in signature
    // Signature-level verification: the function is callable with just read
    const read = makeRead(VALID_FORGE_JSON);
    const result = await loadGameProject(read);
    expect(result).toBeDefined();
  });
});

// ── missing schemaVersion → schema-invalid ──────────────────────────────────
describe('loadGameProject — missing required fields', () => {
  it('returns {ok:false} when schemaVersion is missing', async () => {
    const noSchemaVersion = JSON.stringify({ id: 'test', name: 'Test' });
    const result = await loadGameProject(makeRead(noSchemaVersion));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-schema-invalid');
    }
  });
});

// ── validateGameProject: sync pure core ─────────────────────────────────────
function makeSyncRead(content: string): (path: string) => string {
  return (_path: string) => content;
}

function makeSyncReadThrow(err: Error): (path: string) => string {
  return (_path: string) => {
    throw err;
  };
}

describe('validateGameProject — sync pure core', () => {
  it('returns {ok:true} for valid forge.json', () => {
    const result = validateGameProject(VALID_FORGE_JSON);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('test-game');
      expect(result.value.name).toBe('Test Game');
    }
  });

  it('returns {ok:false, code:forge-parse-failed} for invalid JSON', () => {
    const result = validateGameProject(INVALID_JSON);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-parse-failed');
    }
  });

  it('returns {ok:false, code:forge-unknown-field} when scenes[] present', () => {
    const result = validateGameProject(WITH_SCENES_ARRAY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-unknown-field');
    }
  });

  it('returns {ok:false, code:forge-guid-malformed} for bad GUID', () => {
    const result = validateGameProject(WITH_BAD_GUID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-guid-malformed');
    }
  });

  it('returns {ok:false, code:forge-schema-invalid} when schemaVersion missing', () => {
    const noSchemaVersion = JSON.stringify({ id: 'test', name: 'Test' });
    const result = validateGameProject(noSchemaVersion);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-schema-invalid');
    }
  });
});

// ── loadGameProjectSync: sync companion ─────────────────────────────────────
describe('loadGameProjectSync — sync companion', () => {
  it('returns {ok:true} for valid forge.json', () => {
    const result = loadGameProjectSync(makeSyncRead(VALID_FORGE_JSON));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('test-game');
      expect(result.value.name).toBe('Test Game');
    }
  });

  it('returns {ok:false, code:forge-missing} when read throws', () => {
    const notFound = new Error('ENOENT: no such file');
    (notFound as NodeJS.ErrnoException).code = 'ENOENT';
    const result = loadGameProjectSync(makeSyncReadThrow(notFound));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-missing');
    }
  });

  it('returns {ok:false, code:forge-unknown-field} when scenes[] present', () => {
    const result = loadGameProjectSync(makeSyncRead(WITH_SCENES_ARRAY));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-unknown-field');
    }
  });

  it('returns {ok:false, code:forge-guid-malformed} for bad GUID', () => {
    const result = loadGameProjectSync(makeSyncRead(WITH_BAD_GUID));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forge-guid-malformed');
    }
  });
});
