use super::*;

fn find(doc: &UiDocument, selector: &str) -> u64 {
    doc.query(doc.root(), selector).unwrap()[0]
}

#[test]
fn reset_restores_form_owned_native_values_and_clean_default_state() {
    let mut doc = UiDocument::new(
        "<form id=f><input id=text value=Initial><input id=number type=number value=4>
         <input id=range type=range value=25><textarea id=notes>Default notes</textarea>
         <input id=check type=checkbox checked><input id=a type=radio name=mode checked>
         <input id=b type=radio name=mode><select id=select><option id=low selected>Low</option><option id=high>High</option></select>
         <input id=foreign form=other value=Foreign><input id=disabled disabled value=Locked></form>
         <input id=external form=f value=Outside><form id=other></form>",
        440, 480, 1.0, vec![],
    ).unwrap();
    let form = find(&doc, "#f");
    for (selector, value) in [
        ("#text", "Edited"),
        ("#number", "8"),
        ("#range", "80"),
        ("#notes", "Edited notes"),
        ("#select", "High"),
        ("#foreign", "Edited foreign"),
        ("#external", "Edited outside"),
        ("#disabled", "Edited locked"),
    ] {
        let id = find(&doc, selector);
        doc.set_input_value(id, value).unwrap();
    }
    doc.set_input_checked(find(&doc, "#check"), false).unwrap();
    doc.set_input_checked(find(&doc, "#b"), true).unwrap();
    doc.reset_form(form).unwrap();
    for (selector, expected) in [
        ("#text", "Initial"),
        ("#number", "4"),
        ("#range", "25"),
        ("#notes", "Default notes"),
        ("#select", "Low"),
        ("#foreign", "Edited foreign"),
        ("#external", "Outside"),
        ("#disabled", "Locked"),
    ] {
        assert_eq!(
            doc.input_value(find(&doc, selector)).unwrap(),
            expected,
            "{selector}"
        );
    }
    assert!(doc.input_checked(find(&doc, "#check")).unwrap());
    assert!(doc.input_checked(find(&doc, "#a")).unwrap());
    assert!(!doc.input_checked(find(&doc, "#b")).unwrap());
    for (selector, value) in [("#text", "Updated"), ("#range", "35")] {
        let id = find(&doc, selector);
        doc.set_attribute(id, "value", Some(value.into())).unwrap();
        assert_eq!(doc.input_value(id).unwrap(), value);
    }
    let check = find(&doc, "#check");
    doc.set_attribute(check, "checked", None).unwrap();
    assert!(!doc.input_checked(check).unwrap());
    let high = find(&doc, "#high");
    doc.set_attribute(high, "selected", Some(String::new()))
        .unwrap();
    assert_eq!(doc.input_value(find(&doc, "#select")).unwrap(), "High");
    let number = find(&doc, "#number");
    doc.set_attribute(number, "value", Some("not-a-number".into()))
        .unwrap();
    doc.reset_form(form).unwrap();
    assert_eq!(doc.input_value(number).unwrap(), "");
    assert!(!doc.input_bad_input(number).unwrap());
    assert_eq!(doc.form_owner(find(&doc, "#external")).unwrap(), form);
}
