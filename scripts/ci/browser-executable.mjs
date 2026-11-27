import { isAbsolute } from 'node:path';

/** An explicit, pinned carrier must not retain the host browser channel. */
export function selectBrowserExecutable(defaults, env = process.env) {
  const { channel, ...options } = defaults;
  const executablePath = env.FORGEAX_BROWSER_EXECUTABLE;
  if (executablePath) {
    if (!isAbsolute(executablePath)) throw new Error('FORGEAX_BROWSER_EXECUTABLE must be absolute');
    return { ...options, executablePath };
  }
  return { ...options, channel: env.FORGEAX_CHROME_CHANNEL || channel };
}

/** The default is the declared software CI carrier; local native admission is explicit. */
export function browserGpuLaunchOptions(defaults, env = process.env, platform = process.platform) {
  const mode = env.FORGEAX_BROWSER_GPU ?? 'software';
  if (!['software', 'native'].includes(mode))
    throw new Error('FORGEAX_BROWSER_GPU must be software or native');
  if (mode === 'native' && platform !== 'win32' && platform !== 'darwin')
    throw new Error('explicit native Browser admission is supported on Windows and macOS');
  const selected = selectBrowserExecutable(defaults, env);
  return {
    ...selected,
    args: [
      ...selected.args.flatMap((argument) => {
        if (platform === 'darwin' && mode === 'native') {
          if (argument === '--use-vulkan=swiftshader') return [];
          if (argument.startsWith('--enable-features=')) {
            const features = argument
              .slice('--enable-features='.length)
              .split(',')
              .filter((feature) => feature !== 'Vulkan');
            return features.length > 0 ? [`--enable-features=${features.join(',')}`] : [];
          }
        }
        if (platform !== 'win32') return [argument];
        if (argument.startsWith('--enable-features=Vulkan')) return [];
        if (argument === '--use-vulkan=swiftshader')
          return mode === 'native' ? [] : ['--use-webgpu-adapter=swiftshader'];
        return [argument];
      }),
      ...(env.CI && mode === 'software'
        ? [...(platform === 'win32' ? [] : ['--use-angle=swiftshader']), '--disable-gpu-watchdog']
        : []),
    ],
  };
}
