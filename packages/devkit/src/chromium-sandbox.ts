import { constants } from 'node:fs';
import { access, chmod, chown, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Browser, BrowserServer, LaunchOptions } from 'playwright';

export function needsChromiumPrivilegeDrop(): boolean {
  return process.platform === 'linux' && process.geteuid?.() === 0;
}

export function unattendedRootBrowser(): boolean {
  return needsChromiumPrivilegeDrop() && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

export function liveDevBrowserHeadless(
  headless: boolean | undefined,
  hasCarrier: boolean,
): boolean {
  const configured = process.env.FORGEAX_DEV_HEADLESS;
  return (
    headless ??
    (configured === undefined ? !hasCarrier && unattendedRootBrowser() : configured === 'true')
  );
}

function browserIdentity(passwd: string, invokingUid: string | undefined) {
  const accounts = passwd.split('\n').flatMap((line) => {
    const [name, , uid, gid] = line.split(':');
    return uid !== undefined &&
      gid !== undefined &&
      /^[1-9]\d{0,9}$/.test(uid) &&
      /^[1-9]\d{0,9}$/.test(gid) &&
      Number(uid) < 0xffff_ffff &&
      Number(gid) < 0xffff_ffff
      ? [{ name, uid, gid }]
      : [];
  });
  return (
    accounts.find(({ uid }) => uid === invokingUid) ??
    accounts.find(({ name }) => name === 'pwuser') ??
    accounts.find(({ name }) => name === 'nobody')
  );
}

// Playwright owns its generated arguments and the debugging pipe. Only the profile
// directory needs to move into the browser user's private state.
const launcher = `#!/bin/sh
for argument do
  shift
  case "$argument" in
    --user-data-dir=*) argument="--user-data-dir=$FORGEAX_BROWSER_STATE/profile" ;;
  esac
  set -- "$@" "$argument"
done
cd "$FORGEAX_BROWSER_STATE" || exit 1
exec "$FORGEAX_BROWSER_SETPRIV" --reuid="$FORGEAX_BROWSER_UID" --regid="$FORGEAX_BROWSER_GID" --clear-groups --no-new-privs -- "$FORGEAX_BROWSER_PROGRAM" "$@"
`;

class ChromiumSandboxUnavailable extends Error {}

async function systemSetprivPath(): Promise<string> {
  for (const path of ['/usr/bin/setpriv', '/bin/setpriv']) {
    if (
      await access(path, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return path;
  }
  throw new ChromiumSandboxUnavailable('The Linux host has no executable setpriv.');
}

async function prepareUnprivilegedChromium(launch: LaunchOptions) {
  const executable = launch.executablePath;
  if (executable === undefined || !isAbsolute(executable))
    throw new Error('No absolute Chromium executable is available to the browser subprocess.');
  const setpriv = await systemSetprivPath();
  const identity = browserIdentity(await readFile('/etc/passwd', 'utf8'), process.env.SUDO_UID);
  if (identity === undefined)
    throw new ChromiumSandboxUnavailable('No local unprivileged Chromium identity is available.');
  const root = await mkdtemp('/tmp/forgeax-chromium-');
  const release = () => rm(root, { recursive: true, force: true });
  try {
    const state = join(root, 'state');
    const executablePath = join(root, 'launch');
    await mkdir(state, { mode: 0o700 });
    try {
      await chown(state, Number(identity.uid), Number(identity.gid));
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== 'EINVAL' && code !== 'EPERM' && code !== 'EACCES') throw cause;
      throw new ChromiumSandboxUnavailable(
        `Cannot assign the Chromium profile to UID ${identity.uid}, GID ${identity.gid} (${code}).`,
        { cause },
      );
    }
    await writeFile(executablePath, launcher, { mode: 0o700, flag: 'wx' });
    await chmod(root, 0o711);
    const env: Record<string, string> = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: state,
      TMPDIR: state,
      XDG_RUNTIME_DIR: state,
      FORGEAX_BROWSER_STATE: state,
      FORGEAX_BROWSER_PROGRAM: executable,
      FORGEAX_BROWSER_SETPRIV: setpriv,
      FORGEAX_BROWSER_UID: identity.uid,
      FORGEAX_BROWSER_GID: identity.gid,
    };
    for (const key of ['DISPLAY', 'XAUTHORITY', 'LANG', 'LIBGL_ALWAYS_SOFTWARE']) {
      const value = launch.env?.[key];
      if (value !== undefined) env[key] = value;
    }
    return { options: { ...launch, executablePath, env }, release };
  } catch (cause) {
    await release();
    throw cause;
  }
}

export function chromiumEnvironment(software: boolean, display?: string): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...(software ? { LIBGL_ALWAYS_SOFTWARE: '1' } : {}),
    ...(display === undefined ? {} : { DISPLAY: display }),
  };
}

function isSandboxFailure(cause: unknown): boolean {
  return (
    cause instanceof ChromiumSandboxUnavailable ||
    (cause instanceof Error &&
      /Chromium sandboxing failed!|No usable sandbox!|Failed to move to new namespace:/i.test(
        cause.message,
      ))
  );
}

function recoveryEnvironment(launch: LaunchOptions): NonNullable<LaunchOptions['env']> {
  const environment = launch.env ?? process.env;
  const result: NonNullable<LaunchOptions['env']> = {};
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'TMPDIR',
    'TEMP',
    'TMP',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'LANG',
    'LIBGL_ALWAYS_SOFTWARE',
    'XDG_RUNTIME_DIR',
    'XDG_CACHE_HOME',
  ]) {
    const value = environment[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

async function launchChromium<T>(
  launch: LaunchOptions,
  start: (options: LaunchOptions) => Promise<T>,
  onExit: (owner: T, release: () => void) => void,
): Promise<T> {
  let prepared: Awaited<ReturnType<typeof prepareUnprivilegedChromium>> | undefined;
  try {
    if (needsChromiumPrivilegeDrop() && launch.executablePath !== undefined) {
      prepared = await prepareUnprivilegedChromium(launch);
    }
    const owner = await start({ ...(prepared?.options ?? launch), chromiumSandbox: true });
    const release = prepared?.release;
    if (release !== undefined) onExit(owner, () => void release().catch(() => undefined));
    return owner;
  } catch (cause) {
    await prepared?.release().catch(() => undefined);
    if (!isSandboxFailure(cause)) throw cause;
    process.stderr.write(
      '[forgeax] Chromium sandbox unavailable. Retrying the same browser with sandboxing disabled.\n',
    );
    try {
      return await start({ ...launch, env: recoveryEnvironment(launch), chromiumSandbox: false });
    } catch (retry) {
      throw new AggregateError(
        [cause, retry],
        `Chromium recovery failed. ${String(cause)} ${String(retry)}`,
      );
    }
  }
}

export function launchChromiumBrowser(options: LaunchOptions): Promise<Browser> {
  return launchChromium(
    options,
    async (launch) => (await import('playwright')).chromium.launch(launch),
    (browser, release) => browser.once('disconnected', release),
  );
}

export function launchChromiumBrowserServer(options: LaunchOptions): Promise<BrowserServer> {
  return launchChromium(
    options,
    async (launch) => (await import('playwright')).chromium.launchServer(launch),
    (server, release) => server.once('close', release),
  );
}
