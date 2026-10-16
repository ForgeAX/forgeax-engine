declare module 'virtual:forgeax/plugin-programs/*' {
  export const root: string | null;
  export function createPrograms(
    sessionId: string,
    contextId: string,
    sessionGeneration: number,
  ): import('@forgeax/engine-plugin').PluginPrograms;
}
