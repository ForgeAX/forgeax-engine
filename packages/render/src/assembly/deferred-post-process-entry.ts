import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';

const deferredSources = new WeakMap<PostProcessShaderEntry, { source?: string }>();

/** Renderer-owned immutable declaration; source preparation starts only on actual consumption. */
export function deferredPostProcessEntry(
  descriptor: Omit<PostProcessShaderEntry, 'source'>,
  prepareSource: () => string,
): PostProcessShaderEntry {
  const state: { source?: string } = {};
  const entry: PostProcessShaderEntry = Object.freeze({
    ...descriptor,
    ...(descriptor.params === undefined
      ? {}
      : {
          params: Object.freeze({
            byteSize: descriptor.params.byteSize,
            defaultValue: descriptor.params.defaultValue.slice(),
          }),
        }),
    ...(descriptor.reads === undefined
      ? {}
      : {
          reads: Object.freeze(
            descriptor.reads.map((read) =>
              typeof read === 'string' ? read : Object.freeze({ ...read }),
            ),
          ),
        }),
    ...(descriptor.storageBindings === undefined
      ? {}
      : { storageBindings: Object.freeze([...descriptor.storageBindings]) }),
    get source() {
      if (state.source === undefined) state.source = prepareSource();
      return state.source;
    },
  });
  deferredSources.set(entry, state);
  return entry;
}

export function isDeferredPostProcessEntry(entry: PostProcessShaderEntry): boolean {
  return deferredSources.has(entry);
}

/** An engine-owned source remains owned when a consumer selects another entry point. */
export function postProcessFragmentEntry(
  entry: PostProcessShaderEntry,
  fragmentEntryPoint: string,
): PostProcessShaderEntry {
  const variant = { ...entry, fragmentEntryPoint };
  const source = deferredSources.get(entry);
  if (source === undefined) return variant;
  Object.freeze(variant);
  deferredSources.set(variant, source);
  return variant;
}

/** Retirement must not prepare an unused declaration just to invalidate its module. */
export function preparedPostProcessSource(entry: PostProcessShaderEntry): string | undefined {
  const state = deferredSources.get(entry);
  return state === undefined ? entry.source : state.source;
}
