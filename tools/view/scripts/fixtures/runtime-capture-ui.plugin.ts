import type { GameHost } from '@forgeax/engine/app';
import type { Plugin } from '@forgeax/engine/plugin';

/** The fixture owns DOM in the frontend; its Engine Worker only owns test state. */
const plugin: Plugin = {
  name: 'runtime-capture-proof-ui',
  inject: ['gameHost'],
  apply(ctx) {
    const host: GameHost | undefined = ctx.gameHost;
    if (!host) throw new Error('The capture fixture requires GameHost');
    const evaluate = 'remoteEval' in host.app ? host.app.remoteEval : undefined;
    ctx.effect(() => {
      const hud = document.createElement('div');
      hud.id = 'runtime-capture-proof-hud';
      hud.textContent = 'AI GAME UI';
      hud.style.cssText = 'position:fixed;left:20px;top:20px;width:200px;height:80px;background:#ff00ff';
      const shadow = document.createElement('div');
      shadow.attachShadow({ mode: 'open' }).innerHTML = '<div style="position:fixed;left:20px;top:120px;width:200px;height:80px;background:#00ffff">SHADOW UI</div>';
      let disposed = false;
      let applied = 0;
      let timer: ReturnType<typeof setTimeout>;
      const update = async () => {
        try {
          const revision = Number(evaluate
            ? await evaluate('globalThis.__runtimeCaptureProof ?? 0')
            : Reflect.get(globalThis, '__runtimeCaptureProof') ?? 0);
          if (disposed) return;
          if (revision > applied) {
            if (!applied) (host.uiRoot ?? document.body).append(hud, shadow);
            if (revision === 2) {
              hud.style.background = '#00ff00';
              hud.textContent = 'AI LIVE UPDATE';
              console.info('Runtime capture live update');
            }
            if (evaluate) await evaluate(`globalThis.__runtimeCaptureProofApplied = ${revision}`);
            else Reflect.set(globalThis, '__runtimeCaptureProofApplied', revision);
            applied = revision;
          }
        } catch (error) {
          if (!disposed) console.error('runtime-capture-proof-ui', error);
        } finally {
          if (!disposed) timer = setTimeout(update, 250);
        }
      };
      void update();
      return () => { disposed = true; clearTimeout(timer); hud.remove(); shadow.remove(); };
    });
  },
};
export default plugin;
