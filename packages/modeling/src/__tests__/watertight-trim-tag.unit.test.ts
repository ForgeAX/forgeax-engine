import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { sel } from '../selectors';

/** Open-topped unit box; `tagged` of its four rim faces carry the ordinary tag 'trim'. */
function openBox(tagged: number) {
  const m = model();
  m.box({ size: [1, 1, 1], tag: 'body' });
  m.delete(sel.facing('+y'));
  for (const n of ['+x', '-x', '+z', '-z'].slice(0, tagged)) m.tag(sel.facing(n as '+x'), 'trim');
  return m.validate({ watertight: true });
}

const errors = (v: ReturnType<typeof openBox>) =>
  v.issues.filter((i) => i.code === 'mesh-open' && i.severity === 'error').length;

describe('C-2 an ordinary tag "trim" designs a boundary', () => {
  it('an open box stays an error when 2 of its 4 rim faces carry the tag trim', () => {
    const counts = [0, 1, 2, 4].map((n) => {
      const v = openBox(n);
      return {
        tagged: n,
        errors: errors(v),
        pass: v.pass,
        chains: (v.watertight?.chains ?? []).map((c) => `${c.kind}:${c.designed ?? 'undesigned'}`),
      };
    });
    expect(counts[0]?.errors).toBeGreaterThan(0);
    expect(counts[2]?.errors).toBeGreaterThan(0);
    expect(counts[3]?.errors).toBeGreaterThan(0);
  });
});
