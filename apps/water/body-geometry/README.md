# Water Body Geometry

Standalone Water Body scene for River, Lake, Ocean, and Custom geometry. The
Pack publishes each body's cooked render and enabled derived products; the
scene binds available outputs and displays them independently for inspection.

Select a body to inspect its source geometry, undilated and dilated WaterInfo
footprints, query state, and current Physics receipt. River and Lake expose
shape editing and recooking controls. Ocean additionally supports a Scene
`WaterExclusionVolume`; toggling it updates point queries and Ocean Physics
collision. The raycast control queries the selected body's accepted Physics
collision. Custom demonstrates a cooked mesh body.

The fixtures use `affectsLandscape: false`. This Demo presents Body products
only and does not read terrain data. Runtime validates the Zone metadata
contract for a prebuilt Terrain provider; this scene does not paint, update, or
reverse Terrain.

Versioned `ue-water-spline/1` fixtures follow UE 5.8 point modes and distance
reparameterization. Quaternion keys use normalized XYZW engine-basis rotations;
legacy Up and Roll must be baked into the quaternion, then `up` is regenerated
from rotated engine Up and `rollAngle` is set to zero. The spline mesh and its
collision keep UE's fixed Y-up, zero-roll component frame, while WaterInfo uses
the quaternion-derived Up vector for its horizontal lateral.

Run with `pnpm --filter @forgeax/water-body-geometry dev`. Drag the scene to
orbit, use the body list to select or hide bodies, and use the panel toggle to
hide the inspector.
