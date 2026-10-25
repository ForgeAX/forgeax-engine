// @perf-budget-skip: real Chromium layout of a fixture HUD; geometry needs a layout engine.
import { existsSync } from 'node:fs';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { collectLayout, layoutIssues } from '../play-layout.js';

function browserExecutable(): string | undefined {
  const candidates = [
    process.env.FORGEAX_BROWSER_EXECUTABLE,
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/opt/google/chrome-beta/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    typeof chromium.executablePath === 'function' ? chromium.executablePath() : undefined,
  ];
  return candidates.find(
    (candidate): candidate is string => candidate !== undefined && existsSync(candidate),
  );
}

// A HUD with the benchmark defect (opening text placed for 720 px runs into the
// bottom bar at 600 px) beside intentional layering that must stay silent.
const HUD = `<!doctype html><style>
  body { margin: 0; font: 16px/1.2 sans-serif; }
  #game-ui { position: fixed; inset: 0; pointer-events: none; }
  #layer { position: absolute; inset: 0; }
  #bottom-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 80px; background: #223; color: #fff; }
  #intro { position: absolute; top: 520px; left: 340px; width: 600px; }
  .health { position: absolute; top: 16px; left: 16px; width: 200px; height: 24px; }
  .health .fill { position: absolute; inset: 0 60% 0 0; background: #c33; }
  .health span { position: absolute; left: 70px; top: 2px; }
  #dim { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.2); }
  #names span { position: absolute; top: 300px; }
  #ghost { position: absolute; top: 400px; left: 100px; visibility: hidden; }
  #ghost-over { position: absolute; top: 400px; left: 100px; }
  #log { position: absolute; top: 470px; left: 960px; width: 200px; height: 40px; overflow: hidden; }
  #faint { position: absolute; top: 100px; left: 600px; width: 200px; height: 40px; background: #000; opacity: 0.3; }
  #faint-label { position: absolute; top: 110px; left: 620px; }
</style>
<div id="game-ui"><div id="layer">
  <div id="dim"></div>
  <div class="health"><div class="fill"></div><span>40 / 100</span></div>
  <p id="intro">Night falls over the lighthouse. Keep the lamp lit.</p>
  <div id="bottom-bar"><button>Start</button></div>
  <div id="names" data-forgeax-layout="ignore"><span style="left:500px">Keeper</span><span style="left:510px">Gull</span></div>
  <span id="ghost">Hidden label</span><span id="ghost-over">Shown label</span>
  <div id="log">${Array.from({ length: 12 }, (_unused, index) => `<div>Log line ${index}</div>`).join('')}</div>
  <div id="faint"></div><span id="faint-label">Faint panel label</span>
</div></div>`;

let browser: Browser | undefined;

beforeAll(async () => {
  const executablePath = browserExecutable();
  browser = await chromium.launch({
    headless: true,
    ...(executablePath === undefined ? {} : { executablePath }),
    chromiumSandbox: true,
  });
});

afterAll(async () => {
  await browser?.close();
});

it('flags the short-viewport overlap only and stays silent on intentional HUD layering', async () => {
  if (browser === undefined) throw new Error('browser did not launch');
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await page.setContent(HUD);
    expect(layoutIssues(await collectLayout(page))).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 600 });
    expect(layoutIssues(await collectLayout(page))).toEqual([
      {
        viewport: '1280x600',
        kind: 'text-over-panel',
        a: '#intro "Night falls over the li…"',
        b: '#bottom-bar',
      },
    ]);
    await page.evaluate(() => {
      const button = document.querySelector('#bottom-bar button') as HTMLElement;
      button.style.cssText = 'position:absolute; left:1250px; top:10px';
      const score = document.createElement('span');
      score.id = 'score';
      score.textContent = 'Score 120';
      score.style.cssText = 'position:absolute; top:540px; left:360px';
      document.querySelector('#layer')?.append(score);
    });
    const intro = '#intro "Night falls over the li…"';
    expect(
      layoutIssues(await collectLayout(page)).map((issue) => [issue.kind, issue.a, issue.b]),
    ).toEqual([
      ['text-overlap', intro, '#score "Score 120"'],
      ['text-over-panel', intro, '#bottom-bar'],
      ['text-clipped', '#bottom-bar button "Start"', undefined],
      ['text-over-panel', '#score "Score 120"', '#bottom-bar'],
    ]);
  } finally {
    await page.close();
  }
}, 60_000);
