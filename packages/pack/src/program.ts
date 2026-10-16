import { err, ok, type Result } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { type Node, parse } from 'acorn';

export interface PackProgramSource {
  readonly entry: string;
  readonly export: string;
  readonly modules: Readonly<Record<string, string>>;
  /** Exact identities supplied by the executing host, never bundled substitutes. */
  readonly imports?: Readonly<Record<string, string>>;
}

export interface PackProgram extends PackProgramSource {
  readonly digest: string;
}

export interface PackProgramImport {
  readonly identity: string;
  readonly url: string;
}

// Hosts own supported module transports. Native schemes must retain the same identity checks.
const MODULE_URL = /^[a-z][a-z0-9+.-]*:\S/i;

/** Host publication keeps native ESM URLs alive for the consuming realm. */
export interface PackProgramHost {
  publish(
    program: PackProgram,
    imports: Readonly<Record<string, PackProgramImport>>,
  ): Promise<string>;
  /** Optional native package loader; receives only a verified, published module URL. */
  importModule?(url: string): Promise<Readonly<Record<string, unknown>>>;
}

/** A realm host borrows the executing Engine's actual module namespaces. */
export type PackProgramHostFactory = (
  imports: Readonly<Record<string, PackProgramImport>>,
  loadImport: (specifier: string) => Promise<Readonly<Record<string, unknown>>>,
) => PackProgramHost;

/** Immutable code-package modules retain ordinary admission and generation semantics. */
export function createStaticPackProgramHost(
  entries: readonly {
    readonly modules: Readonly<Record<string, string>>;
    readonly load: (entry: string) => Promise<Readonly<Record<string, unknown>>>;
  }[],
  imports: Readonly<Record<string, PackProgramImport>>,
): PackProgramHost {
  const published = new Map<string, () => Promise<Readonly<Record<string, unknown>>>>();
  return {
    async publish(program, bindings) {
      const identity = packProgramModuleIdentity(program, bindings).unwrap();
      for (const name of Object.keys(program.imports ?? {})) {
        if (
          bindings[name]?.identity !== imports[name]?.identity ||
          bindings[name]?.url !== imports[name]?.url
        )
          throw new TypeError(`Static program import differs from its published package: ${name}`);
      }
      const selected = entries.find((candidate) => {
        const names = Object.keys(program.modules);
        return (
          names.length === Object.keys(candidate.modules).length &&
          names.every((name) => candidate.modules[name] === program.modules[name])
        );
      });
      if (!selected) throw new TypeError('Program modules are not in the published code package');
      const url = `https://forgeax.package/programs/${identity}/${program.entry}`;
      published.set(url, () => selected.load(program.entry));
      return url;
    },
    async importModule(url) {
      const load = published.get(url);
      if (!load) throw new TypeError('Program module has not been admitted');
      return load();
    },
  };
}

/** Native module identity depends on the graph and its bindings, not the selected export. */
export function packProgramModuleIdentity(
  value: PackProgram,
  hostImports: Readonly<Record<string, PackProgramImport>> = {},
): Result<string, PackProgramError> {
  const verified = verifyPackProgram(value);
  if (!verified.ok) return verified;
  const program = verified.value;
  const bindings: string[][] = [];
  for (const [specifier, identity] of Object.entries(program.imports ?? {})) {
    const supplied = hostImports[specifier];
    if (!supplied || supplied.identity !== identity || !MODULE_URL.test(supplied.url))
      return err(
        failure(
          'pack-program-dependency-unavailable',
          specifier,
          'host import identity or module URL is unavailable',
        ),
      );
    bindings.push([specifier, identity, supplied.url]);
  }
  return ok(
    `sha256:${bytesToHex(
      sha256(new TextEncoder().encode(JSON.stringify([program.modules, bindings]))),
    )}`,
  );
}

/** Link a complete closure before making any module visible; cycles retain native ESM semantics. */
export function linkPackProgram(
  program: PackProgram,
  baseUrl: string,
  hostImports: Readonly<Record<string, PackProgramImport>> = {},
) {
  const checked = verifyPackProgram(program);
  if (!checked.ok) return checked;
  const files: { url: string; source: string }[] = [];
  for (const [filename, text] of Object.entries(checked.value.modules)) {
    let source = text;
    const parsed = importsOf(source, filename);
    if (!parsed.ok) return parsed;
    for (const item of [...parsed.value].sort((a, b) => b.start - a.start)) {
      const local = localImport(filename, item.specifier);
      const host = hostImports[item.specifier];
      if (
        local === undefined &&
        (!host || host.identity !== program.imports?.[item.specifier] || !MODULE_URL.test(host.url))
      )
        return err(failure('pack-program-dependency-unavailable', filename, item.specifier));
      const url = local === undefined ? host?.url : new URL(local, baseUrl).href;
      if (url === undefined)
        return err(failure('pack-program-dependency-unavailable', filename, item.specifier));
      source = source.slice(0, item.start) + JSON.stringify(url) + source.slice(item.end);
    }
    files.push({ url: new URL(filename, baseUrl).href, source });
  }
  return ok({ entryUrl: new URL(program.entry, baseUrl).href, files });
}

export type PackProgramError = {
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly module: string; readonly reason: string };
} & {
  readonly code:
    | 'pack-program-invalid'
    | 'pack-program-dependency-unavailable'
    | 'pack-program-integrity-mismatch'
    | 'pack-program-load-failed';
};

interface ModuleImport {
  readonly start: number;
  readonly end: number;
  readonly specifier: string;
}

function failure(code: PackProgramError['code'], module: string, reason: string): PackProgramError {
  return {
    code,
    expected: 'valid ESM bytes and their complete, identity-matched module closure',
    hint: 'repair the program or supply the recorded host imports before admitting this Pack',
    detail: { module, reason },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function modulePath(value: string): boolean {
  return /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:js|mjs)$/.test(
    value,
  );
}

function importsOf(
  source: string,
  filename: string,
): Result<readonly ModuleImport[], PackProgramError> {
  const imports: ModuleImport[] = [];
  try {
    const root = parse(source, { ecmaVersion: 2022, sourceType: 'module' });
    const visit = (node: Node): void => {
      const fields = node as unknown as Record<string, unknown>;
      if (
        [
          'ImportDeclaration',
          'ExportNamedDeclaration',
          'ExportAllDeclaration',
          'ImportExpression',
        ].includes(node.type) &&
        fields.source !== null
      ) {
        const sourceNode = fields.source as
          | { start: number; end: number; value?: unknown }
          | undefined;
        if (sourceNode !== undefined) {
          if (typeof sourceNode.value !== 'string')
            throw new TypeError('imports must have literal specifiers');
          imports.push({
            start: sourceNode.start,
            end: sourceNode.end,
            specifier: sourceNode.value,
          });
        }
      }
      for (const value of Object.values(fields)) {
        for (const child of Array.isArray(value) ? value : [value]) {
          if (child !== null && typeof child === 'object' && typeof child.type === 'string')
            visit(child as Node);
        }
      }
    };
    visit(root);
    return ok(imports);
  } catch (cause) {
    return err(failure('pack-program-invalid', filename, String(cause)));
  }
}

function localImport(filename: string, specifier: string): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;
  const root = 'https://pack.invalid/closure/';
  const resolved = new URL(specifier, root + filename).href;
  return resolved.startsWith(root) ? resolved.slice(root.length) : '';
}

/** Parse and seal JavaScript without evaluating, transpiling or bundling it. */
export function preparePackProgram(
  input: PackProgramSource,
): Result<PackProgram, PackProgramError> {
  if (
    !record(input) ||
    Object.keys(input).some((key) => !['entry', 'export', 'modules', 'imports'].includes(key)) ||
    typeof input.entry !== 'string' ||
    !modulePath(input.entry) ||
    typeof input.export !== 'string' ||
    !input.export ||
    !record(input.modules) ||
    !Object.hasOwn(input.modules, input.entry) ||
    (input.imports !== undefined && !record(input.imports))
  ) {
    return err(
      failure(
        'pack-program-invalid',
        '',
        'expected entry, export, module texts and optional host import identities',
      ),
    );
  }
  const modules: Record<string, string> = {};
  const imports: Record<string, string> = {};
  for (const name of Object.keys(input.imports ?? {}).sort()) {
    const identity = input.imports?.[name];
    if (
      !name ||
      name.startsWith('.') ||
      name.startsWith('/') ||
      !identity ||
      typeof identity !== 'string'
    )
      return err(
        failure(
          'pack-program-invalid',
          name,
          'host imports require a bare specifier and non-empty identity',
        ),
      );
    Object.defineProperty(imports, name, { value: identity, enumerable: true });
  }
  for (const filename of Object.keys(input.modules).sort()) {
    const source = input.modules[filename];
    if (!modulePath(filename) || typeof source !== 'string')
      return err(
        failure(
          'pack-program-invalid',
          filename,
          'expected a relative .js/.mjs path and JavaScript text',
        ),
      );
    const parsed = importsOf(source, filename);
    if (!parsed.ok) return parsed;
    for (const item of parsed.value) {
      const local = localImport(filename, item.specifier);
      if (
        local === undefined
          ? !Object.hasOwn(imports, item.specifier)
          : !local || !Object.hasOwn(input.modules, local)
      )
        return err(failure('pack-program-dependency-unavailable', filename, item.specifier));
    }
    Object.defineProperty(modules, filename, { value: source, enumerable: true });
  }
  const source: PackProgramSource = {
    entry: input.entry,
    export: input.export,
    modules: Object.freeze(modules),
    ...(Object.keys(imports).length ? { imports: Object.freeze(imports) } : {}),
  };
  const digest = `sha256:${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(source))))}`;
  return ok(Object.freeze({ ...source, digest }));
}

export function verifyPackProgram(value: PackProgram): Result<PackProgram, PackProgramError> {
  if (!record(value) || typeof value.digest !== 'string')
    return err(failure('pack-program-invalid', '', 'missing program digest'));
  const { digest, ...source } = value;
  const prepared = preparePackProgram(source);
  if (!prepared.ok) return prepared;
  return digest === prepared.value.digest
    ? prepared
    : err(
        failure(
          'pack-program-integrity-mismatch',
          value.entry,
          'program bytes do not match the recorded digest',
        ),
      );
}

/** Explicit execution; the returned export is validated by its domain owner. */
export async function loadPackProgram(
  value: PackProgram,
  hostImports: Readonly<Record<string, PackProgramImport>> = {},
  host?: PackProgramHost,
): Promise<Result<unknown, PackProgramError>> {
  const verified = verifyPackProgram(value);
  if (!verified.ok) return verified;
  const program = verified.value;
  const moduleIdentity = packProgramModuleIdentity(program, hostImports);
  if (!moduleIdentity.ok) return moduleIdentity;
  const urls = new Map<string, string>();
  const visiting = new Set<string>();
  const locate = (filename: string): string => {
    const existing = urls.get(filename);
    if (existing !== undefined) return existing;
    if (visiting.has(filename))
      throw new TypeError('cyclic modules require a host-served module closure');
    visiting.add(filename);
    let source = program.modules[filename];
    if (source === undefined) throw new TypeError(`missing module ${filename}`);
    const parsed = importsOf(source, filename);
    if (!parsed.ok) throw new TypeError(parsed.error.detail.reason);
    for (const item of [...parsed.value].sort((left, right) => right.start - left.start)) {
      const local = localImport(filename, item.specifier);
      const url = local === undefined ? hostImports[item.specifier]?.url : locate(local);
      if (url === undefined) throw new TypeError(`missing module ${item.specifier}`);
      source = source.slice(0, item.start) + JSON.stringify(url) + source.slice(item.end);
    }
    const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}#${encodeURIComponent(`${moduleIdentity.value}/${filename}`)}`;
    urls.set(filename, url);
    visiting.delete(filename);
    return url;
  };
  try {
    const url =
      host === undefined ? locate(program.entry) : await host.publish(program, hostImports);
    const namespace =
      host?.importModule === undefined
        ? await import(/* @vite-ignore */ url)
        : await host.importModule(url);
    if (!Object.hasOwn(namespace, program.export))
      throw new TypeError(`missing export ${program.export}`);
    return ok(namespace[program.export]);
  } catch (cause) {
    return err(failure('pack-program-load-failed', program.entry, String(cause)));
  }
}
