use super::ElementCx;
use crate::color::{Color, ToColorColor as _};
use anyrender::PaintScene;
use blitz_dom::local_name;
use kurbo::{Affine, BezPath, Circle, Point, Rect, RoundedRect, Stroke, Vec2};
use peniko::{Fill, Mix};
use style::computed_value_flags::ComputedValueFlags;
use style::dom::TElement as _;

impl ElementCx<'_, '_> {
    pub(super) fn draw_disabled_control_background(
        &self,
        scene: &mut impl PaintScene,
        shape: &BezPath,
    ) -> bool {
        if self.node.attr(local_name!("disabled")).is_none()
            || self
                .style
                .flags
                .intersects(ComputedValueFlags::HAS_AUTHOR_SPECIFIED_BORDER_BACKGROUND)
        {
            return false;
        }
        let button = self.node.local_name() == "button"
            || (self.node.local_name() == "input"
                && matches!(
                    self.node.attr(local_name!("type")),
                    Some("button" | "submit" | "reset")
                ));
        if !button
            && self.element.text_input_data().is_none()
            && self.element.select_data().is_none()
        {
            return false;
        }
        // Default disabled surfaces are translucent: a lightening underlay
        // followed by the field/button fill. Authored border/background rules
        // opt out through Stylo's existing cascade flag, not color equality.
        scene.fill(
            Fill::NonZero,
            self.transform,
            Color::from_rgba8(169, 169, 169, 51),
            None,
            shape,
        );
        let fill = if button {
            Color::from_rgba8(239, 239, 239, 77)
        } else {
            Color::from_rgba8(255, 255, 255, 153)
        };
        scene.fill(Fill::NonZero, self.transform, fill, None, shape);
        true
    }

    pub(super) fn draw_input(&self, scene: &mut impl PaintScene) {
        if let Some(select) = self.element.select_data() {
            let frame = self.frame.content_box;
            let index = self.context.dom.select_index(self.node.id).unwrap_or(-1);
            let preview = if select.open {
                select
                    .choices
                    .iter()
                    .find(|(option, _)| select.highlighted == Some(*option))
            } else {
                None
            };
            if let Some((_, layout)) = preview.or_else(|| select.choices.get(index as usize)) {
                let position = Affine::translate((
                    frame.x0 + 4.0 * self.scale,
                    frame.y0 + (frame.height() - f64::from(layout.height())) / 2.0,
                ));
                crate::text::stroke_text(
                    scene,
                    layout.lines(),
                    self.context.dom,
                    self.transform * position,
                    self.scale,
                    self.node.id,
                    &mut self.context.draw_text_context.borrow_mut(),
                );
            }
            let center = Point::new(frame.x1 - 7.0 * self.scale, frame.center().y);
            let mut arrow = BezPath::new();
            arrow.move_to((center.x - 3.0 * self.scale, center.y - 1.5 * self.scale));
            arrow.line_to((center.x, center.y + 1.5 * self.scale));
            arrow.line_to((center.x + 3.0 * self.scale, center.y - 1.5 * self.scale));
            scene.stroke(
                &Stroke::new(2.0 * self.scale),
                self.transform,
                self.style.clone_color().as_srgb_color(),
                None,
                &arrow,
            );
            return;
        }
        if self.node.local_name() != "input" {
            return;
        }
        if let Some(rect) = self.node.number_stepper_rect() {
            let rect = kurbo::Rect::new(rect.x0 * self.scale, rect.y0 * self.scale, rect.x1 * self.scale, rect.y1 * self.scale);
            scene.fill(Fill::NonZero, self.transform, Color::from_rgb8(239, 239, 239), None, &rect);
            for (direction, y) in [(-1.0, rect.y0 + rect.height() / 4.0), (1.0, rect.y1 - rect.height() / 4.0)] {
                let x = rect.center().x;
                let mut arrow = BezPath::new();
                arrow.move_to((x - 4.0 * self.scale, y - direction * 1.5 * self.scale));
                arrow.line_to((x + 4.0 * self.scale, y - direction * 1.5 * self.scale));
                arrow.line_to((x, y + direction * 2.5 * self.scale));
                arrow.close_path();
                scene.fill(Fill::NonZero, self.transform, Color::from_rgb8(128, 128, 128), None, &arrow);
            }
            return;
        }
        if let Some(value) = self.element.range_value() {
            let constraints = self.element.range_constraints().unwrap();
            let (vertical, reversed) = self.node.range_axis();
            let ratio = if constraints.max > constraints.min {
                (value - constraints.min) / (constraints.max - constraints.min)
            } else {
                0.0
            };
            let ratio = if reversed { 1.0 - ratio } else { ratio };
            let frame = self.frame.border_box;
            let thumb = (blitz_dom::node::RANGE_THUMB_SIZE * self.scale)
                .min(frame.width())
                .min(frame.height());
            let radius = thumb / 2.0;
            let (start, end) = if vertical {
                (
                    Point::new(frame.center().x, frame.y0 + radius),
                    Point::new(frame.center().x, frame.y1 - radius),
                )
            } else {
                (
                    Point::new(frame.x0 + radius, frame.center().y),
                    Point::new(frame.x1 - radius, frame.center().y),
                )
            };
            let center = start.lerp(end, ratio);
            let accent = if self.node.attr(local_name!("disabled")).is_some() {
                Color::from_rgba8(170, 170, 170, 255)
            } else {
                Color::from_rgba8(0, 117, 255, 255)
            };
            // The thumb keeps its shared 16px layout/hit box. Painting is
            // inset by half a CSS pixel; the track spans the control itself.
            let track_height = (8.0 * self.scale).min(if vertical {
                frame.width()
            } else {
                frame.height()
            });
            let inset = self.scale.min(
                if vertical {
                    frame.height()
                } else {
                    frame.width()
                } / 2.0,
            );
            let track = if vertical {
                Rect::new(
                    frame.center().x - track_height / 2.0,
                    frame.y0 + inset,
                    frame.center().x + track_height / 2.0,
                    frame.y1 - inset,
                )
            } else {
                Rect::new(
                    frame.x0 + inset,
                    frame.center().y - track_height / 2.0,
                    frame.x1 - inset,
                    frame.center().y + track_height / 2.0,
                )
            };
            let rounding = track_height / 2.0;
            scene.fill(
                Fill::NonZero,
                self.transform,
                Color::from_rgb8(239, 239, 239),
                None,
                &track.to_rounded_rect(rounding),
            );
            let value_track = if vertical {
                if reversed {
                    Rect::new(track.x0, center.y, track.x1, track.y1)
                } else {
                    Rect::new(track.x0, track.y0, track.x1, center.y)
                }
            } else if reversed {
                Rect::new(center.x, track.y0, track.x1, track.y1)
            } else {
                Rect::new(track.x0, track.y0, center.x, track.y1)
            };
            scene.fill(
                Fill::NonZero,
                self.transform,
                accent,
                None,
                &value_track.to_rounded_rect(rounding),
            );
            scene.stroke(
                &Stroke::new(self.scale),
                self.transform,
                Color::new([118.0 / 255.0, 118.0 / 255.0, 118.0 / 255.0, 0.5]),
                None,
                &track.inset(-self.scale / 2.0).to_rounded_rect(rounding),
            );
            scene.fill(
                Fill::NonZero,
                self.transform,
                accent,
                None,
                &Circle::new(center, (radius - self.scale / 2.0).max(0.0)),
            );
            return;
        }
        let Some(checked) = self.element.checkbox_input_checked() else {
            return;
        };

        let type_attr = self.node.attr(local_name!("type"));
        let disabled = self.node.attr(local_name!("disabled")).is_some();

        let accent_color = if disabled {
            Color::from_rgba8(209, 209, 209, 255)
        } else {
            Color::from_rgba8(0, 117, 255, 255)
        };

        // Native controls paint inside the largest centered square. Borders
        // use CSS pixels; the checkmark and radio dot scale with that square.
        let bounds = self.frame.border_box;
        let side = bounds.width().min(bounds.height());
        if side <= 0.0 {
            return;
        }
        let center = bounds.center();
        let frame = Rect::from_center_size(center, (side, side));
        let radio = type_attr == Some("radio");
        let radius = if radio { side / 2.0 } else { 2.0 * self.scale };
        let background = frame.inset(-0.2 * self.scale).to_rounded_rect(radius);
        scene.fill(
            Fill::NonZero,
            self.transform,
            Color::WHITE,
            None,
            &background,
        );
        if radio || !checked {
            let border = if checked {
                accent_color
            } else if disabled {
                Color::from_rgb8(170, 170, 170)
            } else {
                Color::from_rgb8(118, 118, 118)
            };
            scene.stroke(
                &Stroke::new(self.scale),
                self.transform,
                border,
                None,
                &frame.inset(-self.scale / 2.0).to_rounded_rect(radius),
            );
        }
        if checked && radio {
            scene.fill(
                Fill::NonZero,
                self.transform,
                accent_color,
                None,
                &Circle::new(center, side * 0.3),
            );
        } else if checked {
            scene.fill(
                Fill::NonZero,
                self.transform,
                accent_color,
                None,
                &frame.to_rounded_rect(radius),
            );
            let mut tick = BezPath::new();
            tick.move_to((frame.x0 + side * 0.2, center.y));
            tick.line_to((frame.x0 + side * 0.4, frame.y0 + side * 0.7));
            tick.line_to((frame.x0 + side * 0.8, frame.y0 + side * 0.2));
            scene.stroke(
                &Stroke::new(side * 0.16),
                self.transform,
                Color::WHITE,
                None,
                &tick,
            );
        }
    }
}

impl super::BlitzDomPainter<'_, '_> {
    pub(super) fn draw_validation_message(&self, scene: &mut impl PaintScene) {
        let Some(popup) = self.dom.validation_message_popup() else {
            return;
        };
        let rect = popup.rect;
        let layout = popup.layout;
        let transform = Affine::translate((
            self.initial_x + rect[0] * self.scale,
            self.initial_y + rect[1] * self.scale,
        ));
        let bounds = RoundedRect::from_rect(
            kurbo::Rect::new(0.0, 0.0, rect[2] * self.scale, rect[3] * self.scale),
            4.0 * self.scale,
        );
        let background = Color::from_rgb8(248, 248, 248);
        scene.fill(Fill::NonZero, transform, background, None, &bounds);
        scene.stroke(&Stroke::new(self.scale), transform, Color::from_rgb8(128, 128, 128), None, &bounds);
        let x = popup.arrow_x * self.scale;
        let y = if popup.above { rect[3] * self.scale } else { 0.0 };
        let direction = if popup.above { 1.0 } else { -1.0 };
        let mut arrow = BezPath::new();
        arrow.move_to((x - 8.0 * self.scale, y));
        arrow.line_to((x, y + direction * 8.0 * self.scale));
        arrow.line_to((x + 8.0 * self.scale, y));
        arrow.close_path();
        scene.fill(Fill::NonZero, transform, background, None, &arrow);
        let icon = kurbo::Rect::new(8.0 * self.scale, 8.0 * self.scale, 24.0 * self.scale, 24.0 * self.scale);
        scene.fill(Fill::NonZero, transform, Color::from_rgb8(200, 80, 0), None, &icon);
        for mark in [kurbo::Rect::new(15.0, 11.0, 17.0, 17.0), kurbo::Rect::new(15.0, 19.0, 17.0, 21.0)] {
            scene.fill(Fill::NonZero, transform * Affine::scale(self.scale), Color::WHITE, None, &mark);
        }
        scene.push_clip_layer(Fill::NonZero, transform, &bounds);
        let text_transform = transform * Affine::translate((32.0 * self.scale, 8.0 * self.scale));
        for line in layout.lines() {
            for item in line.items() {
                let parley::PositionedLayoutItem::GlyphRun(glyphs) = item else {
                    continue;
                };
                let run = glyphs.run();
                scene.draw_glyphs(
                    run.font(), run.font_size(), true,
                    bytemuck::cast_slice(run.normalized_coords()), Vec2::ZERO,
                    Fill::NonZero, &anyrender::Paint::from(Color::BLACK), 1.0,
                    text_transform, None,
                    glyphs.positioned_glyphs().map(|glyph| anyrender::Glyph {
                        id: glyph.id as _, x: glyph.x, y: glyph.y,
                    }),
                );
            }
        }
        scene.pop_layer();
    }

    pub(super) fn draw_select_popups(&self, scene: &mut impl PaintScene) {
        for (id, node) in self.dom.tree().iter() {
            let Some(rect) = self.dom.select_popup_rect(id) else {
                continue;
            };
            let select = node.element_data().unwrap().select_data().unwrap();
            let transform = Affine::translate((
                self.initial_x + rect[0] * self.scale,
                self.initial_y + rect[1] * self.scale,
            ));
            let bounds = kurbo::Rect::new(0.0, 0.0, rect[2] * self.scale, rect[3] * self.scale);
            scene.fill(Fill::NonZero, transform, Color::WHITE, None, &bounds);
            scene.stroke(
                &Stroke::new(self.scale),
                transform,
                Color::from_rgba8(100, 100, 100, 255),
                None,
                &bounds,
            );
            for (index, (option, layout)) in select.choices.iter().enumerate() {
                let top = index as f64 * select.row_height() * self.scale;
                if top + select.row_height() * self.scale > bounds.height() {
                    break;
                }
                if select.highlighted == Some(*option) {
                    scene.fill(
                        Fill::NonZero,
                        transform,
                        Color::from_rgba8(180, 213, 255, 255),
                        None,
                        &kurbo::Rect::new(
                            0.0,
                            top,
                            bounds.width(),
                            top + select.row_height() * self.scale,
                        ),
                    );
                }
                let disabled = self.dom.option_disabled(*option);
                if disabled {
                    scene.push_layer(
                        Fill::NonZero,
                        Mix::Normal,
                        0.5,
                        transform,
                        &bounds,
                        None,
                        None,
                    );
                }
                crate::text::stroke_text(
                    scene,
                    layout.lines(),
                    self.dom,
                    transform
                        * Affine::translate((
                            4.0 * self.scale,
                            top + (select.row_height() * self.scale - f64::from(layout.height()))
                                / 2.0,
                        )),
                    self.scale,
                    id,
                    &mut self.draw_text_context.borrow_mut(),
                );
                if disabled {
                    scene.pop_layer();
                }
            }
        }
    }
}
