import type { BlitzUiInput } from '@forgeax/engine-ui-blitz';
import { createWebAudioBackend } from '#host-audio';
import { attachBrowserInputBackend } from '#host-input';
import { createBrowserPlatform } from '#host-platform';

export { createBrowserPlatform, createWebAudioBackend };

// Resource addressing changes at the Host. Delivered Catalog, shaders, fonts and
// WASM bytes retain their original publication identity.
export function packageFetch(input: string | URL, init?: RequestInit) {
  const path = new URL(String(input), 'https://forgeax.package/');
  if (path.origin !== 'https://forgeax.package') throw new Error('Unexpected package origin');
  return fetch(new URL(`/payload${path.pathname}${path.search}`, location.origin), init);
}

export function createBrowserWasmHost(path: string) {
  const resource = path.replace(/^payload\//, '').replace(/\.br$/, '');
  const bytes = packageFetch(resource).then(async (response) => {
    if (!response.ok) throw new Error(`Missing packaged WASM: ${resource}`);
    return new Uint8Array(await response.arrayBuffer());
  });
  return {
    now: () => performance.now(),
    readWasm: () => bytes,
    instantiate: async (imports: WebAssembly.Imports) =>
      WebAssembly.instantiate(await bytes, imports),
  };
}

export function createBrowserWgpuHost(path: string, surfaces: HTMLCanvasElement[]) {
  const host = createBrowserWasmHost(path);
  const diagnostic = (
    globalThis as typeof globalThis & {
      __forgeaxGameplayGpu?: {
        project(
          native: WebAssembly.WebAssemblyInstantiatedSource,
          surfaces: HTMLCanvasElement[],
        ): { instance: { exports: WebAssembly.Exports }; module: WebAssembly.Module };
      };
    }
  ).__forgeaxGameplayGpu;
  if (diagnostic === undefined) return { ...host, surfaces };
  return {
    ...host,
    surfaces,
    async instantiate(imports: WebAssembly.Imports) {
      const native = await host.instantiate(imports);
      return diagnostic.project(native, surfaces);
    },
  };
}

// The existing benchmark forwards real DOM input to Blitz. Keep that same
// interface, and prevent UI-owned contacts from also reaching the game backend.
export function createBrowserInput(
  canvas: HTMLCanvasElement,
  ui: BlitzUiInput,
  onError: (error: unknown) => void,
) {
  const releases: (() => void)[] = [];
  const listen = <K extends keyof HTMLElementEventMap>(
    kind: K,
    action: (event: HTMLElementEventMap[K]) => boolean,
  ) => {
    const handler = (event: HTMLElementEventMap[K]) => {
      try {
        if (action(event)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      } catch (error) {
        onError(error);
      }
    };
    canvas.addEventListener(kind, handler, { capture: true, passive: false });
    releases.push(() => canvas.removeEventListener(kind, handler, { capture: true }));
  };
  const point = (event: MouseEvent) => {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  for (const [kind, phase] of [
    ['pointerdown', 'down'],
    ['pointermove', 'move'],
    ['pointerup', 'up'],
    ['pointercancel', 'cancel'],
  ] as const) {
    listen(kind, (event) => {
      if (phase === 'down') canvas.setPointerCapture(event.pointerId);
      return ui.pointer({
        phase,
        pointerId: event.pointerId,
        pointerType: event.pointerType as 'touch' | 'mouse' | 'pen',
        pressure: event.pressure,
        ...point(event),
      });
    });
  }
  listen('wheel', (event) =>
    ui.wheel({ ...point(event), deltaX: event.deltaX, deltaY: event.deltaY }),
  );
  const attached = attachBrowserInputBackend(canvas, { pointerLockAllowed: () => false });
  const backend = attached.backend;
  const detach = backend.detach;
  return {
    ...backend,
    detach() {
      for (const release of releases.splice(0).reverse()) release();
      detach();
    },
  };
}
