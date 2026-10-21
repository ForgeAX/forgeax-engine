import {
  type AssetDecoderContribution,
  type AssetDecoderInput,
  type AssetKind,
  type AssetLoadError,
  err,
  ok,
  type Result,
} from '@forgeax/engine-types';
import type { UiAsset } from './asset.js';
import { isUiBrowserExtensions } from './browser-extensions.js';
import type { UiResult } from './errors.js';
import { uiError } from './errors.js';
import { isUiLocalization } from './localization/resources.js';
import {
  type UiResource,
  uiResourceFailure,
  uiResourceMimeType,
  uiResourcePath,
} from './resources.js';

export interface UiLoaderInput {
  readonly guid: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly refs: readonly string[];
  readonly streams?: Readonly<
    Record<string, { readonly descriptor: { readonly mediaType: string }; readonly url: string }>
  >;
  readonly artifacts: Readonly<
    Record<
      string,
      { readonly descriptor: { readonly mediaType: string }; readonly bytes: Uint8Array }
    >
  >;
}

export interface UiLoader {
  /** Payloads without companions, or the existing verified Pack loader input. */
  load(payload: unknown): UiResult<UiAsset>;
  /** Consume companions through the publication-scoped AssetRegistry reader. */
  decode(input: AssetDecoderInput<UiAsset>): Promise<Result<UiAsset, AssetLoadError>>;
}

export function createUiLoader(): UiLoader {
  const load = (value: unknown): UiResult<UiAsset> => {
    let payload = value;
    let packed: UiLoaderInput | undefined;
    if (payload && typeof payload === 'object' && 'payload' in payload) {
      packed = payload as UiLoaderInput;
      if (packed.kind !== 'ui' || !packed.payload || typeof packed.payload !== 'object')
        return uiError('invalid-asset', 'Pack v2 input must contain a UI payload');
      payload = packed.payload;
    }
    if (!payload || typeof payload !== 'object')
      return uiError('invalid-asset', 'payload is not an object');
    const candidate = payload as Record<string, unknown>;
    if (
      typeof candidate.guid !== 'string' ||
      !candidate.guid ||
      typeof candidate.html !== 'string' ||
      typeof candidate.css !== 'string'
    )
      return uiError('invalid-asset', 'guid, html, and css are required strings');
    if (packed && packed.guid !== candidate.guid)
      return uiError('invalid-asset', 'payload and envelope GUID must match');
    if (
      candidate.browserExtensions !== undefined &&
      !isUiBrowserExtensions(candidate.browserExtensions)
    )
      return uiError(
        'invalid-asset',
        'browserExtensions must contain unique supported browser extension names',
      );
    if (
      candidate.sourcePath !== undefined &&
      (typeof candidate.sourcePath !== 'string' || !uiResourcePath(candidate.sourcePath))
    )
      return uiError('invalid-asset', 'sourcePath must be an author-relative file path');
    if (candidate.localization !== undefined && !isUiLocalization(candidate.localization))
      return uiError(
        'invalid-asset',
        'localization must contain i18next JSON resources and a valid fallback namespace',
      );
    // Serialized source never supplies decoded resources: only the verified
    // envelope reader can introduce companion bytes or URLs into a loaded UiAsset.
    const resources: Record<string, UiResource> = {};
    for (const [key, artifact] of [
      ...Object.entries(packed?.artifacts ?? {}),
      ...Object.entries(packed?.streams ?? {}),
    ]) {
      if (
        uiResourcePath(key) !== key ||
        !artifact.descriptor ||
        ('url' in artifact
          ? typeof artifact.url !== 'string' || !artifact.url
          : !(artifact.bytes instanceof Uint8Array)) ||
        uiResourceMimeType(key) !== artifact.descriptor.mediaType
      )
        return uiError('invalid-asset', `invalid verified UI companion: ${key}`);
      resources[key] = {
        mediaType: artifact.descriptor.mediaType,
        ...('url' in artifact ? { url: artifact.url } : { bytes: artifact.bytes }),
      };
    }
    if (Object.keys(resources).length && !candidate.sourcePath)
      return uiError('invalid-asset', 'UI companions require the author sourcePath');
    try {
      return {
        ok: true,
        value: {
          guid: candidate.guid,
          html: candidate.html,
          css: candidate.css,
          ...(candidate.browserExtensions === undefined
            ? {}
            : { browserExtensions: [...candidate.browserExtensions] }),
          ...(candidate.sourcePath === undefined
            ? {}
            : { sourcePath: candidate.sourcePath as string }),
          ...(Object.keys(resources).length ? { resources } : {}),
          ...(candidate.localization === undefined
            ? {}
            : {
                localization: {
                  fallbackLng: candidate.localization.fallbackLng,
                  defaultNS: candidate.localization.defaultNS,
                  resources: structuredClone(candidate.localization.resources),
                },
              }),
        },
      };
    } catch {
      return uiError('invalid-asset', 'localization resources must be cloneable JSON data');
    }
  };
  return {
    load,
    async decode(input) {
      const { envelope, signal } = input;
      const asset = load({
        guid: envelope.guid,
        kind: envelope.kind,
        payload: envelope.payload,
        refs: envelope.refs,
        artifacts: {},
      });
      const project = (result: UiResult<UiAsset>): Result<UiAsset, AssetLoadError> =>
        result.ok
          ? ok(result.value)
          : err({
              code: 'asset-package-invalid',
              expected: result.error.expected,
              hint: result.error.hint,
              detail: { guid: envelope.guid, reason: JSON.stringify(result.error) },
            });
      const cancelled = (): Result<UiAsset, AssetLoadError> =>
        err({
          code: 'asset-load-cancelled',
          expected: 'the current UI publication to remain active',
          hint: 'Load the current publication with a live signal.',
          detail: { guid: envelope.guid },
        });
      if (!asset.ok) return project(asset);
      const resources: Record<string, UiResource> = {};
      for (const [key, descriptor] of Object.entries(envelope.artifacts)) {
        if (signal.aborted) return cancelled();
        const mediaType = descriptor.mediaType;
        if (uiResourcePath(key) !== key || uiResourceMimeType(key) !== mediaType)
          return project(
            uiResourceFailure(asset.value, key, 'invalid-companion-key-or-media-type'),
          );
        const url =
          descriptor.delivery === 'stream' ? input.artifacts.locate?.(descriptor) : undefined;
        if (url !== undefined) {
          if (typeof url !== 'string' || !url)
            return project(uiResourceFailure(asset.value, key, 'invalid-companion-url'));
          resources[key] = { mediaType, url };
          continue;
        }
        const read = await input.artifacts.read(descriptor);
        if (signal.aborted) return cancelled();
        if (!read.ok) return read;
        if (!(read.value instanceof Uint8Array))
          return project(uiResourceFailure(asset.value, key, 'invalid-companion-bytes'));
        resources[key] = { mediaType, bytes: read.value };
      }
      if (signal.aborted) return cancelled();
      const hasResources = Object.keys(resources).length > 0;
      if (hasResources && !asset.value.sourcePath)
        return project(uiError('invalid-asset', 'UI companions require the author sourcePath'));
      return ok({ ...asset.value, ...(hasResources ? { resources } : {}) });
    },
  };
}

export const uiAssetContribution: AssetDecoderContribution<UiAsset, 'ui'> = {
  kind: { kind: 'ui' } as AssetKind<UiAsset, 'ui'>,
  consumer: 'UI',
  decoder: createUiLoader(),
};
