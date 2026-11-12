import { selectBrowserExecutable } from './browser-executable.mjs';

/** Test placement only; runtime capabilities remain owned by the device. */
export function compatibilityPhases(carrier) {
  if (!['stable', 'reference', 'legacy', 'webkit'].includes(carrier))
    throw new Error(`Unknown compatibility carrier: ${carrier}`);
  return carrier === 'stable'
    ? ['owners', 'policy', 'compatibility', 'scene']
    : carrier === 'webkit'
      ? ['owners', 'scene']
      : ['owners'];
}

/** Keep software Vulkan admission, but retain browser limit and driver policy. */
export function compatibilityLaunch(defaults, phase, env = process.env) {
  if (!['owners', 'policy', 'compatibility', 'scene'].includes(phase))
    throw new Error(`Unknown compatibility phase: ${phase}`);
  const selected = selectBrowserExecutable(defaults, env);
  if (phase === 'owners') return selected;
  return {
    ...selected,
    chromiumSandbox: true,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
      '--use-angle=swiftshader',
      '--autoplay-policy=no-user-gesture-required',
    ],
  };
}
