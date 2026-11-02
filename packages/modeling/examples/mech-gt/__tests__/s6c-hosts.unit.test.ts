import { describe, expect, it } from 'vitest';
import { ARCH_LINES } from '../feature-lines';
import { S6A_ANCHORS } from '../s6a-anchors';
import { bodyAnchors, HOSTED } from '../s6c-anchors';
import { linePoint, onShell, resolveAnchor } from '../s6c-hosts';
import { dot3, sub3 } from '../s6c-kit';

/**
 * C-100 S6c: details hosted on the feature-line network land on the shell part they name, at
 * the S6a table's spot; the shell query sees through openings and past the car.
 */
describe('C-100 S6c feature-line hosts', () => {
  it('resolves every hosted spec on its host part, within 3 mm of the S6a anchor', { timeout: 60000 }, () => {
    const body = bodyAnchors();
    for (const [key, spec] of Object.entries(HOSTED)) {
      const a = resolveAnchor(spec);
      expect(a, key).toBeDefined();
      const at = linePoint(spec.line, spec.at);
      const hit = at && onShell('right', [at.p[0] + (spec.offset?.[0] ?? 0), at.p[1] + (spec.offset?.[1] ?? 0)], 'l');
      expect([key, hit?.part]).toEqual([key, spec.host]);
      const old = S6A_ANCHORS[key];
      if (a === undefined || old === undefined) continue;
      expect([key, Math.hypot(...sub3(a.origin, old.origin)) < 0.003]).toEqual([key, true]);
      expect([key, dot3(a.normal, old.normal) > 0.99]).toEqual([key, true]);
      expect(body[key]).toEqual(a);
    }
  });

  it('sees through the arches and the side intake, and past the car', { timeout: 60000 }, () => {
    for (const arch of ARCH_LINES) expect(onShell('right', [arch.center[0], arch.center[1] + arch.radius - 0.02], 'l')).toBeUndefined();
    expect(onShell('right', [-0.45, 0.5], 'l')).toBeUndefined();
    expect(onShell('right', [3, 0.5], 'l')).toBeUndefined();
    expect(onShell('top', [1.5, 0], 'l')).toBeUndefined();
  });

  it('answers each view with an outward normal on the queried side', { timeout: 60000 }, () => {
    const cases = [
      ['right', [0.4, 0.6], [1, 0, 0]],
      ['top', [0.3, 0.2], [0, 1, 0]],
      ['front', [0.5, 0.45], [0, 0, 1]],
      ['back', [0.5, 0.7], [0, 0, -1]],
    ] as const;
    for (const [view, p2, out] of cases) {
      for (const side of ['l', 'r'] as const) {
        const hit = onShell(view, p2, side);
        expect([view, side, hit !== undefined]).toEqual([view, side, true]);
        if (hit === undefined) continue;
        const s = side === 'l' ? 1 : -1;
        expect([view, side, Math.sign(hit.point[0])]).toEqual([view, side, s]);
        expect([view, side, dot3(hit.normal, [out[0] * s, out[1], out[2]]) > 0.2]).toEqual([view, side, true]);
        expect([view, side, hit.part.endsWith(side === 'l' ? '-r' : '-l')]).toEqual([view, side, false]);
      }
    }
    // Inside the nose section the fascia cap answers.
    expect(onShell('front', [0.2, 0.3], 'l')).toMatchObject({ part: 'bumper-center', normal: [0, 0, 1] });
  });

  it('reads a station on a line: the highest crossing, and the exact arch arc', () => {
    const arch = ARCH_LINES[0];
    if (arch === undefined) throw new Error('no arch');
    const top = linePoint(arch.id, arch.center[0]);
    expect(top?.p[1]).toBeCloseTo(arch.center[1] + arch.radius, 9);
    expect(top?.tangent[1]).toBeCloseTo(0, 9);
    // The side intake is a closed outline: two crossings, the upper one wins.
    const p = linePoint('side-intake', -0.5);
    expect(p?.p[1]).toBeGreaterThan(0.75);
    expect(linePoint('belt', 9)).toBeUndefined();
  });
});
