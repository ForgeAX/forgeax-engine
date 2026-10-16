use super::UiDocument;

#[test]
fn hidden_root_blocks_user_scroll_chaining_but_retains_programmatic_offsets() {
    let mut doc = UiDocument::new(
        "<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#content{position:fixed;width:300px;height:400px}#overlay{position:absolute;inset:0;overflow:auto}#message{height:150px}</style><div id=content></div><div id=overlay><div id=message></div></div>",
        200, 100, 1.0, Vec::new(),
    ).unwrap();
    let root = doc.document_element();
    let overlay = doc.query(doc.root(), "#overlay").unwrap()[0];
    doc.scroll_by_user(overlay, 1000.0, 1000.0).unwrap();
    assert_eq!(doc.scroll_metrics(overlay).unwrap()[1], 50.0);
    assert_eq!(&doc.scroll_metrics(root).unwrap()[..2], &[0.0, 0.0]);
    doc.scroll_to(root, 20.0, 40.0).unwrap();
    assert_eq!(&doc.scroll_metrics(root).unwrap()[..2], &[20.0, 40.0]);
    for delta in [100.0, -100.0] {
        doc.scroll_by_user(root, delta, delta).unwrap();
        assert_eq!(&doc.scroll_metrics(root).unwrap()[..2], &[20.0, 40.0]);
    }
    doc.set_style(root, "overflow", "auto", "").unwrap();
    doc.scroll_by_user(root, 30.0, 30.0).unwrap();
    assert_eq!(&doc.scroll_metrics(root).unwrap()[..2], &[50.0, 70.0]);
}

#[test]
fn fixed_descendants_remain_in_ancestor_stacking_contexts() {
    for z_index in ["auto", "-1", "1", "999"] {
        let html = format!(
            "<style>html,body{{margin:0}}body{{height:600px}}#shell{{position:relative;left:40px;top:30px;width:160px;height:120px;isolation:isolate}}#lower{{position:absolute;inset:0;z-index:1}}#fixed{{position:fixed;left:60px;top:50px;width:80px;height:60px;z-index:{z_index};background:red}}#fatal{{position:absolute;inset:0;z-index:2;background:blue}}</style><div id=shell><div id=lower><div id=fixed></div></div><div id=fatal></div></div>"
        );
        let mut doc = UiDocument::new(&html, 240, 180, 1.0, Vec::new()).unwrap();
        let fixed = doc.query(doc.root(), "#fixed").unwrap()[0];
        let fatal = doc.query(doc.root(), "#fatal").unwrap()[0];
        for visible in [true, false, true] {
            doc.set_style(fatal, "display", if visible { "block" } else { "none" }, "")
                .unwrap();
            assert_eq!(&doc.rect(fixed).unwrap()[..2], &[60.0, 50.0]);
            let expected = if visible { fatal } else { fixed };
            assert_eq!(doc.hit(80.0, 70.0).unwrap(), expected, "z-index={z_index}");
            let pixels = doc.paint().unwrap();
            let offset = (70 * 240 + 80) * 4;
            assert_eq!(
                &pixels[offset..offset + 4],
                if visible {
                    &[0, 0, 255, 255]
                } else {
                    &[255, 0, 0, 255]
                },
                "z-index={z_index}, visible={visible}"
            );
        }
        doc.set_style(fatal, "display", "none", "").unwrap();
        doc.scroll_to(doc.document_element(), 0.0, 40.0).unwrap();
        assert_eq!(&doc.rect(fixed).unwrap()[..2], &[60.0, 50.0]);
        assert_eq!(
            doc.hit(80.0, 70.0).unwrap(),
            fixed,
            "scrolled z-index={z_index}"
        );
        let pixels = doc.paint().unwrap();
        let offset = (70 * 240 + 80) * 4;
        assert_eq!(&pixels[offset..offset + 4], &[255, 0, 0, 255]);
    }
}

#[test]
fn fixed_scroller_rect_pixels_and_hits_agree_after_viewport_scroll() {
    for ratio in [1, 3] {
        for z_index in ["auto", "1"] {
            for transformed in [false, true] {
                let transform = if transformed {
                    "transform:translate(10px,120px)"
                } else {
                    ""
                };
                let html = format!(
                    "<style>html,body{{margin:0}}#page{{height:800px}}#host{{position:absolute;inset:0;z-index:1;{transform}}}#fixed{{position:fixed;inset:0;z-index:{z_index}}}#panel{{position:absolute;left:100px;top:32px;width:200px;height:100px;overflow:auto;background:red}}#space{{height:200px}}button{{display:block;width:100px;height:30px;padding:0;border:0;background:blue}}</style><div id=page></div><div id=host><section id=fixed><div id=panel><div id=space></div><button id=done></button></div></section></div>"
                );
                let width = 400 * ratio;
                let mut doc =
                    UiDocument::new(&html, width, 300 * ratio, ratio as f32, Vec::new()).unwrap();
                let panel = doc.query(doc.root(), "#panel").unwrap()[0];
                let done = doc.query(doc.root(), "#done").unwrap()[0];
                if transformed {
                    // A transformed ancestor owns its fixed descendant: viewport
                    // scrolling must move the panel with that ancestor.
                    doc.scroll_to(panel, 0.0, 130.0).unwrap();
                    doc.scroll_to(doc.document_element(), 0.0, 40.0).unwrap();
                } else {
                    // The same excess wheel path as the actual settings dialog.
                    doc.scroll_by_user(panel, 0.0, 1000.0).unwrap();
                    assert_eq!(doc.document.viewport_scroll().y, 500.0);
                }
                let rect = doc.rect(panel).unwrap();
                assert_eq!(rect[1], if transformed { 112.0 } else { 32.0 });
                let target = doc.rect(done).unwrap();
                assert_eq!(
                    doc.hit((target[0] + 50.0) as f32, (target[1] + 15.0) as f32)
                        .unwrap(),
                    done
                );
                let pixels = doc.paint().unwrap();
                for (x, y, color) in [
                    (rect[0] + 180.0, rect[1] + 10.0, [255, 0, 0, 255]),
                    (target[0] + 50.0, target[1] + 15.0, [0, 0, 255, 255]),
                ] {
                    let i = (((y as u32 * ratio) * width + x as u32 * ratio) * 4) as usize;
                    assert_eq!(
                        &pixels[i..i + 4],
                        &color,
                        "DPR={ratio}, z-index={z_index}, transformed={transformed}"
                    );
                }
            }
        }
    }
}

// The reference is the same real text raster before its scrollport is shortened.
// Comparing cropped pixels detects missing text and double scrolling even when
// scrollTop, layout and hit testing all report the correct geometry.
fn assert_scrolled_pixels(scale: u32, ratio: u32, block_child: bool) {
    let text = "AAAA BBBB CCCC DDDD EEEE FFFF\nGGGG HHHH IIII JJJJ KKKK LLLL\nMMMM NNNN OOOO PPPP QQQQ RRRR\nSSSS TTTT UUUU VVVV WWWW XXXX\nYYYY ZZZZ 0000 1111 2222 3333\n4444 5555 6666 7777 8888 9999";
    let content = if block_child {
        format!("<div>{text}</div>")
    } else {
        text.to_owned()
    };
    let html = format!(
        "<style>body{{margin:0;background:white}}pre{{position:absolute;left:10px;top:10px;margin:0;padding:4px;border:2px solid red;width:100px;height:120px;overflow:hidden;white-space:pre;font:12px/20px sans-serif;color:black;transform-origin:0 0;transform:scale({scale})}}</style><pre>{content}</pre>"
    );
    let font = include_bytes!(
        "../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf"
    )
    .to_vec();
    let width = 260 * ratio;
    let mut doc = UiDocument::new(&html, width, 300 * ratio, ratio as f32, font).unwrap();
    let host = doc.query(doc.root(), "pre").unwrap()[0];
    let reference = doc.paint().unwrap();
    doc.set_style(host, "height", "40px", "").unwrap();
    for (x, y) in [(0, 20), (20, 60), (0, 80), (0, 0)] {
        doc.scroll_to(host, x as f64, y as f64).unwrap();
        let metrics = doc.scroll_metrics(host).unwrap();
        assert_eq!(&metrics[..2], &[x as f64, y as f64]);
        let actual = doc.paint().unwrap();
        let unit = scale * ratio;
        let left = 10 * ratio + 6 * unit;
        let top = 10 * ratio + 6 * unit;
        let mut dark = 0;
        for py in 0..40 * unit {
            for px in 0..60 * unit {
                let i = (((top + py) * width + left + px) * 4) as usize;
                let j = (((top + py + y * unit) * width + left + px + x * unit) * 4) as usize;
                dark += usize::from(reference[j] < 128);
                // Translating the same f32 path can round coverage by one byte.
                assert!(
                    actual[i..i + 4]
                        .iter()
                        .zip(&reference[j..j + 4])
                        .all(|(a, b)| a.abs_diff(*b) <= 1),
                    "scroll=({x},{y}), scale={scale}, DPR={ratio}, block={block_child}, pixel=({px},{py}): {:?} vs {:?}",
                    &actual[i..i + 4],
                    &reference[j..j + 4]
                );
            }
        }
        assert!(
            dark > 50,
            "the compared source window must contain real glyphs"
        );
    }
}

#[test]
fn inline_scroll_raster_matches_one_source_offset() {
    for ratio in [1, 2] {
        assert_scrolled_pixels(1, ratio, false);
    }
}

#[test]
fn transformed_inline_scroll_raster_uses_local_offset() {
    for ratio in [1, 2] {
        assert_scrolled_pixels(2, ratio, false);
    }
}

#[test]
fn transformed_block_scroll_raster_uses_local_offset() {
    for ratio in [1, 2] {
        assert_scrolled_pixels(2, ratio, true);
    }
}

#[test]
fn terminal_block_margin_remains_in_scroll_extent_and_resize_clamp() {
    // Measured Chromium CSSOM values from the same four authored documents.
    for (padding, margin, expected) in [
        (0, 0, 200.0),
        (12, 0, 224.0),
        (0, 12, 212.0),
        (12, 12, 236.0),
    ] {
        let html = format!(
            "<style>*{{box-sizing:border-box}}html,body{{margin:0}}#outer{{width:300px;height:100px;padding:{padding}px;overflow:auto}}#child{{height:200px;margin-bottom:{margin}px;background:red}}</style><div id='outer'><div id='child'></div></div>"
        );
        let mut doc = UiDocument::new(&html, 320, 240, 1.0, Vec::new()).unwrap();
        let outer = doc.query(doc.root(), "#outer").unwrap()[0];
        let metrics = doc.scroll_metrics(outer).unwrap();
        assert_eq!(metrics[3], expected, "padding={padding}, margin={margin}");
        assert_eq!(metrics[5], 100.0);
        doc.scroll_to(outer, 0.0, 10000.0).unwrap();
        assert_eq!(doc.scroll_metrics(outer).unwrap()[1], expected - 100.0);
        // Growing the actual scrollport reconciles its existing offset against
        // the same margin-inclusive extent before the next geometry read.
        doc.set_style(outer, "height", "160px", "").unwrap();
        let resized = doc.scroll_metrics(outer).unwrap();
        assert_eq!(resized[1], expected - 160.0);
        assert_eq!(resized[3], expected);
        assert_eq!(resized[5], 160.0);
    }
}

#[test]
fn scroll_hit_clips_before_offset_and_inverts_transform_before_scroll() {
    for ratio in [1, 2] {
        for scale in [1, 2] {
            let html = format!(
                "<style>body{{margin:0}}button{{display:block;margin:0;padding:0;border:0;width:100px;height:40px}}#toolbar{{position:absolute;left:10px;top:0;width:200px;height:24px}}#scroll{{position:absolute;left:10px;top:30px;width:100px;height:60px;overflow:auto;transform-origin:0 0;transform:scale({scale})}}#tail{{height:100px}}</style><button id=toolbar></button><div id=scroll><button id=first></button><button id=second></button><div id=tail></div></div>"
            );
            let mut doc =
                UiDocument::new(&html, 240 * ratio, 200 * ratio, ratio as f32, Vec::new()).unwrap();
            let scroll = doc.query(doc.root(), "#scroll").unwrap()[0];
            let toolbar = doc.query(doc.root(), "#toolbar").unwrap()[0];
            let second = doc.query(doc.root(), "#second").unwrap()[0];
            doc.scroll_to(scroll, 0.0, 30.0).unwrap();
            assert_eq!(
                doc.hit(20.0, 10.0).unwrap(),
                toolbar,
                "scale{scale}/DPR{ratio}: clipped content cannot intercept toolbar"
            );
            let rect = doc.rect(second).unwrap();
            assert_eq!(
                doc.hit((rect[0] + 5.0) as f32, (rect[1] + 3.0) as f32)
                    .unwrap(),
                second,
                "scale{scale}/DPR{ratio}: visible child uses local scroll offset"
            );
        }
    }
}

#[test]
fn scroll_into_view_reveals_nested_control_in_local_css_coordinates() {
    use blitz_dom::{NodeId, ScrollBehavior, ScrollLogicalPosition};
    for ratio in [1, 2, 3] {
        for scale in [0.75, 1.0, 1.25] {
            let html = format!(
                "<style>*{{box-sizing:border-box}}html,body{{margin:0;width:100%;height:100%;overflow:hidden}}#panel{{position:absolute;left:24px;top:72px;width:320px;height:220px;overflow:auto;border:8px solid;padding:12px;transform-origin:top left;transform:scale({scale})}}#before{{height:220px}}#field{{display:block;width:120px;height:32px;margin:16px 0}}#after{{height:180px}}</style><form id=panel><div id=before></div><input id=field><div id=after></div></form>"
            );
            let mut doc =
                UiDocument::new(&html, 640 * ratio, 480 * ratio, ratio as f32, Vec::new()).unwrap();
            let panel = doc.query(doc.root(), "#panel").unwrap()[0];
            let field = doc.query(doc.root(), "#field").unwrap()[0];
            doc.resolve();
            doc.document.scroll_into_view(
                NodeId::from_u64(field),
                ScrollBehavior::Instant,
                ScrollLogicalPosition::Nearest,
                ScrollLogicalPosition::Nearest,
            );
            assert_eq!(
                doc.scroll_metrics(panel).unwrap()[1],
                76.0,
                "scale={scale}, DPR={ratio}"
            );
        }
    }
}

#[test]
fn transformed_descendants_extend_one_css_scroll_range_and_reset_on_mutation() {
    for ratio in [1, 3] {
        let html = "<style>*{box-sizing:border-box}html,body{margin:0;overflow:hidden}#outer{position:absolute;left:24px;top:72px;width:360px;height:220px;overflow:auto;padding:12px;border:6px solid;transform:scale(.9);transform-origin:top left}#panel{width:320px;height:220px;overflow:auto;transform:scale(1.25);transform-origin:top left;margin-top:120px;margin-bottom:200px}#content{width:500px;height:520px}</style><section id=outer><form id=panel><div id=content></div></form></section>";
        let mut doc =
            UiDocument::new(html, 640 * ratio, 480 * ratio, ratio as f32, Vec::new()).unwrap();
        let outer = doc.query(doc.root(), "#outer").unwrap()[0];
        let panel = doc.query(doc.root(), "#panel").unwrap()[0];
        // Chromium: the transformed inner border box extends the outer range;
        // inner scrolling content remains clipped and never extends it again.
        assert_eq!(doc.scroll_metrics(outer).unwrap()[2], 412.0, "DPR={ratio}");
        doc.scroll_to(outer, 1000.0, 0.0).unwrap();
        assert_eq!(doc.scroll_metrics(outer).unwrap()[0], 64.0);
        doc.scroll_to(panel, 180.0, 300.0).unwrap();
        assert_eq!(doc.scroll_metrics(outer).unwrap()[2], 412.0);
        doc.set_style(panel, "transform", "scale(.75)", "").unwrap();
        let shrunk = doc.scroll_metrics(outer).unwrap();
        assert_eq!(shrunk[2], 348.0);
        assert_eq!(shrunk[0], 0.0, "transform changes reconcile the same range");
        doc.set_style(panel, "transform", "scale(1.25)", "")
            .unwrap();
        assert_eq!(doc.scroll_metrics(outer).unwrap()[2], 412.0);
    }
}

#[test]
fn hidden_scrolling_subtree_does_not_resolve_unstyled_descendants() {
    let html = "<style>#panel{position:relative;width:300px;height:200px;overflow:hidden}#popup{position:absolute;inset:0;display:grid}</style><section id=panel><div id=popup><button>Close</button></div></section>";
    let mut doc = UiDocument::new(html, 500, 140, 1.0, Vec::new()).unwrap();
    let panel = doc.query(doc.root(), "#panel").unwrap()[0];
    doc.rect(panel).unwrap();
    doc.set_style(panel, "display", "none", "").unwrap();
    assert_eq!(doc.rect(panel).unwrap(), vec![0.0; 4]);
    doc.set_style(panel, "display", "block", "").unwrap();
    assert_eq!(doc.rect(panel).unwrap()[3], 200.0);
}

#[test]
fn focus_reveal_centers_hidden_axes_and_retains_visible_axes() {
    let html = "<style>*{box-sizing:border-box}body{margin:0}#panel{width:200px;height:100px;overflow:auto}#area{width:700px;height:700px;padding:220px 0 0 300px}button{display:block;width:80px;height:20px;padding:0;border:0}</style><div id=panel><div id=area><button id=target>Focus</button></div></div>";
    let mut doc = UiDocument::new(html, 400, 300, 1.0, Vec::new()).unwrap();
    let panel = doc.query(doc.root(), "#panel").unwrap()[0];
    let target = doc.query(doc.root(), "#target").unwrap()[0];
    // Chromium's actual focus() reference: hidden => center, partly visible
    // => nearest, fully visible/covering => unchanged, independently per axis.
    for (x, y, height, expected) in [
        (0.0, 0.0, "20px", [240.0, 180.0]),
        (250.0, 150.0, "20px", [250.0, 150.0]),
        (190.0, 130.0, "20px", [190.0, 140.0]),
        (0.0, 0.0, "150px", [240.0, 245.0]),
        (240.0, 240.0, "150px", [240.0, 240.0]),
    ] {
        doc.set_style(target, "height", height, "").unwrap();
        doc.scroll_to(panel, x, y).unwrap();
        let changed = doc
            .scroll_into_view(target, "center-if-needed", "center-if-needed")
            .unwrap();
        assert_eq!(&doc.scroll_metrics(panel).unwrap()[..2], &expected);
        assert_eq!(changed.contains(&panel), [x, y] != expected);
        assert!(
            doc.scroll_into_view(target, "center-if-needed", "center-if-needed")
                .unwrap()
                .is_empty()
        );
    }
}
