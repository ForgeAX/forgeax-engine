#define_import_path forgeax_standard::cluster_layout_probe
#import forgeax_standard::cluster_layout::{light_data, cluster_uniform}

// Keep both shared bindings live in an artifact that only needs compiler reflection.
@group(1) @binding(0) var<storage, read_write> layout_probe : array<u32, 1>;

@compute @workgroup_size(1)
fn cs_cluster_layout_probe() {
  layout_probe[0] = bitcast<u32>(light_data[0].position.x) + cluster_uniform.grid.x;
}
