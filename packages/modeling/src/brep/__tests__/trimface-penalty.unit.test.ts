import { describe, expect, it } from 'vitest';
import { booleanSolids } from '../boolean';
import { box, cylinder } from '../build';
import { quadrangulate } from '../quad';

function holedBlock() {
  const block = box({ size: [2.6, 1, 1] });
  const hole = cylinder({ radius: 0.3, height: 3 });
  if (!block.ok || !hole.ok) throw new Error('primitive build failed');
  const d = booleanSolids(block.value, hole.value, 'difference');
  if (!d.ok) throw new Error('boolean failed');
  return d.value;
}

describe('trimmed quadrangulation modes', () => {
  it('default blossom mode stays fail-closed on the holed block', () => {
    const q = quadrangulate(holedBlock(), { size: 0.25 });
    expect(q.ok).toBe(false);
  });

  it('blossom-penalty yields watertight quads with a per-face quality report', () => {
    const q = quadrangulate(holedBlock(), { size: 0.25, trimmed: 'blossom-penalty' });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.value.report.openEdges).toBe(0);
    expect(q.value.report.nonManifoldEdges).toBe(0);
    expect(q.value.faceQuality.length).toBeGreaterThan(0);
    for (const f of q.value.faceQuality) {
      expect(Number.isFinite(f.minSj)).toBe(true);
      expect(f.foldedPairs).toBeGreaterThanOrEqual(f.unresolved);
    }
  });
});
