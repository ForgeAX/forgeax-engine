import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { measure } from '../../../src/brep/measure';
import { validate } from '../../../src/brep/validate';
import { renderShape } from '../../brep-kit/index.ts';
import { buildManifold, MANIFOLD } from '../showcase.ts';

// Set MANIFOLD_RENDER_DIR to keep the PNGs; otherwise they go to a temporary directory.
const outDir = process.env.MANIFOLD_RENDER_DIR ?? mkdtempSync(join(tmpdir(), 'manifold-showcase-'));

describe('pipe manifold: sweep + loft + revolve + booleans', () => {
  const m = buildManifold();
  const volume = (name: string): number => {
    const part = m.parts[m.names.indexOf(name)];
    if (!part) throw new Error(name);
    const r = measure(part);
    if (!r.ok) throw new Error(name);
    return r.value.volume;
  };

  it('every part is a watertight solid', () => {
    expect(m.parts).toHaveLength(m.names.length);
    for (const [i, part] of m.parts.entries()) {
      const report = validate(part);
      expect(report.ok, `${m.names[i]}: ${JSON.stringify(report.issues)}`).toBe(true);
    }
  });

  it('revolved parts match hand volumes', () => {
    const { bore, pipe, flangeR, flangeT, headerLength, boltRadius, boltCount } = MANIFOLD;
    const disc = Math.PI * (flangeR * flangeR - bore * bore) * flangeT;
    const bolt = boltCount * Math.PI * boltRadius * boltRadius * flangeT;
    expect(volume('flange-a')).toBeCloseTo(disc - bolt, 6);
    expect(volume('flange-b')).toBeCloseTo(disc - bolt, 6);
    expect(volume('blind-flange')).toBeCloseTo(Math.PI * flangeR * flangeR * flangeT - bolt, 6);
    expect(volume('header')).toBeCloseTo(Math.PI * (pipe * pipe - bore * bore) * headerLength, 6);
    expect(volume('stiffener-1')).toBeCloseTo(Math.PI * (0.62 * 0.62 - pipe * pipe) * 0.3, 6);
  });

  it('sweep and loft volumes sit inside their section bounds', () => {
    const { pipe, bore } = MANIFOLD;
    // Annulus area times a path length between the chord (about 5.5) and a generous 8.
    const ring = Math.PI * (pipe * pipe - bore * bore);
    expect(volume('s-bend')).toBeGreaterThan(ring * 5);
    expect(volume('s-bend')).toBeLessThan(ring * 8);
    // Transition wall: between the thinnest ring and the largest box section, length 1.8.
    expect(volume('transition')).toBeGreaterThan(0.1);
    expect(volume('transition')).toBeLessThan(1.8 * 1.6 * 0.9);
  });

  it('drills 3 x 8 bolt holes and fails closed exactly where the kernel cannot join', () => {
    expect(m.boltHoles).toBe(3 * MANIFOLD.boltCount);
    const outcome = (needle: string) => m.joins.find((j) => j.step.includes(needle));
    for (const needle of [
      'flange A: 8 bolt',
      'flange B: 8 bolt',
      'blind flange: 8 bolt',
      'header: stiffener ring 1',
      'header: stiffener ring 2',
    ]) {
      expect(outcome(needle)?.ok, needle).toBe(true);
    }
    expect(outcome('flange A + header')?.ok, 'flange A + header').toBe(true);
    const refused = m.joins.filter((j) => !j.ok);
    expect(refused.length).toBeGreaterThanOrEqual(4);
    for (const j of refused) {
      expect(j.code, j.step).toBe('model-partial');
      expect(j.brep, j.step).toBe('brep-ssi-unsupported');
    }
  });

  it('renders shaded and feature-line views', () => {
    const result = renderShape(m.parts, {
      views: ['iso', 'front', 'top'],
      modes: ['shaded', 'features'],
      size: 720,
      silhouette: true,
      tessellation: { angle: Math.PI / 32, chord: 0.01 },
      outDir,
      name: 'manifold-',
    });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    const files = readdirSync(outDir).filter((f) => f.startsWith('manifold-'));
    expect(files).toHaveLength(6);
    for (const f of files) expect(statSync(join(outDir, f)).size).toBeGreaterThan(10_000);
  });
});
