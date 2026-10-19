import { createThreeScene } from './three-scene.mjs';
import { createForgeaxScene } from './forgeax-scene.mjs';
import threeSource from './three-scene.mjs?raw';
import forgeaxSource from './forgeax-scene.mjs?raw';

const status = document.getElementById('status');
const controls = [...document.querySelectorAll('select, input, button')];
const sources = { three: threeSource, forgeax: forgeaxSource };
for (const [name, source] of Object.entries(sources)) {
  document.getElementById(`${name}-source`).textContent = source;
  document.getElementById(`${name}-download`).href =
    `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

let scenes = [];
let generation = 0;
const api = {
  sources,
  productHead: __FORGEAX_PRODUCT_HEAD__,
  get generation() {
    return generation;
  },
  async restart() {
    controls.forEach((control) => {
      control.disabled = true;
    });
    await Promise.all(scenes.map((scene) => scene.dispose()));
    scenes = [];
    // Recreate the surfaces as well as their renderers for the lifecycle check.
    for (const name of ['three', 'forgeax']) {
      const old = document.getElementById(name);
      old.replaceWith(old.cloneNode());
    }
    try {
      // Keep partial startup failures disposable.
      scenes.push(await createThreeScene(document.getElementById('three')));
      scenes.push(await createForgeaxScene(document.getElementById('forgeax')));
      api.apply();
      generation++;
      status.textContent = `Ready · Three.js 0.184.0 · ForgeaX ${api.productHead.slice(0, 12)} · generation ${generation}`;
      controls.forEach((control) => {
        control.disabled = false;
      });
    } catch (error) {
      fail(error);
      await Promise.all(scenes.map((scene) => scene.dispose()));
      scenes = [];
      throw error;
    }
  },
  apply() {
    for (const scene of scenes) {
      scene.setMode(document.getElementById('mode').value);
      scene.setShadows(document.getElementById('shadows').checked);
      scene.setAmbient(document.getElementById('ambient').checked);
      scene.setView(document.getElementById('view').checked);
    }
  },
  async dispose() {
    await Promise.all(scenes.map((scene) => scene.dispose()));
    scenes = [];
  },
};
function fail(error) {
  if (globalThis.__sceneAuthoringError) return;
  status.textContent = `Failed: ${error.stack ?? error}`;
  globalThis.__sceneAuthoringError = String(error.stack ?? error);
}
for (const control of document.querySelectorAll('select, input'))
  control.addEventListener('change', () => {
    try {
      api.apply();
    } catch (error) {
      fail(error);
    }
  });
document.getElementById('restart').addEventListener('click', () => api.restart().catch(fail));
window.addEventListener('error', (event) => fail(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => fail(event.reason));
try {
  await api.restart();
  globalThis.__sceneAuthoring = api;
} catch (error) {
  fail(error);
}
if (import.meta.hot) import.meta.hot.dispose(() => api.dispose());
