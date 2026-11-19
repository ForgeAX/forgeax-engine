use super::*;

#[test]
fn inherited_text_stroke_paints_real_outlines_and_respects_paint_order() {
    let font = include_bytes!(
        "../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf"
    )
    .to_vec();
    let mut doc = UiDocument::new("<style>body{margin:0;font:48px sans-serif;color:lime}div{position:absolute;left:12px;top:4px;-webkit-text-stroke:6px red;paint-order:stroke fill}</style><div><span>I</span></div>", 100, 80, 1.0, font).unwrap();
    let count = |pixels: &[u8], color: [u8; 3]| {
        pixels
            .chunks_exact(4)
            .filter(|p| p[..3] == color && p[3] > 240)
            .count()
    };
    let span = doc.query(doc.root(), "span").unwrap()[0];
    let back = doc.paint().unwrap();
    assert!(count(&back, [255, 0, 0]) > 60, "inherited native outline");
    assert!(
        count(&back, [0, 255, 0]) > 60,
        "fill covers inner half of stroke"
    );
    doc.set_style(span, "paint-order", "normal", "").unwrap();
    let front = doc.paint().unwrap();
    assert!(count(&front, [255, 0, 0]) > count(&back, [255, 0, 0]));
    assert!(count(&front, [0, 255, 0]) < count(&back, [0, 255, 0]));
    doc.set_style(span, "-webkit-text-stroke-width", "0", "")
        .unwrap();
    assert_eq!(count(&doc.paint().unwrap(), [255, 0, 0]), 0);
}

#[test]
fn text_stroke_resolves_current_color_and_scales_as_css_pixels() {
    let font = include_bytes!(
        "../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf"
    )
    .to_vec();
    let html = "<style>body{margin:0;font:48px sans-serif;color:red;-webkit-text-stroke:4px currentColor}span{position:absolute;left:12px;top:4px}</style><span>I</span>";
    let mut one = UiDocument::new(html, 100, 80, 1.0, font.clone()).unwrap();
    let mut two = UiDocument::new(html, 200, 160, 2.0, font).unwrap();
    let count = |pixels: &[u8]| {
        pixels
            .chunks_exact(4)
            .filter(|p| p[0] > 240 && p[1] == 0 && p[2] == 0 && p[3] > 240)
            .count()
    };
    let a = count(&one.paint().unwrap());
    let b = count(&two.paint().unwrap());
    assert!(
        a > 100 && b > a * 3 && b < a * 5,
        "CSS pixel scaling: {a} -> {b}"
    );
    let span = one.query(one.root(), "span").unwrap()[0];
    one.set_style(span, "color", "blue", "").unwrap();
    assert_eq!(
        count(&one.paint().unwrap()),
        0,
        "currentColor follows descendant color"
    );
}
