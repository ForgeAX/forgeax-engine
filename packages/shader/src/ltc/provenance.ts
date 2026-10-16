// @forgeax/engine-shader - provenance for the tracked RectArea LTC tables.

/**
 * The table source is the Three.js r184 RectAreaLight implementation. The
 * source arrays are converted to IEEE-754 binary16 offline and checked into
 * `tables.ts`; the runtime never fetches or parses a source file.
 */
export const LTC_SOURCE_PROVENANCE = {
  source: 'Three.js',
  revision: 'r184',
  sourceUrl:
    'https://github.com/mrdoob/three.js/blob/r184/examples/jsm/lights/RectAreaLightTexturesLib.js',
  upstreamData: 'selfshadow/ltc_code fit/results/ltc.js',
  generator: 'deterministic Three.js source-array to rgba16float conversion',
  inputSha256: {
    lambert: 'cf5cf21e5c112d2095c7e2418cb0a1ac54636e275d73e42f3453646c67f26814',
    ggx: '3b1b09080b26104498db277c14fc1733786465c6958e7a8403d688b1e24c2ff5',
  },
} as const;
