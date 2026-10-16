import type { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { HostTransportClient } from '@forgeax/engine-host/transport';

/** Children acknowledge teardown before their bridges and remaining Host leases retire. */
export async function retireViewResources(
  frames: Iterable<{
    bridge: Pick<AppBridge, 'getAppVersion' | 'teardownResource' | 'close'>;
    frame: Pick<HTMLIFrameElement, 'remove'>;
  }>,
  connections: Iterable<HostTransportClient>,
  disposeRuntime: () => void,
) {
  const failures: unknown[] = [];
  const collect = (results: PromiseSettledResult<unknown>[]) => {
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
  };
  collect(
    await Promise.allSettled(
      [...frames].map(async ({ bridge, frame }) => {
        try {
          if (bridge.getAppVersion()) await bridge.teardownResource({});
        } finally {
          try {
            await bridge.close();
          } finally {
            frame.remove();
          }
        }
      }),
    ),
  );
  collect(
    await Promise.allSettled([...connections].map((client) => client.close('MCP View retired'))),
  );
  try {
    disposeRuntime();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, 'MCP View resource retirement failed');
}
