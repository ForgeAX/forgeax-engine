declare module 'virtual:forgeax/plugin-programs/engine' {
  export function createPrograms(
    sessionId: string,
    contextId: string,
    sessionGeneration: number,
  ): import('@forgeax/engine/plugin').PluginPrograms;
}
