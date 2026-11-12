import { expect, it, vi } from 'vitest';
import { model } from '../model';
import { sel } from '../selectors';

it('queries sparse face tag words without materializing every live face', () => {
  const m = model();
  for (let index = 0; index < 40; index++)
    m.box({ size: [1, 1, 1], center: [index * 2, 0, 0], tag: `part-${index}` });
  const mesh = m.editMesh;
  const selected = sel.tag('part-35');
  const expected = mesh.faces().filter((face) => mesh.hasTag(face, 35));
  const live = vi.spyOn(mesh, 'isFaceAlive');
  const all = vi.spyOn(mesh, 'faces');
  try {
    expect(selected.resolve(mesh).unwrap()).toEqual(expected);
    expect(all).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledTimes(expected.length);
  } finally {
    live.mockRestore();
    all.mockRestore();
  }
  mesh.removeFace(expected[0] as number);
  expect(selected.resolve(mesh).unwrap()).toEqual(expected.slice(1));
  m.box({ size: [1, 1, 1], center: [100, 0, 0], tag: 'other' });
  expect(selected.resolve(mesh).unwrap()).toEqual(expected.slice(1));
  m.tag(sel.tag('other'), 'part-35');
  expect(selected.resolve(mesh).unwrap()).toEqual(
    mesh.faces().filter((face) => mesh.hasTag(face, 35)),
  );
  expect(sel.tag('missing').resolve(mesh)).toMatchObject({
    ok: false,
    error: { code: 'model-selection-empty' },
  });
});
