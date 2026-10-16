/// <reference types="vite/client" />

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): import('@forgeax/engine-app').BundlerAdapter;
}