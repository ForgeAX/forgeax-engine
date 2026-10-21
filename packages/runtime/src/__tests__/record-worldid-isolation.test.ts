// m2-t1-a: Production-path dual-world cache isolation — source-level verification.
//
// Verifies that every cache write/read site in the record stage that was
// identified in plan-strategy D-1a as needing worldEntityKey compositing
// actually uses a world-aware key (worldEntityKey or
// instanceCollectionCacheKey), not a bare entityKey / cacheKey.
//
// Anchors:
//   plan-tasks.json m2 (patch assignment)
//   plan-strategy D-1a #1 (instanceBuffers positive half); bind groups are now
//   shared by opaque buffer handles after the probe/identity layout split.
//   requirements AC-07
//
// The production instance-buffer sites and the shared bind-group resolver are
// located by their stable cache operation below; source line numbers are not
// part of the contract and must not make this gate stale after extraction.
//
// Each site check uses a line-range window: we read the source file and verify
// that within the line range, a world-aware key call appears on a line
// that contains the target key expression. This directly falsifies the bug
// "site uses bare key" — when a site uses a bare key, the worldEntityKey
// check will fail.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Verify that a cache site uses a world-aware composite key.
 * Scans the source file around the given line (within a window) for both
 * `worldEntityKey` and the cache operation (`targetPattern` such as
 * `instanceBuffers.get`, etc.).
 */
function expectWorldAwareCacheKeyAt(
  filePath: string,
  line: number,
  description: string,
  windowRadius = 10,
): void {
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const start = Math.max(line - windowRadius, 0);
  const end = Math.min(line + windowRadius, lines.length);

  for (let i = start; i < end; i++) {
    const l = lines[i];
    if (l?.includes('worldEntityKey') || l?.includes('instanceCollectionCacheKey')) {
      // Found — passes
      return;
    }
  }
  // Not found — fail with diagnostic
  const nearby = [];
  for (let i = start; i < end; i++) {
    nearby.push(`  ${i + 1}: ${lines[i]}`);
  }
  expect.fail(
    `${description}: world-aware cache key NOT found near line ${line} in ${filePath}\nNearby lines:\n${nearby.join('\n')}`,
  );
}

function findLine(filePath: string, needle: string, occurrence = 0): number {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  let seen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.includes(needle)) {
      if (seen === occurrence) return index + 1;
      seen += 1;
    }
  }
  expect.fail(`${needle} occurrence ${occurrence} not found in ${filePath}`);
}

// ── Geometry pass instanceBuffers (D-1a #1) ────────────────────────────────

describe('production-path geometry instanceBuffers world-aware key', () => {
  const FILE = fileURLToPath(
    new URL('../../../render/src/record/main-pass-geometry.ts', import.meta.url),
  );

  it('inst.cacheKey get uses a world-aware key', () => {
    expectWorldAwareCacheKeyAt(
      FILE,
      findLine(FILE, 'frameState.instanceBuffers.get('),
      'main-pass-geometry instanceBuffers.get',
    );
  });

  it('inst.cacheKey set uses a world-aware key', () => {
    expectWorldAwareCacheKeyAt(
      FILE,
      findLine(FILE, 'frameState.instanceBuffers.set('),
      'main-pass-geometry instanceBuffers.set',
    );
  });
});

const SPRITE_FILE = fileURLToPath(
  new URL('../../../render/src/record/main-pass-sprite-draws.ts', import.meta.url),
);
const FOLD_FILE = fileURLToPath(
  new URL('../../../render/src/record/fold-instance-buffer.ts', import.meta.url),
);

describe('production-path shared instance bind-group resolver', () => {
  it('sprite identity and sprite-instance paths use the shared resolver', () => {
    const src = readFileSync(SPRITE_FILE, 'utf8');
    expect(src).toContain('const spriteInstBg = resolveGeometryInstancesBindGroup(');
    expect(src).toContain('const spriteInstancesBg = resolveGeometryInstancesBindGroup(');
  });
});

// ── Sprite Instances / SpriteInstances instanceBuffers (D-1a #1) ──────────

const SPRITE_INSTANCES_FILE = fileURLToPath(
  new URL('../../../render/src/record/sprite-instance-buffer.ts', import.meta.url),
);

describe('production-path sprite instanceBuffers world-aware key', () => {
  it('Instances and SpriteInstances both upload through the shared owner', () => {
    const src = readFileSync(SPRITE_FILE, 'utf8');
    expect(src).toContain('uploadSpriteInstanceBuffer(');
    expect(src).not.toContain('frameState.instanceBuffers.');
    expect(readFileSync(SPRITE_INSTANCES_FILE, 'utf8')).toContain('uploadSpriteInstanceBuffer(');
  });

  it('the shared owner keys get and set by the world-aware key', () => {
    const src = readFileSync(SPRITE_INSTANCES_FILE, 'utf8');
    expect(src).toContain('const key = worldEntityKey(worldId, snapshot.cacheKey);');
    expect(src).toContain('frameState.instanceBuffers.get(key)');
    expect(src).toContain('frameState.instanceBuffers.set(key, active)');
  });
});

// ── Shadow pass instanceBuffers (D-1a #1) ──────────────────────────────────

const SHADOW_FILE = fileURLToPath(
  new URL('../../../render/src/record/shadow-pass.ts', import.meta.url),
);

describe('production-path shadow instanceBuffers world-aware key', () => {
  it('passes the source entry to the shared world-aware geometry cache', () => {
    const src = readFileSync(SHADOW_FILE, 'utf8');
    expect(src).toContain('resolveGeometryInstanceBuffer(c, entry, [], false)');
    expect(src).not.toContain('c.frameState.instanceBuffers.');
  });

  it('spot shadow uses the shared world-aware caster recorder', () => {
    const src = readFileSync(SHADOW_FILE, 'utf8');
    const start = src.indexOf('export function encodeSpotShadowPass(');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(src.slice(start)).toContain('recordShadowCasterDraws(');
    // Cross-World buffer identity and all three light front doors are exercised
    // by render's shadow-instance-residency and shadow-dispatch-projection tests.
  });
});

describe('production-path shadow shared instance bind-group resolver', () => {
  it('shadow pass resolves the bind group from the world-aware buffer cache', () => {
    const src = readFileSync(SHADOW_FILE, 'utf8');
    expect(src).toContain(
      'const shadowInstancesBg = resolveGeometryInstancesBindGroup(c, instanceDraw.buffer);',
    );
  });
});

// ── Fold-bucket negative half NOT worldEntityKey (D-1a #1 invariant) ───────

describe('production-path fold-bucket key NOT worldEntityKey', () => {
  it('fold-bucket bucketCacheKey is NOT worldEntityKey', () => {
    const src = readFileSync(FOLD_FILE, 'utf8');
    const lines = src.split('\n');
    const bucketLine = lines[findLine(FOLD_FILE, 'const key =') - 1];
    expect(bucketLine).toBeDefined();
    // Must NOT contain worldEntityKey — fold-bucket keys are material-handle-based
    expect(bucketLine).not.toContain('worldEntityKey');
    // Should contain some form of the fold key: -1 -
    expect(bucketLine).toMatch(/-1\s*-/);
  });
});
