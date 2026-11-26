#define_import_path forgeax_view::depth_of_field_tiles

const DOF_TILE_SIZE : i32 = 16;

fn dofReceiverTile(uv : vec2<f32>, internalSize : vec2<u32>) -> vec2<i32> {
  let pixel = clamp(vec2<i32>(uv * vec2<f32>(internalSize)), vec2<i32>(0), vec2<i32>(internalSize) - 1);
  return pixel / DOF_TILE_SIZE;
}

fn dofTileSides(
  mask : texture_2d<f32>, uv : vec2<f32>, internalSize : vec2<u32>,
) -> vec2<bool> {
  return textureLoad(mask, dofReceiverTile(uv, internalSize), 0).rg > vec2<f32>(0.0);
}

fn dofEligibleRadii(nearRadius : f32, farRadius : f32, side : f32) -> vec2<f32> {
  // The near background kernel starts at 0.5px. The far gather first
  // contributes above 2px. Small destination blur runs at composite.
  return vec2<f32>(
    select(0.0, nearRadius, side < 1.5 && nearRadius > 0.5),
    select(0.0, farRadius, (side < 0.5 || side >= 1.5) && farRadius > 2.0),
  );
}

fn dofTileRadius(coc : texture_2d<f32>, tile : vec2<i32>, side : f32) -> vec2<f32> {
  let first = tile * DOF_TILE_SIZE;
  let end = min(first + DOF_TILE_SIZE, vec2<i32>(textureDimensions(coc)));
  var nearRadius = 0.0;
  var farRadius = 0.0;
  for (var y = first.y; y < end.y; y += 1) {
    for (var x = first.x; x < end.x; x += 1) {
      let signedRadius = textureLoad(coc, vec2<i32>(x, y), 0).r;
      nearRadius = max(nearRadius, -signedRadius);
      farRadius = max(farRadius, signedRadius);
    }
  }
  let radius = dofEligibleRadii(nearRadius, farRadius, side);
  // Round up before packing into 8-bit channels to preserve source support.
  return ceil(radius) / 255.0;
}

fn dofTileHasInfluence(
  radii : texture_2d<f32>,
  tile : vec2<i32>,
  outputSize : vec2<f32>,
  maxRadius : f32,
) -> vec2<bool> {
  var result = textureLoad(radii, tile, 0).rg > vec2<f32>(0.0);
  if (all(result)) { return result; }
  let tileCount = vec2<i32>(textureDimensions(radii));
  // Rounding the internal extent up to whole tiles bounds the conversion
  // conservatively, even with dynamic resolution and partial edge tiles.
  let internalPerOutput = vec2<f32>(tileCount * DOF_TILE_SIZE) / outputSize;
  // Up to 3.5 internal pixels from raw CoC to a prefiltered gather tap,
  // plus two half-resolution RGB lookups through composite and fallback.
  let padding = vec2<f32>(8.0);
  let reach = vec2<i32>(ceil(((maxRadius + 1.0) * internalPerOutput + padding) / f32(DOF_TILE_SIZE)));
  let first = max(tile - reach, vec2<i32>(0));
  let last = min(tile + reach, tileCount - 1);
  for (var y = first.y; y <= last.y; y += 1) {
    for (var x = first.x; x <= last.x; x += 1) {
      let source = vec2<i32>(x, y);
      let radius = round(textureLoad(radii, source, 0).rg * 255.0);
      let gap = vec2<f32>(max(abs(source - tile) - 1, vec2<i32>(0)) * DOF_TILE_SIZE);
      let nearBound = all(gap <= (radius.x + 1.0) * internalPerOutput + padding);
      let farBound = all(gap <= (radius.y + 1.0) * internalPerOutput + padding);
      result.x = result.x || (radius.x > 0.0 && nearBound);
      result.y = result.y || (radius.y > 0.0 && farBound);
      if (all(result)) { return result; }
    }
  }
  return result;
}
