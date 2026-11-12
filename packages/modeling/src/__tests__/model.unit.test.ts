import { describe, expect, it, vi } from 'vitest';
import { model } from '../model';
import { sel } from '../selectors';

describe('session contract', () => {
  it('inspects every label and role with one live-face scan, including unused labels', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    for (let i = 0; i < 8; i++) m.box({ size: [1, 1, 1], label: `part-${i}` });
    m.box({ size: [1, 1, 1], label: 'part-0' });
    m.delete(sel.createdBy('part-3'));
    const mesh = m.editMesh;
    const faces = mesh.faces();
    const expected = mesh.labelNames.slice(1).map((label, index) => {
      const roles: Record<string, number> = {};
      for (const face of faces.filter((id) => mesh.fLabel[id] === index + 1)) {
        const role = mesh.roleNames[mesh.fRole[face] as number] ?? '';
        roles[role] = (roles[role] ?? 0) + 1;
      }
      return { label, roles };
    });
    const scan = vi.spyOn(mesh, 'faces');
    try {
      const first = m.inspect();
      expect(first.labels).toEqual(expected);
      expect(first.labels.find(({ label }) => label === 'part-3')?.roles).toEqual({});
      expect(scan).toHaveBeenCalledTimes(1);
      m.delete(sel.createdBy('part-0'));
      const next = m.inspect();
      expect(next.labels.find(({ label }) => label === 'part-0')?.roles).toEqual({});
      expect(first.labels).toEqual(expected);
    } finally {
      scan.mockRestore();
    }
  });

  it('records every call in the journal with status and topology stamps', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.extrude(sel.facing('+y'), { distance: 1, region: 'merged', label: 'up' });
    const journal = m.inspect().journal;
    expect(journal.map((entry) => [entry.op, entry.status])).toEqual([
      ['box', 'ok'],
      ['extrude', 'ok'],
    ]);
    const [before, after] = journal[1]?.topologyStamp ?? [0, 0];
    expect(after).toBeGreaterThan(before);
    expect(journal[1]?.label).toBe('up');
  });

  it('poison keeps the first cause and skips later work', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const failed = m.extrude(sel.tag('nope'), { distance: 1, region: 'merged', label: 'bad' });
    expect(failed.error?.code).toBe('model-selection-empty');
    expect(failed.error?.detail?.site).toEqual({ op: 'extrude', opIndex: 1, label: 'bad' });
    expect(m.box({ size: [1, 1, 1] }).status).toBe('skipped');
    expect(m.poisoned?.code).toBe('model-selection-empty');
    const finished = m.finish({ key: 'box' });
    expect(!finished.ok && finished.error).toBe(m.poisoned);
  });

  it('try() rolls back a failed branch so another construction can follow', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const attempt = m.try((inner) => {
      inner.inset(sel.facing('+y'), { thickness: 0.3, region: 'merged' });
      inner.inset(sel.facing('+y'), { thickness: 5, region: 'merged' });
    });
    expect(!attempt.ok && attempt.error.code).toBe('model-degenerate');
    expect(m.poisoned).toBeUndefined();
    expect(m.validate().faces).toBe(6);
    expect(m.journal.length).toBe(1);
    expect(m.inset(sel.facing('+y'), { thickness: 0.1, region: 'merged' }).status).toBe('ok');
  });

  it('a structurally empty extrude is reported as no effect', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const op = m.extrude(sel.facing('+y'), { distance: Number.NaN, region: 'merged' });
    expect(op.error?.code).toBe('model-invalid-argument');
  });

  it('finish validates the source key', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.uv.project({ mode: 'box', scale: 1 });
    const bad = m.finish({ key: 'Bad Key' });
    expect(!bad.ok && bad.error.code).toBe('model-invalid-argument');
    const good = m.finish({ key: 'crate' });
    expect(good.ok && Object.keys(good.value)).toEqual(['mesh/crate']);
  });
});
