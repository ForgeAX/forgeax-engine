import type { Plugin } from '@forgeax/engine/plugin';

export default {
  name: 'independent-run-ui',
  apply(ctx) {
    ctx.effect(() => {
      const root = document.querySelector('#game-ui');
      if (root === null) throw new Error('Independent run UI root is missing');
      const hud = document.createElement('div');
      hud.textContent = 'INDEPENDENT GAME UI';
      hud.style.cssText =
        'position:fixed;top:12px;left:12px;width:260px;height:80px;background:#ff00ff;z-index:99999';
      root.append(hud);
      const shadowHost = document.createElement('div');
      const shadow = shadowHost.attachShadow({ mode: 'open' });
      shadow.innerHTML =
        '<div style="position:fixed;top:110px;left:12px;width:260px;height:80px;background:#00ffff">SHADOW GAME UI</div>';
      root.append(shadowHost);
      return () => {
        hud.remove();
        shadowHost.remove();
      };
    });
  },
} satisfies Plugin;
