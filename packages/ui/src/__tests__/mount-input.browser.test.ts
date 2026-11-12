import { expect, it } from 'vitest';
import { mountUi } from '../mount.js';

it('keeps empty areas click-through while authored elements receive input', () => {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
  document.body.append(canvas);
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none';
  document.body.append(root);
  const mounted = mountUi(
    {
      guid: 'ui-input',
      html: '<button style="position:absolute;left:10px;top:10px">Go</button><i class="decor"></i>',
      css: '.decor { position: absolute; left: 100px; top: 10px; width: 40px; height: 40px; pointer-events: none; }',
    },
    { root, layer: 1 },
  );
  if (!mounted.ok) throw mounted.error;
  const shadow = mounted.value.host.shadowRoot;
  if (!shadow) throw new Error('Expected an open shadow root');
  const button = shadow.querySelector('button');
  if (!button) throw new Error('Expected the authored button');
  const box = button.getBoundingClientRect();
  // A hit on the button resolves to the button, not to the page beneath.
  expect(shadow.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)).toBe(button);
  // Empty areas and authored pointer-events:none pass through the mount.
  expect(document.elementFromPoint(200, 300)).toBe(canvas);
  expect(document.elementFromPoint(120, 30)).toBe(canvas);
  mounted.value.dispose();
  root.remove();
  canvas.remove();
});

it('lets display-only content pass clicks to the canvas while controls stay clickable', () => {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
  document.body.append(canvas);
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none';
  document.body.append(root);
  const mounted = mountUi(
    {
      guid: 'ui-display-only',
      // A full-screen read-only HUD: a panel with text, a crosshair and a
      // nested panel holding the only controls.
      html: [
        '<div class="hud">',
        '<p class="score">Score <b>12</b></p>',
        '<i class="crosshair"></i>',
        '<div class="menu"><button><span class="label">Resume</span></button>',
        '<div class="card" data-ui-action="pick">Card</div>',
        '<div class="opt-in">Scroll me</div></div>',
        '</div>',
      ].join(''),
      css: [
        '.hud { position: absolute; inset: 0; background: rgb(0 0 0 / 30%); }',
        '.score { position: absolute; left: 10px; top: 10px; margin: 0; width: 120px; height: 30px; }',
        '.crosshair { position: absolute; left: 300px; top: 200px; width: 20px; height: 20px; }',
        '.menu { position: absolute; left: 10px; top: 300px; width: 300px; height: 100px; }',
        '.menu button { position: absolute; left: 0; top: 0; width: 80px; height: 30px; }',
        '.card { position: absolute; left: 100px; top: 0; width: 80px; height: 30px; }',
        '.opt-in { position: absolute; left: 200px; top: 0; width: 80px; height: 30px; pointer-events: auto; }',
      ].join('\n'),
    },
    { root, layer: 1 },
  );
  if (!mounted.ok) throw mounted.error;
  const shadow = mounted.value.host.shadowRoot;
  if (!shadow) throw new Error('Expected an open shadow root');
  const at = (x: number, y: number) => {
    const hit = document.elementFromPoint(x, y);
    return hit === mounted.value.host ? shadow.elementFromPoint(x, y) : hit;
  };
  // The full-screen panel, its text and the crosshair are display-only.
  expect(at(400, 100)).toBe(canvas);
  expect(at(20, 20)).toBe(canvas);
  expect(at(310, 210)).toBe(canvas);
  expect(at(150, 380)).toBe(canvas);
  // A button (and the label inside it), an action element and authored opt-in receive input.
  expect(at(30, 315)).toBe(shadow.querySelector('.label'));
  expect(at(140, 315)).toBe(shadow.querySelector('.card'));
  expect(at(240, 315)).toBe(shadow.querySelector('.opt-in'));
  mounted.value.dispose();
  // An open modal dialog still blocks the game beneath it, backdrop included.
  const modal = mountUi(
    {
      guid: 'ui-modal',
      html: '<section role="dialog" class="backdrop"><p>Paused</p></section>',
      css: '.backdrop { position: absolute; inset: 0; }',
    },
    { root, layer: 2 },
  );
  if (!modal.ok) throw modal.error;
  expect(document.elementFromPoint(400, 100)).toBe(modal.value.host);
  modal.value.dispose();
  root.remove();
  canvas.remove();
});
