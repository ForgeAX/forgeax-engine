use anyrender::render_to_buffer;
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::{DocumentConfig, FontContext, StyleThreading};
use blitz_html::HtmlDocument;
use blitz_paint::paint_scene;
use blitz_traits::shell::{ColorScheme, Viewport};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn parse_html(source: &str) -> usize {
    let document = HtmlDocument::from_html(source, DocumentConfig::default());
    document.id()
}

#[wasm_bindgen]
pub fn render_html(source: &str, width: u32, height: u32, font: Vec<u8>) -> Vec<u8> {
    assert!(width > 0 && height > 0 && width <= 2048 && height <= 2048);
    let mut font_ctx = FontContext::default();
    if !font.is_empty() {
        font_ctx.collection.register_fonts(font.into(), None);
    }
    let mut document = HtmlDocument::from_html(source, DocumentConfig {
        viewport: Some(Viewport::new(width, height, 1.0, ColorScheme::Light)),
        style_threading: StyleThreading::Sequential,
        font_ctx: Some(font_ctx),
        ..Default::default()
    });
    document.resolve(0.0);
    render_to_buffer::<VelloCpuImageRenderer, _>(|scene| {
        paint_scene(scene, &mut document, 1.0, width, height, 0, 0);
    }, width, height)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grid_paints_two_columns() {
        let bytes = render_html("<style>body{margin:0;display:grid;grid-template-columns:1fr 1fr;height:100px}section{background:red}aside{background:blue}</style><section></section><aside></aside>", 100, 100, vec![]);
        assert_eq!(bytes.len(), 100 * 100 * 4);
        let left = 4 * (50 * 100 + 25);
        let right = 4 * (50 * 100 + 75);
        assert_eq!(&bytes[left..left + 4], &[255, 0, 0, 255]);
        assert_eq!(&bytes[right..right + 4], &[0, 0, 255, 255]);
    }
}
