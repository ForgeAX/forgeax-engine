import { fileURLToPath } from 'node:url';
import { type Model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import { buildPanel, PANEL_DEFAULTS, type PanelParameters } from '../panel';
import pack from '../panel.pack';

const SOURCE = fileURLToPath(new URL('../panel.ts', import.meta.url));

function identity(m: Model) {
  const inspection = m.inspect();
  return {
    labels: inspection.labels.map((l) => l.label),
    tags: inspection.tags,
    materials: inspection.materials,
    holes: m.count(sel.createdBy('drill', 'cutB')),
    vents: m.count(sel.createdBy('vent', 'cutB')),
    bore: m.count(sel.createdBy('bore', 'cutB')),
    cover: m.count(sel.createdBy('cover', 'piece')),
  };
}

describe('C-011 boolean equipment panel', () => {
  it('builds without failure; every boolean is ok on the TS baseline and maps to its source line', () => {
    const recording = recordingSessions();
    const panel = buildPanel(PANEL_DEFAULTS, recording.session);
    expect(panel.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps.length).toBeGreaterThanOrEqual(30);
    expect(steps.every((s) => s.entry.status === 'ok')).toBe(true);
    const booleans = steps.filter((s) => ['union', 'difference', 'intersection', 'splitBy'].includes(s.entry.op));
    expect(booleans.map((s) => s.entry.op)).toEqual(['difference', 'union', 'difference', 'difference', 'union', 'difference', 'union', 'union', 'intersection', 'union', 'splitBy']);
    for (const step of booleans) {
      const info = step.entry.diagnostics?.find((d) => d.severity === 'info');
      expect(info?.detail).toMatchObject({ backend: 'ts', quality: 'baseline', status: 'ok' });
      const metrics = (info?.detail as { metrics: Record<string, number> }).metrics;
      expect(metrics.provenanceMapped).toBe(metrics.provenanceFaces);
      expect(metrics.resultFaces).toBeLessThanOrEqual((metrics.inputFaces as number) + (metrics.cutFaces as number));
    }
  });

  it('is a closed solid without confirmed issues; holes, vents and bore keep their walls', () => {
    const panel = buildPanel();
    const report = panel.validate();
    expect(report.closed).toBe(true);
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(report.issues.filter((i) => i.code === 'self-intersection' && i.detail.certainty === 'confirmed')).toEqual([]);
    expect(panel.count(sel.createdBy('drill', 'cutB'))).toBe(8 * 16);
    expect(panel.count(sel.createdBy('bore', 'cutB'))).toBe(16);
    expect(panel.count(sel.material('aluminum'))).toBeGreaterThan(0);
    expect(panel.count(sel.material('Default'))).toBe(0);
    expect(panel.toMesh({ normals: { mode: 'weighted' } }).ok).toBe(true);
  });

  it('keeps every label, tag and boolean region across the declared parameter range', { timeout: 120000 }, () => {
    const base = identity(buildPanel());
    for (const p of pack.parameters as readonly { name: keyof PanelParameters; minimum: number; maximum: number }[]) {
      for (const value of [p.minimum, p.maximum]) {
        const variant = buildPanel({ ...PANEL_DEFAULTS, [p.name]: value });
        expect([p.name, value, variant.poisoned?.code]).toEqual([p.name, value, undefined]);
        expect(identity(variant)).toEqual(base);
        expect(variant.validate().closed).toBe(true);
      }
    }
  });
});
