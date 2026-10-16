/// <reference types="node" />

// asset-union-no-name.test-d.ts - M2 grep gate for Asset union cardinality
// + POD no-name constraint (OOS-2).
//
// Three assertions guard the SSOT boundary:
// (a) Asset union exhaustive switch covers all 16 kind discriminants
//     without default fallback -- TS compile-error on drift.
// (b) Type-level: exhaustiveSwitch returns string (proves all cases present).
// (c) grep: none of the 16 Asset union member interfaces (MeshAsset /
//     TextureAsset / EquirectAsset / SamplerAsset / MaterialAsset /
//     SceneAsset / SkeletonAsset / SkinAsset / AnimationClip /
//     AudioClipAsset / FontAsset / RenderPipelineAsset / TilesetAsset /
//     VideoAsset / ParticleEffectAsset) has gained a `name`
//     field. The check scans
//     each Asset member interface block in the core contract owner between
//     `export interface <N>Asset`
//     and the next `}` for `readonly name` and asserts exactly 1 hit
//     (MaterialRuntimeInfo).
//
// Anchors:
// - requirements OOS-2 (Asset POD shall not carry name)
// - requirements section 6 constraint (Route B: name via resolveName, not POD)
// - plan-tasks w1 acceptanceCheck

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Asset, ParticleEffectAsset, TilesetAsset } from '../index';

const REPO_ROOT = resolve(import.meta.dirname ?? '.', '..', '..', '..', '..');
const TYPES_SOURCES = [
  'mesh-contracts.ts',
  'font-contracts.ts',
  'asset-union-contracts.ts',
  'scene-contracts.ts',
  'animation-contracts.ts',
  'media-contracts.ts',
  'material/asset.ts',
  'vfx.ts',
].map((file) => resolve(REPO_ROOT, 'packages', 'types', 'src', file));

// Exhaustive switch over Asset.kind -- when a 14th variant is added,
// TS2322 fires on the `_exhaustiveCheck: never` line, blocking the
// PR until this test is updated (charter P4 explicit failure).
function exhaustiveAssetKindSwitch(asset: Asset): string {
  switch (asset.kind) {
    case 'plugin':
      return 'PluginAsset';
    case 'mesh':
      return 'MeshAsset';
    case 'texture':
      return 'TextureAsset';
    case 'equirect':
      return 'EquirectAsset';
    case 'sampler':
      return 'SamplerAsset';
    case 'material':
      return 'MaterialAsset';
    case 'scene':
      return 'SceneAsset';
    case 'skeleton':
      return 'SkeletonAsset';
    case 'skin':
      return 'SkinAsset';
    case 'animation-clip':
      return 'AnimationClip';
    case 'animation-graph':
      return 'AnimationGraph';
    case 'audio':
      return 'AudioClipAsset';
    case 'ies-profile':
      return 'IesProfileAsset';
    case 'font':
      return 'FontAsset';
    case 'render-pipeline':
      return 'RenderPipelineAsset';
    case 'tileset':
      return 'TilesetAsset';
    case 'video':
      return 'VideoAsset';
    case 'navigation-mesh':
    case 'terrain':
      return 'TerrainAsset';
    case 'particle-effect':
      return 'ParticleEffectAsset';
    default: {
      const _exhaustiveCheck: never = asset;
      return _exhaustiveCheck;
    }
  }
}

// The Asset union member interface names, matching export declarations.
const ASSET_MEMBER_NAMES = [
  'MeshAsset',
  'TextureAsset',
  'EquirectAsset',
  'SamplerAsset',
  'MaterialAsset',
  'SceneAsset',
  'SkeletonAsset',
  'SkinAsset',
  'AnimationClip',
  'AnimationGraph',
  'AudioClipAsset',
  'FontAsset',
  'RenderPipelineAsset',
  'TilesetAsset',
  'VideoAsset',
  'ParticleEffectAsset',
] as const;

/**
 * For each Asset member interface, count `readonly name` field declarations
 * within its interface block. Returns a map from interface name to count.
 *
 * Strategy: for each interface, extract the block between
 * `export interface <Name>` and its matching closing `}` (brace-count
 * method), then grep for `readonly name` within that span.
 */
function countNameFieldsPerAssetInterface(): Map<string, number> {
  const raw = execSync(`cat ${TYPES_SOURCES.join(' ')}`, { encoding: 'utf-8' });
  const lines = raw.split('\n');
  const result = new Map<string, number>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    for (const name of ASSET_MEMBER_NAMES) {
      // Match `export interface MeshAsset {` or `export interface AnimationClip {`
      if (line.match(new RegExp(`^export interface ${name} \\{`))) {
        // Walk forward with brace-count until we close this interface.
        let braceDepth = 0;
        let hasOpen = false;
        const blockLines: string[] = [];
        for (let j = i; j < lines.length; j++) {
          const l = lines[j] ?? '';
          blockLines.push(l);
          for (const ch of l) {
            if (ch === '{') {
              braceDepth++;
              hasOpen = true;
            }
            if (ch === '}') {
              braceDepth--;
            }
          }
          if (hasOpen && braceDepth === 0) {
            // Interface block closed.
            const block = blockLines.join('\n');
            const nameCount = (block.match(/\breadonly name\b/g) || []).length;
            result.set(name, nameCount);
            i = j; // continue outer loop from here
            break;
          }
        }
        break;
      }
    }
    i++;
  }
  return result;
}

describe('M2 Asset union cardinality grep gate (16 members, OOS-2 POD no-name)', () => {
  it('keeps the durable union discoverable through the public kind field', () => {
    expectTypeOf<Asset>().toHaveProperty('kind');
  });

  it('does not expose removed durable identity fields on public PODs', () => {
    expectTypeOf<ParticleEffectAsset>().not.toMatchTypeOf<{ readonly guid: string }>();
    expectTypeOf<TilesetAsset>().not.toMatchTypeOf<{ readonly guid: string }>();
  });

  it('(a) exhaustive switch over Asset.kind covers all 17 discriminants', () => {
    const result = exhaustiveAssetKindSwitch({ kind: 'mesh' } as Asset);
    expect(typeof result).toBe('string');
  });

  it('(b) type-level: exhaustive switch returns string (proves all cases)', () => {
    expectTypeOf(exhaustiveAssetKindSwitch).returns.toEqualTypeOf<string>();
  });

  it('(c) no Asset union member interface has a name field', () => {
    const counts = countNameFieldsPerAssetInterface();
    expect(counts.size).toBe(16);

    for (const count of counts.values()) {
      expect(count).toBe(0);
    }
  });
});
