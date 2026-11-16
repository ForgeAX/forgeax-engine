#define_import_path game_3d::paving_texture

struct PavingParameters {
    tileColor: vec4<f32>,
    tileContrast: f32,
    _textureSize: vec2<f32>,
};
@group(0) @binding(0) var<uniform> params: PavingParameters;

// Author the swatch in sRGB; shading and mip generation operate in linear light.
fn srgb_to_linear(color: vec3<f32>) -> vec3<f32> {
    return select(color / 12.92, pow((color + 0.055) / 1.055, vec3<f32>(2.4)),
        color > vec3<f32>(0.04045));
}

@fragment
fn paving(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let tiles = position.xy / params._textureSize * 2.0;
    let local = fract(tiles);
    let edge = min(local, vec2<f32>(1.0) - local);
    let texel = 2.0 / params._textureSize;
    let interior = smoothstep(vec2<f32>(0.008) - texel, vec2<f32>(0.008) + texel, edge);
    let joint = 1.0 - min(interior.x, interior.y);
    let cell = vec2<u32>(floor(tiles));
    let checker = f32((cell.x + cell.y) % 2u) * 2.0 - 1.0;
    let base = srgb_to_linear(params.tileColor.rgb);
    let stone = base * (1.0 + checker * params.tileContrast);
    return vec4<f32>(mix(stone, base * 0.72, joint), params.tileColor.a);
}
