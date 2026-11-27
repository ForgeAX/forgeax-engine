import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sha = /^[0-9a-f]{40}$/;

export function comparedCiInputs(root, environment = process.env) {
  if (!['pull_request', 'push'].includes(environment.GITHUB_EVENT_NAME)) return undefined;
  try {
    const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, 'utf8'));
    const { GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: kind } = environment;
    if (
      (kind === 'pull_request' &&
        (event.pull_request?.base?.ref !== 'main' ||
          event.pull_request.base.repo.full_name !== repository)) ||
      (kind === 'push' && event.ref !== 'refs/heads/main')
    )
      return undefined;

    const git = ciInputGit(root);
    const target = git('rev-parse', 'HEAD').trim();
    const base = kind === 'pull_request' ? event.pull_request.base.sha : event.before;
    const head = kind === 'pull_request' ? event.pull_request.head.sha : event.after;
    if (!sha.test(base) || !sha.test(head) || /^0+$/.test(base) || head !== target)
      return undefined;
    const files = changedCiInputs(root, base, target);
    return files && { base, target, files };
  } catch {
    return undefined;
  }
}

function ciInputGit(root) {
  return (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
}

export function changedCiInputs(root, base, target) {
  if (!sha.test(base) || !sha.test(target)) return undefined;
  const git = ciInputGit(root);
  try {
    try {
      git('cat-file', '-e', `${base}^{commit}`);
    } catch {
      git('fetch', '--no-tags', '--depth=1', 'origin', base);
    }
    const fields = git('diff', '--no-renames', '--name-status', '-z', base, target)
      .split('\0')
      .slice(0, -1);
    if (fields.length % 2 !== 0) return undefined;
    const files = [];
    for (let index = 0; index < fields.length; index += 2)
      files.push({ status: fields[index], path: fields[index + 1] });
    return files;
  } catch {
    return undefined;
  }
}

// Runtime implementation edits can use dependency-based validation. A new
// path, test, generated input, or unknown root invalidates the narrow route.
export function internalSourceOwners(files) {
  const owners = new Set();
  for (const file of files) {
    if (/^(?:skills\/.+|(?:packages\/[^/]+\/)?README(?:\.[^.]+)?)\.md$/.test(file.path)) continue;
    const owner = /^packages\/([^/]+)\/src\/(.+\.tsx?)$/.exec(file.path);
    if (file.status !== 'M' || !owner || /(?:^|\/)__tests__\/|\.test\.[^.]+$/.test(owner[2]))
      return undefined;
    owners.add(owner[1]);
  }
  return owners;
}

// A changed import/export route can make a cold or native consumer newly
// reachable. The narrowed plans only admit modified files with stable edges.
export function unchangedModuleEdges(root, comparison, path) {
  if (!sha.test(comparison.base) || !sha.test(comparison.target)) return false;
  try {
    const git = ciInputGit(root);
    const ts = require('typescript');
    const edges = (source) => {
      const syntax = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      if (syntax.parseDiagnostics.length > 0) throw new Error('invalid TypeScript');
      const result = [];
      const visit = (node) => {
        if (
          ts.isImportDeclaration(node) ||
          ts.isExportDeclaration(node) ||
          ts.isImportEqualsDeclaration(node) ||
          ts.isImportTypeNode(node) ||
          (ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              ['require', 'require.resolve', 'import.meta.resolve'].includes(
                node.expression.getText(syntax),
              )))
        ) {
          result.push(node.getText(syntax));
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(syntax);
      const { referencedFiles, typeReferenceDirectives, libReferenceDirectives } =
        ts.preProcessFile(source, false);
      return JSON.stringify([
        result,
        ...[referencedFiles, typeReferenceDirectives, libReferenceDirectives].map((rows) =>
          rows.map(({ fileName }) => fileName),
        ),
      ]);
    };
    return (
      edges(git('show', `${comparison.base}:${path}`)) ===
      edges(git('show', `${comparison.target}:${path}`))
    );
  } catch {
    return false;
  }
}

const withoutViewImplementation =
  /^packages\/(?:animation|audio|ecs|geometry|math|navigation|path|picking|skinning|state)\/src\/(?!(?:.*\/)?(?:__tests__\/|index\.ts$))(?!.*(?:\.test\.|\.d\.ts$)).+\.ts$/;

export function engineWithoutViewRequired(comparison, keepsModuleEdges = () => false) {
  return (
    !comparison ||
    comparison.files.some(({ path, status }) => {
      if (
        /^(?:tools\/view$|skills\/.*\.md$|(?:packages\/[^/]+\/)?README(?:\.[^.]+)?\.md$)/.test(path)
      )
        return false;
      return status !== 'M' || !withoutViewImplementation.test(path) || !keepsModuleEdges(path);
    })
  );
}
