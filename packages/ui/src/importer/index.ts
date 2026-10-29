import {
  type ImportContext,
  ImportError,
  type ImportedArtifactBody,
  type ImporterCapabilities,
  type ImportResult,
} from '@forgeax/engine-types';
import type { UiAsset } from '../asset.js';
import { classifyUiAuthoring, validateUiAuthoring } from '../authoring/index.js';
import { isUiBrowserExtensions } from '../browser-extensions.js';
import { isUiLocalization, type UiLocalization } from '../localization/resources.js';
import { uiResourceMimeType, uiResourcePath } from '../resources.js';

export type UiSource = Pick<
  UiAsset,
  'guid' | 'html' | 'css' | 'browserExtensions' | 'localization'
>;

function importFailure(reason: string): ImportResult<UiAsset> {
  return {
    ok: false,
    error: new ImportError({
      code: 'import-internal-error',
      expected: 'a valid UI author source and readable local companions',
      hint: 'Fix the UI source or add the referenced companion file.',
      detail: { reason },
    }),
  };
}

function validationFailure(
  diagnostics: readonly import('@forgeax/engine-types').ImportDiagnostic[],
): ImportResult<UiAsset> {
  return {
    ok: false,
    error: new ImportError({
      code: 'source-validation-failed',
      expected: 'HTML, CSS, and companions within the UiAuthoringProfile',
      hint: 'Inspect err.detail.diagnostics and fix each source-located error.',
      detail: { diagnostics },
    }),
  };
}

export function importUiSource(source: UiSource): ImportResult<UiAsset> {
  if (source.browserExtensions !== undefined && !isUiBrowserExtensions(source.browserExtensions))
    return importFailure('invalid browserExtensions declaration');
  if (source.localization !== undefined && !isUiLocalization(source.localization))
    return importFailure('invalid localization resources');
  const classification = classifyUiAuthoring({
    sourcePath: `${source.guid}.ui.html`,
    html: source.html,
    css: source.css,
    browserExtensions: source.browserExtensions ?? [],
  });
  if (classification.blocking) return validationFailure(classification.diagnostics);
  return {
    ok: true,
    value: {
      assets: [
        {
          guid: source.guid,
          kind: 'ui',
          payload: {
            guid: source.guid,
            html: source.html,
            css: source.css,
            ...(source.browserExtensions === undefined
              ? {}
              : { browserExtensions: source.browserExtensions }),
            ...(source.localization === undefined ? {} : { localization: source.localization }),
          },
          refs: [],
          artifacts: {},
        },
      ],
      sourceDependencies: [],
    },
  };
}
export function createUiImporter(): {
  readonly key: 'ui';
  readonly capabilities: ImporterCapabilities;
  import(context: ImportContext): Promise<ImportResult<UiAsset>>;
} {
  return {
    key: 'ui',
    capabilities: {
      sourceFormats: [
        { extensions: ['.ui.html'], kind: 'ui', sourceKey: 'ui:document', importSettings: {} },
      ],
    },
    async import(context) {
      const source = await context.readSource();
      if (!source.ok) return importFailure(`unable to read UI source: ${String(source.error)}`);
      const htmlText = new TextDecoder().decode(source.value);
      const guid = context.subAssets[0]?.guid;
      if (guid === undefined) return importFailure('meta.subAssets must declare one UI GUID');
      const fileName = context.source.slice(
        Math.max(context.source.lastIndexOf('/'), context.source.lastIndexOf('\\')) + 1,
      );
      const cssPath = fileName.replace(/\.ui\.html$/i, '.ui.css');
      const cssRead = await context.readSibling(cssPath);
      if (!cssRead.ok) return importFailure(`missing UI stylesheet companion: ${cssPath}`);
      const cssText = new TextDecoder().decode(cssRead.value);
      const browserExtensions = context.importSettings.browserExtensions;
      if (browserExtensions !== undefined && !isUiBrowserExtensions(browserExtensions))
        return importFailure(
          'importSettings.browserExtensions must contain unique supported browser extension names',
        );
      const companions = new Map<string, Uint8Array>();
      const validation = await validateUiAuthoring({
        sourcePath: context.source,
        html: htmlText,
        css: cssText,
        browserExtensions: browserExtensions ?? [],
        readCompanion: async (path) => {
          const read = await context.readSibling(path);
          if (read.ok) companions.set(path, read.value);
          return read.ok
            ? { ok: true as const }
            : {
                ok: false as const,
                path,
                reason:
                  ('reason' in read.error.detail ? read.error.detail.reason : undefined) ??
                  read.error.message,
              };
        },
      });
      if (!validation.ok) {
        if ('diagnostics' in validation.error.detail)
          return validationFailure(validation.error.detail.diagnostics);
        return importFailure(validation.error.message);
      }
      let localization: UiLocalization | undefined;
      const localizationPath = context.importSettings.localization;
      if (localizationPath !== undefined) {
        const path =
          typeof localizationPath === 'string' ? uiResourcePath(localizationPath) : undefined;
        if (!path || path !== localizationPath || /[:\\]/.test(path) || !path.endsWith('.json'))
          return importFailure('importSettings.localization must name a relative JSON companion');
        const read = await context.readSibling(path);
        if (!read.ok) return importFailure(`missing UI localization companion: ${path}`);
        try {
          if (read.value.byteLength > 1_048_576) throw new Error('resource exceeds 1 MiB');
          const parsed: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(read.value),
          );
          if (!isUiLocalization(parsed))
            throw new Error(
              'expected string-valued i18next resources with fallbackLng and defaultNS',
            );
          localization = parsed;
        } catch (error) {
          return validationFailure([
            {
              code: 'ui-localization-invalid',
              severity: 'error',
              sourcePath: path,
              sourceRange: { start: 0, end: 1, line: 1, column: 1 },
              rule: 'ui-localization-json',
              expected: 'valid i18next JSON resources, at most 1 MiB and 16 levels',
              actual: String(error),
              hint: 'Repair this JSON companion, then reimport the owning UI asset.',
            },
          ]);
        }
      }
      const declared = context.importSettings.resources ?? [];
      if (
        !Array.isArray(declared) ||
        !declared.every((path) => typeof path === 'string' && uiResourcePath(path) === path)
      )
        return importFailure(
          'importSettings.resources must contain canonical author-relative companion paths',
        );
      for (const path of declared) {
        if (companions.has(path)) continue;
        const read = await context.readSibling(path);
        if (!read.ok) return importFailure(`missing declared UI companion: ${path}`);
        companions.set(path, read.value);
      }
      const unique = [...new Set([...validation.value.references, ...declared])];
      const artifacts: Record<string, ImportedArtifactBody> = {};
      const dependencies = [
        context.source,
        cssPath,
        ...(typeof localizationPath === 'string' ? [localizationPath] : []),
      ];
      for (const reference of unique) {
        const path = uiResourcePath(reference);
        if (path === undefined) return importFailure(`unsafe UI companion URL: ${reference}`);
        const bytes = companions.get(path);
        if (bytes === undefined) return importFailure(`missing UI companion: ${path}`);
        dependencies.push(path);
        const mediaType = uiResourceMimeType(path);
        if (!mediaType) return importFailure(`unsupported UI companion media type: ${path}`);
        artifacts[path] = { delivery: 'stream', mediaType, bytes };
      }
      return {
        ok: true,
        value: {
          assets: [
            {
              guid,
              kind: 'ui',
              payload: {
                guid,
                html: htmlText,
                css: cssText,
                ...(browserExtensions === undefined ? {} : { browserExtensions }),
                // Pack keys are relative to this author's directory, not the
                // import host's filesystem or project root.
                sourcePath: fileName,
                ...(localization === undefined ? {} : { localization }),
              },
              refs: [],
              artifacts,
            },
          ],
          sourceDependencies: dependencies,
        },
      };
    },
  };
}
