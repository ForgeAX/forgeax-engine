declare module 'virtual:forgeax/plugin-programs/*' {
  export const root: string | null;
  export function createPrograms(
    sessionId: string,
    contextId: string,
    sessionGeneration: number,
  ): import('@forgeax/engine-plugin').PluginPrograms;
}
declare module 'virtual:forgeax/preview-runtime-packs' {
  import type { AuthoredRuntimePack } from '@forgeax/engine-app';

  const packs: Readonly<Record<string, readonly AuthoredRuntimePack[]>>;
  export default packs;
}
