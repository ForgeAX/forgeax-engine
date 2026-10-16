import type { Plugin } from '@forgeax/engine-plugin';

export interface RemoteServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

/** Own a Node remote server with the App Fiber while App still exposes its handle. */
export function remoteServerPlugin(handle: RemoteServerHandle): Plugin {
  return {
    name: 'remote-server',
    apply(ctx) {
      ctx.effect(() => async () => handle.close(), 'remote/server');
    },
  };
}
