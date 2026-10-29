# @forgeax/engine-physics-rapier2d

```ts
import physics2d from '@forgeax/engine/physics-rapier2d';

const app = await createApp(canvas, { plugins: [physics2d] });
```

The default plugin owns only Rapier2D. Its module dependency is static;
WASM initializes lazily during activation. The shared physics contract imports no backend.

Rapier 0.20 / WASM backend for the realm-neutral [Physics contract](../physics/README.md).
Install `physics2d`; fixed systems project Scene/RigidBody/Collider
state, perform one solver step per fixed iteration, and write dynamic poses back
to Scene. Two-dimensional writeback preserves the authored Transform z coordinate.
World owns scheduling and time; the backend owns native bodies and their cleanup.
The KCC enables native contact impulses for dynamic-body pushing, matching 3D;
sensor obstacles remain excluded without game-side duplicate impulses.

The default `loadRapier2D()` uses the self-contained package-local browser module.
Native targets select `forgeax-native` and call `initializeNativeRapier2D(host)`
from `@forgeax/engine-physics-rapier2d/native` before activating the plugin.
`PhysicsWasmHost.readWasm()` and `instantiate(imports)` must use the same immutable
package path or bytes. Length and SHA-256 validation precede instantiation.
`now()` supplies the Host's monotonic, finite, nonnegative milliseconds. The
generated binding directs its native Performance import to that explicit clock;
it requires no global `performance` and leaves the World's fixed delta unchanged.
Ordinary loading shares the initialized realm-local module; missing initialization
and rejected attempts return `PhysicsError` with `code: 'wasm-load-failed'`.
Failures can retry, concurrent initializers share one attempt, and successful
initialization remains fixed for that realm.

Package `prebuild` uses the shared pinned Rust producer under
`physics-rapier3d/scripts/build-wasm.mjs --2d` to generate both transports, their
matching WASM, declarations, license and source/toolchain provenance under `pkg/`.
The dimension-specific locked manifest and Cargo lockfile live beside that producer.
2D retains its pinned upstream solver behavior; the maintained 3D patches remain
specific to the 3D output.
Compiler path remapping covers the source, Cargo registry, toolchain and builder
home; all WASM bytes are checked for machine paths before cache admission.
SDK and CI artifact inventories include the complete bundle. No global WebAssembly
replacement or base64 compat payload enters the native
bundle. See the shared [native Host contract and real 60-step gate](../physics-rapier3d/README.md#native-wasm-hosts).

```sh
pnpm exec vitest run --config packages/physics-rapier2d/vitest.config.ts \
  packages/physics-rapier2d --maxWorkers=2
```
