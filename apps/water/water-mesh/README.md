# Island watershed · R0–R2

Run the workspace dev command on port 5383. This is the formal combined R0–R2
entry: one App, World and Renderer contains a 960 m textured arc-shaped island Terrain around an inner bay,
an elevated lake at 30 m, a descending River and its ordinary River-to-Ocean
transition. The terminal continuity reach includes the full authored estuary
edge and its paired grid triangles; the transition shares Ocean optics while
the upstream River keeps its flow detail. The Ocean extends 10 km. The timber bridge, lake jetty and shore
vegetation give the watershed human scale. Camera buttons keep the entire
watershed mounted while moving between overview, lake, river, mouth and sea.

The canvas never requests Pointer Lock. Click the scene to focus free flight,
then drag with the left or right mouse button to look around. WASD or arrow keys
move; E, Space or PageUp rise; Q or PageDown descend. Shift triples the current
speed. Scroll over the focused scene to adjust the base speed from 0.5 to 500 m/s;
the hint displays the current speed. Escape, panel focus and window blur stop
navigation. Forms and browser modifier shortcuts retain their normal input.
The five camera buttons restore their saved views without rebuilding the scene.
Camera movement consumes the App-installed frozen InputSnapshot in an Update
system; DOM handlers only manage focus and browser default behavior.

Select an actual Body before changing its water level, conservative wave bound,
priority or surface optics. Geometry edits prepare and atomically adopt a
re-cooked Body/Mesh closure under the existing GUIDs. River width uses the same
publication path. Rejected edits retain accepted content. The scene controls
exercise Zone bind/unbind, Body mount/unmount and instance retirement/recreation.
Terrain A/B and TerrainProvider opt-in share the visible Terrain root.

Three floating rods have matching native cylinder colliders, dynamic RigidBodies
and world-metre buoyancy probes. Query controls expose position, depth, normal,
velocity, full/simple waves and exclusion. The grid switch uses the Water owner's
real tile/LOD overlay. WaterInfo resolution and tessellation change the admitted
Zone workload. Complete owner fields remain in the closed Advanced section.
Large-world full/simple wave observations use the owning Gerstner evaluator at
its real tile boundary; they are numerical observations, not another scene.

The gallery now discovers this combined entry plus R3–R8 and the independent
original R8 coast showcase: eight entries. Earlier R0/R1 sources and standalone
servers remain available for historical regressions and existing sessions, but
are hidden from the formal gallery through package metadata. Synthetic query
fixtures remain clearly distinct from R7's real GPU River Bake.

See [Water](../../../packages/water/README.md) and
[Terrain](../../../packages/terrain/README.md) for ownership and admission.
Raw acceptance images, timings and tapes remain outside this checkout.
