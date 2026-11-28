/** Shared private Screen dispatch records. The published placement/history
 * module's matching WGSL shape is checked by the owning reflection test. */
export const SCREEN_PROBE_WORLD_RECORDS_WGSL = `struct ScreenProbeFrame { extent:vec4u, probes:vec4u, control:vec4u, environment:vec4f, tuning:vec4f, query:vec4u,
 previousViewProjection:mat4x4f, previousCamera:vec4f, expectedSource:vec4u, previousJitter:vec4f }
struct ScreenProbe {
 position:vec3f, distance:f32, normal:vec3f, pixel:u32,
 canonicalLo:vec3u, receiverRow:u32, canonicalHi:vec3u, receiverPrimitive:u32,
 receiverExpected:vec4u, receiverControl:vec4u
}
struct ProbeRay { direction:vec3f, info:u32, radiance:vec3f, hitDistance:f32 }
`;

/** The original Hit64 transport plus the canonical origin enclosure and exact
 * receiver primitive. The paid-root point bank is never redeemed for this ray. */
export const SCREEN_PROBE_RECEIVER_REQUEST_WGSL = `struct ScreenProbeRootRequest {
 expected:vec4u, control:vec4u, payload:array<vec4u,4>,
 originLo:vec3u, receiverRow:u32, originHi:vec3u, receiverPrimitive:u32
}
`;
