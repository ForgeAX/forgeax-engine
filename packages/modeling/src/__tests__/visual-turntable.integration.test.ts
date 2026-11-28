import { describe, expect, it } from 'vitest';
import { evaluateTurntable } from '../tools/visual-turntable';
import { plate } from './visual-fixture';

const views = (options: { thin?: boolean; ring?: boolean }, azimuths = [0, 90, 180, 270]) =>
  azimuths.map((azimuth) => ({ azimuth, image: plate(128, { ...options, azimuth }) }));

describe('model.turntable orbit gate', () => {
  it('passes a solid subject captured at every required azimuth', () => {
    const r = evaluateTurntable(views({}));
    expect(r.pass).toBe(true);
    expect(r.views).toHaveLength(4);
    expect(r.views.every((v) => (v.holes as number) === 0)).toBe(true);
  });

  it('fails a billboard whose silhouette collapses edge-on', () => {
    const r = evaluateTurntable(views({ thin: true }));
    expect(r.pass).toBe(false);
    const collapse = r.issues.filter((i) => i.code === 'silhouette-collapse');
    expect(collapse.map((i) => i.detail.subject)).toEqual(['azimuth 90', 'azimuth 270']);
  });

  it('fails when a required azimuth was not captured', () => {
    const r = evaluateTurntable(views({}, [0, 90, 180]));
    expect(r.pass).toBe(false);
    expect(r.issues.find((i) => i.code === 'azimuth-missing')?.detail.subject).toBe('azimuth 270');
  });

  it('accepts a capture within the angular tolerance and wraps negative azimuths', () => {
    const r = evaluateTurntable(views({}, [2, 88, 181, -88]));
    expect(r.pass).toBe(true);
  });

  it('fails a through-hole unless the subject declares holes', () => {
    const strict = evaluateTurntable(views({ ring: true }));
    expect(strict.pass).toBe(false);
    expect(strict.issues.some((i) => i.code === 'through-hole' && i.severity === 'error')).toBe(
      true,
    );
    const allowed = evaluateTurntable(views({ ring: true }), { allowHoles: true });
    expect(allowed.pass).toBe(true);
    expect(allowed.issues.some((i) => i.code === 'through-hole' && i.severity === 'info')).toBe(
      true,
    );
  });

  it('fails closed on an unsegmentable capture even when holes are allowed', () => {
    const blank = {
      azimuth: 90,
      image: { width: 64, height: 64, rgb: new Float32Array(64 * 64 * 3).fill(0.85) },
    };
    const r = evaluateTurntable([...views({}).filter((v) => v.azimuth !== 90), blank], {
      allowHoles: true,
    });
    expect(r.pass).toBe(false);
    expect(r.issues.find((i) => i.code === 'mask-unreliable')?.detail.subject).toBe('azimuth 90');
  });
});
