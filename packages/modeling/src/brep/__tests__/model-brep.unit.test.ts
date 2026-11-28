import { describe, expect, it } from 'vitest';
import { decodeSnapshot } from '../../fxem';
import { EDGE_SHARP } from '../../mesh';
import { type JournalEntry, type Model, model } from '../../model';
import * as exact from '../index';
import { BREP_LIMITS } from '../types';

/** Closed replay table: a journal entry names an op and plain parameters; unknown ops fail loudly. */
function replay(journal: readonly JournalEntry[]): { model: Model; unknown?: string } {
  const m = model({ exact });
  for (const entry of journal) {
    const { name, ...options } = entry.args as { name: string } & Record<string, unknown>;
    switch (entry.op) {
      case 'brep.box':
        m.brep.box(name, options as never);
        break;
      case 'brep.cylinder':
        m.brep.cylinder(name, options as never);
        break;
      case 'brep.extrude':
        m.brep.extrude(name, options as never);
        break;
      case 'fromShape':
        m.fromShape(name, options);
        break;
      default:
        return { model: m, unknown: entry.op };
    }
  }
  return { model: m };
}

function build(): Model {
  const m = model({ exact });
  m.brep.box('plate', { size: [2, 3, 4], label: 'plate', role: 'body' });
  m.brep.cylinder('post', { radius: 0.5, height: 2 });
  m.fromShape('plate');
  m.fromShape('post', { angle: Math.PI / 8 });
  return m;
}

describe('Model exact ops (D-P2-6)', () => {
  it('build ops store a shape and leave the mesh alone; fromShape appends it', () => {
    const m = model({ exact });
    const built = m.brep.box('plate', { size: [2, 3, 4], label: 'plate', role: 'body' });
    expect(built).toMatchObject({ status: 'ok', op: 'brep.box', faces: 0, vertices: 0 });
    expect(m.shape('plate')?.faces.length).toBe(6);
    const from = m.fromShape('plate');
    expect(from).toMatchObject({ status: 'ok', op: 'fromShape', faces: 6 });
    expect(from.roles).toEqual({ part: 6 });
    const again = m.fromShape('plate');
    expect(again.faces).toBe(12);
    expect(m.poisoned).toBeUndefined();
  });

  it('faces keep labels and roles, creases are sharp, uv0 is present', () => {
    const m = model({ exact });
    m.brep.box('plate', { size: [1, 1, 1], label: 'plate', role: 'body' });
    m.fromShape('plate');
    const mesh = decodeSnapshot(m.snapshot());
    if (!mesh.ok) throw new Error(JSON.stringify(mesh.error));
    expect(mesh.value.labelNames).toContain('plate.px');
    expect(mesh.value.roleNames).toContain('body');
    expect(mesh.value.channels.has('uv0')).toBe(true);
    expect(Array.from(mesh.value.eFlags).some((f) => (f & EDGE_SHARP) !== 0)).toBe(true);
  });

  it('fromShape passes uv zones through and validate({ surface }) is clean', () => {
    const m = model({ exact });
    m.brep.box('plate', { size: [2, 3, 4], label: 'plate', role: 'body' });
    const r = m.fromShape('plate', { uv: { zones: { body: [1, 0] } } });
    expect(r.status).toBe('ok');
    const mesh = decodeSnapshot(m.snapshot());
    if (!mesh.ok) throw new Error('snapshot');
    const h = mesh.value.faceHalves(mesh.value.faces()[0] as number)[0] as number;
    expect((mesh.value.corner('uv0', h) as Float32Array)[0]).toBeGreaterThanOrEqual(1);
    const bad = m.fromShape('plate', { uv: { gutter: -1 } });
    expect(bad.status).not.toBe('ok');
    const report = m.validate({ surface: { need: ['uv0'] } });
    expect(report.issues.filter((i) => i.code === 'surface')).toEqual([]);
  });

  it('fromShape reads options.uv once: the journal and the geometry see the same value', () => {
    const m = model({ exact });
    m.brep.box('plate', { size: [2, 3, 4], role: 'body' });
    let reads = 0;
    const options = {
      get uv() {
        return ++reads === 1 ? { gutter: 0.5 } : { gutter: 0.01 };
      },
    };
    const r = m.fromShape('plate', options);
    expect(reads).toBe(1);
    expect(r.status).toBe('ok');
    const entry = m.journal.at(-1);
    expect((entry?.args as { uv?: { gutter?: number } }).uv?.gutter).toBe(0.5);
    const same = model({ exact });
    same.brep.box('plate', { size: [2, 3, 4], role: 'body' });
    same.fromShape('plate', { uv: { gutter: 0.5 } });
    expect(Array.from(m.snapshot())).toEqual(Array.from(same.snapshot()));
  });

  it('fromShape with options that throw on read is an error report, never a throw', () => {
    const boom = (): never => {
      throw new Error('boom');
    };
    const hostile: unknown[] = [
      {
        get uv() {
          return boom();
        },
      },
      {
        get angle() {
          return boom();
        },
      },
      new Proxy({}, { ownKeys: boom, get: boom, getOwnPropertyDescriptor: boom }),
    ];
    for (const options of hostile) {
      const m = model({ exact });
      m.brep.box('plate', { size: [2, 3, 4] });
      let r: ReturnType<typeof m.fromShape> | undefined;
      expect(() => {
        r = m.fromShape('plate', options as never);
      }).not.toThrow();
      expect(r?.status).not.toBe('ok');
    }
  });

  it('the journal holds names and plain parameters, never shape bytes', () => {
    const m = build();
    for (const entry of m.journal) {
      const text = JSON.stringify(entry.args);
      expect(text.length).toBeLessThan(300);
      expect(text).not.toContain('coedges');
    }
    expect(m.journal.map((e) => e.op)).toEqual([
      'brep.box',
      'brep.cylinder',
      'fromShape',
      'fromShape',
    ]);
    expect(m.journal[0]?.args).toMatchObject({ name: 'plate', size: [2, 3, 4] });
  });

  it('replaying the journal reproduces the mesh byte for byte', () => {
    const a = build();
    const { model: b, unknown } = replay(JSON.parse(JSON.stringify(a.journal)));
    expect(unknown).toBeUndefined();
    expect(Buffer.from(b.snapshot()).equals(Buffer.from(a.snapshot()))).toBe(true);
  });

  it('replaying a journal with an op this kernel lacks fails by name (unknown-op falsifier)', () => {
    const journal = JSON.parse(JSON.stringify(build().journal)) as JournalEntry[];
    journal.splice(2, 0, { ...journal[0], op: 'brep.loftThrough' } as JournalEntry);
    const r = replay(journal);
    expect(r.unknown).toBe('brep.loftThrough');
    expect(r.model.shape('post')).toBeDefined();
    expect(r.model.journal.length).toBe(2);
  });

  it('fromShape of an unknown name poisons the session with brep-bad-argument', () => {
    const m = model({ exact });
    const r = m.fromShape('missing');
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-invalid-argument');
    expect(r.error?.detail).toMatchObject({ brep: 'brep-bad-argument', name: 'missing' });
    expect(m.poisoned?.code).toBe('model-invalid-argument');
  });

  it('a duplicate shape name and a builder failure fail the session', () => {
    const dup = model({ exact });
    dup.brep.box('a', { size: [1, 1, 1] });
    expect(dup.brep.box('a', { size: [1, 1, 1] }).error?.detail).toMatchObject({
      brep: 'brep-bad-argument',
    });
    const bad = model({ exact });
    const r = bad.brep.box('a', { size: [1, 0, 1] });
    expect(r.status).toBe('failed');
    expect(r.error?.detail).toMatchObject({ brep: 'brep-bad-argument' });
  });

  it('a failing op later in the session leaves no half-applied shape (rollback on internal error aside)', () => {
    const m = model({ exact });
    m.brep.box('a', { size: [1, 1, 1] });
    m.brep.box('b', { size: [1, 0, 1] });
    expect(m.shape('b')).toBeUndefined();
    expect(m.brep.box('c', { size: [1, 1, 1] }).status).toBe('skipped');
    expect(m.shape('c')).toBeUndefined();
  });

  it('a shape beyond BREP_LIMITS is model-work-budget, not a mesh budget', () => {
    expect(BREP_LIMITS).toEqual({ faces: 4096, edges: 4096 });
    const m = model({ exact });
    const n = 1400;
    const profile: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      profile.push([Math.cos(a) * 10, Math.sin(a) * 10]);
    }
    const r = m.brep.extrude('ring', { profile, depth: 1 });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-work-budget');
    expect(r.error?.detail).toMatchObject({ name: 'ring' });
  });

  it('the mesh face budget still bounds fromShape', () => {
    const m = model({ exact, budget: { faces: 4 } });
    m.brep.box('a', { size: [1, 1, 1] });
    const r = m.fromShape('a');
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-work-budget');
  });

  it('shapes sit beside authored geometry', () => {
    const m = model({ exact });
    m.box({ size: [1, 1, 1] });
    m.brep.cylinder('post', { radius: 0.2, height: 3 });
    const r = m.fromShape('post');
    expect(r.faces).toBeGreaterThan(6);
  });

  it('without an injected stage the exact ops fail with model-capability-unavailable and change nothing', () => {
    const m = model();
    expect(m.brep.box('plate', { size: [1, 1, 1] }).error?.code).toBe(
      'model-capability-unavailable',
    );
    expect(m.shape('plate')).toBeUndefined();
    const f = model();
    const r = f.fromShape('plate');
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-capability-unavailable');
  });
});
