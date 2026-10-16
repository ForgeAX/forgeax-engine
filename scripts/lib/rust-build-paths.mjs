import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Compiler-owned remapping covers panic locations as well as debug sections. */
export function portableRustFlags(engine, env = process.env, home = homedir()) {
  const overrides = Object.keys(env).filter(
    (name) =>
      env[name] &&
      /^(?:RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_BUILD_RUSTFLAGS|CARGO_TARGET_.*_RUSTFLAGS)$/.test(
        name,
      ),
  );
  if (overrides.length)
    throw new Error(`Unsupported Rust path recipe overrides: ${overrides.sort().join(', ')}`);
  const mappings = new Map();
  // Rust applies the last matching prefix. More specific Cargo and source roots
  // follow the home fallback; include resolved and Windows slash spellings.
  for (const [root, replacement] of [
    [home, '/build/user'],
    [env.RUSTUP_HOME ?? join(home, '.rustup'), '/rust-toolchain'],
    [env.CARGO_HOME ?? join(home, '.cargo'), '/cargo'],
    [engine, '/src/engine'],
    ...(env.CARGO_TARGET_DIR ? [[env.CARGO_TARGET_DIR, '/build/target']] : []),
  ]) {
    const absolute = resolve(root);
    const paths = [absolute];
    try {
      paths.push(realpathSync(absolute));
    } catch {
      /* The compiler may create this root later. */
    }
    for (const path of paths) {
      mappings.set(path, replacement);
      mappings.set(path.replaceAll('\\', '/'), replacement);
    }
  }
  return [...mappings].map(([from, to]) => `--remap-path-prefix=${from}=${to}`).join('\x1f');
}

export function assertPortableRustArtifact(bytes) {
  if (
    /(?:\/(?:data\/)?home\/[^/\s]+|\/Users\/[^/\s]+|[A-Za-z]:[\\/]Users[\\/][^\\/\s]+)/.test(
      bytes.toString('utf8'),
    )
  )
    throw new Error('rust-artifact-machine-path: rebuild with the canonical path remapping recipe');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.stdout.write(portableRustFlags(resolve(process.argv[2])));
