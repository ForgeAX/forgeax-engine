struct ForgeaxVfxEventShaderRecord {
  position: vec4<f32>,
  strength: f32,
  sequence: u32,
  channel: u32,
  fan_out: u32,
}

fn forgeax_vfx_event_strength(record: ForgeaxVfxEventShaderRecord) -> f32 {
  return max(record.strength, 0.0);
}
