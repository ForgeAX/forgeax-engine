// feat-20260608 M4 / m4-t1 — migration grep spot-check.
//
// Mechanical gate for the asi-world demo migration: the legacy per-object
// sprite-entity path (registerObjectMaterials + spawnObjectSprites +
// placeObjectSprite — 779 entities, 1 MaterialAsset per tile id) must be
// physically deleted from main.ts (AC-15 falsifier), and the new
// TilesetAsset + Tilemap + TileLayer object-layer path must be present.
//
// Five assertions (one retired-symbol zero-hit + four positive guards):
//   (1) NEG  — `registerObjectMaterials` / `spawnObjectSprites` /
//              `placeObjectSprite` grep zero hits in main.ts (AC-15).
//   (2) POS  — `world.allocSharedRef<'TilesetAsset', ...>` appears at
//              least once (object tileset registration path).
//   (3) POS  — `world.spawn(` invocation that mentions `Tilemap` appears
//              (Tilemap entity spawn — terrain or object layer).
//   (4) POS  — `world.spawn(` invocation that mentions `TileLayer`
//              alongside `ChildOf` appears (anchor-only TileLayer path).
//   (5) POS  — the legacy sprite-entity layout `world.spawn(... MeshFilter
//              + MeshRenderer + Layer + Transform ...)` cluster count
//              must stay << 779 (target: < 10 — only player + a handful
//              of pickup / NPC sprite entities left, no per-object spawn
//              loop).
//
// Anchors: requirements §AC-15; plan-tasks m4-t1; plan-strategy §M4
// boundary criteria (grep zero hits + sandbox PNG ε ≤ 0.05).
//
// charter P3 — these mechanical assertions are the structured failure
// signal for the migration; AI users grep + run this test rather than
// eyeballing main.ts diff.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_TS = resolve(HERE, '..', 'main.ts');

function readMain(): string {
  return readFileSync(MAIN_TS, 'utf8');
}

function countMatches(haystack: string, pattern: RegExp): number {
  const matches = haystack.match(pattern);
  return matches === null ? 0 : matches.length;
}

describe('asi-world demo migration (m4-t1 grep spot-check)', () => {
  it('AC-15: legacy 3 functions deleted (registerObjectMaterials / spawnObjectSprites / placeObjectSprite zero hits)', () => {
    const src = readMain();
    expect(countMatches(src, /\bregisterObjectMaterials\b/g)).toBe(0);
    expect(countMatches(src, /\bspawnObjectSprites\b/g)).toBe(0);
    expect(countMatches(src, /\bplaceObjectSprite\b/g)).toBe(0);
  });

  it('positive guard: world.allocSharedRef<TilesetAsset> appears at least once', () => {
    const src = readMain();
    expect(countMatches(src, /world\.allocSharedRef<['"]TilesetAsset['"]/g)).toBeGreaterThanOrEqual(1);
  });

  it('positive guard: world.spawn() with Tilemap component appears', () => {
    const src = readMain();
    expect(countMatches(src, /world\.spawn\([^;]*\bTilemap\b/gs)).toBeGreaterThanOrEqual(1);
  });

  it('positive guard: world.spawn() with TileLayer + ChildOf cluster appears', () => {
    const src = readMain();
    const tileLayerChildOf = src.match(/world\.spawn\([^;]*\bTileLayer\b[^;]*\bChildOf\b/gs);
    expect(tileLayerChildOf === null ? 0 : tileLayerChildOf.length).toBeGreaterThanOrEqual(1);
  });

  it('AC-15 corollary: sprite-entity (MeshFilter + MeshRenderer + Layer + Transform) cluster count < 10 (no per-object spawn loop)', () => {
    const src = readMain();
    const cluster =
      src.match(
        /world\.spawn\([^;]*\bMeshFilter\b[^;]*\bMeshRenderer\b[^;]*\bLayer\b[^;]*\bTransform\b/gs,
      ) ?? [];
    const clusterReverse =
      src.match(
        /world\.spawn\([^;]*\bTransform\b[^;]*\bMeshFilter\b[^;]*\bMeshRenderer\b[^;]*\bLayer\b/gs,
      ) ?? [];
    const total = Math.max(cluster.length, clusterReverse.length);
    expect(total).toBeLessThan(10);
  });
});
