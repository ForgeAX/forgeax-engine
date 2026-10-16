import { readFile, stat } from 'node:fs/promises';
import { defineFeature } from '../../lab/feature';

const ROOT = new URL('../../../../../', import.meta.url);
const PIN = '30.0.1';

async function text(relative: string): Promise<string | undefined> {
  try {
    return await readFile(new URL(relative, ROOT), 'utf8');
  } catch {
    return undefined;
  }
}

async function exists(relative: string): Promise<boolean> {
  try {
    await stat(new URL(relative, ROOT));
    return true;
  } catch {
    return false;
  }
}

function lockVersion(lock: string, name: string): string | undefined {
  const match = new RegExp(
    `\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"(\\nsource = "([^"]+)")?`,
  ).exec(lock);
  if (match === null) return undefined;
  return match[3] === undefined ? match[1] : `${match[1]} (${match[3]})`;
}

export default defineFeature({
  title: 'Native wgpu source pin',
  catalog: 'Native wgpu source pin',
  kind: 'headless',
  summary:
    'The private native wgpu owner builds against the maintained third_party/wgpu gitlink at an exact version instead of a crates.io range; the SDK source snapshot expands the same tree.',
  expect:
    'Every wgpu/naga dependency in packages/rhi-wgpu-native/Cargo.toml is `=30.0.1` with a third_party/wgpu path, Cargo.lock resolves wgpu and naga to 30.0.1 from the path (no registry source), and the gitlink or expanded source reports workspace version 30.0.1.',
  async run(checks) {
    const manifest = await text('packages/rhi-wgpu-native/Cargo.toml');
    checks.ok('rhi-wgpu-native Cargo.toml readable', manifest !== undefined);
    if (manifest === undefined) return;
    const deps = manifest.split('\n').filter((line) => /^(wgpu|naga) = /.test(line));
    checks.ok('wgpu and naga dependencies declared', deps.length >= 2, deps.join(' | '));
    checks.ok(
      `every wgpu/naga dependency pins =${PIN}`,
      deps.length > 0 && deps.every((line) => line.includes(`version = "=${PIN}"`)),
      deps.join(' | '),
    );
    checks.ok(
      'every wgpu/naga dependency uses the third_party/wgpu path',
      deps.length > 0 && deps.every((line) => line.includes('path = "../../third_party/wgpu/')),
      deps.join(' | '),
    );

    const lock = await text('packages/rhi-wgpu-native/Cargo.lock');
    checks.ok('Cargo.lock readable', lock !== undefined);
    if (lock !== undefined) {
      checks.equal('Cargo.lock wgpu resolves to the path pin', lockVersion(lock, 'wgpu'), PIN);
      checks.equal('Cargo.lock naga resolves to the path pin', lockVersion(lock, 'naga'), PIN);
    }

    const gitmodules = await text('.gitmodules');
    const publicSource = await exists('.forgeax-public-distribution');
    checks.ok(
      'third_party/wgpu is a gitlink (or expanded in public SDK source)',
      publicSource || (gitmodules?.includes('path = third_party/wgpu') ?? false),
      publicSource ? 'public SDK source mode' : 'contributor checkout',
    );
    const workspace = await text('third_party/wgpu/Cargo.toml');
    checks.ok(
      'third_party/wgpu materialized',
      workspace !== undefined,
      'run `git submodule update --init third_party/wgpu`',
    );
    if (workspace !== undefined) {
      const version = /\[workspace\.package\][\s\S]*?\nversion = "([^"]+)"/.exec(workspace)?.[1];
      checks.equal('third_party/wgpu workspace version', version, PIN);
    }
  },
});
