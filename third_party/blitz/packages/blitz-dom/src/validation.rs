//! User-agent constraint-validation feedback. The DOM facade supplies the
//! current standard validation message; this projection owns no validity rules.
use crate::{BaseDocument, NodeId, node::TextBrush};

pub(crate) struct ValidationMessage {
    node: NodeId,
    text: String,
    layout: parley::Layout<TextBrush>,
}

pub struct ValidationPopup<'a> {
    pub rect: [f64; 4],
    pub arrow_x: f64,
    pub above: bool,
    pub layout: &'a parley::Layout<TextBrush>,
}

impl BaseDocument {
    pub fn show_validation_message(&mut self, node: NodeId, text: &str) {
        self.validation_message = (!text.is_empty()).then(|| ValidationMessage {
            node,
            text: text.to_owned(),
            layout: Default::default(),
        });
        self.prepare_validation_message();
        self.shell_provider.request_redraw();
    }

    pub fn dismiss_validation_message(&mut self) {
        if self.validation_message.take().is_some() {
            self.shell_provider.request_redraw();
        }
    }

    pub(crate) fn prepare_validation_message(&mut self) {
        let Some(mut message) = self.validation_message.take() else {
            return;
        };
        let Some(node) = self.get_node(message.node) else {
            return;
        };
        if self.focus_node_id != Some(message.node)
            || !node.has_boxes()
            || !self.can_focus(message.node)
        {
            return;
        }
        let Some(style) = node.primary_styles() else {
            return;
        };
        let authored = crate::stylo_to_parley::style(message.node, &style);
        drop(style);
        let text_style = parley::TextStyle {
            font_family: authored.font_family,
            locale: authored.locale,
            font_size: 13.0,
            brush: TextBrush::from_id(message.node),
            ..Default::default()
        };
        let scale = self.viewport.scale();
        let width = (self.viewport.window_size.0 as f32 / scale - 48.0).clamp(1.0, 256.0);
        let mut fonts = self.font_ctx.lock().unwrap();
        let mut builder = self
            .layout_ctx
            .tree_builder(&mut fonts, scale, true, &text_style);
        builder.push_text(&message.text);
        message.layout = builder.build().0;
        message.layout.break_all_lines(Some(width * scale));
        self.validation_message = Some(message);
    }

    /// A viewport layer, independent of author overflow clips and CSS effects.
    pub fn validation_message_popup(&self) -> Option<ValidationPopup<'_>> {
        let message = self.validation_message.as_ref()?;
        let anchor = self.get_client_bounding_rect(message.node)?;
        let scale = self.viewport.scale_f64();
        let viewport_width = self.viewport.window_size.0 as f64 / scale;
        let viewport_height = self.viewport.window_size.1 as f64 / scale;
        let width = (message.layout.width() as f64 / scale + 40.0).min((viewport_width - 8.0).max(1.0));
        let height = (message.layout.height() as f64 / scale + 16.0).min((viewport_height - 16.0).max(1.0));
        // Keep the pointer attached to the leading edge of the invalid field even
        // when the viewport forces the bubble to shift or flip above it.
        let x = (anchor.x - 8.0).clamp(4.0, (viewport_width - width - 4.0).max(4.0));
        let below = anchor.y + anchor.height + 8.0;
        let above = below + height > viewport_height - 4.0;
        let y = if above { (anchor.y - height - 8.0).max(4.0) } else { below };
        Some(ValidationPopup {
            rect: [x, y, width, height],
            arrow_x: (anchor.x + 8.0 - x).clamp(12.0, (width - 12.0).max(12.0)),
            above,
            layout: &message.layout,
        })
    }
}
