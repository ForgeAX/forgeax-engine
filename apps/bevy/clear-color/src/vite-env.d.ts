/// <reference types="vite/client" />
declare module 'virtual:forgeax/bundler' {
  import type { BundlerOptions } from '@forgeax/engine-app';
  export function forgeaxBundlerAdapter(): BundlerOptions;
}