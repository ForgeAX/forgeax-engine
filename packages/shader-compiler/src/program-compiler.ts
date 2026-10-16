import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import { threadId } from 'node:worker_threads';
import { composeShader } from '@forgeax/engine-naga';
import { ok } from '@forgeax/engine-types';
import {
  type CompileOptions,
  type CompileResult,
  type compileShader,
  compileShaderProgram,
  compileShaderWithComposition,
} from './compile.js';
import { canonicalizePortableWgsl } from './wgsl-compat.js';

let nextCompilerInstance = 0;

function invocationIdentity(
  source: string,
  options: CompileOptions,
): { key: string; bytes: number; options: CompileOptions } | undefined {
  try {
    // Accessor-backed or non-data options stay on the ordinary admission path.
    const seen = new WeakSet<object>();
    let unsupported = false;
    const copy = (value: unknown): unknown => {
      if (typeof value === 'function' || typeof value === 'symbol') {
        unsupported = true;
        return value;
      }
      if (value === null || typeof value !== 'object') return value;
      if (
        seen.has(value) ||
        (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
      ) {
        unsupported = true;
        return value;
      }
      seen.add(value);
      const captured = Array.isArray(value) ? new Array(value.length) : {};
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!('value' in descriptor)) {
          unsupported = true;
          return value;
        }
        if (descriptor.enumerable)
          Object.defineProperty(captured, key, {
            value: copy(descriptor.value),
            enumerable: true,
            configurable: true,
            writable: true,
          });
      }
      return captured;
    };
    // Own the selector containers while sharing immutable WGSL strings.
    const captured = copy(options) as CompileOptions;
    if (unsupported) return undefined;
    const hash = createHash('sha256');
    let bytes = 0;
    const append = (text: string): void => {
      const length = Buffer.byteLength(text);
      bytes += length;
      hash.update(`${length}:`).update(text);
    };
    append(source);
    const metadata = serialize({ ...captured, imports: undefined });
    bytes += metadata.byteLength;
    hash.update(`${metadata.byteLength}:`).update(metadata);
    const imports = Object.entries(captured.imports ?? {});
    append(String(imports.length));
    for (const [name, text] of imports) {
      append(name);
      append(text);
    }
    return { key: `request:${hash.digest('hex')}`, bytes, options: captured };
  } catch {
    return undefined;
  }
}

type CachedProgram =
  | {
      readonly kind: 'composition';
      readonly value: Promise<string>;
      readonly bytes: number;
      readonly wgsl?: string;
      readonly wgslBytes?: number;
    }
  | {
      readonly kind: 'result';
      readonly value: ReturnType<typeof compileShaderProgram>;
      readonly bytes: number;
      readonly wgsl: string;
      readonly wgslBytes: number;
    };

// Keep the source closure's selectors and the compiler-owned color projection.
// Malformed unused selectors still reach the real compiler's rejection path.
function referencedDefines(
  source: string,
  imports: Readonly<Record<string, string>>,
  defines: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  const sources = [source, ...Object.values(imports)];
  return Object.fromEntries(
    Object.entries(defines).filter(
      ([name, value]) =>
        typeof value !== 'boolean' ||
        name === 'VERTEX_COLOR_AVAILABLE' ||
        sources.some((text) => text.includes(name)),
    ),
  );
}

// WGSL strings are immutable; copy only the independently mutable facts.
function copyResult(result: CompileResult): CompileResult {
  const copy = structuredClone({
    ...result,
    wgsl: '',
    manifestEntry: { ...result.manifestEntry, wgsl: '' },
  });
  return {
    ...copy,
    wgsl: result.wgsl,
    manifestEntry: { ...copy.manifestEntry, wgsl: result.manifestEntry.wgsl },
  };
}

/** Scoped reuse, accounting for each immutable WGSL body only once. */
export function createShaderProgramCompiler(): typeof compileShader {
  const instance = ++nextCompilerInstance;
  const statistics = process.env.FORGEAX_SHADER_CACHE_STATS === '1';
  const counters = {
    requests: 0,
    completed: 0,
    admissionHits: 0,
    admissions: 0,
    compositions: 0,
    validations: 0,
  };
  type Stage = CachedProgram['kind'];
  const MiB = 1024 * 1024;
  const budgets: Record<Stage, number> = { composition: 16 * MiB, result: 32 * MiB };
  const retainedBytes: Record<Stage, number> = { composition: 0, result: 0 };
  const programs = new Map<string, CachedProgram>();
  let admittedBy = compileShaderWithComposition;
  const bodies = new Map<string, { counts: Record<Stage, number>; bytes: number }>();
  const report = (): void => {
    counters.completed++;
    if (statistics && counters.completed % 256 === 0)
      console.error(
        '[forgeax.shader-reuse]',
        JSON.stringify({
          pid: process.pid,
          threadId,
          instance,
          ...counters,
          retainedPayloadBytes: retainedBytes,
        }),
      );
  };
  const touch = (key: string, entry: CachedProgram): void => {
    programs.delete(key);
    programs.set(key, entry);
  };
  const remove = (key: string): void => {
    const entry = programs.get(key);
    if (entry === undefined) return;
    programs.delete(key);
    retainedBytes[entry.kind] -= entry.bytes;
    if (entry.wgsl === undefined) return;
    const body = bodies.get(entry.wgsl);
    if (body === undefined) return;
    if (--body.counts[entry.kind] === 0) retainedBytes[entry.kind] -= body.bytes;
    if (body.counts.composition === 0 && body.counts.result === 0) bodies.delete(entry.wgsl);
  };
  const retain = (key: string, entry: CachedProgram) => {
    // Result selections can share one program body. Count their metadata and
    // each distinct WGSL body, rather than charging the body for every result.
    remove(key);
    // A single oversized source/result is never retained, even when a stage
    // has more aggregate room. Both stages keep independent bounded recency.
    if (entry.bytes + (entry.wgslBytes ?? 0) > 16 * MiB) return;
    programs.set(key, entry);
    retainedBytes[entry.kind] += entry.bytes;
    if (entry.wgsl !== undefined) {
      const body = bodies.get(entry.wgsl);
      if (body === undefined) {
        const bytes = entry.wgslBytes ?? 0;
        bodies.set(entry.wgsl, { counts: { composition: 0, result: 0, [entry.kind]: 1 }, bytes });
        retainedBytes[entry.kind] += bytes;
      } else {
        if (body.counts[entry.kind]++ === 0) retainedBytes[entry.kind] += body.bytes;
      }
    }
    while (retainedBytes[entry.kind] > budgets[entry.kind]) {
      let oldest: string | undefined;
      for (const [key, candidate] of programs) {
        if (candidate.kind === entry.kind) {
          oldest = key;
          break;
        }
      }
      if (oldest === undefined) break;
      remove(oldest);
    }
  };
  const compose: typeof composeShader = async (source, imports = {}, defines = {}) => {
    // Preserve the Wasm boundary's boolean check for untyped JavaScript callers.
    if (Object.values(defines).some((value) => typeof value !== 'boolean'))
      return composeShader(source, imports, defines);
    // Absent names cannot affect composition. Literal matching conservatively keeps
    // names occurring in comments or longer identifiers; prepared branches stay in the key.
    const relevantDefines = referencedDefines(source, imports, defines);
    const hash = createHash('sha256');
    let inputBytes = 0;
    const append = (text: string): void => {
      const bytes = Buffer.byteLength(text);
      inputBytes += bytes;
      hash.update(`${bytes}:`).update(text);
    };
    append(source);
    append(String(Object.keys(imports).length));
    for (const [name, text] of Object.entries(imports)) {
      append(name);
      append(text);
    }
    append(JSON.stringify(relevantDefines));
    const key = `composition:${hash.digest('hex')}`;
    const previous = programs.get(key);
    if (previous?.kind === 'composition') {
      touch(key, previous);
      return previous.value;
    }
    // Admit the in-flight work before awaiting it. Pending source bytes share
    // the existing entry/payload budget; success accounts for the resulting WGSL.
    counters.compositions++;
    const entry: CachedProgram = {
      kind: 'composition',
      value: composeShader(source, imports, defines).then(canonicalizePortableWgsl),
      bytes: inputBytes,
    };
    retain(key, entry);
    try {
      const wgsl = await entry.value;
      // An evicted pending input must not re-enter the cache on completion.
      if (programs.get(key) === entry)
        retain(key, { ...entry, bytes: 0, wgsl, wgslBytes: Buffer.byteLength(wgsl) });
      return wgsl;
    } catch (error) {
      if (programs.get(key) === entry) remove(key);
      throw error;
    }
  };
  const compileProgram: typeof compileShaderProgram = async (wgsl, options, locateSyntaxError) => {
    const selection = {
      ...(options.renderEntries === undefined ? {} : { renderEntries: options.renderEntries }),
      dynamicOffsets: options.dynamicOffsets ?? [],
    };
    const key = `result:${createHash('sha256')
      .update(`${Buffer.byteLength(wgsl)}:`)
      .update(wgsl)
      .update(JSON.stringify(selection))
      .digest('hex')}`;
    const previous = programs.get(key);
    if (previous?.kind === 'result') {
      touch(key, previous);
      const shared = await previous.value;
      if (shared.ok) return ok(copyResult(shared.value));
      // Failed validation can carry the first caller's source location. Each
      // source retains its own diagnostic path; only successful results share.
      counters.validations++;
      return compileShaderProgram(wgsl, selection, locateSyntaxError);
    }
    // Entry, attachment format and dynamic-offset changes still validate fresh IR.
    counters.validations++;
    const entry: CachedProgram = {
      kind: 'result',
      value: compileShaderProgram(wgsl, selection, locateSyntaxError),
      bytes: Buffer.byteLength(JSON.stringify(selection)),
      wgsl,
      wgslBytes: Buffer.byteLength(wgsl),
    };
    retain(key, entry);
    try {
      const compiled = await entry.value;
      if (!compiled.ok) {
        if (programs.get(key) === entry) remove(key);
        return compiled;
      }
      const value = compiled.value;
      if (programs.get(key) === entry)
        retain(key, {
          ...entry,
          bytes: Buffer.byteLength(
            JSON.stringify({
              ...value,
              wgsl: '',
              manifestEntry: { ...value.manifestEntry, wgsl: '' },
            }),
          ),
          wgsl: value.wgsl,
          wgslBytes: Buffer.byteLength(value.wgsl),
        });
      return ok(copyResult(value));
    } catch (error) {
      if (programs.get(key) === entry) remove(key);
      throw error;
    }
  };
  return async (source, options = {}) => {
    counters.requests++;
    const pipeline = compileShaderWithComposition;
    if (admittedBy !== pipeline) {
      for (const key of programs.keys()) if (key.startsWith('request:')) remove(key);
      admittedBy = pipeline;
    }
    const identity = invocationIdentity(source, options);
    const previous = identity === undefined ? undefined : programs.get(identity.key);
    if (identity !== undefined && previous?.kind === 'result') {
      touch(identity.key, previous);
      const cached = await previous.value;
      if (cached.ok) {
        counters.admissionHits++;
        report();
        return ok(copyResult(cached.value));
      }
    }
    let reusable = true;
    counters.admissions++;
    const result = await pipeline(
      source,
      identity?.options ?? options,
      async (...args) => {
        const wgsl = await compose(...args);
        if (Buffer.byteLength(wgsl) > 16 * MiB) reusable = false;
        return wgsl;
      },
      compileProgram,
    );
    // Only completed successful admissions are reused. Mutated inputs, failures
    // and source-location-bearing diagnostics never enter this projection.
    if (
      result.ok &&
      reusable &&
      identity !== undefined &&
      identity.bytes <= 16 * MiB &&
      invocationIdentity(source, identity.options)?.key === identity.key &&
      admittedBy === pipeline
    ) {
      const value = copyResult(result.value);
      retain(identity.key, {
        kind: 'result',
        value: Promise.resolve(ok(value)),
        bytes: Buffer.byteLength(
          JSON.stringify({
            ...value,
            wgsl: '',
            manifestEntry: { ...value.manifestEntry, wgsl: '' },
          }),
        ),
        wgsl: value.wgsl,
        wgslBytes: Buffer.byteLength(value.wgsl),
      });
    }
    report();
    return result;
  };
}
