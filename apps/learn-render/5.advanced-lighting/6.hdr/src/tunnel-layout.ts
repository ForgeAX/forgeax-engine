// LO 5.6 tunnel depth layout shared by the scene and its regression test.
//
// The camera starts at z=0 looking down -Z toward the far end at z=-50. The
// tunnel entrance extends behind the camera instead of lying on its eye plane:
// a wall vertex at view depth 0 has clip w = 0, and Mali WebGL2 (Quark)
// mis-interpolates varyings across every triangle touching such a vertex,
// splitting each wall face into two differently lit triangles (four bright
// wedges converging on the far light). Desktop GPUs clip it cleanly.
export const CAMERA_POS_Z = 0.0;
export const CAMERA_NEAR = 0.1;

export const TUNNEL_FAR_Z = -50.0;
export const TUNNEL_ENTRANCE_Z = 1.0;
export const TUNNEL_SCALE_Z = TUNNEL_ENTRANCE_Z - TUNNEL_FAR_Z;
export const TUNNEL_POS_Z = (TUNNEL_ENTRANCE_Z + TUNNEL_FAR_Z) / 2;
