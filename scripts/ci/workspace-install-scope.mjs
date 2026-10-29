/** Root-only frozen installs cannot execute View hooks or materialize its workspace. */
export function isRootRuntimeInstall(command) {
  return /^\s*(?:-\s*)?(?:run:\s*)?pnpm\s+install\s+--frozen-lockfile\s+--ignore-scripts\s+--filter\s+forgeax-engine\s*$/u.test(
    command,
  );
}

/** A workspace install can evaluate View inputs unless its scope excludes them. */
export function isGlobalWorkspaceInstall(command) {
  return (
    /^(?:pnpm|bun)\s+(?:install|i)\b/u.test(command) &&
    !isRootRuntimeInstall(command) &&
    !/\s(?:--dir|--cwd|--prefix)\s/u.test(command)
  );
}
