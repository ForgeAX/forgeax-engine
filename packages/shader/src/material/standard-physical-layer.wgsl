#define_import_path forgeax_material::standard_physical_layer

// Engine-owned physical layer facts are selected from the root StandardLayerPlan.
// Surface modules only produce base SurfaceData and never own this interface.
// The Standard template owns the facts struct; this module supplies the one
// physical evaluator body when the clearcoat plan is present.
fn evaluate_standard_physical_layer() -> StandardPhysicalLayerFacts {
  return StandardPhysicalLayerFacts(
    clamp(material.clearcoat, 0.0, 1.0),
    clamp(material.clearcoatRoughness, 0.04, 1.0),
  );
}
