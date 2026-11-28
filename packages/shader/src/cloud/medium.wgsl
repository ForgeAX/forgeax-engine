#define_import_path forgeax_cloud::medium
#import forgeax_cloud::coordinates::{cloud_model_position, cloud_distance_fade}

struct MediumSample {
    extinctionPerMeter: f32,
    albedo: vec3f,
    emissivePerMeter: vec3f,
    materialAO: f32,
};

fn cloud_in_layer(heightFraction: f32) -> bool {
    return heightFraction >= 0.0 && heightFraction <= 1.0;
}

fn evaluate_uniform_conservative(sample: MediumSample, heightFraction: f32) -> vec4f {
    let occupied = cloud_in_layer(heightFraction)
        && (sample.extinctionPerMeter > 0.0 || any(sample.emissivePerMeter > vec3f(0.0)));
    return vec4f(select(0.0, 1.0, occupied), 0.0, 0.0, 0.0);
}

fn evaluate_uniform_medium(sample: MediumSample, heightFraction: f32) -> MediumSample {
    if (cloud_in_layer(heightFraction)) {
        return sample;
    }
    return MediumSample(0.0, vec3f(0.0), vec3f(0.0), 1.0);
}

struct CloudDensityPoint {
    positionMeters: vec3f,
    cameraRelativeMeters: vec3f,
    heightFraction: f32,
    windOffsetMeters: vec3f,
};

struct CloudDensityControls {
    layoutScaleMeters: f32,
    coverageBias: f32,
    extinctionPerMeter: f32,
    albedo: vec4f,
    layoutWeight: f32,
    maskWeight: f32,
    profileWeight: f32,
    bodyWeight: f32,
    erosionWeight: f32,
};

const REFERENCE_MASK_STRENGTH: f32 = 0.01;

fn cloud_max3(value: vec3f) -> f32 {
    return max(max(value.x, value.y), value.z);
}

fn cloud_profile_lookup(
    profile: texture_2d<f32>, wrapSampler: sampler, height: f32, pattern: f32,
) -> vec4f {
    return textureSampleLevel(profile, wrapSampler, vec2f(height, pattern), 0.0);
}

// Simulation Blank defaults: StormClouds=0 and identity placement/per-type scale.
// The Demo's independent mask control has its own typed contribution; it is not coverage.
fn evaluate_reference_conservative(
    point: CloudDensityPoint,
    controls: CloudDensityControls,
    pattern: texture_2d<f32>,
    mask: texture_2d<f32>,
    profile: texture_2d<f32>,
    body: texture_3d<f32>,
    wrapSampler: sampler,
    useDetail: bool,
) -> vec4f {
    let h = point.heightFraction;
    if h != h {
        return vec4f(0.0);
    }
    let coord = cloud_model_position(point.positionMeters) / controls.layoutScaleMeters
        + vec3f(0.5, 0.5, 0.0);
    let wind = cloud_model_position(point.windOffsetMeters) / controls.layoutScaleMeters;
    // Subtract_6 removes SkyTexScale's half-period offset for Pattern/Mask only.
    // Time affects the noise coordinates, not the frozen layout transform.
    let layoutUv = coord.xy - vec2f(0.5);
    let layoutTexel = textureSampleLevel(pattern, wrapSampler, layoutUv, 0.0);
    // Sample_25.R / Sample_20.G / Sample_26.B coincide in UV for the frozen scales.
    // A is the separate storm branch and does not participate in this default.
    let layoutValues = mix(vec3f(0.58), layoutTexel.rgb, controls.layoutWeight);
    let carrier = cloud_max3(layoutValues);
    let maskTexel = textureSampleLevel(mask, wrapSampler, coord.xy, 0.0);
    // AppendVector_8/7/4 put normalized height first, then the respective pattern value.
    let profiled = vec3f(
        cloud_profile_lookup(profile, wrapSampler, h, layoutValues.x).r,
        cloud_profile_lookup(profile, wrapSampler, h, layoutValues.y).g,
        cloud_profile_lookup(profile, wrapSampler, h, layoutValues.z).b,
    );
    let vertical = mix(0.8, cloud_max3(profiled), controls.profileWeight) - 0.5;
    // The XY mask adds density only within the local profile's vertical support.
    let maskSupport = smoothstep(0.0, REFERENCE_MASK_STRENGTH, vertical);
    let maskContribution = REFERENCE_MASK_STRENGTH * controls.maskWeight * maskSupport
        * dot(maskTexel.rgb, vec3f(0.40, 0.35, 0.25));

    // Add_13 / Sample_12.R warp Add_24 / Sample_9.G. Wind displacement is already
    // integrated by the owner, so this evaluation applies each graph multiplier once.
    let noise2Uv = coord * vec3f(60.0, 60.0, 75.0) - 6.0 * wind;
    let distortion = (textureSampleLevel(body, wrapSampler, noise2Uv, 0.0).r - 0.8)
        * 0.08 * controls.erosionWeight;
    let heightScale = 0.05 + h * 0.95;
    let hWarp = 2.0 * abs(heightScale - 0.5);
    let noise1Uv = coord * vec3f(4.167, 4.444, 9.091) + 7.0 * wind
        + distortion * vec3f(heightScale, heightScale, hWarp * hWarp);
    let bodyG = textureSampleLevel(body, wrapSampler, noise1Uv, 0.0).g;
    var detail = 0.8 * ((bodyG - 0.5) * controls.bodyWeight + controls.coverageBias);
    if useDetail {
        let noise3Uv = coord * vec3f(30.0, 40.0, 25.0) + 8.0 * wind;
        let noise3 = textureSampleLevel(body, wrapSampler, noise3Uv, 0.0).b;
        // StaticSwitchParameter_0 / Add_19, with independently switchable erosion.
        let third = detail * (0.4 * noise3)
            + 0.03 * (controls.coverageBias + noise3 - 0.5);
        detail = mix(detail, third, controls.erosionWeight);
    }

    // Include the supported mask in the occupancy test so skip-on and skip-off agree.
    let occupied = carrier + maskContribution;
    return vec4f(occupied, carrier, vertical, detail);
}

fn evaluate_reference_medium(
    point: CloudDensityPoint, controls: CloudDensityControls, conservative: vec4f,
) -> MediumSample {
    // x equals the T3D carrier when the mask is disabled, or adds the Demo mask.
    // Keep a gate-independent complete expression for skip-off comparison.
    let maskContribution = max(conservative.x - conservative.y, 0.0);
    let density = max(0.0, maskContribution + conservative.y * (conservative.z + conservative.w));
    // If_1 gates the extinction root, not the conservative payload.
    let heightGate = select(0.0, 1.0, cloud_in_layer(point.heightFraction)
        && abs(point.heightFraction - 0.5) <= 0.48);
    let extinction = clamp(heightGate * density * controls.extinctionPerMeter
        * cloud_distance_fade(point.cameraRelativeMeters), 0.0, 1.0);
    return MediumSample(extinction, controls.albedo.rgb, vec3f(0.0), controls.albedo.a);
}
