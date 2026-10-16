import type { GameHost } from '@forgeax/engine-app';
import { mountUi, type UiAsset } from '@forgeax/engine-ui';

export type BrotatoPhase = 'playing' | 'defeated';

export interface BrotatoHudSnapshot {
  readonly phase: BrotatoPhase;
  readonly score: number;
  readonly kills: number;
  readonly wave: number;
  readonly elapsed: number;
  readonly health: number;
  readonly maxHealth: number;
  readonly enemies: number;
  readonly projectiles: number;
}

export interface BrotatoHud {
  readonly update: (snapshot: BrotatoHudSnapshot) => void;
  readonly dispose: () => void;
}

function updateHealthBar(
  health: HTMLElement,
  maxHealth: number,
  currentHealth: number,
  state: { maxHealth: number; health: number },
): void {
  const safeMax = Math.max(0, Math.floor(maxHealth));
  const safeHealth = Math.max(0, Math.min(safeMax, Math.floor(currentHealth)));
  if (state.maxHealth !== safeMax) {
    const hearts: HTMLSpanElement[] = [];
    for (let index = 0; index < safeMax; index += 1) {
      const heart = document.createElement('span');
      heart.className = 'brotato3d-heart' + (index < safeHealth ? '' : ' empty');
      heart.setAttribute('aria-hidden', 'true');
      hearts.push(heart);
    }
    health.replaceChildren(...hearts);
    state.maxHealth = safeMax;
    state.health = safeHealth;
    return;
  }
  if (state.health === safeHealth) return;
  for (let index = 0; index < safeMax; index += 1) {
    health.children.item(index)?.classList.toggle('empty', index >= safeHealth);
  }
  state.health = safeHealth;
}

function setText(element: HTMLElement | null, value: string): void {
  if (element?.textContent !== value) element?.replaceChildren(document.createTextNode(value));
}

function createFallbackHud(host: GameHost): BrotatoHud {
  const root = host.uiRoot ?? (host.canvas && 'parentElement' in host.canvas ? host.canvas.parentElement : null) ?? document.body;
  const style = document.createElement('style');
  style.textContent = [
    '.brotato3d-hud{position:absolute;inset:0;pointer-events:none;color:#eef7ff;font:500 14px/1.4 ui-sans-serif,system-ui,sans-serif;text-shadow:0 2px 10px #000;letter-spacing:.02em}',
    '.brotato3d-card{position:absolute;top:22px;left:22px;min-width:230px;padding:16px 18px;border:1px solid #5ee6ff66;border-radius:14px;background:linear-gradient(145deg,#08162ce8,#10182bd9);box-shadow:0 12px 38px #0008,0 0 24px #22c8ff1c;backdrop-filter:blur(10px)}',
    '.brotato3d-title{margin:0 0 8px;color:#65e7ff;font-size:12px;letter-spacing:.18em;text-transform:uppercase}',
    '.brotato3d-score{font-size:30px;font-weight:800;line-height:1;color:#fff}',
    '.brotato3d-row{display:flex;justify-content:space-between;gap:16px;margin-top:9px;color:#a9bfd5}',
    '.brotato3d-row b{color:#f4fbff;font-weight:700}',
    '.brotato3d-health{display:flex;gap:4px;margin-top:12px}',
    '.brotato3d-heart{width:20px;height:8px;border-radius:5px;background:#ff5578;box-shadow:0 0 12px #ff416577}',
    '.brotato3d-heart.empty{background:#243447;box-shadow:none}',
    '.brotato3d-wave{margin-top:10px;color:#ffd36a;font-weight:700}',
    '.brotato3d-help{position:absolute;right:22px;bottom:22px;max-width:320px;padding:12px 14px;border:1px solid #ffffff22;border-radius:12px;background:#07111cd4;color:#aac1d3;text-align:right}',
    '.brotato3d-help b{color:#fff}',
    '.brotato3d-state{position:absolute;left:50%;top:16%;transform:translateX(-50%);padding:12px 22px;border-radius:999px;background:#ff4664dd;color:#fff;font-size:18px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;opacity:0;transition:opacity .2s}',
    '.brotato3d-state.visible{opacity:1}',
    '.brotato3d-vignette{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 42%,#02061144 100%)}',
  ].join('');
  const panel = document.createElement('aside');
  panel.className = 'brotato3d-hud';
  panel.innerHTML = [
    '<div class="brotato3d-vignette"></div>',
    '<section class="brotato3d-card" aria-label="Brotato 3D status">',
    '<p class="brotato3d-title">Brotato 3D / Arena run</p>',
    '<div class="brotato3d-score" data-score>00000</div>',
    '<div class="brotato3d-row"><span>Kills</span><b data-kills>0</b></div>',
    '<div class="brotato3d-row"><span>Threats</span><b data-enemies>0</b></div>',
    '<div class="brotato3d-row"><span>Run time</span><b data-time>00:00</b></div>',
    '<div class="brotato3d-health" data-health aria-label="Player health"></div>',
    '<div class="brotato3d-wave" data-wave>Wave 1</div>',
    '</section>',
    '<div class="brotato3d-state" data-state>RUN OVER - PRESS R</div>',
    '<div class="brotato3d-help"><b>WASD</b> move - auto-aim fire<br><b>Space / click</b> overclock fire rate - <b>R</b> restart</div>',
  ].join('');
  root.append(style, panel);

  const score = panel.querySelector<HTMLElement>('[data-score]');
  const kills = panel.querySelector<HTMLElement>('[data-kills]');
  const enemies = panel.querySelector<HTMLElement>('[data-enemies]');
  const time = panel.querySelector<HTMLElement>('[data-time]');
  const health = panel.querySelector<HTMLElement>('[data-health]');
  const wave = panel.querySelector<HTMLElement>('[data-wave]');
  const state = panel.querySelector<HTMLElement>('[data-state]');
  const healthState = { maxHealth: -1, health: -1 };

  const update = (snapshot: BrotatoHudSnapshot): void => {
    setText(score, String(Math.max(0, Math.floor(snapshot.score))).padStart(5, '0'));
    setText(kills, String(Math.max(0, Math.floor(snapshot.kills))));
    setText(enemies, String(Math.max(0, Math.floor(snapshot.enemies))));
    if (time) {
      const seconds = Math.max(0, Math.floor(snapshot.elapsed));
      const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
      const remainder = String(seconds % 60).padStart(2, '0');
      setText(time, minutes + ':' + remainder);
    }
    setText(wave, 'Wave ' + Math.max(1, Math.floor(snapshot.wave)));
    if (health) updateHealthBar(health, snapshot.maxHealth, snapshot.health, healthState);
    state?.classList.toggle('visible', snapshot.phase === 'defeated');
  };

  return {
    update,
    dispose: () => {
      panel.remove();
      style.remove();
    },
  };
}

function createPackHud(host: GameHost, asset: UiAsset): BrotatoHud | undefined {
  const root = host.uiRoot ?? (host.canvas && 'parentElement' in host.canvas ? host.canvas.parentElement : null) ?? document.body;
  const mounted = mountUi(asset, { root, layer: 50 });
  if (!mounted.ok) return undefined;
  const shadow = mounted.value.host.shadowRoot;
  if (shadow === null) {
    mounted.value.dispose();
    return undefined;
  }
  const score = shadow.querySelector<HTMLElement>('[data-ui-slot="score"]');
  const kills = shadow.querySelector<HTMLElement>('[data-ui-slot="kills"]');
  const enemies = shadow.querySelector<HTMLElement>('[data-ui-slot="enemies"]');
  const time = shadow.querySelector<HTMLElement>('[data-ui-slot="time"]');
  const health = shadow.querySelector<HTMLElement>('[data-ui-slot="health"]');
  const wave = shadow.querySelector<HTMLElement>('[data-ui-slot="wave"]');
  const state = shadow.querySelector<HTMLElement>('[data-ui-slot="state"]');
  const healthState = { maxHealth: -1, health: -1 };
  return {
    update: (snapshot) => {
      setText(score, String(Math.max(0, Math.floor(snapshot.score))).padStart(5, '0'));
      setText(kills, String(Math.max(0, Math.floor(snapshot.kills))));
      setText(enemies, String(Math.max(0, Math.floor(snapshot.enemies))));
      if (time) {
        const seconds = Math.max(0, Math.floor(snapshot.elapsed));
        setText(
          time,
          `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
        );
      }
      setText(wave, `Wave ${Math.max(1, Math.floor(snapshot.wave))}`);
      if (health) updateHealthBar(health, snapshot.maxHealth, snapshot.health, healthState);
      state?.classList.toggle('visible', snapshot.phase === 'defeated');
    },
    dispose: mounted.value.dispose,
  };
}

export function createBrotatoHud(host: GameHost, asset?: UiAsset): BrotatoHud {
  if (asset !== undefined) {
    const packed = createPackHud(host, asset);
    if (packed !== undefined) return packed;
  }
  return createFallbackHud(host);
}
