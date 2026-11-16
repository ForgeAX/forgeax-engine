# Water Body Geometry

The single R1 scene combines River, Lake, Ocean and Custom geometry with the
TerrainProvider lifecycle in the same World. The geometry view frames the four
independent products; the riverbed view exposes the visible authored Terrain,
its A/B revision selector and provider mount/retirement. The
Pack publishes each body's cooked render and enabled derived products; the
scene binds available outputs and displays them independently for inspection.

The products and riverbed occupy connected, framed plinths inside an illuminated
museum. This ordinary architecture supplies physical context and material
detail while leaving the generated Water geometry and diagnostics inspectable.
Product close views retain the selected plinth and surrounding room. The riverbed
edge follows the accepted Terrain heights on A/B replacement; it is supporting
architecture, separate from the Terrain provider's depth and collision outputs.

The river geometry material preserves the cooked mesh's flow attributes while
shading its shape with the authored Standard surface module. Flow-encoded
`COLOR_0` is not interpreted as an albedo tint. Recooking retains each generated
mesh's explicit material reference and the accepted material publication.

Select a body to inspect its source geometry, undilated and dilated WaterInfo
footprints, query state, and current Physics receipt. River and Lake expose
shape editing and recooking controls. Ocean additionally supports a Scene
`WaterExclusionVolume`; toggling it updates point queries and Ocean Physics
collision. The raycast control queries the selected body's accepted Physics
collision. Custom demonstrates a cooked mesh body.

The geometry fixtures use `affectsLandscape: false`. The separate riverbed
exercises visible prebuilt Terrain input and the Zone's accepted provider
versions, bounds and generations. It does not paint or reverse Terrain.

Versioned `ue-water-spline/1` fixtures follow UE 5.8 point modes and distance
reparameterization. Quaternion keys use normalized XYZW engine-basis rotations;
legacy Up and Roll must be baked into the quaternion, then `up` is regenerated
from rotated engine Up and `rollAngle` is set to zero. The spline mesh and its
collision keep UE's fixed Y-up, zero-roll component frame, while WaterInfo uses
the quaternion-derived Up vector for its horizontal lateral.

Run with `pnpm --filter @forgeax/water-body-geometry dev`. Drag the scene to
orbit, use the body list to select or hide bodies, and use the panel toggle to
hide the inspector.
