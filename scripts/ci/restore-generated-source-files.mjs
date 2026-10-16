import { execFileSync } from 'node:child_process';

const GENERATED_TRACKED_SOURCE_FILES = Object.freeze(['apps/hello/taa/evidence/visual-cases.json']);
const GENERATED_TRACKED_SOURCE_FILE_SET = new Set(GENERATED_TRACKED_SOURCE_FILES);

function readTrackedChanges() {
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no', '-z'], {
    encoding: 'utf8',
  });
  return status
    .split('\0')
    .filter(Boolean)
    .map((entry) => ({
      status: entry.slice(0, 2),
      path: entry.slice(3),
    }));
}

const before = readTrackedChanges();
const unexpected = before.filter(({ path }) => !GENERATED_TRACKED_SOURCE_FILE_SET.has(path));
if (unexpected.length > 0) {
  console.error(
    [
      '[ci] refusing to restore generated source evidence because unexpected tracked changes exist:',
      ...unexpected.map(({ status, path }) => `  ${status} ${path}`),
    ].join('\n'),
  );
  process.exit(1);
}

const pathsToRestore = before.map(({ path }) => path);
if (pathsToRestore.length > 0) {
  execFileSync('git', ['restore', '--source=HEAD', '--', ...pathsToRestore], {
    stdio: 'inherit',
  });
}

const after = readTrackedChanges();
if (after.length > 0) {
  console.error(
    [
      '[ci] generated source evidence restore left tracked changes behind:',
      ...after.map(({ status, path }) => `  ${status} ${path}`),
    ].join('\n'),
  );
  process.exit(1);
}

console.log(
  pathsToRestore.length === 0
    ? '[ci] generated source evidence already clean'
    : `[ci] restored generated source evidence: ${pathsToRestore.join(', ')}`,
);
