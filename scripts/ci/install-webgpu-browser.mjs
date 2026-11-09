import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const rosterPath = fileURLToPath(new URL('./webgpu-browser-roster.json', import.meta.url));

export function browserEntry(roster, id) {
  if (roster.schemaVersion !== 1 || roster.platform !== 'linux64')
    throw new Error('Unsupported browser roster');
  const row = Object.hasOwn(roster.browsers ?? {}, id) ? roster.browsers[id] : undefined;
  if (
    !row ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(row.version) ||
    !/^[a-f0-9]{64}$/.test(row.sha256) ||
    !Number.isSafeInteger(row.bytes) ||
    row.bytes <= 0 ||
    row.bytes > 300_000_000
  ) {
    throw new Error(`Invalid pinned browser: ${id}`);
  }
  return {
    ...row,
    url: `https://storage.googleapis.com/chrome-for-testing-public/${row.version}/linux64/chrome-linux64.zip`,
  };
}

export function verifyBrowserVersion(actual, expected) {
  if (actual.trim().match(/\b\d+\.\d+\.\d+\.\d+\b/)?.[0] !== expected) {
    throw new Error(`Browser version mismatch: expected ${expected}, received ${actual.trim()}`);
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function admit(directory, entry) {
  const executable = join(directory, 'chrome-linux64/chrome');
  const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
  if (
    receipt.archiveSha256 !== entry.sha256 ||
    receipt.version !== entry.version ||
    receipt.executableSha256 !== sha256(executable) ||
    receipt.sandboxSha256 !== sha256(join(directory, 'chrome-linux64/chrome_sandbox'))
  )
    throw new Error('Pinned browser cache failed integrity verification');
  verifyBrowserVersion(
    execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000 }),
    entry.version,
  );
  return executable;
}

export async function installBrowser(entry, cacheRoot) {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error('Pinned CfT carrier requires Linux x64');
  const root = resolve(cacheRoot);
  const directory = join(root, `${entry.version}-${entry.sha256.slice(0, 16)}`);
  mkdirSync(root, { recursive: true });
  if (existsSync(directory)) return admit(directory, entry);
  const temp = mkdtempSync(join(root, '.install-'));
  try {
    const archive = join(temp, 'chrome.zip');
    const response = await fetch(entry.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body)
      throw new Error(`Browser download failed: HTTP ${response.status}`);
    const hash = createHash('sha256');
    const file = await open(archive, 'wx');
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > entry.bytes) throw new Error('Browser archive exceeds its pinned size');
        hash.update(chunk);
        await file.writeFile(chunk);
      }
    } finally {
      await file.close();
    }
    if (bytes !== entry.bytes || hash.digest('hex') !== entry.sha256)
      throw new Error('Browser archive checksum mismatch');
    execFileSync('unzip', ['-q', archive, '-d', temp], { timeout: 30_000 });
    rmSync(archive);
    const executable = join(temp, 'chrome-linux64/chrome');
    writeFileSync(
      join(temp, 'receipt.json'),
      JSON.stringify({
        version: entry.version,
        archiveSha256: entry.sha256,
        executableSha256: sha256(executable),
        sandboxSha256: sha256(join(temp, 'chrome-linux64/chrome_sandbox')),
      }),
    );
    admit(temp, entry);
    try {
      renameSync(temp, directory);
    } catch (error) {
      if (!existsSync(directory)) throw error;
      // A concurrent installer may have admitted the same immutable artifact.
    }
    return admit(directory, entry);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  const id = process.argv[2];
  if (process.argv.length !== 3)
    throw new Error('usage: node scripts/ci/install-webgpu-browser.mjs stable|reference|legacy');
  const entry = browserEntry(JSON.parse(readFileSync(rosterPath, 'utf8')), id);
  const executable = await installBrowser(
    entry,
    process.env.FORGEAX_COMPAT_BROWSER_CACHE ?? join(homedir(), '.cache/forgeax-webgpu-browsers'),
  );
  if (/[\r\n]/.test(executable)) throw new Error('Browser path must fit one output line');
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `executable=${executable}\nversion=${entry.version}\nsandbox=${join(executable, '..', 'chrome_sandbox')}\n`,
    );
  console.log(
    JSON.stringify({ browser: id, version: entry.version, sha256: entry.sha256, executable }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
