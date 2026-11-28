import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseMesh } from '../../mesh.ts';
import { main } from '../../run.ts';
import { BASELINE_CASES, TOOLS } from '../config.ts';
import { evalMeshToObj, objToEvalMesh, producerJson, sha256, triangleInput } from '../convert.ts';
import { p05, tableOf } from '../score-baselines.ts';

const results = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');

describe('objToEvalMesh', () => {
  it('keeps triangles and quads, drops larger polygons and reports them', () => {
    const text = [
      'v 0 0 0',
      'v 1 0 0',
      'v 1 1 0',
      'v 0 1 0',
      'v 2 0 0',
      'v 2 1 0',
      'f 1 2 3 4',
      'f 2/1/1 5//2 3',
      'f 1 2 5 6 3',
    ].join('\n');
    const r = objToEvalMesh(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.mesh.faces).toEqual([
      [0, 1, 2, 3],
      [1, 4, 2],
    ]);
    expect(r.value.dropped).toEqual({ count: 1, sides: { 5: 1 } });
    expect(r.value.declared).toEqual({ vertices: 6, faces: 3 });
  });

  it('rejects an out-of-range face index and an OBJ without usable faces', () => {
    expect(objToEvalMesh('v 0 0 0\nf 1 2 3')).toEqual({
      ok: false,
      error: { code: 'bad-face-index', line: 2 },
    });
    expect(objToEvalMesh('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 2 2 2\nf 1 2 3 4 5')).toEqual({
      ok: false,
      error: { code: 'no-faces' },
    });
    expect(objToEvalMesh('v 0 x 0')).toEqual({
      ok: false,
      error: { code: 'bad-vertex', line: 1 },
    });
  });

  it('round-trips a mesh through OBJ text and the producer json', () => {
    const mesh = {
      positions: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ] as const,
      faces: [[0, 1, 2, 3]],
    };
    const r = objToEvalMesh(evalMeshToObj({ positions: [...mesh.positions], faces: mesh.faces }));
    expect(r.ok && r.value.mesh.faces).toEqual(mesh.faces);
    const parsed = parseMesh(
      JSON.parse(producerJson({ positions: [...mesh.positions], faces: mesh.faces })),
    );
    expect(parsed.ok).toBe(true);
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('triangleInput yields only triangles', () => {
    const t = triangleInput({
      positions: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      faces: [[0, 1, 2, 3]],
    });
    expect(t.faces.every((f) => f.length === 3)).toBe(true);
    expect(t.faces.length).toBe(2);
  });
});

describe('committed baseline results', () => {
  const entries = TOOLS.flatMap((tool) =>
    readdirSync(join(results, tool))
      .filter((n) => n.endsWith('.manifest.json'))
      .map((n) => ({ tool, id: n.replace('.manifest.json', '') })),
  );

  it('every tool scores on at least four cases', () => {
    for (const tool of TOOLS) {
      const ok = entries
        .filter((e) => e.tool === tool)
        .filter((e) => {
          const m = JSON.parse(
            readFileSync(join(results, tool, `${e.id}.manifest.json`), 'utf8'),
          ) as { outcome?: string };
          return m.outcome === 'ok';
        });
      expect(ok.length, tool).toBeGreaterThanOrEqual(4);
    }
  });

  it('each converted file parses and matches its manifest digest', () => {
    for (const e of entries) {
      const manifest = JSON.parse(
        readFileSync(join(results, e.tool, `${e.id}.manifest.json`), 'utf8'),
      ) as Record<string, unknown>;
      expect(BASELINE_CASES.some((c) => c.id === e.id)).toBe(true);
      if (manifest.outcome !== 'ok') continue;
      const parsed = parseMesh(
        JSON.parse(readFileSync(join(results, e.tool, `${e.id}.json`), 'utf8')),
      );
      expect(parsed.ok, `${e.tool}/${e.id}`).toBe(true);
      if (!parsed.ok) continue;
      // The digest covers the canonical compact serialization, so a formatter cannot invalidate it.
      expect(sha256(producerJson(parsed.mesh)), `${e.tool}/${e.id}`).toBe(manifest.outputSha256);
      expect(manifest.toolCommit).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe('score helpers', () => {
  it('p05 is the 5th percentile of the sorted values', () => {
    const values = Array.from({ length: 101 }, (_, i) => (100 - i) / 100);
    expect(p05(values)).toBeCloseTo(0.05, 12);
  });

  it('a missing baseline is a row, not a number', () => {
    const table = tableOf([
      {
        tool: 'qw',
        case: 'x',
        status: 'baseline not available',
        detail: 'no run recorded',
      },
    ]);
    expect(table).toContain('baseline not available');
  });
});

describe('falsifier: a hand-corrupted baseline file is rejected', () => {
  const base = JSON.parse(readFileSync(join(results, 'qf', 'brep-box-quad.json'), 'utf8')) as {
    positions: number[][];
    faces: number[][];
  };
  const out = mkdtempSync(join(tmpdir(), 'qb-'));
  const corrupt = (name: string, value: unknown): string => {
    mkdirSync(out, { recursive: true });
    const path = join(out, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const run = (path: string): number =>
    main(['--case', 'brep-box-quad', '--producer', `json:${path}`, '--out', join(out, 'rep')]);

  it('the intact file is accepted (exit 0 or a verdict exit 1, never 2)', () => {
    expect(run(corrupt('ok.json', base))).not.toBe(2);
  });

  it.each([
    [
      'index out of range',
      {
        ...base,
        faces: [[0, 1, 2, base.positions.length], ...base.faces.slice(1)],
      },
    ],
    ['pentagon face', { ...base, faces: [[0, 1, 2, 3, 4], ...base.faces.slice(1)] }],
    ['NaN as null position', { ...base, positions: [[null, 0, 0], ...base.positions.slice(1)] }],
    ['no faces', { ...base, faces: [] }],
  ])('%s -> exit 2', (name, value) => {
    expect(run(corrupt(`${name.replace(/ /g, '-')}.json`, value))).toBe(2);
  });
});

describe('feature meshes', () => {
  it('the committed F1-F3 meshes equal what the kernel builders produce now', () => {
    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'gen-feature-meshes.ts',
    );
    const r = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  }, 120_000);
});
