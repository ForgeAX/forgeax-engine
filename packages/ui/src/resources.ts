import { type CssNode, generate, parse, walk } from 'css-tree/dist/csstree.esm';
import { type DefaultTreeAdapterTypes, parseFragment, serialize } from 'parse5';
import type { UiAsset } from './asset.js';
import { type UiResult, uiError } from './errors.js';

export type UiResource =
  | { readonly mediaType: string; readonly bytes: Uint8Array }
  | { readonly mediaType: string; readonly url: string };

/** Canonical artifact key within the author's directory; never a transport URL. */
export function uiResourcePath(reference: string): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: URL boundaries reject control characters.
  if (!reference || reference.trim() !== reference || /[\\\u0000-\u0020]/u.test(reference))
    return undefined;
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(reference)) return undefined;
  try {
    const path = decodeURIComponent(reference.split(/[?#]/, 1)[0] ?? '');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Escaped controls are invalid asset paths too.
    if (!path || /[\\:%?#\u0000-\u0020]/u.test(path) || path.startsWith('/')) return undefined;
    const parts: string[] = [];
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) return undefined;
        parts.pop();
      } else parts.push(part);
    }
    return parts.join('/') || undefined;
  } catch {
    return undefined;
  }
}

export function uiResourceMimeType(path: string): string | undefined {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  return (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf',
      '.txt': 'text/plain',
    } as Record<string, string>
  )[extension];
}

function base64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const chunks: string[] = [];
  let chunk = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const word =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    chunk +=
      alphabet.charAt((word >>> 18) & 63) +
      alphabet.charAt((word >>> 12) & 63) +
      (index + 1 < bytes.length ? alphabet.charAt((word >>> 6) & 63) : '=') +
      (index + 2 < bytes.length ? alphabet.charAt(word & 63) : '=');
    if (chunk.length >= 8192) {
      chunks.push(chunk);
      chunk = '';
    }
  }
  chunks.push(chunk);
  return chunks.join('');
}

export function uiResourceFailure(
  asset: UiAsset,
  reference: string,
  reason: string,
  cause?: unknown,
): UiResult<never> {
  return {
    ok: false,
    error: {
      code: 'ui-resource-invalid',
      expected: 'a declared asset-local companion in the current UI instance',
      hint: 'Declare the companion beside the UI author source, reload its publication, and resolve it through the live UI instance.',
      detail: {
        message: `${reference}: ${reason}`,
        ...(cause === undefined ? {} : { cause }),
        guid: asset.guid,
        sourcePath: asset.sourcePath ?? '',
        reference,
        reason,
      },
    },
  };
}

/** A disposable projection of admitted companions, not another asset catalogue. */
export function createUiResourceResolver(asset: UiAsset, signal: AbortSignal) {
  const urls = new Map<string, string>();
  signal.addEventListener('abort', () => urls.clear(), { once: true });
  return (reference: string): UiResult<string> => {
    if (signal.aborted) return uiResourceFailure(asset, reference, 'instance-disposed');
    if (reference.startsWith('#')) return { ok: true, value: reference };
    const path = uiResourcePath(reference);
    if (!path) return uiResourceFailure(asset, reference, 'reference-escapes-author-base');
    const resource = asset.resources?.[path];
    if (!resource) return uiResourceFailure(asset, reference, 'companion-not-declared');
    if (
      uiResourceMimeType(path) !== resource.mediaType ||
      ('url' in resource
        ? typeof resource.url !== 'string' || !resource.url
        : !(resource.bytes instanceof Uint8Array) || resource.bytes.length > 32 * 1024 * 1024)
    ) {
      return uiResourceFailure(asset, reference, 'invalid-companion-bytes-or-media-type');
    }
    let url = urls.get(path);
    if (!url) {
      url =
        'url' in resource
          ? resource.url
          : `data:${resource.mediaType};base64,${base64(resource.bytes)}`;
      urls.set(path, url);
    }
    const hash = reference.indexOf('#');
    return { ok: true, value: url + (hash < 0 ? '' : reference.slice(hash)) };
  };
}

/** Project only parsed URL nodes. Ordinary text, CSS strings and author bytes stay unchanged. */
export function projectUiResources(
  asset: UiAsset,
  resolve: (reference: string) => UiResult<string>,
): UiResult<{ readonly html: string; readonly css: string; readonly fonts: string }> {
  let failure: UiResult<never> | undefined;
  const fonts: string[] = [];
  const url = (reference: string): string => {
    const result = resolve(reference);
    if (result.ok) return result.value;
    failure ??= result;
    return reference;
  };
  const css = (
    source: string,
    context: 'stylesheet' | 'declarationList' = 'stylesheet',
  ): string => {
    const tree = parse(source, { context, parseCustomProperty: true });
    const parents: CssNode[] = [];
    walk(tree, {
      enter(node) {
        if (node.type === 'Url' && typeof node.value === 'string') node.value = url(node.value);
        if (node.type === 'Atrule') {
          parents.push(node);
          if (node.name?.toLowerCase() === 'import')
            failure ??= uiResourceFailure(asset, '@import', 'stylesheet-import-not-declared');
        }
      },
      leave(node) {
        if (node.type !== 'Atrule') return;
        parents.pop();
        if (node.name?.toLowerCase() !== 'font-face') return;
        let sheet = generate(node);
        for (const parent of [...parents].reverse())
          sheet = `@${parent.name} ${parent.prelude ? generate(parent.prelude) : ''}{${sheet}}`;
        fonts.push(sheet);
        node.type = 'Raw';
        node.value = '';
      },
    });
    return generate(tree);
  };
  try {
    const fragment = parseFragment(asset.html);
    const visit = (parent: DefaultTreeAdapterTypes.ParentNode): void => {
      for (const child of parent.childNodes) {
        if (!('tagName' in child)) continue;
        for (const attribute of child.attrs) {
          if (['src', 'href', 'poster'].includes(attribute.name) && attribute.value)
            attribute.value = url(attribute.value);
          if (attribute.name === 'srcset')
            failure ??= uiResourceFailure(asset, attribute.value, 'srcset-not-declared');
          if (attribute.name === 'style') attribute.value = css(attribute.value, 'declarationList');
        }
        if (child.tagName === 'style') {
          for (const text of child.childNodes)
            if (text.nodeName === '#text' && 'value' in text) text.value = css(text.value);
        }
        visit(child);
        if ('content' in child) visit(child.content);
      }
    };
    visit(fragment);
    const projectedCss = css(asset.css);
    return (
      failure ?? {
        ok: true,
        value: { html: serialize(fragment), css: projectedCss, fonts: fonts.join('') },
      }
    );
  } catch (cause) {
    return uiError('invalid-asset', `invalid resource syntax: ${String(cause)}`);
  }
}
