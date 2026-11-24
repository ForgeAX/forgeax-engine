# R6 local fluid basins

Run `pnpm dev` and open port 5386. Two stone basins compare ripple and shallow
fluid. The left Ripple solver uses constant depth; the right Shallow solver uses
Terrain-derived depth, with gravity-driven velocity and wet/dry boundaries.
Both explicitly select fluid kernel version 2. Its Shallow displacement uses
free-surface elevation, so the sloping bed does not tilt the resting surface.
Authored injector, obstacle and gauge
assemblies keep the source location and waterline visible. Controls expose the
accepted recipe, injection, collision, material and camera parameters. The
runtime panel follows mounted entities and counts only completed ready frames.

The paired basins sit inside an illuminated, limestone-lined laboratory. The
room is ordinary scene presentation; each basin retains its authored fluid,
Terrain depth and material outputs. Overview and basin views frame the actual
simulation and its source gauges.
The basin floor uses an ordinary textured Terrain layer with its texture included
in the Pack's cook closure. This changes surface appearance without changing
the sampled depth, injection locations or simulation recipes.

See [Water](../../../packages/water/README.md) for source ownership and the
independent material-output boundary.

The floating settings panel groups interaction, observation and quality by
visible purpose; full Engine parameters are an explicit advanced inspector.
Shared navigation uses WASD/arrows, drag look, E/Q or Space/Page keys, Shift and
wheel travel speed without pointer capture or pointer lock. Panel focus releases
acquired input. Four quality choices edit the accepted Water source configuration.
