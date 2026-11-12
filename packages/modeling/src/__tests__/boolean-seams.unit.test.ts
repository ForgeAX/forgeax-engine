import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { closeSoup } from '../compute/boolean-ts';
import type { Tuple3 } from '../geom';
import { type Model, model } from '../model';
import { loopWidth } from '../repair';
import { sel } from '../selectors';

function fixture(name: string): Uint8Array {
  return new Uint8Array(gunzipSync(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))));
}

function openEdges(loops: readonly { loop: readonly number[] }[]): number {
  const directed = new Set<string>();
  for (const { loop } of loops) {
    for (let i = 0; i < loop.length; i++) directed.add(`${loop[i]},${loop[(i + 1) % loop.length]}`);
  }
  let open = 0;
  for (const { loop } of loops) {
    for (let i = 0; i < loop.length; i++) {
      if (!directed.has(`${loop[(i + 1) % loop.length]},${loop[i]}`)) open++;
    }
  }
  return open;
}

function info(report: ReturnType<Model['difference']>): Record<string, number> {
  const detail = report.diagnostics?.find((d) => d.severity === 'info')?.detail as {
    metrics: Record<string, number>;
  };
  return detail.metrics;
}

describe('boolean seams (C-101 robustness)', () => {
  it('closes a gap between two split points of one corner just over the weld distance', () => {
    const eps = 1e-5;
    // A tetrahedron whose last face reached corner 0 as a separate split point 1.2 eps
    // away: every open edge is long, so no short open edge marks the gap.
    const positions: Tuple3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0.85e-5, 0, 0.85e-5],
    ];
    const ids = [
      [0, 2, 1],
      [0, 1, 3],
      [1, 2, 3],
      [4, 3, 2],
    ];
    const closed = closeSoup(ids, [0, 1, 2, 3], positions, eps);
    expect(closed.collapsed).toBe(1);
    expect(openEdges(closed.loops)).toBe(0);
  });

  it('cuts the C-101 spoke windows (22 in, 10 spokes) into a closed manifold', () => {
    const target = model();
    target.append(fixture('c101-windows-target.fxem.gz'));
    const report = target.difference(fixture('c101-windows-tool.fxem.gz'), { label: 'windows' });
    expect([report.status, report.error?.code]).toEqual(['ok', undefined]);
    const v = target.validate();
    expect(v.closed).toBe(true);
    expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('boolean sliver cleanup', () => {
  /**
   * An octagonal bar through a 1 m block whose facet edge runs 0.4 mm above the block
   * floor: the facet below it keeps a 1 mm strip inside the block, a sliver remainder
   * of a 0.23 m facet (the S2 wheel-arch case).
   */
  function channel(options: { readonly slivers?: number } = {}) {
    const m = model();
    m.box({ size: [1, 1, 1], label: 'block' });
    const bar = model();
    bar.cylinder({ radiusTop: 0.3, radiusBottom: 0.3, height: 2, radialSegments: 8, label: 'bar' });
    bar.rotate(sel.all(), 'x', 90);
    // The facet edge ring below the axis sits at y = -0.3 sin 45 deg.
    bar.translate(sel.all(), [0, -0.5 + 0.0004 + 0.3 * Math.SQRT1_2, 0]);
    const report = m.difference(bar, { label: 'channel', ...options });
    const mesh = m.editMesh;
    const widths = sel
      .createdBy('channel', 'cutB')
      .evaluate(mesh)
      .map((f) => loopWidth(mesh.faceVertices(f).map((v) => mesh.position(v))));
    return { m, report, narrowest: Math.min(...widths) };
  }

  it('collapses a narrow remainder of a wide tool facet into its neighbours', () => {
    const { m, report, narrowest } = channel();
    expect(report.status).toBe('ok');
    expect(info(report).slivers).toBe(2);
    expect(narrowest).toBeGreaterThan(0.2);
    const v = m.validate();
    expect(v.closed).toBe(true);
    expect(v.issues).toEqual([]);
  });

  it('keeps the remainder with slivers: 0, and rejects a negative width', () => {
    const kept = channel({ slivers: 0 });
    expect(info(kept.report).slivers).toBe(0);
    expect(kept.narrowest).toBeLessThan(0.0011);
    expect(Math.abs(kept.m.validate().volume - channel().m.validate().volume)).toBeLessThan(1e-6);
    expect(channel({ slivers: -1 }).report.error?.code).toBe('model-invalid-argument');
  });
});
