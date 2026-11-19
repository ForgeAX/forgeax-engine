import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
export const GPU_RUNTIME_DIR = join(homedir(), '.cache', 'forgeax-performance', 'gpu-1');
const PACKAGES = [
  [
    'echarts',
    '6.1.0',
    'dist/echarts.min.js',
    'echarts.min.js',
    'LICENSE',
    'NOTICE',
    'sha512-q0yaFPggC9FUdsWH4blavRWFmxdrIodbkoKNAjJudAI6CA9gNPxHtV2RcZNEepZVlk4yvBYkOkbk6HIVpIyHZA==',
  ],
  [
    'cytoscape',
    '3.35.0',
    'dist/cytoscape.min.js',
    'cytoscape.min.js',
    'LICENSE',
    null,
    'sha512-sMvBIXiGMnhkCaWz2R06FwF/27MNlS+Tqvi17foO9UhnUg3XGZccKjxsvEqQFAQYMSSZmN5SxYzUYlQ0DOJJ3g==',
  ],
  [
    'elkjs',
    '0.12.1',
    'lib/elk.bundled.js',
    'elk.bundled.js',
    'LICENSE.md',
    null,
    'sha512-IhMYKHE4S2vtx0QrhBP3lYOIKDeIiJXBrdq9MGYkuB8ZHqhrBnHNfSUndjXFewrX1CPK8chwq+2NA0K0hliYuw==',
  ],
  [
    'cytoscape-elk',
    '2.4.0',
    'dist/cytoscape-elk.js',
    'cytoscape-elk.js',
    'LICENSE',
    null,
    'sha512-r92FRISDqTTgvxYwGDUAjW6Zu2Lfl0nq7tezQQ5FA5tsWy6iL7gfVqvfZiYUsYO3GSb+dSbVImHgWRQxAYWy5Q==',
  ],
];
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Fixed published archives, verified before extracting only named regular members. No install scripts. */
export async function setupGpuRuntime(directory = GPU_RUNTIME_DIR) {
  const temporary = await mkdtemp(join(tmpdir(), 'forgeax-gpu-vendor-'));
  try {
    const manifest = { schemaVersion: 1, packages: [], files: [] };
    const outputs = [];
    let notices = '';
    for (const [name, version, member, output, license, notice, integrity] of PACKAGES) {
      const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw Error('Runtime download failed: ' + name + ' ' + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if ('sha512-' + createHash('sha512').update(bytes).digest('base64') !== integrity)
        throw Error('Runtime integrity mismatch: ' + name);
      const archive = join(temporary, name + '.tgz');
      await writeFile(archive, bytes);
      const extract = async (path) =>
        (
          await run('tar', ['-xOf', archive, 'package/' + path], {
            encoding: 'buffer',
            maxBuffer: 30 * 1024 * 1024,
            timeout: 60000,
          })
        ).stdout;
      const script = await extract(member);
      outputs.push([output, script]);
      notices += '\n\n' + name + '@' + version + '\n' + (await extract(license)).toString();
      if (notice) notices += '\n' + (await extract(notice)).toString();
      manifest.packages.push({ name, version, url, integrity });
    }
    outputs.push(['NOTICES.txt', Buffer.from(notices)]);
    await mkdir(directory, { recursive: true });
    for (const [file, bytes] of outputs) {
      await writeFile(join(directory, file), bytes);
      manifest.files.push({ file, sha256: sha(bytes), bytes: bytes.length });
    }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { directory, manifest };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function loadGpuRuntime(directory = GPU_RUNTIME_DIR) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  } catch {
    throw Error('GPU runtimes are missing; run gpu.mjs setup [--runtime-dir DIR] once');
  }
  const scripts = [];
  let notices = '';
  for (const file of [
    'echarts.min.js',
    'cytoscape.min.js',
    'elk.bundled.js',
    'cytoscape-elk.js',
    'NOTICES.txt',
  ]) {
    const bytes = await readFile(join(directory, file));
    if (manifest.files?.find((f) => f.file === file)?.sha256 !== sha(bytes))
      throw Error('GPU runtime hash mismatch: ' + file);
    if (file === 'NOTICES.txt') notices = bytes.toString();
    else scripts.push('data:application/javascript;base64,' + bytes.toString('base64'));
  }
  return { scripts, notices, manifest };
}
