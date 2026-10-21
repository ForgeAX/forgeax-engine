import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
};
run(process.execPath, ['scripts/build-wasm.mjs', '--ensure']);
const provenance = JSON.parse(await readFile(resolve(root, 'pkg/provenance.json'), 'utf8'));
const source = resolve(root, '.wasm-build', provenance.contentKey, 'parry');
if (!existsSync(resolve(source, 'crates/parry3d/Cargo.toml'))) {
  run(process.execPath, ['scripts/build-wasm.mjs']);
}
const harness = resolve(source, '..', 'penetration-bound-tests');
await mkdir(resolve(harness, 'src'), { recursive: true });
// Compile the owning file and its private utilities unchanged, without pulling
// the upstream workspace's graphical test/dev dependencies into this CPU gate.
await writeFile(
  resolve(harness, 'Cargo.toml'),
  `[package]
name = "penetration-bound-tests"
version = "0.0.0"
edition = "2024"
[features]
default = ["dim3", "f32"]
dim3 = []
dim2 = []
f32 = []
[dependencies]
parry3d = { path = ${JSON.stringify(resolve(source, 'crates/parry3d'))} }
num = { package = "num-traits", version = "0.2" }
simba = "0.10"
log = "0.4"
`,
);
await writeFile(
  resolve(harness, 'src/lib.rs'),
  `#![allow(dead_code)]
pub use parry3d::{math, query, shape};
mod utils {
    #[path = ${JSON.stringify(resolve(source, 'src/utils/wops.rs'))}]
    mod wops;
    #[path = ${JSON.stringify(resolve(source, 'src/utils/inv.rs'))}]
    mod inverse;
    pub(crate) use wops::WCross;
    pub(crate) use inverse::inv;
}
#[path = ${JSON.stringify(resolve(source, 'src/query/nonlinear_shape_cast/nonlinear_shape_cast_support_map_support_map.rs'))}]
mod owner;
`,
);
run('cargo', [
  `+${provenance.source.rust}`,
  'test',
  '--release',
  '--manifest-path',
  resolve(harness, 'Cargo.toml'),
  '--jobs',
  '4',
  'penetration_motion_bound_tests',
]);
