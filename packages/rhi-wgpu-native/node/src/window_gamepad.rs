//! Windows XInput acquisition. Gamepad mapping and edges above this boundary use Engine Input.
use super::NativeGamepad;
use windows_sys::Win32::UI::Input::XboxController::*;

fn axis(value: i16) -> f64 {
    f64::from(value) / if value < 0 { 32768.0 } else { 32767.0 }
}

fn standard_pad(index: u32, pad: XINPUT_GAMEPAD) -> NativeGamepad {
    let button = |mask| f64::from(u8::from(pad.wButtons & mask != 0));
    NativeGamepad {
        index,
        buttons: [
            button(XINPUT_GAMEPAD_A),
            button(XINPUT_GAMEPAD_B),
            button(XINPUT_GAMEPAD_X),
            button(XINPUT_GAMEPAD_Y),
            button(XINPUT_GAMEPAD_LEFT_SHOULDER),
            button(XINPUT_GAMEPAD_RIGHT_SHOULDER),
            f64::from(pad.bLeftTrigger) / 255.0,
            f64::from(pad.bRightTrigger) / 255.0,
            button(XINPUT_GAMEPAD_BACK),
            button(XINPUT_GAMEPAD_START),
            button(XINPUT_GAMEPAD_LEFT_THUMB),
            button(XINPUT_GAMEPAD_RIGHT_THUMB),
            button(XINPUT_GAMEPAD_DPAD_UP),
            button(XINPUT_GAMEPAD_DPAD_DOWN),
            button(XINPUT_GAMEPAD_DPAD_LEFT),
            button(XINPUT_GAMEPAD_DPAD_RIGHT),
            0.0, // XInput does not expose the system Guide button.
        ],
        axes: [
            axis(pad.sThumbLX),
            -axis(pad.sThumbLY),
            axis(pad.sThumbRX),
            -axis(pad.sThumbRY),
        ],
    }
}

pub(super) fn snapshots() -> Vec<NativeGamepad> {
    (0..XUSER_MAX_COUNT)
        .filter_map(|index| {
            let mut state = XINPUT_STATE::default();
            // SAFETY: index is within the documented slots and state is writable.
            let status = unsafe { XInputGetState(index, &mut state) };
            (status == 0).then(|| standard_pad(index, state.Gamepad))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_xinput_to_standard_slots_and_normalizes_signed_axes() {
        let pad = standard_pad(
            2,
            XINPUT_GAMEPAD {
                wButtons: XINPUT_GAMEPAD_A | XINPUT_GAMEPAD_DPAD_UP,
                bLeftTrigger: 128,
                sThumbLX: i16::MIN,
                sThumbLY: i16::MAX,
                ..Default::default()
            },
        );
        assert_eq!(pad.index, 2);
        assert_eq!(pad.buttons[0], 1.0);
        assert_eq!(pad.buttons[6], 128.0 / 255.0);
        assert_eq!(pad.buttons[12], 1.0);
        assert_eq!(pad.axes, [-1.0, -1.0, 0.0, 0.0]);
    }
}
