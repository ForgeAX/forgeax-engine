import type { UiAsset, UiInstance } from './asset.js';
import { parseCssAuthoring } from './authoring/css.js';
import { parseHtmlAuthoring } from './authoring/html.js';
import { isUiBrowserExtensions } from './browser-extensions.js';
import type { UiResult } from './errors.js';
import { uiError } from './errors.js';
import { createUiResourceResolver, projectUiResources } from './resources.js';

export interface MountOptions {
  readonly root: HTMLElement;
  readonly layer: number;
  readonly onAction?: (name: string, event: Event) => void;
}

export function mountUi(asset: UiAsset, options: MountOptions): UiResult<UiInstance> {
  if (typeof AbortController === 'undefined')
    return uiError('invalid-environment', 'AbortController is unavailable');
  if (options.root?.nodeType !== 1 || !options.root.ownerDocument || !options.root.style)
    return uiError('invalid-root', 'root is not an HTMLElement');
  const document = options.root.ownerDocument;
  if (!Number.isInteger(options.layer) || options.layer < 0)
    return uiError('invalid-layer', 'layer must be non-negative');
  if (!asset?.guid || typeof asset.html !== 'string' || typeof asset.css !== 'string')
    return uiError('invalid-asset', 'asset payload is malformed');
  if (asset.browserExtensions !== undefined && !isUiBrowserExtensions(asset.browserExtensions))
    return uiError(
      'invalid-asset',
      'browserExtensions must contain unique supported browser extension names',
    );
  const sourcePath = asset.sourcePath ?? asset.guid;
  const sourceOptions = { portableOnly: true, browserExtensions: asset.browserExtensions ?? [] };
  const diagnostics = [
    ...parseHtmlAuthoring(asset.html, sourcePath, sourceOptions).diagnostics,
    ...parseCssAuthoring(asset.css, sourcePath.replace(/\.html?$/i, '.css'), sourceOptions)
      .diagnostics,
  ];
  if (diagnostics.some((entry) => entry.severity === 'error'))
    return {
      ok: false,
      error: {
        code: 'invalid-asset',
        expected: 'portable HTML and CSS or explicitly declared browser CSS',
        hint: 'Fix the reported source diagnostics before mounting.',
        detail: { message: 'Unsupported or invalid UI source', asset: asset.guid, diagnostics },
      },
    };
  const cssSupport = (
    document.defaultView as unknown as {
      CSS?: { supports(property: string, value?: string): boolean };
    } | null
  )?.CSS;
  const unavailable =
    asset.browserExtensions?.filter((extension) =>
      extension === 'css'
        ? !cssSupport?.supports('selector(:host)') || !cssSupport.supports('display', 'grid')
        : !cssSupport?.supports(extension, 'blur(1px)'),
    ) ?? [];
  if (unavailable.length) {
    const unsupported = [
      ...parseHtmlAuthoring(asset.html, sourcePath, { portableOnly: true }).diagnostics,
      ...parseCssAuthoring(asset.css, sourcePath.replace(/\.html?$/i, '.css'), {
        portableOnly: true,
      }).diagnostics,
    ];
    return {
      ok: false,
      error: {
        code: 'invalid-environment',
        expected: 'a browser document supporting the declared UI extensions',
        hint: 'Open this browser-specific UiAsset in a browser that supports its declared extensions.',
        detail: {
          message: `Unavailable browser UI extensions: ${unavailable.join(', ')}`,
          environment: 'receiving UI document',
          diagnostics: unavailable.map((extension) => {
            const location =
              unsupported.find((entry) => entry.actual === extension) ??
              (extension === 'css' ? unsupported[0] : undefined);
            return {
              code: 'ui-browser-extension-unavailable',
              severity: 'error' as const,
              sourcePath: location?.sourcePath ?? sourcePath,
              sourceRange: location?.sourceRange ?? {
                start: 0,
                end: 1,
                line: 1,
                column: 1,
              },
              rule: 'ui-browser-extension',
              expected: `browser support for ${extension}`,
              actual: extension,
              hint: 'This declared browser extension is unavailable in the receiving document.',
            };
          }),
        },
      },
    };
  }
  const controller = new AbortController();
  const resourceUrl = createUiResourceResolver(asset, controller.signal);
  const projected = projectUiResources(asset, resourceUrl);
  if (!projected.ok) {
    controller.abort();
    return projected;
  }
  const fontStyle = projected.value.fonts ? document.createElement('style') : undefined;
  if (fontStyle) fontStyle.textContent = projected.value.fonts;
  const host = document.createElement('div');
  host.dataset.uiAsset = asset.guid;
  if (asset.sourcePath) host.dataset.uiSource = asset.sourcePath;
  host.style.position = 'absolute';
  host.style.inset = '0';
  host.style.zIndex = String(options.layer);
  host.style.pointerEvents = 'none';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  // A number control must expose its adjustment affordance before focus,
  // including on touch Hosts. Native controls already own that default; this
  // capability-gated browser UA correction preserves the same mounted contract.
  const controlDefaults = cssSupport?.supports('selector(input::-webkit-inner-spin-button)')
    ? ':where(input[type="number" i]:not(:disabled):not([readonly]))::-webkit-inner-spin-button{opacity:1}\n'
    : '';
  style.textContent = controlDefaults + projected.value.css;
  shadow.append(style);
  const content = document.createElement('div');
  content.innerHTML = projected.value.html;
  content.style.height = '100%';
  content.style.pointerEvents = 'none';
  shadow.append(content);
  const onClick = (event: Event) => {
    const element = event.target as Element | null;
    const target =
      element?.nodeType === 1 ? element.closest<HTMLElement>('[data-ui-action]') : null;
    const action = target?.dataset.uiAction;
    if (action) options.onAction?.(action, event);
  };
  shadow.addEventListener('click', onClick, { signal: controller.signal });
  options.root.append(host);
  if (fontStyle) document.head.append(fontStyle);
  let disposed = false;
  return {
    ok: true,
    value: {
      host,
      signal: controller.signal,
      resourceUrl,
      dispose() {
        if (disposed) return;
        disposed = true;
        controller.abort();
        host.remove();
        fontStyle?.remove();
      },
    },
  };
}
