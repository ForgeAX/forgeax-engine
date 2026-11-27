//! macOS extended gamepads use the system's positional button profile.
use super::NativeGamepad;
use objc2::rc::{autoreleasepool, Retained};
use objc2_game_controller::{GCController, GCControllerButtonInput, GCExtendedGamepad};

#[derive(Default)]
pub(super) struct Gamepads {
    // Keep the native object alive until its disconnection has been sampled.
    slots: [Option<Retained<GCController>>; 4],
}

impl Gamepads {
    pub(super) fn snapshots(&mut self) -> Vec<NativeGamepad> {
        // SAFETY: The winit owner samples Game Controller on its macOS main thread.
        autoreleasepool(|_| unsafe { self.sample(GCController::controllers().to_vec()) })
    }

    unsafe fn sample(&mut self, controllers: Vec<Retained<GCController>>) -> Vec<NativeGamepad> {
        let mut seen = [false; 4];
        let mut samples = Vec::new();
        for controller in controllers {
            let Some(profile) = controller.extendedGamepad() else {
                continue;
            };
            if let Some(index) = self.slot(controller) {
                seen[index] = true;
                samples.push(standard_pad(index as u32, &profile));
            }
        }
        // A vacated slot becomes available on the next sample, after Input sees the disconnect.
        for (slot, seen) in self.slots.iter_mut().zip(seen) {
            if !seen {
                *slot = None;
            }
        }
        samples.sort_unstable_by_key(|pad| pad.index);
        samples
    }

    fn slot(&mut self, controller: Retained<GCController>) -> Option<usize> {
        if let Some(index) = self.slots.iter().position(|slot| {
            slot.as_ref()
                .is_some_and(|current| Retained::as_ptr(current) == Retained::as_ptr(&controller))
        }) {
            return Some(index);
        }
        let index = self.slots.iter().position(Option::is_none)?;
        self.slots[index] = Some(controller);
        Some(index)
    }
}

unsafe fn value(button: Retained<GCControllerButtonInput>) -> f64 {
    f64::from(button.value())
}

unsafe fn standard_pad(index: u32, pad: &GCExtendedGamepad) -> NativeGamepad {
    let left = pad.leftThumbstick();
    let right = pad.rightThumbstick();
    let dpad = pad.dpad();
    let optional = |button: Option<Retained<GCControllerButtonInput>>| {
        button.map_or(0.0, |button| value(button))
    };
    NativeGamepad {
        index,
        buttons: [
            value(pad.buttonA()),
            value(pad.buttonB()),
            value(pad.buttonX()),
            value(pad.buttonY()),
            value(pad.leftShoulder()),
            value(pad.rightShoulder()),
            value(pad.leftTrigger()),
            value(pad.rightTrigger()),
            optional(pad.buttonOptions()),
            value(pad.buttonMenu()),
            optional(pad.leftThumbstickButton()),
            optional(pad.rightThumbstickButton()),
            value(dpad.up()),
            value(dpad.down()),
            value(dpad.left()),
            value(dpad.right()),
            optional(pad.buttonHome()),
        ],
        axes: [
            f64::from(left.xAxis().value()),
            -f64::from(left.yAxis().value()),
            f64::from(right.xAxis().value()),
            -f64::from(right.yAxis().value()),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_apple_profile_input_to_standard_buttons_and_axes() {
        // SAFETY: Use an isolated framework snapshot, without modifying a system controller.
        autoreleasepool(|_| unsafe {
            let controller = GCController::controllerWithExtendedGamepad();
            let pad = controller.extendedGamepad().unwrap();
            pad.buttonA().setValue(1.0);
            pad.leftTrigger().setValue(0.75);
            pad.dpad().setValueForXAxis_yAxis(0.0, 1.0);
            pad.leftThumbstick().setValueForXAxis_yAxis(0.5, -0.25);
            pad.rightThumbstick().setValueForXAxis_yAxis(-0.5, 0.25);
            let sample = standard_pad(2, &pad);
            assert_eq!(sample.index, 2);
            assert_eq!(sample.buttons[0], 1.0);
            assert_eq!(sample.buttons[6], 0.75);
            assert_eq!(sample.buttons[12], 1.0);
            assert_eq!(sample.axes, [0.5, 0.25, -0.5, -0.25]);
        });
    }

    #[test]
    fn keeps_live_slots_when_apple_reorders_and_retires_a_slot_before_reuse() {
        // SAFETY: The test owns the framework snapshots it uses as controller identities.
        autoreleasepool(|_| unsafe {
            let devices: Vec<_> = (0..5)
                .map(|_| GCController::controllerWithExtendedGamepad())
                .collect();
            let mut state = Gamepads::default();
            let slots = |state: &mut Gamepads, indices: &[usize]| -> Vec<u32> {
                state
                    .sample(
                        indices
                            .iter()
                            .map(|&index| devices[index].clone())
                            .collect(),
                    )
                    .into_iter()
                    .map(|pad| pad.index)
                    .collect()
            };
            assert_eq!(slots(&mut state, &[0, 1, 2, 3]), [0, 1, 2, 3]);
            assert_eq!(slots(&mut state, &[4, 3, 2, 1]), [1, 2, 3]);
            assert_eq!(slots(&mut state, &[4, 3, 2, 1]), [0, 1, 2, 3]);
            assert_eq!(slots(&mut state, &[1]), [1]);
        });
    }
}
