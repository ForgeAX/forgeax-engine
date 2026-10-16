import type { UiGpuFrame } from '@forgeax/engine-types';
import { parseHtmlAuthoring } from '@forgeax/engine-ui/authoring';
import { assertUiSupport, BlitzDocument } from './dom.js';
import { BlitzInput, type BlitzUiInput } from './input.js';
import { BlitzResources, type UiResources } from './resources.js';

export type { BlitzUiInput, UiKeyInput, UiPointerInput, UiTextEditor } from './input.js';

import type { UiWasmHost } from './wasm-host.js';

export { UiDomError } from './dom.js';
export { gpuShaders } from './gpu-shaders.js';
export { UiResourceError, type UiResources } from './resources.js';
export type { UiWasmHost } from './wasm-host.js';

export interface BlitzUiOptions {
  readonly wasm: UiWasmHost;
  readonly html: string;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio?: number;
  readonly reducedMotion?: boolean;
  readonly font?: Uint8Array;
  /** CSS alias shared by the bootstrap face and companion @font-face subsets. */
  readonly fontFamily?: string;
  readonly resources?: UiResources;
  readonly onError: (error: unknown) => void;
  readonly signal?: AbortSignal;
}

export interface BlitzUi {
  readonly document: Document;
  readonly input: BlitzUiInput;
  loadResources(): Promise<void>;
  paint(timeMs: number): Uint8Array | null;
  paintGpu(timeMs: number): UiGpuFrame | null;
  resize(width: number, height: number, pixelRatio?: number): void;
  setReducedMotion(reduce: boolean): void;
  elementFromPoint(x: number, y: number): Element | null;
  getComputedStyle(element: Element): Pick<CSSStyleDeclaration, 'getPropertyValue'>;
  dispose(): void;
}

/** A document-local standard subset; it never replaces browser globals. */
export async function createBlitzUi(options: BlitzUiOptions): Promise<BlitzUi> {
  options.signal?.throwIfAborted();
  assertUiSupport(
    'createBlitzUi',
    parseHtmlAuthoring(options.html, '<ui-document>', { portableOnly: true, context: 'document' })
      .diagnostics,
  );
  const binding = await import('../pkg/ui-native.mjs');
  await binding.initialize(options.wasm);
  options.signal?.throwIfAborted();
  const core = binding.UiDocument.with_resources(
    options.html,
    options.width,
    options.height,
    options.pixelRatio ?? 1,
    options.font ?? new Uint8Array(),
    options.fontFamily,
    options.resources?.baseUrl ?? 'https://forgeax-ui.invalid/',
  );
  const resources = new BlitzResources(core, options.resources);
  let dom: BlitzDocument;
  try {
    if (options.reducedMotion !== undefined) core.set_reduced_motion(options.reducedMotion);
    dom = new BlitzDocument(core, options.onError);
  } catch (cause) {
    core.free();
    throw cause;
  }
  const input = new BlitzInput(dom);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener('abort', dispose);
    const failures: unknown[] = [];
    for (const release of [() => resources.dispose(), () => input.dispose(), () => dom.dispose()]) {
      try {
        release();
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'UI disposal failed');
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  try {
    await resources.load();
    options.signal?.throwIfAborted();
  } catch (cause) {
    dispose();
    throw cause;
  }
  return {
    input,
    loadResources: () => resources.load(),
    // Native browser objects remain the browser implementation. This cast is
    // confined to the adapter; the supported portable subset is documented.
    document: dom.root as unknown as Document,
    paint(timeMs: number): Uint8Array | null {
      dom.read('paint', (kernel) => kernel.set_time(timeMs));
      resources.start(options.onError);
      dom.time = timeMs;
      dom.collect();
      const bytes = dom.read('paint', (kernel) => kernel.paint());
      return bytes.length === 0 ? null : bytes;
    },
    paintGpu(timeMs: number): UiGpuFrame | null {
      dom.read('paintGpu', (kernel) => kernel.set_time(timeMs));
      resources.start(options.onError);
      dom.time = timeMs;
      dom.collect();
      return dom.read('paintGpu', (kernel) => kernel.paint_gpu()) as UiGpuFrame | null;
    },
    setReducedMotion(reduce: boolean): void {
      dom.read('setReducedMotion', (kernel) => kernel.set_reduced_motion(reduce));
    },
    resize(width: number, height: number, pixelRatio = 1): void {
      dom.read('resize', (kernel) => kernel.set_viewport(width, height, pixelRatio));
    },
    elementFromPoint(x: number, y: number): Element | null {
      const id = dom.read('elementFromPoint', (kernel) => kernel.hit(x, y));
      return id === 0n ? null : (dom.wrap(id) as unknown as Element);
    },
    getComputedStyle(element: Element): Pick<CSSStyleDeclaration, 'getPropertyValue'> {
      const node = element as unknown as { readonly realm: BlitzDocument; readonly coreId: bigint };
      if (node.realm !== dom) throw new TypeError('Element belongs to a different UI document');
      return {
        getPropertyValue: (property) =>
          dom.read('getComputedStyle', (kernel) => kernel.computed_style(node.coreId, property)),
      };
    },
    dispose,
  };
}
