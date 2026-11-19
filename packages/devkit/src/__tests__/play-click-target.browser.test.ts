import { afterEach, expect, it } from 'vitest';
// The mount source, so the test follows the current default pointer-events rule.
import { mountUi } from '../../../ui/src/mount';
import { clickTargetInPage } from '../play-click-target';

afterEach(() => {
  document.body.replaceChildren();
});

function stage(css: string) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:400px;height:300px';
  const ui = document.createElement('div');
  ui.id = 'game-ui';
  ui.style.cssText = 'position:fixed;inset:0;width:400px;height:300px;pointer-events:none';
  document.body.append(canvas, ui);
  const mounted = mountUi(
    {
      guid: 'hud',
      sourcePath: 'hud.ui.html',
      html: '<div class="hud"><span class="score">12</span><button data-ui-action="go"><span class="label">Go</span></button></div>',
      css: `.hud { position: absolute; inset: 0; } .score { position: absolute; left: 10px; top: 10px; } button { position: absolute; left: 200px; top: 200px; width: 80px; height: 40px; } ${css}`,
    },
    { root: ui, layer: 0 },
  );
  if (!mounted.ok) throw mounted.error;
}

it('finds no blocker over the canvas, display-only text or a control', () => {
  stage('');
  expect(clickTargetInPage({ x: 100, y: 100 })).toBeNull();
  expect(clickTargetInPage({ x: 14, y: 16 })).toBeNull();
  expect(clickTargetInPage({ x: 220, y: 220 })).toBeNull();
});

it('names display-only content that opted into pointer input', () => {
  stage('.hud { pointer-events: auto; }');
  expect(clickTargetInPage({ x: 100, y: 100 })).toBe('<div.hud> in UI hud.ui.html');
  expect(clickTargetInPage({ x: 220, y: 220 })).toBeNull();
});
