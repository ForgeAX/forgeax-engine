import { browserGpuLaunchOptions, selectBrowserExecutable } from './browser-executable.mjs';

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

/** Preserve the carrier defaults and the scene's explicit local GPU selection. */
export function compatibilityLaunch(
  defaults,
  phase,
  env = process.env,
  platform = process.platform,
) {
  if (!['owners', 'policy', 'compatibility', 'scene'].includes(phase))
    throw new Error(`Unknown compatibility phase: ${phase}`);
  if (phase === 'owners') return selectBrowserExecutable(defaults, env);
  const nativeScene = phase === 'scene' && env.FORGEAX_BROWSER_GPU === 'native';
  const launch = {
    ...defaults,
    chromiumSandbox: true,
    args: [
      '--enable-unsafe-webgpu',
      ...(nativeScene
        ? []
        : ['--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader']),
      ...(phase === 'scene' ? defaults.args.filter((arg) => arg === '--disable-gpu-watchdog') : []),
      '--autoplay-policy=no-user-gesture-required',
    ],
  };
  return nativeScene
    ? browserGpuLaunchOptions(launch, env, platform)
    : selectBrowserExecutable(launch, env);
}
