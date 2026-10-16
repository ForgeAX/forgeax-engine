use super::{ElementData, Node, SpecialElementData};
use crate::local_name;

/// The range control's current value, independent of its default attribute.
#[derive(Clone)]
pub struct RangeInput {
    pub value: f64,
    pub dirty: bool,
}

/// One geometry contract for native painting and pointer defaults (CSS pixels).
pub const RANGE_THUMB_SIZE: f64 = 16.0;

pub struct NumericConstraints {
    pub min: f64,
    pub max: f64,
    pub step: Option<f64>,
    base: f64,
    precision: i32,
}

fn number(value: &str) -> Option<f64> {
    crate::document::valid_number_value(value).then(|| value.parse().unwrap())
}

fn precision(value: &str) -> i32 {
    let (mantissa, exponent) = value.split_once(['e', 'E']).unwrap_or((value, "0"));
    let fractional = mantissa
        .split_once('.')
        .map_or(0, |(_, tail)| tail.len() as i32);
    (fractional - exponent.parse::<i32>().unwrap_or(0)).clamp(0, 308)
}

impl NumericConstraints {
    pub fn sanitize(&self, value: Option<f64>) -> f64 {
        let value = value
            .unwrap_or(self.min / 2.0 + self.max / 2.0)
            .clamp(self.min, self.max);
        let Some(step) = self.step else { return value };
        let count = (value - self.base) / step;
        if !count.is_finite() {
            return value;
        }
        // HTML chooses the greater allowed value when equally near two steps.
        let tolerance = f64::EPSILON * count.abs().max(1.0) * 8.0;
        let count = (count + 0.5 + tolerance)
            .floor()
            .max(((self.min - self.base) / step - tolerance).ceil())
            .min(((self.max - self.base) / step + tolerance).floor());
        let value = (self.base + count * step).clamp(self.min, self.max);
        let scale = 10_f64.powi(self.precision);
        if (value * scale).is_finite() {
            (value * scale).round() / scale
        } else {
            value
        }
    }

    /// A number editor keeps its text; stepping only derives the next permitted value.
    pub fn stepped(&self, text: &str, count: i32) -> Option<f64> {
        let step = self.step?;
        if self.min > self.max || count == 0 { return None; }
        let current = number(text);
        let value = current.unwrap_or(0.0);
        let quotient = (value - self.base) / step;
        if !quotient.is_finite() { return None; }
        let tolerance = f64::EPSILON * quotient.abs().max(1.0) * 8.0;
        let aligned = (quotient - quotient.round()).abs() <= tolerance;
        let first = if aligned { quotient.round() }
            else if count > 0 { quotient.ceil() - 1.0 }
            else { quotient.floor() + 1.0 };
        let low = ((self.min - self.base) / step - tolerance).ceil();
        let high = ((self.max - self.base) / step + tolerance).floor();
        if low > high { return None; }
        let next = (first + f64::from(count)).clamp(low, high);
        let next = self.base + next * step;
        if current.is_some() && ((count > 0 && next < value) || (count < 0 && next > value)) {
            return None;
        }
        let scale = 10_f64.powi(self.precision.max(precision(text)));
        let next = if (next * scale).is_finite() { (next * scale).round() / scale } else { next };
        next.is_finite().then_some(next)
    }

    pub fn stepped_by_user(&mut self, text: &str, count: i32) -> Option<f64> {
        if self.step.is_none() {
            self.step = Some(1.0);
            self.base = number(text).unwrap_or(0.0);
        }
        self.stepped(text, count)
    }

    pub fn parse(&self, value: &str) -> f64 {
        self.sanitize(number(value))
    }
}

impl ElementData {
    pub fn range_constraints(&self) -> Option<NumericConstraints> {
        self.attr(local_name!("type"))
            .is_some_and(|kind| kind.eq_ignore_ascii_case("range"))
            .then(|| self.numeric_constraints()).flatten()
    }

    pub fn numeric_constraints(&self) -> Option<NumericConstraints> {
        if self.name.local != local_name!("input")
            || !self
                .attr(local_name!("type"))
                .is_some_and(|kind| kind.eq_ignore_ascii_case("range") || kind.eq_ignore_ascii_case("number"))
        {
            return None;
        }
        let min_text = self.attr(local_name!("min")).unwrap_or("");
        let max_text = self.attr(local_name!("max")).unwrap_or("");
        let value_text = self.attr(local_name!("value")).unwrap_or("");
        let step_text = self.attr(local_name!("step")).unwrap_or("");
        let range = self.attr(local_name!("type")).is_some_and(|kind| kind.eq_ignore_ascii_case("range"));
        let min = number(min_text).unwrap_or(if range { 0.0 } else { f64::NEG_INFINITY });
        let max = number(max_text).unwrap_or(if range { 100.0 } else { f64::INFINITY });
        Some(NumericConstraints {
            min,
            max: if range { max.max(min) } else { max },
            step: if step_text.eq_ignore_ascii_case("any") {
                None
            } else {
                Some(
                    number(step_text)
                        .filter(|value| *value > 0.0)
                        .unwrap_or(1.0),
                )
            },
            base: number(min_text)
                .or_else(|| number(value_text))
                .unwrap_or(0.0),
            precision: precision(min_text)
                .max(precision(value_text))
                .max(precision(step_text)),
        })
    }

    pub fn range_value(&self) -> Option<f64> {
        let constraints = self.range_constraints()?;
        Some(match &self.special_data {
            SpecialElementData::RangeInput(input) => input.value,
            _ => constraints.parse(self.attr(local_name!("value")).unwrap_or("")),
        })
    }

    pub(crate) fn sync_range_attribute(&mut self, attribute: &str) {
        let Some(constraints) = self.range_constraints() else {
            return;
        };
        let (current, dirty) = match &self.special_data {
            SpecialElementData::RangeInput(input) => (Some(input.value), input.dirty),
            SpecialElementData::TextInput(input) => {
                (number(&input.editor.text().to_string()), input.dirty_value)
            }
            _ => (None, false),
        };
        let value = if current.is_none() || (!dirty && attribute == "value") {
            constraints.parse(self.attr(local_name!("value")).unwrap_or(""))
        } else {
            constraints.sanitize(current)
        };
        self.special_data = SpecialElementData::RangeInput(RangeInput { value, dirty });
    }

    pub fn set_range_value(&mut self, value: &str) {
        let Some(constraints) = self.range_constraints() else {
            return;
        };
        self.special_data = SpecialElementData::RangeInput(RangeInput {
            value: constraints.parse(value),
            dirty: true,
        });
    }
}

impl Node {
    pub fn range_axis(&self) -> (bool, bool) {
        self.primary_styles().map_or((false, false), |style| {
            let wm = style.writing_mode;
            (wm.is_vertical(), !wm.is_bidi_ltr())
        })
    }
}

impl Node {
    /// Native number buttons and hit defaults share this element-local CSS rectangle.
    /// Disabled/read-only controls have no interactive decoration.
    pub fn number_stepper_rect(&self) -> Option<kurbo::Rect> {
        let element = self.element_data()?;
        if !element.attr(local_name!("type")).is_some_and(|kind| kind.eq_ignore_ascii_case("number"))
            || element.attr(local_name!("readonly")).is_some()
            || element.element_state.contains(style_dom::ElementState::DISABLED)
            || self.primary_styles()?.clone_appearance() == style::values::specified::Appearance::Textfield
        { return None; }
        let layout = self.final_layout();
        let text = element.text_input_data()?.editor.try_layout()?;
        let height = (text.height() / text.scale()).min(layout.content_box_height()).max(0.0) as f64;
        let width = 15.0_f64.min(layout.content_box_width() as f64).max(0.0);
        let right = (layout.size.width - layout.border.right - layout.padding.right) as f64;
        let top = (layout.border.top + layout.padding.top) as f64
            + (layout.content_box_height() as f64 - height) / 2.0;
        Some(kurbo::Rect::new(right - width, top, right, top + height))
    }
}
