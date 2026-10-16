// paths.ts — path constants SSOT (D-8 bottom tier)
//
// All path literals for forge.json live here as the single authoritative source.
// Consumers import FORGE_JSON rather than hardcoding 'forge.json' strings.

/** The forge.json manifest filename, relative to a game root directory. */
export const FORGE_JSON = 'forge.json' as const;
