# Runtime vase overlay

Engine-owned test feature, not part of the `game-3d` starter. `installRuntimeVase(root)`
copies `assets/` into a disposable copy of `templates/game-3d` and adds the plugin GUID,
the guide button and its wiring. It covers runtime packs (a native program admitted
after start), `GameHost.port` UI -> engine -> state replies, and the
`game-3d.runtime-vase` read projection used by the Preview, DevKit, Tauri and MCP probes.

If an anchor in the template moves, `installRuntimeVase` throws; update `install.mjs`.
