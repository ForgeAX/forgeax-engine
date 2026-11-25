# Engine Dawn Node provider

`@forgeax/engine-dawn-node` exposes the official `webgpu@0.6.2` Node binding
through the optional `upstream-webgpu` peer. Linux, macOS and Windows load the
prebuilt addon selected by that package. Its Windows release includes DXC.
Browsers supply their own WebGPU.

A frozen Engine workspace install supplies the provider for `pnpm test:dawn`
and the Node-backed smoke roster. In an installed game, the optional peer
enables Node GPU tools such as `model render`, `rhi timing`, RHI replay and
supported build-time texture baking.

```sh
pnpm add -D --save-exact upstream-webgpu@npm:webgpu@0.6.2
pnpm exec forgeax rhi timing frame.rhitape
```

Generated games already allow the upstream package's installation script.
The `game-3d` template uses an available hardware adapter for Convoy AO and
atlas filtering during the asset build. A project without a supported Node
adapter uses the CPU bake. Both paths publish ordinary texture assets to the
project's build cache.
Tape structure remains readable with `rhi summary` and the default
`rhi inspect` fields. Missing or unreadable binary output surfaces as a load
failure with the original cause.

On Metal, passes without GPU work can leave timestamps unwritten. Replay
coverage reports those passes as unmeasured. Live copy timing uses a private
compute dispatch for its boundary markers.

The hosted Windows Dawn lane selects Microsoft WARP and passes Dawn's
`d3d_skip_shader_optimizations` toggle through its test setup. The ordinary
hardware path uses the upstream defaults.
