#define_import_path forgeax_cloud::coordinates

fn cloud_relative_position(positionMeters: vec3f, cameraMeters: vec3f) -> vec3f {
    return positionMeters - cameraMeters;
}

fn cloud_model_position(positionMeters: vec3f) -> vec3f {
    return vec3f(-positionMeters.z, positionMeters.x, positionMeters.y);
}

fn cloud_height_fraction(altitudeMeters: f32, bottomMeters: f32, thicknessMeters: f32) -> f32 {
    return (altitudeMeters - bottomMeters) / thicknessMeters;
}

fn cloud_distance_fade(relativeMeters: vec3f) -> f32 {
    return min(1.0, length(relativeMeters) * 0.002);
}

fn cloud_advected_model_position(
    positionMeters: vec3f, windMetersPerSecond: vec3f, seconds: f32,
) -> vec3f {
    return cloud_model_position(positionMeters - windMetersPerSecond * seconds);
}
