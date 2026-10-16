import { execFileSync } from 'node:child_process';
import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceExtensions = new Set([
  '.cjs',
  '.js',
  '.mjs',
  '.mts',
  '.py',
  '.sh',
  '.ts',
  '.tsx',
  '.wgsl',
]);

const retainedEvidenceInputs = new Set([
  'apps/bevy/fog/evidence/manifest.json',
  'apps/hello/physical-material/evidence/case-input.json',
  'apps/hello/physical-material/evidence/case-manifest.json',
  'apps/hello/physical-material/evidence/manifest.json',
  'apps/hello/physical-material/evidence/reference-environment.json',
  'apps/hello/physical-material/evidence/reference-linear-hdr.json',
  'apps/hello/ssr/evidence/visual-cases.json',
  'apps/hello/taa/evidence/manifest.json',
  'apps/hello/taa/evidence/visual-cases.json',
]);

export function isEvidenceUpload(path) {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const parts = normalized.split('/');
  const file = basename(normalized);
  const extension = extname(normalized).toLowerCase();
  const inEvidenceDirectory = parts.some((part) => /evidence/i.test(part));
  const inArtifactsDirectory = parts.some((part) => /^artifacts?$/i.test(part));
  const namedAsEvidence = /(?:^|[-_.])evidence(?:[-_.]|$)/i.test(file);
  if (!inEvidenceDirectory && !namedAsEvidence && !inArtifactsDirectory) return false;
  if (inArtifactsDirectory) return true;
  if (sourceExtensions.has(extension)) return false;
  if (
    !inArtifactsDirectory &&
    (file.toLowerCase().endsWith('.schema.json') || file === 'schema.json')
  )
    return false;
  if (!inArtifactsDirectory && parts.includes('__tests__')) return false;
  if (retainedEvidenceInputs.has(normalized)) return false;
  return true;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function resolveBase() {
  const requested = process.env.FORGEAX_EVIDENCE_GUARD_BASE;
  if (requested && /^[0-9a-f]{7,40}$/i.test(requested)) {
    try {
      return git('rev-parse', '--verify', `${requested}^{commit}`);
    } catch {
      // Resolve the checked-out remote base below when the event SHA is absent.
    }
  }
  const remote = process.env.GITHUB_BASE_REF;
  if (remote) {
    try {
      return git('merge-base', 'HEAD', `origin/${remote}`);
    } catch {
      // The checkout may not carry the event's remote-tracking branch.
    }
  }
  return git('merge-base', 'HEAD', 'origin/main');
}

function changedPaths(base) {
  const output = execFileSync(
    'git',
    ['diff', '--name-status', '-z', '--no-renames', '--diff-filter=ACMRT', `${base}...HEAD`],
    { encoding: 'utf8' },
  );
  const fields = output.split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < fields.length; index += 2) paths.push(fields[index + 1]);
  return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const base = resolveBase();
    const forbidden = changedPaths(base).filter(isEvidenceUpload);
    if (forbidden.length > 0) {
      console.error('Generated evidence files cannot be committed:');
      for (const path of forbidden) console.error(`  ${path}`);
      console.error(
        'Keep run output outside the repository or in the ignored root artifacts/ directory.',
      );
      process.exitCode = 1;
    } else {
      console.log('No generated evidence files are added or modified.');
    }
  } catch (error) {
    console.error(`Evidence upload check could not verify the change set: ${error.message}`);
    process.exitCode = 1;
  }
}
