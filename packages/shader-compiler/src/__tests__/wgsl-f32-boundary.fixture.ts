export const EXACT_F32_MAX = '3.4028234663852885981170418348451692544e38f';
export const F32_BOUNDARY_SOURCE = `
@group(0) @binding(0) var<storage,read_write> values:array<f32>;
fn finite(value:f32)->bool{return abs(value)<=3.402823466e+38;}
@compute @workgroup_size(1) fn positive(){values[0]=select(0.0,1.0,finite(values[1]));}
@compute @workgroup_size(1) fn negative(){values[0]=select(0.0,1.0,finite(-values[1]));}
`;

/** Actual 95a compiler facade output for this source, captured before the fix.
 * SHA256 c596f63d66b9275a02bd0921841da0d9a2ab1e3a3ee43eaff512ea18eaef9045. */
export const LEGACY_F32_PUBLICATION = `@group(0) @binding(0)\u0020
var<storage, read_write> values: array<f32>;

fn finite(value: f32) -> bool {
    return (abs(value) <= 3.4028235e38f);
}

@compute @workgroup_size(1, 1, 1)\u0020
fn positive() {
    let _e4 = values[1];
    let _e5 = finite(_e4);
    values[0] = select(0f, 1f, _e5);
    return;
}

@compute @workgroup_size(1, 1, 1)\u0020
fn negative() {
    let _e4 = values[1];
    let _e6 = finite(-(_e4));
    values[0] = select(0f, 1f, _e6);
    return;
}
`;
