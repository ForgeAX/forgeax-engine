/// <reference types="vite/client" />
import publishedFallback from '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2?inline';
import { required } from './fixture.js';

// The same published font bytes travel through the ordinary @font-face/data URL
// path in Chromium and native. The ASCII bootstrap stays deliberately incomplete.
export const inventoryHtml = `<!doctype html><style>
  @font-face{font-family:"Noto Sans SC Variable";src:url("${publishedFallback}")}
  *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font:14px/20px "Inventory Fixture";background:#10243a;color:#eef2fa}
  #inventory{position:absolute;left:16px;top:16px;width:328px;padding:16px;background:#25435f;border-radius:8px}
  header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
  #items{display:grid;gap:8px;margin-bottom:12px}.item{display:flex;align-items:center;justify-content:space-between;padding:8px;background:#18324b}
  button{height:32px;width:112px;padding:4px 12px;border:0;border-radius:4px;background:#f7c62d;color:#10243a;font:inherit}
  button:disabled{background:#78838c}canvas{position:absolute;left:16px;top:300px;width:328px;height:44px;background:#305849}
</style><section id="inventory" aria-label="Inventory">
  <header><strong>Inventory</strong><button id="add" type="button">Add torch</button></header>
  <div id="items"><div class="item" id="row-a"><span>Potion × 3</span><button id="a" type="button">Use potion</button></div><div class="item" id="row-c"><span>Rope × 1</span><button id="c" type="button">Use rope</button></div></div>
  <button id="close" type="button">Close</button>
</section><canvas id="game" tabindex="0" width="328" height="44"></canvas>`;

/** One ordinary author controller runs unchanged in Chromium and Blitz. */
export function mountInventory(document: Document) {
  const inventory = required(document.querySelector<HTMLElement>('#inventory'));
  const items = required(document.querySelector<HTMLElement>('#items'));
  const game = required(document.querySelector<HTMLCanvasElement>('#game'));
  const add = required(document.querySelector<HTMLButtonElement>('#add'));
  const a = required(document.querySelector<HTMLButtonElement>('#a'));
  const c = required(document.querySelector<HTMLButtonElement>('#c'));
  const close = required(document.querySelector<HTMLButtonElement>('#close'));
  const row = document.createElement('div');
  row.id = 'row-b';
  row.className = 'item';
  row.innerHTML = '<span>Torch × 1</span><button id="b" type="button">Use torch</button>';
  const b = required(row.querySelector<HTMLButtonElement>('button'));
  const trace: string[] = [];
  add.addEventListener('click', () => {
    items.insertBefore(row, c.parentElement);
    b.focus();
    trace.push('insert');
  });
  b.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete') return;
    row.remove();
    trace.push('remove');
    event.preventDefault();
  });
  for (const button of [a, b, c])
    button.addEventListener('click', () => trace.push(`use:${button.id}`));
  close.addEventListener('click', () => {
    inventory.hidden = true;
    trace.push('close');
  });
  return { document, inventory, items, game, add, a, b, c, close, row, trace };
}
