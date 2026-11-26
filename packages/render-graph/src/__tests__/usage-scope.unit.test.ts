import { expect, it } from 'vitest';
import { accessMode, rangesOverlap } from '../pass-access.js';
import type { GraphAccessUsage, GraphTextureContentRange } from '../types.js';
import { firstScopeConflict, type ScopeAccess, type ScopeWorkspace } from '../usage-scope.js';

interface Operand extends ScopeAccess {
  readonly resource: number;
}

it('matches the first declared conflict through mixed roles, aspects and changing view order', () => {
  const workspace: ScopeWorkspace = {};
  const roles = [
    'copy-src',
    'sampled-read',
    'storage-read-write',
    'sampled-storage-read-write',
    'copy-dst',
  ] as const;
  const aspects = ['all', 'depth-only', 'stencil-only'] as const;
  let seed = 19;
  const random = (bound: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 8) % bound;
  };
  for (let frame = 0; frame < 512; frame++) {
    const operands: Operand[] = [];
    const tails: (Operand | undefined)[] = [];
    for (let slot = 0; slot < 64; slot++) {
      const resource = random(3);
      const mipStart = random(8);
      const layerStart = frame % 4 === 0 ? (slot * 23) % 64 : random(32);
      const range: GraphTextureContentRange = {
        aspect: aspects[random(3)] as GPUTextureAspect,
        mipStart,
        mipEnd: mipStart + random(3) + 1,
        layerStart,
        layerEnd: layerStart + (frame % 4 === 0 ? 1 : random(4) + 1),
      };
      const usage: GraphAccessUsage = roles[random(roles.length)] as GraphAccessUsage;
      const item: Operand = { resource, range, usage, write: accessMode(usage).write };
      const prior = tails[resource];
      if (prior !== undefined) {
        prior.nextOfResource = slot;
        item.resourceFollower = true;
      }
      tails[resource] = item;
      operands.push(item);
    }
    let expected: [Operand, Operand] | undefined;
    oracle: for (const [i, a] of operands.entries()) {
      for (const b of operands.slice(i + 1)) {
        if (a.resource !== b.resource || (!a.write && !b.write)) continue;
        if (
          a.usage === b.usage &&
          (a.usage === 'storage-read-write' || a.usage === 'sampled-storage-read-write')
        )
          continue;
        if (rangesOverlap(a.range, b.range)) {
          expected = [a, b];
          break oracle;
        }
      }
    }
    const actual = firstScopeConflict(operands, workspace);
    expect(actual?.[0]).toBe(expected?.[0]);
    expect(actual?.[1]).toBe(expected?.[1]);
  }
  expect(workspace.texture?.ordered).toHaveLength(0);
  expect(workspace.texture?.groups.every((group) => group.length === 0)).toBe(true);
});
