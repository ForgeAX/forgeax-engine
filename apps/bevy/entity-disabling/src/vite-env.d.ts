/// <reference types="vite/client" />

declare module 'virtual:forgeax/bundler' {
  import type { BundlerAdapter } from '@forgeax/engine-runtime';

  export const forgeaxBundlerAdapter: () => BundlerAdapter;
}
