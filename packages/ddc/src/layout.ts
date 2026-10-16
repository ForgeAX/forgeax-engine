import { isAbsolute, normalize } from 'node:path';

export const DDC_LAYOUT_VERSION = 'v2' as const;

export interface DdcBuildOptions {
  readonly buildCacheRoot: string;
}

export interface DdcServeOptions extends DdcBuildOptions {
  readonly projectDdcRoot?: string;
}

export interface DdcBuildLayout {
  readonly objects: string;
  readonly staging: string;
}

export interface DdcProjectLayout {
  readonly root: string;
  readonly scope: string;
  readonly heads: string;
  readonly generations: string;
  readonly leases: string;
  readonly staging: string;
}

export interface DdcLayout {
  readonly version: typeof DDC_LAYOUT_VERSION;
  readonly buildCacheRoot: string;
  readonly projectDdcRoot: string;
  readonly build: DdcBuildLayout;
  readonly project: DdcProjectLayout;
}

export interface DdcBuildLayoutResult {
  readonly ok: true;
  readonly value: DdcBuildLayout;
}

export interface DdcLayoutError {
  readonly code: 'ddc-project-root-required' | 'ddc-root-absolute-required';
  readonly detail: string;
  readonly hint: string;
  readonly expected: string;
  readonly actual?: string;
}

export interface DdcLayoutResult {
  readonly ok: true;
  readonly value: DdcLayout;
}

export interface DdcLayoutFailure {
  readonly ok: false;
  readonly error: DdcLayoutError;
}

type ClosedLayoutResult = DdcLayoutResult | DdcLayoutFailure;

function rootOrError(root: string, name: string): string | DdcLayoutError {
  if (!isAbsolute(root)) {
    return {
      code: 'ddc-root-absolute-required',
      detail: `${name} must be an absolute injected path`,
      hint: `inject the canonical ${name} from the host root policy`,
      expected: 'an absolute filesystem path',
      actual: root,
    };
  }
  const normalized = normalize(root);
  return normalized.replace(/[\\/]+$/, '') || normalized;
}

function buildLayout(root: string): DdcBuildLayout {
  return { objects: `${root}/objects`, staging: `${root}/staging` };
}

function projectLayout(root: string): DdcProjectLayout {
  return {
    root,
    scope: `${root}/scope.json`,
    heads: `${root}/heads`,
    generations: `${root}/generations`,
    leases: `${root}/leases`,
    staging: `${root}/staging`,
  };
}

export function resolveBuildDdcLayout(
  options: DdcBuildOptions,
): DdcBuildLayoutResult | DdcLayoutFailure {
  const root = rootOrError(options.buildCacheRoot, 'buildCacheRoot');
  return typeof root === 'string'
    ? { ok: true, value: buildLayout(root) }
    : { ok: false, error: root };
}

export function resolveDdcLayout(options: DdcServeOptions): ClosedLayoutResult {
  const buildRoot = rootOrError(options.buildCacheRoot, 'buildCacheRoot');
  if (typeof buildRoot !== 'string') return { ok: false, error: buildRoot };
  if (options.projectDdcRoot === undefined || options.projectDdcRoot.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: 'ddc-project-root-required',
        detail: 'serve and publication require an explicitly injected projectDdcRoot',
        hint: 'canonicalize the game directory in the host and inject its .forgeax/ddc/v2 root',
        expected: 'projectDdcRoot',
      },
    };
  }
  const projectRoot = rootOrError(options.projectDdcRoot, 'projectDdcRoot');
  if (typeof projectRoot !== 'string') return { ok: false, error: projectRoot };
  return {
    ok: true,
    value: {
      version: DDC_LAYOUT_VERSION,
      buildCacheRoot: buildRoot,
      projectDdcRoot: projectRoot,
      build: buildLayout(buildRoot),
      project: projectLayout(projectRoot),
    },
  };
}

export function isDdcLayout(value: unknown): value is DdcLayout {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { readonly version?: unknown }).version === DDC_LAYOUT_VERSION
  );
}
