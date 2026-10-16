import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };

export function chromeLaunchOptions() {
  return {
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? browserLaunch.channel,
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    args: [
      ...browserLaunch.args.filter(arg => !arg.startsWith('--autoplay-policy=')),
      ...(process.env.CI ? ['--use-angle=swiftshader'] : []),
    ],
  };
}
