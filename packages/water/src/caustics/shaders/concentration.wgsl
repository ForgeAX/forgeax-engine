#define_import_path forgeax_water::caustics::concentration
#import forgeax_optics::interface::{OpticalConcentration, opticalRelativeConcentration}

// Source footprint and peak limits are explicit scene/quality controls. Overlapping
// branches still add in the field; the receiver independently controls its response.
fn waterCausticsConcentration(incidentArea: f32, receiverArea: f32,
    referenceIncidentArea: f32, referenceReceiverArea: f32,
    minimumReceiverArea: f32, maximumConcentration: f32) -> OpticalConcentration {
  let concentration = opticalRelativeConcentration(incidentArea,
    max(receiverArea, minimumReceiverArea), referenceIncidentArea, referenceReceiverArea);
  return OpticalConcentration(min(maximumConcentration, concentration.value), concentration.status);
}
