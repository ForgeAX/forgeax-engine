/// <reference types="vite/client" />

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): Record<string, unknown>;
}
