const UPDATE_MIGRATION_RISK =
  'Install a newer SDK in a separate directory. Existing games remain pinned and are not migrated automatically; review release notes and migrate and test each game before changing its Engine version.';

type SdkUpdateStatus =
  | {
      readonly status: 'available';
      readonly currentVersion: string;
      readonly latestVersion: string;
      readonly migrationRisk: typeof UPDATE_MIGRATION_RISK;
    }
  | {
      readonly status: 'current';
      readonly currentVersion: string;
      readonly latestVersion: string;
    }
  | {
      readonly status: 'skipped';
      readonly currentVersion: string;
      readonly reason: 'offline' | 'disabled';
    }
  | {
      readonly status: 'unavailable';
      readonly currentVersion: string;
      readonly reason: string;
    };

interface ParsedVersion {
  readonly core: readonly [string, string, string];
  readonly prerelease?: readonly string[];
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      version,
    );
  if (match === null) return undefined;
  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  const prerelease = match[4]?.split('.');
  if (
    prerelease?.some(
      (identifier) =>
        identifier.length === 0 || (/^\d+$/.test(identifier) && /^0\d+/.test(identifier)),
    )
  ) {
    return undefined;
  }
  return {
    core: [major, minor, patch],
    ...(prerelease === undefined ? {} : { prerelease }),
  };
}

function compareNumericIdentifier(current: string, latest: string): number {
  if (current.length !== latest.length) return latest.length > current.length ? 1 : -1;
  if (current === latest) return 0;
  return latest > current ? 1 : -1;
}

function comparePrerelease(current: readonly string[], latest: readonly string[]): number {
  const length = Math.max(current.length, latest.length);
  for (let index = 0; index < length; index += 1) {
    const currentIdentifier = current[index];
    const latestIdentifier = latest[index];
    if (currentIdentifier === undefined) return 1;
    if (latestIdentifier === undefined) return -1;
    if (currentIdentifier === latestIdentifier) continue;
    const currentNumeric = /^\d+$/.test(currentIdentifier);
    const latestNumeric = /^\d+$/.test(latestIdentifier);
    if (currentNumeric && latestNumeric) {
      return compareNumericIdentifier(currentIdentifier, latestIdentifier);
    }
    if (currentNumeric !== latestNumeric) return latestNumeric ? -1 : 1;
    return latestIdentifier > currentIdentifier ? 1 : -1;
  }
  return 0;
}

export function newerSdkVersion(currentVersion: string, latestVersion: string): boolean {
  const current = parseVersion(currentVersion);
  const latest = parseVersion(latestVersion);
  if (current === undefined || latest === undefined) return false;
  for (let index = 0; index < current.core.length; index += 1) {
    const precedence = compareNumericIdentifier(
      current.core[index] ?? '0',
      latest.core[index] ?? '0',
    );
    if (precedence !== 0) return precedence > 0;
  }
  if (current.prerelease !== undefined && latest.prerelease === undefined) return true;
  if (current.prerelease === undefined || latest.prerelease === undefined) return false;
  return comparePrerelease(current.prerelease, latest.prerelease) > 0;
}

function offline(): boolean {
  return ['1', 'true'].includes((process.env.npm_config_offline ?? '').toLowerCase());
}

export async function checkSdkUpdate(currentVersion: string): Promise<SdkUpdateStatus> {
  if (process.env.FORGEAX_DISABLE_UPDATE_CHECK === '1') {
    return { status: 'skipped', currentVersion, reason: 'disabled' };
  }
  if (offline()) return { status: 'skipped', currentVersion, reason: 'offline' };
  try {
    const registry = process.env.npm_config_registry ?? 'https://registry.npmjs.org/';
    const response = await fetch(
      new URL('@forgeax%2Fengine-sdk', `${registry.replace(/\/$/, '')}/`),
      {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (!response.ok) throw new Error(`registry-http-${response.status}`);
    const metadata = (await response.json()) as {
      readonly 'dist-tags'?: Readonly<Record<'latest' | 'next' | 'rc', unknown>>;
    };
    const tag = currentVersion.includes('-dev.') ? 'next' : 'latest';
    const channelVersion = metadata['dist-tags']?.[tag];
    if (typeof channelVersion !== 'string') throw new Error(`registry-${tag}-version-missing`);
    // An rc install follows its test line until that line is promoted to latest.
    const rcVersion = currentVersion.includes('-rc.') ? metadata['dist-tags']?.rc : undefined;
    const latestVersion =
      typeof rcVersion === 'string' && newerSdkVersion(channelVersion, rcVersion)
        ? rcVersion
        : channelVersion;
    return newerSdkVersion(currentVersion, latestVersion)
      ? {
          status: 'available',
          currentVersion,
          latestVersion,
          migrationRisk: UPDATE_MIGRATION_RISK,
        }
      : { status: 'current', currentVersion, latestVersion };
  } catch (cause) {
    return {
      status: 'unavailable',
      currentVersion,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
