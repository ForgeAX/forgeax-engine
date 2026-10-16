use super::{SpecialElementData, TextBrush};
use crate::layout::damage::ALL_DAMAGE;
use crate::{BaseDocument, ElementData, NodeId, local_name};
use style::dom::TElement;
use style_dom::ElementState;

/// Current option state stays on the real option nodes. These layouts and popup
/// coordinates are only a projection of that tree, rebuilt by native layout.
#[derive(Clone, Default)]
pub struct SelectInput {
    pub allow_empty: bool,
    pub open: bool,
    pub highlighted: Option<NodeId>,
    pub choices: Vec<(NodeId, parley::Layout<TextBrush>)>,
    pub line_height: f64,
    pub intrinsic_width: f64,
}

impl SelectInput {
    pub fn row_height(&self) -> f64 {
        self.line_height + 6.0
    }
}

impl ElementData {
    pub fn select_data(&self) -> Option<&SelectInput> {
        match &self.special_data {
            SpecialElementData::Select(data) => Some(data),
            _ => None,
        }
    }
    pub fn select_data_mut(&mut self) -> Option<&mut SelectInput> {
        match &mut self.special_data {
            SpecialElementData::Select(data) => Some(data),
            _ => None,
        }
    }
    pub(crate) fn sync_option_attribute(&mut self) {
        if self.name.local != local_name!("option") {
            return;
        }
        if matches!(
            self.special_data,
            SpecialElementData::Option { dirty: true }
        ) {
            return;
        }
        self.special_data = SpecialElementData::Option { dirty: false };
        self.element_state.set(
            ElementState::CHECKED,
            self.has_attr(local_name!("selected")),
        );
    }
}

impl BaseDocument {
    pub fn select_options(&self, id: NodeId) -> Option<Vec<NodeId>> {
        self.get_node(id)?.element_data()?.select_data()?;
        let mut result = Vec::new();
        fn collect(doc: &BaseDocument, id: NodeId, result: &mut Vec<NodeId>) {
            for child in &doc.nodes[id].children {
                let Some(element) = doc.nodes[*child].element_data() else {
                    continue;
                };
                match element.name.local.as_ref() {
                    "option" => result.push(*child),
                    "optgroup" => collect(doc, *child, result),
                    _ => {}
                }
            }
        }
        collect(self, id, &mut result);
        Some(result)
    }
    pub(crate) fn option_owner(&self, id: NodeId) -> Option<NodeId> {
        if self.get_node(id)?.element_data()?.name.local != local_name!("option") {
            return None;
        }
        let parent = self.get_node(id)?.parent?;
        let parent_element = self.nodes[parent].element_data()?;
        if parent_element.name.local == local_name!("optgroup") {
            self.nodes[parent].parent.filter(|id| {
                self.nodes[*id]
                    .element_data()
                    .is_some_and(|e| e.select_data().is_some())
            })
        } else {
            parent_element.select_data().is_some().then_some(parent)
        }
    }
    pub fn option_disabled(&self, id: NodeId) -> bool {
        let node = &self.nodes[id];
        node.attr(local_name!("disabled")).is_some()
            || node.parent.is_some_and(|parent| {
                (&self.nodes[parent]).local_name() == "optgroup"
                    && self.nodes[parent].attr(local_name!("disabled")).is_some()
            })
    }
    pub fn option_value(&self, id: NodeId) -> Option<String> {
        let node = self.get_node(id)?;
        if node.local_name() != "option" {
            return None;
        }
        Some(
            node.attr(local_name!("value"))
                .map(str::to_string)
                .unwrap_or_else(|| {
                    node.text_content()
                        .split_ascii_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                }),
        )
    }
    pub fn select_index(&self, id: NodeId) -> Option<i32> {
        let options = self.select_options(id)?;
        let selected = options.iter().rposition(|option| {
            self.nodes[*option]
                .element_data()
                .unwrap()
                .element_state
                .contains(ElementState::CHECKED)
        });
        let selected = selected.or_else(|| {
            if self.nodes[id]
                .element_data()
                .unwrap()
                .select_data()
                .unwrap()
                .allow_empty
            {
                None
            } else {
                options
                    .iter()
                    .position(|option| !self.option_disabled(*option))
            }
        });
        Some(selected.map_or(-1, |index| index as i32))
    }
    pub fn option_selected(&self, id: NodeId) -> Option<bool> {
        self.option_value(id)?;
        if let Some(owner) = self.option_owner(id) {
            let options = self.select_options(owner)?;
            return Some(
                self.select_index(owner)
                    .and_then(|index| options.get(index as usize).copied())
                    == Some(id),
            );
        }
        Some(
            self.nodes[id]
                .element_data()?
                .element_state
                .contains(ElementState::CHECKED),
        )
    }
    fn write_option(&mut self, id: NodeId, selected: bool, dirty: bool) {
        self.snapshot_node(id);
        let node = &mut self.nodes[id];
        let element = node.element_data_mut().unwrap();
        element.element_state.set(ElementState::CHECKED, selected);
        if dirty {
            element.special_data = SpecialElementData::Option { dirty: true };
        }
        node.insert_damage(ALL_DAMAGE);
        node.mark_ancestors_dirty();
    }
    pub(crate) fn reconcile_select(&mut self, id: NodeId) {
        let owner = if self.select_options(id).is_some() {
            Some(id)
        } else if self.nodes[id]
            .element_data()
            .is_some_and(|e| e.name.local == local_name!("optgroup"))
        {
            self.nodes[id].parent
        } else {
            self.option_owner(id)
        };
        let Some(owner) = owner else {
            return;
        };
        let Some(options) = self.select_options(owner) else {
            return;
        };
        let index = self.select_index(owner).unwrap();
        for (position, option) in options.into_iter().enumerate() {
            let selected = position as i32 == index;
            if self.nodes[option]
                .element_data()
                .unwrap()
                .element_state
                .contains(ElementState::CHECKED)
                != selected
            {
                self.write_option(option, selected, false);
            }
        }
    }
    pub(crate) fn reconcile_selected_option(&mut self, id: NodeId) {
        let Some(owner) = self.option_owner(id) else {
            return;
        };
        if self.nodes[id]
            .element_data()
            .unwrap()
            .element_state
            .contains(ElementState::CHECKED)
        {
            for option in self.select_options(owner).unwrap() {
                if option != id {
                    self.write_option(option, false, false);
                }
            }
        }
        self.reconcile_select(owner);
    }
    pub fn set_select_index(&mut self, id: NodeId, index: i32) -> bool {
        let Some(options) = self.select_options(id) else {
            return false;
        };
        for (position, option) in options.iter().enumerate() {
            self.write_option(*option, position as i32 == index, true);
        }
        let node = &mut self.nodes[id];
        node.element_data_mut()
            .unwrap()
            .select_data_mut()
            .unwrap()
            .allow_empty = index < 0 || index as usize >= options.len();
        node.insert_damage(ALL_DAMAGE);
        node.mark_ancestors_dirty();
        true
    }
    pub fn set_option_selected(&mut self, id: NodeId, selected: bool) -> bool {
        if self.option_value(id).is_none() {
            return false;
        }
        if let Some(owner) = self.option_owner(id) {
            if selected {
                for option in self.select_options(owner).unwrap() {
                    if option != id {
                        self.write_option(option, false, false);
                    }
                }
            }
            self.nodes[owner]
                .element_data_mut()
                .unwrap()
                .select_data_mut()
                .unwrap()
                .allow_empty = false;
        }
        self.write_option(id, selected, true);
        self.reconcile_select(id);
        true
    }
    pub fn select_value(&self, id: NodeId) -> Option<String> {
        let index = self.select_index(id)?;
        Some(
            self.select_options(id)?
                .get(index as usize)
                .and_then(|id| self.option_value(*id))
                .unwrap_or_default(),
        )
    }
    pub fn set_select_value(&mut self, id: NodeId, value: &str) -> bool {
        let Some(options) = self.select_options(id) else {
            return false;
        };
        let index = options
            .iter()
            .position(|id| self.option_value(*id).as_deref() == Some(value));
        for (position, option) in options.into_iter().enumerate() {
            let selected = Some(position) == index;
            self.write_option(option, selected, selected);
        }
        let node = &mut self.nodes[id];
        node.element_data_mut()
            .unwrap()
            .select_data_mut()
            .unwrap()
            .allow_empty = index.is_none();
        node.insert_damage(ALL_DAMAGE);
        node.mark_ancestors_dirty();
        true
    }
    pub(crate) fn prepare_select(&mut self, id: NodeId) {
        let options = self.select_options(id).unwrap();
        let style = self.nodes[id].primary_styles().unwrap();
        let mut text_style = crate::stylo_to_parley::style(id, &style);
        // A native single-line select uses the font strut, independently of
        // authored CSS line-height (as does Chromium).
        text_style.line_height = parley::style::LineHeight::NORMAL;
        drop(style);
        let scale = self.viewport.scale();
        let mut choices = Vec::with_capacity(options.len());
        let mut width = 0.0_f64;
        // Closed controls and popup rows share the font strut, not popup padding.
        // An empty select still has the same native control height.
        let line_height = {
            let mut fonts = self.font_ctx.lock().unwrap();
            let builder = self
                .layout_ctx
                .tree_builder(&mut fonts, scale, true, &text_style);
            let mut strut = builder.build().0;
            strut.break_all_lines(None);
            f64::from(strut.height() / scale)
        };
        for option in options {
            let node = &self.nodes[option];
            let text = node
                .attr(local_name!("label"))
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    node.text_content()
                        .split_ascii_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                });
            let mut fonts = self.font_ctx.lock().unwrap();
            let mut builder = self
                .layout_ctx
                .tree_builder(&mut fonts, scale, true, &text_style);
            builder.push_text(&text);
            let mut layout = builder.build().0;
            layout.break_all_lines(None);
            width = width.max(f64::from(layout.width() / scale));
            choices.push((option, layout));
        }
        let data = self.nodes[id]
            .element_data_mut()
            .unwrap()
            .select_data_mut()
            .unwrap();
        data.choices = choices;
        data.line_height = line_height;
        data.intrinsic_width = width.ceil() + 20.0;
    }
    /// Popup is a viewport layer, so the same rectangle drives painting and input.
    pub fn select_popup_rect(&self, id: NodeId) -> Option<[f64; 4]> {
        let node = self.get_node(id)?;
        let data = node.element_data()?.select_data()?;
        if !data.open
            || !node.flags.is_in_document()
            || !node.has_boxes()
            || node.attr(local_name!("disabled")).is_some()
        {
            return None;
        }
        let rect = self.get_client_bounding_rect(id)?;
        let viewport = self.get_viewport();
        let height = data.row_height() * data.choices.len() as f64;
        let viewport_height = f64::from(viewport.window_size.1) / f64::from(viewport.scale());
        let viewport_width = f64::from(viewport.window_size.0) / f64::from(viewport.scale());
        let width = rect.width.max(data.intrinsic_width).min(viewport_width);
        let x = rect.x.min(viewport_width - width).max(0.0);
        let y = if rect.y + rect.height + height <= viewport_height {
            rect.y + rect.height
        } else {
            (rect.y - height).max(0.0)
        };
        Some([x, y, width, height.min(viewport_height)])
    }
    pub fn select_popup_hit(&self, x: f64, y: f64) -> Option<NodeId> {
        self.nodes.iter().find_map(|(id, _)| {
            self.select_popup_rect(id)
                .filter(|r| x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3])
                .map(|_| id)
        })
    }
    pub fn select_close(&mut self, id: NodeId) {
        if let Some(data) = self
            .nodes
            .get_mut(id)
            .and_then(|node| node.element_data_mut())
            .and_then(|element| element.select_data_mut())
        {
            data.open = false;
            data.highlighted = None;
        }
    }
    pub fn select_pointer(&mut self, id: NodeId, x: f64, y: f64, commit: bool) -> bool {
        if self.nodes[id].attr(local_name!("disabled")).is_some() {
            return false;
        }
        let before = self.select_index(id);
        if let Some(rect) = self.select_popup_rect(id) {
            if x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3] {
                let data = self.nodes[id]
                    .element_data()
                    .unwrap()
                    .select_data()
                    .unwrap();
                let index = ((y - rect[1]) / data.row_height()).floor() as usize;
                if let Some(option) = data.choices.get(index).map(|choice| choice.0) {
                    if !self.option_disabled(option) {
                        self.nodes[id]
                            .element_data_mut()
                            .unwrap()
                            .select_data_mut()
                            .unwrap()
                            .highlighted = Some(option);
                        if commit {
                            self.set_select_index(id, index as i32);
                            self.select_close(id);
                        }
                    }
                }
            } else if !commit {
                self.select_close(id);
            }
        } else if !commit {
            let option = self
                .select_options(id)
                .and_then(|options| options.get(before.unwrap_or(-1) as usize).copied());
            let data = self.nodes[id]
                .element_data_mut()
                .unwrap()
                .select_data_mut()
                .unwrap();
            data.open = true;
            data.highlighted = option;
        }
        before != self.select_index(id)
    }
    pub fn select_key(&mut self, id: NodeId, key: &str) -> bool {
        let Some(options) = self.select_options(id) else {
            return false;
        };
        if self.nodes[id].attr(local_name!("disabled")).is_some() {
            return false;
        }
        let before = self.select_index(id).unwrap();
        let open = self.nodes[id]
            .element_data()
            .unwrap()
            .select_data()
            .unwrap()
            .open;
        if key == "Escape" && !open {
            return false;
        }
        if key == " " || key == "Enter" || key == "Escape" {
            if open {
                let highlighted = self.nodes[id]
                    .element_data()
                    .unwrap()
                    .select_data()
                    .unwrap()
                    .highlighted;
                if let Some(index) = options
                    .iter()
                    .position(|option| {
                        Some(*option) == highlighted && !self.option_disabled(*option)
                    })
                {
                    self.set_select_index(id, index as i32);
                }
                self.select_close(id);
            } else {
                let data = self.nodes[id]
                    .element_data_mut()
                    .unwrap()
                    .select_data_mut()
                    .unwrap();
                data.open = true;
                data.highlighted = options.get(before as usize).copied();
            }
            return before != self.select_index(id).unwrap();
        }
        let active = if open {
            self.nodes[id]
                .element_data()
                .unwrap()
                .select_data()
                .unwrap()
                .highlighted
                .and_then(|id| options.iter().position(|option| *option == id))
                .map_or(before, |i| i as i32)
        } else {
            before
        };
        let (start, direction) = match key {
            "ArrowDown" | "ArrowRight" => (active + 1, 1),
            "ArrowUp" | "ArrowLeft" => (active - 1, -1),
            "Home" | "PageUp" => (0, 1),
            "End" | "PageDown" => (options.len() as i32 - 1, -1),
            _ => return false,
        };
        let mut index = start;
        while index >= 0 && (index as usize) < options.len() {
            let option = options[index as usize];
            if !self.option_disabled(option) {
                if open {
                    self.nodes[id]
                        .element_data_mut()
                        .unwrap()
                        .select_data_mut()
                        .unwrap()
                        .highlighted = Some(option);
                } else {
                    self.set_select_index(id, index);
                }
                break;
            }
            index += direction;
        }
        before != self.select_index(id).unwrap()
    }
}
