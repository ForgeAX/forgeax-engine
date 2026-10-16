import { installBrowserGameplayGpu } from './browser_gameplay_gpu.mjs';

/**
 * Explicit diagnostic only. The caller supplies the ordinary Platform's normalized
 * millisecond clock and brackets a short capture before collecting asynchronously.
 * This uses the existing elapsed-query owner; it never enables RHI timestampQuery.
 */
export function installPhoneGameplayGpu({
  now,
  capacity = 512,
  globalName = '__forgeaxPhoneGameplayGpuQueries',
} = {}) {
  if (typeof now !== 'function')
    throw new Error('Phone GPU diagnostic requires Platform.now in milliseconds');
  const query = installBrowserGameplayGpu({ now, capacity, globalName, clock: 'platform.now' });
  function report(value) {
    return {
      ...value,
      schemaVersion: 'forgeax-phone-gameplay-gpu/1',
      querySchemaVersion: value.schemaVersion,
      diagnosticOnly: true,
      cleanFpsEvidence: false,
      changesRhiCapabilities: false,
      scope:
        'Intrusive EXT_disjoint_timer_query_webgl2 intervals around actual native submit and present. Driver-reported elapsed intervals are not additive GPU busy time, exclusive shader time, fence latency, display timing or ordinary-loop FPS. RHI timestampQuery capability is unchanged.',
      cleanup: {
        status:
          value.lifecycle !== 'disposed'
            ? 'not-disposed'
            : value.coverage.allocatedQueries === value.coverage.deletedQueries
              ? 'complete'
              : 'partial',
        allocatedQueries: value.coverage.allocatedQueries,
        deletedQueries: value.coverage.deletedQueries,
      },
    };
  }
  return {
    project: query.project,
    /** Keep the existing WeChat import compatibility fixes and original Host receiver. */
    wrapHost(host) {
      return {
        ...host,
        readWasm(...args) {
          return Reflect.apply(host.readWasm, host, args);
        },
        instantiate(...args) {
          // No async wrapper: an original synchronous throw remains synchronous.
          return Reflect.apply(host.instantiate, host, args).then((native) =>
            query.project(native, host.surfaces),
          );
        },
      };
    },
    start: query.start,
    stop: () => report(query.stop()),
    snapshot: () => report(query.snapshot()),
    collect: async (options) => report(await query.collect(options)),
    dispose: () => report(query.dispose()),
  };
}
