use super::UiDocument;
use blitz_traits::node_id::NodeId;

#[test]
fn tab_continues_at_the_removed_inventory_row() {
    for reverse in [false, true] {
        let mut doc = UiDocument::new(
            "<button id=add>Add</button><div><button id=a>A</button></div><div id=row><button id=b>B</button></div><div><button id=c>C</button></div>",
            360, 320, 1.0, Vec::new(),
        ).unwrap();
        let find = |doc: &UiDocument, selector| doc.query(doc.root(), selector).unwrap()[0];
        let row = find(&doc, "#row");
        let b = find(&doc, "#b");
        let expected = NodeId::from_u64(find(&doc, if reverse { "#a" } else { "#c" }));
        doc.focus(b, false).unwrap();
        doc.remove(row).unwrap();
        doc.resolve();
        assert_ne!(
            doc.document.get_focussed_node_id(),
            Some(NodeId::from_u64(b))
        );
        let actual = if reverse {
            doc.document.focus_prev_node()
        } else {
            doc.document.focus_next_node()
        };
        assert_eq!(actual, Some(expected), "reverse={reverse}");
    }
}

#[test]
fn removed_focus_boundary_tracks_live_siblings_and_eligibility() {
    let mut doc = UiDocument::new(
        "<button id=add>Add</button><div id=items><button id=a>A</button><button id=b>B</button><button id=c>C</button></div><button id=close>Close</button>",
        360, 320, 1.0, Vec::new(),
    ).unwrap();
    let find = |doc: &UiDocument, selector| doc.query(doc.root(), selector).unwrap()[0];
    let add = find(&doc, "#add");
    let a = find(&doc, "#a");
    let b = find(&doc, "#b");
    let c = find(&doc, "#c");
    let items = find(&doc, "#items");
    let close = find(&doc, "#close");
    doc.focus(b, false).unwrap();
    doc.remove(b).unwrap();
    // Insertion/removal before the retained gap cannot shift it to another row.
    doc.insert(items, add, a).unwrap();
    assert_eq!(doc.sequential_focus_target(false), c);
    doc.remove(a).unwrap();
    assert_eq!(doc.sequential_focus_target(false), c);
    assert_eq!(doc.sequential_focus_target(true), add);
    // Insertion exactly at the gap participates in the next Tab traversal.
    doc.insert(items, b, c).unwrap();
    assert_eq!(doc.sequential_focus_target(false), b);
    doc.set_attribute(b, "disabled".into(), Some(String::new()))
        .unwrap();
    assert_eq!(doc.sequential_focus_target(false), c);
    doc.set_attribute(items, "inert".into(), Some(String::new()))
        .unwrap();
    assert_eq!(doc.sequential_focus_target(false), close);
    doc.remove(items).unwrap();
    assert_eq!(doc.sequential_focus_target(false), close);
}
