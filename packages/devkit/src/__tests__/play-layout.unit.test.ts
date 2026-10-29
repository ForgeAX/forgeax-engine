import { describe, expect, it } from 'vitest';
import {
  type LayoutNode,
  type LayoutRect,
  layoutIssues,
  parsePlayViewports,
} from '../play-layout.js';

const viewport = { width: 1280, height: 600 };
const r = (x: number, y: number, width: number, height: number): LayoutRect => ({
  x,
  y,
  width,
  height,
});
const node = (partial: Partial<LayoutNode> & Pick<LayoutNode, 'label' | 'box'>): LayoutNode => ({
  parent: -1,
  text: '',
  lines: [],
  panel: false,
  ...partial,
});
const text = (label: string, line: LayoutRect, parent = -1): LayoutNode =>
  node({ label, text: label.slice(1), box: line, lines: [line], parent });

describe('play viewports', () => {
  it('parses WxH lists and rejects tiny, duplicate, malformed or too many viewports', () => {
    expect(parsePlayViewports('1280x720,390x844')).toEqual({
      ok: true,
      value: [
        { width: 1280, height: 720 },
        { width: 390, height: 844 },
      ],
    });
    for (const bad of ['1280', '100x720', '1280x720,1280x720', '1x1,2x2,3x3,4x4,5x5', ''])
      expect(parsePlayViewports(bad).ok, bad).toBe(false);
  });
});

describe('HUD layout check', () => {
  it('reports opening text that runs into the bottom bar at a short viewport', () => {
    const bar = node({ label: '#bottom-bar', box: r(0, 520, 1280, 80), panel: true });
    const above = text('#intro', r(340, 480, 600, 24));
    expect(layoutIssues({ viewport, truncated: false, nodes: [bar, above] })).toEqual([]);
    for (const y of [506, 540])
      expect(
        layoutIssues({
          viewport,
          truncated: false,
          nodes: [bar, text('#intro', r(340, y, 600, 24))],
        }),
      ).toEqual([
        { viewport: '1280x600', kind: 'text-over-panel', a: '#intro "intro"', b: '#bottom-bar' },
      ]);
  });

  it('treats a full-viewport backdrop as design, not a HUD collision', () => {
    const backdrop = node({ label: '#pause-dim', box: r(0, 0, 1280, 600), panel: true });
    expect(
      layoutIssues({
        viewport,
        truncated: false,
        nodes: [backdrop, text('#menu', r(500, 280, 200, 24))],
      }),
    ).toEqual([]);
  });

  it('reports text drawn over other text but not tightly stacked lines', () => {
    const title = text('#title', r(100, 100, 300, 20));
    const stacked = text('#subtitle', r(100, 117, 300, 20));
    expect(layoutIssues({ viewport, truncated: false, nodes: [title, stacked] })).toEqual([]);
    const over = text('#score', r(150, 104, 100, 20));
    expect(layoutIssues({ viewport, truncated: false, nodes: [title, over] })).toMatchObject([
      { kind: 'text-overlap', a: '#title "title"', b: '#score "score"' },
    ]);
  });

  it('ignores a label on its own small component, such as a health bar fill', () => {
    const bar = node({ label: '#health', box: r(20, 20, 200, 24) });
    const fill = node({
      label: '#health div.fill',
      box: r(20, 20, 80, 24),
      panel: true,
      parent: 0,
    });
    const label = text('#health span', r(90, 22, 60, 20), 0);
    expect(layoutIssues({ viewport, truncated: false, nodes: [bar, fill, label] })).toEqual([]);
  });

  it('reports text cut by the viewport edge but not text parked fully off-screen', () => {
    const cut = text('#toast', r(1200, 300, 120, 20));
    const parked = text('#drawer', r(1300, 300, 120, 20));
    expect(layoutIssues({ viewport, truncated: false, nodes: [cut, parked] })).toEqual([
      { viewport: '1280x600', kind: 'text-clipped', a: '#toast "toast"' },
    ]);
  });

  it('never reports text inside its own panel or a panel nested in the text element', () => {
    const panel = node({ label: '#dialog', box: r(300, 200, 600, 200), panel: true });
    const line = text('#dialog p', r(320, 220, 560, 20), 0);
    const icon = node({ label: '#dialog p img', box: r(340, 222, 16, 16), panel: true, parent: 1 });
    expect(layoutIssues({ viewport, truncated: false, nodes: [panel, line, icon] })).toEqual([]);
  });

  it('treats an earlier panel in a bounded component as background, a later one as covering', () => {
    const dialog = node({ label: '#dialog', box: r(200, 100, 800, 400) });
    const portrait = node({
      label: '#dialog img',
      box: r(220, 120, 200, 200),
      panel: true,
      parent: 0,
    });
    const line = text('#dialog p', r(240, 200, 500, 20), 0);
    expect(layoutIssues({ viewport, truncated: false, nodes: [dialog, portrait, line] })).toEqual(
      [],
    );
    const badge = node({
      label: '#dialog .badge',
      box: r(260, 195, 80, 30),
      panel: true,
      parent: 0,
    });
    expect(
      layoutIssues({ viewport, truncated: false, nodes: [dialog, line, badge] }).map(
        (issue) => issue.b,
      ),
    ).toEqual(['#dialog .badge']);
  });

  it('reports an incomplete check when the element walk hit its limit', () => {
    expect(layoutIssues({ viewport, truncated: true, nodes: [] })).toEqual([
      expect.objectContaining({ viewport: '1280x600', kind: 'incomplete' }),
    ]);
  });
});
