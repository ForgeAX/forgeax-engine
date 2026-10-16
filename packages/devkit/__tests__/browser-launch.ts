import browserLaunch from '../../../scripts/ci/browser-launch.json' with { type: 'json' };

/** Desktop correctness uses Metal/D3D12; Linux retains the CI software route. */
export function runtimeBrowserLaunchOptions() {
  const software = process.platform === 'linux';
  return {
    ...(process.env.FORGEAX_BROWSER_EXECUTABLE
      ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE }
      : { channel: process.env.FORGEAX_CHROME_CHANNEL ?? browserLaunch.channel }),
    headless: false,
    args: [
      '--enable-unsafe-webgpu',
      software
        ? '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer'
        : '--enable-features=UseSkiaRenderer,SharedArrayBuffer',
      ...(software
        ? [
            '--use-angle=swiftshader',
            '--use-vulkan=swiftshader',
            '--enable-unsafe-swiftshader',
            '--disable-vulkan-surface',
          ]
        : []),
      '--ignore-gpu-blocklist',
    ],
  };
}
