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
