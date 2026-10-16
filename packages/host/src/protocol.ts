/** Host transports code/config projections; domain roots resolve them into native Fibers. */
declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    hostAssembly:
      | import('./backend.js').BackendAssemblyAuthority
      | import('./frontend.js').FrontendAssemblyState;
    hostTransport:
      | import('./transport.js').HostTransportServer
      | import('./transport.js').HostTransportClient;
  }
}

export const HOST_ASSEMBLY_SCHEMA_VERSION = 2 as const;
export type HostAssemblySchemaVersion = typeof HOST_ASSEMBLY_SCHEMA_VERSION;

export interface HostRootDescriptor {
  readonly program: string;
  readonly codeRevision: string;
  readonly config?: unknown;
  /** Opaque domain identity, such as a plugin asset GUID. */
  readonly source?: string;
}
export interface HostAssembly {
  readonly schemaVersion: HostAssemblySchemaVersion;
  readonly revision: string;
  readonly sessionGeneration: number;
  readonly root?: HostRootDescriptor;
  readonly config?: unknown;
}
export interface HostAssemblyInput {
  readonly sessionGeneration?: number;
  readonly root?: HostRootDescriptor;
  readonly config?: unknown;
}
/** Legacy wire field name retained as a projection of actual native Fibers. */
export interface HostActivationEntry {
  readonly entryId: string;
  readonly fiberState: string;
  readonly failure?: HostErrorSummary;
}
export interface HostErrorSummary {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;
}
export interface HostActivationReport {
  readonly state: 'created' | 'loading' | 'active' | 'failed' | 'disposed';
  readonly revision: string;
  readonly sessionGeneration: number;
  readonly entries?: readonly HostActivationEntry[];
  readonly error?: HostErrorSummary;
}
export interface HostAssemblyErrorDetailByCode {
  'host-assembly-activation-timeout': { readonly milliseconds: number };
  'host-assembly-cleanup-timeout': { readonly milliseconds: number };
  'host-assembly-invalid': { readonly reason: string };
  'host-assembly-revision-mismatch': { readonly actual: string; readonly expected: string };
  'host-assembly-module-missing': { readonly name: string };
  'host-assembly-module-version-mismatch': {
    readonly name: string;
    readonly actual: string;
    readonly expected: string;
  };
  'host-assembly-reload-required': {
    readonly module: string;
    readonly actual: string;
    readonly expected: string;
  };
  'host-assembly-service-unavailable': { readonly service: string };
  'host-assembly-stale-request': { readonly service: string; readonly generation: number };
  'host-assembly-request-aborted': { readonly service: string };
  'host-transport-failure': {
    readonly service: string;
    readonly reason: string;
    /** Business error code received from a remote host service, if any. */
    readonly remoteCode?: string;
  };
  'host-assembly-not-ready': HostActivationEntry;
}

export type HostAssemblyErrorCode = keyof HostAssemblyErrorDetailByCode;

export class HostAssemblyError<
  C extends HostAssemblyErrorCode = HostAssemblyErrorCode,
> extends Error {
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: HostAssemblyErrorDetailByCode[C];

  constructor(code: C, expected: string, hint: string, detail: HostAssemblyErrorDetailByCode[C]) {
    super(`${code}: ${expected}`);
    this.name = 'HostAssemblyError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

export type HostAssemblyResult = { readonly ok: true; readonly value: HostAssembly };
export type HostAssemblyFailure = { readonly ok: false; readonly error: HostAssemblyError };
export type HostAssemblyValidation = HostAssemblyResult | HostAssemblyFailure;

export function canonicalHostJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalHostJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalHostJson(item)}`)
    .join(',')}}`;
}
export function hostRevision(value: unknown): string {
  let hash = 2166136261;
  for (const char of canonicalHostJson(value)) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
function invalid(reason: string): HostAssemblyError {
  return new HostAssemblyError(
    'host-assembly-invalid',
    'a version 2 root program/config projection',
    'rebuild both hosts with the same assembly schema',
    { reason },
  );
}
function json(value: unknown, seen = new Set<object>()): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return;
  if (typeof value !== 'object' || seen.has(value))
    throw invalid('configuration must be a finite JSON tree');
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw invalid('configuration must contain plain objects');
  }
  if (
    Array.isArray(value) &&
    (Object.keys(value).length !== value.length ||
      Object.keys(value).some((key, index) => key !== String(index)))
  ) {
    throw invalid('configuration arrays must be dense and have no extra properties');
  }
  seen.add(value);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!descriptor.enumerable || !('value' in descriptor))
      throw invalid('configuration contains hidden fields or accessors');
    json(descriptor.value, seen);
  }
  if (Object.getOwnPropertySymbols(value).length) throw invalid('configuration contains symbols');
  seen.delete(value);
}
export function createHostAssembly(input: HostAssemblyInput = {}): HostAssembly {
  const payload = {
    schemaVersion: HOST_ASSEMBLY_SCHEMA_VERSION,
    sessionGeneration: input.sessionGeneration ?? 1,
    ...(input.root === undefined ? {} : { root: input.root }),
    ...(input.config === undefined ? {} : { config: input.config }),
  };
  json(payload);
  const assembly = { ...structuredClone(payload), revision: hostRevision(payload) };
  const checked = validateHostAssembly(assembly);
  if (!checked.ok) throw checked.error;
  return checked.value;
}
export function validateHostAssembly(value: unknown): HostAssemblyValidation {
  try {
    json(value);
    if (typeof value !== 'object' || value === null) throw invalid('assembly must be an object');
    const assembly = value as HostAssembly;
    if (
      Object.keys(assembly).some(
        (key) =>
          !['schemaVersion', 'revision', 'sessionGeneration', 'root', 'config'].includes(key),
      )
    ) {
      throw invalid('unknown assembly fields');
    }
    if (
      assembly.schemaVersion !== 2 ||
      !Number.isSafeInteger(assembly.sessionGeneration) ||
      assembly.sessionGeneration < 1
    ) {
      throw invalid('invalid schema or session generation');
    }
    const root = assembly.root;
    if (
      root !== undefined &&
      (root === null ||
        typeof root !== 'object' ||
        typeof root.program !== 'string' ||
        !root.program ||
        typeof root.codeRevision !== 'string' ||
        !root.codeRevision ||
        (root.source !== undefined && typeof root.source !== 'string') ||
        Object.keys(root).some(
          (key) => !['program', 'codeRevision', 'config', 'source'].includes(key),
        ))
    ) {
      throw invalid('invalid root descriptor');
    }
    const { revision, ...payload } = assembly;
    const expected = hostRevision(payload);
    if (revision !== expected)
      throw new HostAssemblyError(
        'host-assembly-revision-mismatch',
        'assembly revision to match its root projection',
        'discard the stale assembly',
        { actual: revision, expected },
      );
    const snapshot = structuredClone(assembly);
    function freeze(value: unknown): void {
      if (value === null || typeof value !== 'object') return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    freeze(snapshot);
    return { ok: true, value: snapshot };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof HostAssemblyError ? cause : invalid(String(cause)),
    };
  }
}
