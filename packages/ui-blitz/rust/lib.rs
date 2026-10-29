//! Persistent headless DOM. JavaScript wraps these generational core identities;
//! it never owns a second tree or a layout implementation.
use anyrender::{ImageRenderer, PaintScene};
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::{DocumentConfig, Node, NodeData, NodeId, QualName, StyleThreading};
use std::sync::Arc;
mod gpu;
mod resources;
#[cfg(test)]
mod image_tests;
#[cfg(test)]
mod scroll_tests;
#[cfg(test)]
mod focus_tests;
#[cfg(test)]
mod form_tests;
#[cfg(test)]
mod control_tests;
use blitz_html::HtmlDocument;
use blitz_paint::paint_scene;
use blitz_traits::shell::{ColorScheme, Viewport};
use resources::Resources;
use serde::Serialize;
use wasm_bindgen::prelude::*;

fn name(local: &str, element: bool) -> QualName {
    QualName::new(
        None,
        if element {
            blitz_dom::ns!(html)
        } else {
            blitz_dom::ns!()
        },
        local.into(),
    )
}

fn viewport(width: u32, height: u32, scale: f32) -> Result<Viewport, String> {
    if width == 0
        || height == 0
        || width > 4096
        || height > 4096
        || !scale.is_finite()
        || scale <= 0.0
    {
        return Err("ui-invalid-viewport: dimensions must be 1..4096 and scale positive".into());
    }
    Ok(Viewport::new(width, height, scale, ColorScheme::Light))
}

enum Painter {
    Cpu(VelloCpuImageRenderer),
    Gpu(gpu::GpuPainter),
}

#[wasm_bindgen]
pub struct UiDocument {
    document: HtmlDocument,
    resources: Arc<Resources>,
    painter: Option<Painter>,
    time_ms: f64,
    dirty: bool,
}

impl UiDocument {
    fn node(&self, id: u64) -> Result<&Node, String> {
        self.document
            .get_node(NodeId::from_u64(id))
            .ok_or_else(|| "ui-stale-node: node identity is no longer live".into())
    }

    fn element(&self, id: u64) -> Result<&Node, String> {
        let node = self.node(id)?;
        if !node.is_element() {
            return Err("ui-invalid-node: expected an element".into());
        }
        Ok(node)
    }

    fn check_insertion(&self, parent: u64, child: u64) -> Result<(), String> {
        if !matches!(self.node_type(parent)?, 1 | 11) {
            return Err("HierarchyRequestError: parent cannot contain children".into());
        }
        self.node(child)?;
        let mut ancestor = Some(NodeId::from_u64(parent));
        while let Some(id) = ancestor {
            if id.as_u64() == child {
                return Err("HierarchyRequestError: insertion would create a cycle".into());
            }
            ancestor = self
                .document
                .get_node(id)
                .and_then(|node| node.parent.or(node.shadow_host_id()));
        }
        if child == self.root() || self.node(child)?.shadow_host_id().is_some() {
            return Err("HierarchyRequestError: cannot insert document".into());
        }
        Ok(())
    }

    fn resolve(&mut self) {
        // Stylo takes seconds. The public host clock and binding take milliseconds.
        self.document.resolve(self.time_ms / 1000.0);
        if self
            .document
            .get_focussed_node_id()
            .is_some_and(|id| !self.document.can_focus(id))
        {
            self.document.clear_focus();
        }
    }
}

#[wasm_bindgen]
impl UiDocument {
    #[wasm_bindgen(constructor)]
    pub fn new(
        html: &str,
        width: u32,
        height: u32,
        scale: f32,
        font: Vec<u8>,
    ) -> Result<UiDocument, String> {
        Self::with_resources(html, width, height, scale, font, None, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_resources(
        html: &str,
        width: u32,
        height: u32,
        scale: f32,
        font: Vec<u8>,
        font_family: Option<String>,
        base_url: Option<String>,
    ) -> Result<UiDocument, String> {
        let viewport = viewport(width, height, scale)?;
        if let Some(url) = &base_url {
            blitz_traits::net::Url::parse(url)
                .map_err(|error| format!("ui-invalid-base-url: {error}"))?;
        }
        let font_ctx = blitz_dom::build_single_font_ctx_with_family(&font, font_family.as_deref())
            .map_err(|error| format!("ui-invalid-font: {error}"))?;
        let resources = Arc::new(Resources::default());
        Ok(Self {
            document: HtmlDocument::from_html(
                html,
                DocumentConfig {
                    scripting_enabled: true,
                    viewport: Some(viewport),
                    style_threading: StyleThreading::Sequential,
                    font_ctx: Some(font_ctx),
                    base_url,
                    net_provider: Some(resources.clone()),
                    html_parser_provider: Some(Arc::new(blitz_html::HtmlProvider)),
                    ..Default::default()
                },
            ),
            resources,
            painter: None,
            time_ms: 0.0,
            dirty: true,
        })
    }

    pub fn resource_requests(&mut self) -> Vec<u32> {
        self.resolve();
        self.resources.take_requests()
    }

    pub fn resource_url(&self, id: u32) -> Result<String, String> {
        self.resources.url(id)
    }

    pub fn resource_response(&mut self, id: u32, bytes: Vec<u8>) -> Result<(), String> {
        self.resources.complete(id, Ok(bytes))?;
        self.document.handle_messages();
        self.dirty = true;
        Ok(())
    }

    pub fn resource_failed(&mut self, id: u32, message: String) -> Result<(), String> {
        self.resources.complete(id, Err(message))?;
        self.document.handle_messages();
        self.dirty = true;
        Ok(())
    }

    /// Alternating URL/message pairs, drained after each transport batch.
    pub fn resource_errors(&mut self) -> Vec<String> {
        self.document
            .take_resource_errors()
            .into_iter()
            .flat_map(|(url, message)| [url.unwrap_or_default(), message])
            .collect()
    }

    pub fn root(&self) -> u64 {
        self.document.root_node().id.as_u64()
    }
    pub fn document_element(&self) -> u64 {
        self.document.root_element().id.as_u64()
    }
    pub fn node_type(&self, id: u64) -> Result<u8, String> {
        Ok(match &self.node(id)?.data {
            NodeData::Element(_) => 1,
            NodeData::Text(_) => 3,
            NodeData::Comment { .. } => 8,
            NodeData::Document(_) => 9,
            NodeData::DocumentFragment(_) => 11,
            _ => return Err("ui-internal-node: layout nodes are not DOM nodes".into()),
        })
    }
    pub fn clone_node(&mut self, id: u64, deep: bool) -> Result<u64, String> {
        let node = self.node(id)?;
        if node.shadow_host_id().is_some() || self.node_type(id)? == 9 {
            return Err("NotSupportedError: cannot clone document or shadow root".into());
        }
        Ok(self
            .document
            .clone_node(NodeId::from_u64(id), deep)
            .as_u64())
    }
    pub fn template_content(&mut self, id: u64) -> Result<u64, String> {
        if self.tag_name(id)? != "template" {
            return Err("ui-invalid-node: expected template element".into());
        }
        Ok(self
            .document
            .mutate()
            .template_contents(NodeId::from_u64(id))
            .as_u64())
    }
    pub fn tag_name(&self, id: u64) -> Result<String, String> {
        Ok(self
            .element(id)?
            .element_data()
            .unwrap()
            .name
            .local
            .to_string())
    }
    pub fn parent(&self, id: u64) -> Result<u64, String> {
        Ok(self.node(id)?.parent.map_or(0, NodeId::as_u64))
    }
    pub fn children(&self, id: u64) -> Result<Vec<u64>, String> {
        Ok(self
            .node(id)?
            .children
            .iter()
            .map(|id| id.as_u64())
            .collect())
    }
    pub fn query(&self, scope: u64, selector: &str) -> Result<Vec<u64>, String> {
        self.node(scope)?;
        self.document
            .query_selector_all_in(NodeId::from_u64(scope), selector)
            .map(|ids| ids.into_iter().map(NodeId::as_u64).collect())
            .map_err(|error| format!("SyntaxError: {error:?}"))
    }
    pub fn matches(&self, id: u64, selector: &str) -> Result<bool, String> {
        self.element(id)?;
        self.document
            .matches_selector(NodeId::from_u64(id), selector)
            .map_err(|error| format!("SyntaxError: {error:?}"))
    }
    pub fn create_element(&mut self, tag: &str) -> Result<u64, String> {
        if tag.is_empty()
            || !tag
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("InvalidCharacterError: invalid element name".into());
        }
        Ok(self
            .document
            .mutate()
            .create_element(name(&tag.to_ascii_lowercase(), true), vec![])
            .as_u64())
    }
    pub fn create_text(&mut self, text: &str) -> u64 {
        self.document.mutate().create_text_node(text).as_u64()
    }
    pub fn create_fragment(&mut self) -> u64 {
        self.document.mutate().create_document_fragment().as_u64()
    }
    pub fn attach_shadow(&mut self, id: u64) -> Result<u64, String> {
        self.element(id)?;
        let root = self.document.mutate().attach_shadow(NodeId::from_u64(id))?;
        self.dirty = true;
        Ok(root.as_u64())
    }
    pub fn shadow_root(&self, id: u64) -> Result<u64, String> {
        Ok(self.element(id)?.shadow_root_id().map_or(0, NodeId::as_u64))
    }
    pub fn shadow_host(&self, id: u64) -> Result<u64, String> {
        Ok(self.node(id)?.shadow_host_id().map_or(0, NodeId::as_u64))
    }
    pub fn attribute(&self, id: u64, attr: &str) -> Result<Option<String>, String> {
        Ok(self
            .element(id)?
            .element_data()
            .unwrap()
            .attr(blitz_dom::LocalName::from(attr))
            .map(str::to_string))
    }
    pub fn attribute_names(&self, id: u64) -> Result<Vec<String>, String> {
        Ok(self
            .element(id)?
            .element_data()
            .unwrap()
            .attrs()
            .iter()
            .map(|a| a.name.local.to_string())
            .collect())
    }
    pub fn set_attribute(
        &mut self,
        id: u64,
        attr: &str,
        value: Option<String>,
    ) -> Result<(), String> {
        self.element(id)?;
        if attr.is_empty()
            || attr
                .chars()
                .any(|c| c.is_whitespace() || "\"'>/=\0".contains(c))
        {
            return Err("InvalidCharacterError: invalid attribute name".into());
        }
        let attr = attr.to_ascii_lowercase();
        if self.attribute(id, &attr)? == value {
            return Ok(());
        }
        let mut mutation = self.document.mutate();
        match value {
            Some(value) => mutation.set_attribute(NodeId::from_u64(id), name(&attr, false), &value),
            None => mutation.clear_attribute(NodeId::from_u64(id), name(&attr, false)),
        }
        self.dirty = true;
        Ok(())
    }
    pub fn insert(&mut self, parent: u64, child: u64, before: u64) -> Result<(), String> {
        self.check_insertion(parent, child)?;
        if before != 0 && self.parent(before)? != parent {
            return Err("NotFoundError: reference is not a child".into());
        }
        if child == before {
            return Ok(());
        }
        let mut mutation = self.document.mutate();
        mutation.remove_node(NodeId::from_u64(child));
        if before == 0 {
            mutation.append_children(NodeId::from_u64(parent), &[NodeId::from_u64(child)]);
        } else {
            mutation.insert_nodes_before(NodeId::from_u64(before), &[NodeId::from_u64(child)]);
        }
        self.dirty = true;
        Ok(())
    }
    pub fn remove(&mut self, id: u64) -> Result<(), String> {
        self.node(id)?;
        if id == self.root() {
            return Err("HierarchyRequestError: cannot remove document".into());
        }
        self.document.mutate().remove_node(NodeId::from_u64(id));
        self.dirty = true;
        Ok(())
    }
    pub fn text_content(&self, id: u64) -> Result<String, String> {
        Ok(self.node(id)?.text_content())
    }
    pub fn set_text_content(&mut self, id: u64, text: &str) -> Result<(), String> {
        let node_type = self.node_type(id)?;
        let mut mutation = self.document.mutate();
        if node_type == 3 {
            mutation.set_node_text(NodeId::from_u64(id), text);
        } else if matches!(node_type, 1 | 11) {
            let children = if text.is_empty() {
                vec![]
            } else {
                vec![mutation.create_text_node(text)]
            };
            mutation.replace_children(NodeId::from_u64(id), &children);
        } else {
            return Err("ui-unsupported-operation: textContent setter on this node".into());
        }
        self.dirty = true;
        Ok(())
    }
    pub fn inner_html(&self, id: u64) -> Result<String, String> {
        let mut output = String::new();
        let node = self.node(id)?;
        let node = node
            .element_data()
            .and_then(|element| element.template_contents)
            .and_then(|id| self.document.get_node(id))
            .unwrap_or(node);
        for child in &node.children {
            self.document
                .get_node(*child)
                .unwrap()
                .write_outer_html(&mut output);
        }
        Ok(output)
    }
    pub fn set_inner_html(&mut self, id: u64, html: &str) -> Result<(), String> {
        if !matches!(self.node_type(id)?, 1 | 11) {
            return Err("ui-invalid-node: innerHTML requires element or fragment".into());
        }
        self.document
            .mutate()
            .set_inner_html(NodeId::from_u64(id), html);
        self.dirty = true;
        Ok(())
    }
    pub fn style_value(&self, id: u64, property: &str) -> Result<String, String> {
        Ok(self
            .document
            .style_attr_get_property(&self.attribute(id, "style")?.unwrap_or_default(), property))
    }
    pub fn set_style(
        &mut self,
        id: u64,
        property: &str,
        value: &str,
        priority: &str,
    ) -> Result<(), String> {
        let previous = self.attribute(id, "style")?.unwrap_or_default();
        if !priority.is_empty() && !priority.eq_ignore_ascii_case("important") {
            return Ok(());
        }
        let next =
            self.document
                .style_attr_set_property(&previous, property, value, !priority.is_empty());
        match next {
            Some(next) => self.set_attribute(id, "style", Some(next)),
            None => Ok(()),
        }
    }
    pub fn computed_style(&mut self, id: u64, property: &str) -> Result<String, String> {
        self.element(id)?;
        self.resolve();
        Ok(self
            .document
            .resolved_style_value(NodeId::from_u64(id), property))
    }
    pub fn rect(&mut self, id: u64) -> Result<Vec<f64>, String> {
        self.element(id)?;
        self.resolve();
        let rect = self
            .document
            .get_client_bounding_rect(NodeId::from_u64(id))
            .ok_or("ui-layout-unavailable: element has no box")?;
        Ok(vec![rect.x, rect.y, rect.width, rect.height])
    }
    pub fn set_viewport(&mut self, width: u32, height: u32, scale: f32) -> Result<(), String> {
        let mut viewport = viewport(width, height, scale)?;
        viewport.prefers_reduced_motion = self.document.get_viewport().prefers_reduced_motion;
        self.document.set_viewport(viewport);
        if let Some(Painter::Cpu(painter)) = self.painter.as_mut() {
            painter.resize(width, height);
        }
        self.dirty = true;
        Ok(())
    }
    pub fn set_reduced_motion(&mut self, reduce: bool) {
        let mut viewport = self.document.get_viewport().clone();
        if viewport.prefers_reduced_motion != reduce {
            viewport.prefers_reduced_motion = reduce;
            self.document.set_viewport(viewport);
            self.dirty = true;
        }
    }
    pub fn set_time(&mut self, time_ms: f64) -> Result<(), String> {
        if !time_ms.is_finite() || time_ms < self.time_ms {
            return Err("ui-invalid-clock: expected monotonic milliseconds".into());
        }
        if time_ms != self.time_ms && self.document.is_animating() {
            self.dirty = true;
        }
        self.time_ms = time_ms;
        Ok(())
    }
    pub fn show_validation_message(&mut self, id: u64, message: &str) -> Result<(), String> {
        self.element(id)?;
        self.resolve();
        self.document.show_validation_message(NodeId::from_u64(id), message);
        self.dirty = true;
        Ok(())
    }
    pub fn can_focus(&mut self, id: u64) -> Result<bool, String> {
        self.element(id)?;
        self.resolve();
        Ok(self.document.can_focus(NodeId::from_u64(id)))
    }
    pub fn sequential_focus_target(&mut self, reverse: bool) -> u64 {
        self.resolve();
        self.document.sequential_focus_target(reverse).map_or(0, |id| id.as_u64())
    }
    pub fn focus(&mut self, id: u64, by_pointer: bool) -> Result<(), String> {
        if id == 0 {
            self.document.clear_focus();
        } else {
            self.element(id)?;
            self.resolve();
            if by_pointer {
                self.document.set_focus_by_pointer(NodeId::from_u64(id));
            } else {
                self.document.set_focus_to(NodeId::from_u64(id));
            }
        }
        self.dirty = true;
        Ok(())
    }
    pub fn select_input_text(&mut self, id: u64) -> Result<bool, String> {
        self.element(id)?;
        self.resolve();
        let node_id = NodeId::from_u64(id);
        if self.document.get_focussed_node_id() != Some(node_id)
            || self.element(id)?.element_data().unwrap().text_input_data().is_none()
        {
            return Ok(false);
        }
        self.document.with_text_input(node_id, |mut driver| driver.select_all());
        self.dirty = true;
        Ok(true)
    }
    pub fn keyboard_focus(&mut self) {
        self.dirty |= self.document.use_keyboard_focus();
    }
    pub fn set_hover(&mut self, id: u64) -> Result<(), String> {
        if id != 0 {
            self.element(id)?;
        }
        self.dirty |= self
            .document
            .set_hover_element((id != 0).then(|| NodeId::from_u64(id)));
        Ok(())
    }
    pub fn set_active(&mut self, id: u64) -> Result<(), String> {
        if id != 0 {
            self.element(id)?;
        }
        self.dirty |= self
            .document
            .set_active_element((id != 0).then(|| NodeId::from_u64(id)));
        Ok(())
    }
    pub fn scroll_metrics(&mut self, id: u64) -> Result<Vec<f64>, String> {
        self.element(id)?;
        self.resolve();
        let node = self.node(id)?;
        if !node.has_boxes() {
            return Ok(vec![0.0; 8]);
        }
        let offset = if id == self.document_element() {
            self.document.viewport_scroll()
        } else {
            node.scroll_position()
        };
        Ok(vec![
            offset.x,
            offset.y,
            f64::from(node.scroll_width()),
            f64::from(node.scroll_height()),
            f64::from(node.client_width()),
            f64::from(node.client_height()),
            f64::from(node.client_left()),
            f64::from(node.client_top()),
        ])
    }
    pub fn scroll_to(&mut self, id: u64, x: f64, y: f64) -> Result<(), String> {
        self.element(id)?;
        if !x.is_finite() || !y.is_finite() {
            return Err("ui-invalid-coordinate: expected finite coordinates".into());
        }
        self.resolve();
        self.document.scroll_to(
            NodeId::from_u64(id),
            x,
            y,
            blitz_dom::ScrollBehavior::Instant,
        );
        self.dirty = true;
        Ok(())
    }
    pub fn scroll_into_view(
        &mut self,
        id: u64,
        block: &str,
        inline: &str,
    ) -> Result<Vec<u64>, String> {
        use blitz_dom::ScrollLogicalPosition;
        let alignment = |value| match value {
            "start" => Ok(ScrollLogicalPosition::Start),
            "center" => Ok(ScrollLogicalPosition::Center),
            "center-if-needed" => Ok(ScrollLogicalPosition::CenterIfNeeded),
            "end" => Ok(ScrollLogicalPosition::End),
            "nearest" => Ok(ScrollLogicalPosition::Nearest),
            _ => Err(
                "ui-invalid-scroll-alignment: expected start, center, end or nearest".to_owned(),
            ),
        };
        let block = alignment(block)?;
        let inline = alignment(inline)?;
        self.element(id)?;
        self.resolve();
        let changed = self.document.scroll_into_view(
            NodeId::from_u64(id),
            blitz_dom::ScrollBehavior::Instant,
            block,
            inline,
        );
        self.dirty |= !changed.is_empty();
        Ok(changed.into_iter().map(NodeId::as_u64).collect())
    }
    /// CSS/wheel deltas are positive towards larger scroll offsets. Return the
    /// actual core scrollers, so JS dispatches events after releasing the borrow.
    pub fn scroll_by_user(&mut self, id: u64, x: f64, y: f64) -> Result<Vec<u64>, String> {
        self.element(id)?;
        if !x.is_finite() || !y.is_finite() {
            return Err("ui-invalid-coordinate: expected finite coordinates".into());
        }
        self.resolve();
        let mut changed = Vec::new();
        self.dirty |=
            self.document
                .scroll_node_by_has_changed(NodeId::from_u64(id), -x, -y, |event| {
                    changed.push(event.target.as_u64())
                });
        Ok(changed)
    }
    /// Snapshot direct-manipulation pan permissions at pointerdown. Bit 0 is X,
    /// bit 1 is Y. Wheel/programmatic scrolling has independent semantics.
    pub fn touch_pan_axes(&mut self, id: u64) -> Result<u8, String> {
        self.element(id)?;
        self.resolve();
        let (x, y) = blitz_dom::touch_action_pan_axes(&self.document, NodeId::from_u64(id));
        Ok(u8::from(x) | (u8::from(y) << 1))
    }
    pub fn focused(&self) -> u64 {
        self.document
            .get_focussed_node_id()
            .filter(|id| {
                self.document
                    .get_node(*id)
                    .is_some_and(|node| node.is_focussed())
            })
            .map_or(0, NodeId::as_u64)
    }
    pub fn hit(&mut self, x: f32, y: f32) -> Result<u64, String> {
        if !x.is_finite() || !y.is_finite() {
            return Err("ui-invalid-coordinate: expected finite coordinates".into());
        }
        self.resolve();
        if let Some(id) = self.document.select_popup_hit(f64::from(x), f64::from(y)) {
            return Ok(id.as_u64());
        }
        Ok(self
            .document
            .element_from_point(x, y)
            .map_or(0, NodeId::as_u64))
    }
    pub fn input_value(&self, id: u64) -> Result<String, String> {
        self.element(id)?;
        self.document
            .input_value(NodeId::from_u64(id))
            .ok_or_else(|| "ui-invalid-node: expected a value-bearing input".into())
    }
    pub fn select_options(&self, id: u64) -> Result<Vec<u64>, String> {
        self.node(id)?;
        self.document
            .select_options(NodeId::from_u64(id))
            .map(|ids| ids.into_iter().map(NodeId::as_u64).collect())
            .ok_or_else(|| "ui-invalid-node: expected select".into())
    }
    pub fn select_index(&self, id: u64) -> Result<i32, String> {
        self.node(id)?;
        self.document
            .select_index(NodeId::from_u64(id))
            .ok_or_else(|| "ui-invalid-node: expected select".into())
    }
    pub fn set_select_index(&mut self, id: u64, index: i32) -> Result<(), String> {
        self.select_index(id)?;
        self.document.set_select_index(NodeId::from_u64(id), index);
        self.dirty = true;
        Ok(())
    }
    pub fn option_selected(&self, id: u64) -> Result<bool, String> {
        self.node(id)?;
        self.document
            .option_selected(NodeId::from_u64(id))
            .ok_or_else(|| "ui-invalid-node: expected option".into())
    }
    pub fn set_option_selected(&mut self, id: u64, selected: bool) -> Result<(), String> {
        self.option_selected(id)?;
        self.document
            .set_option_selected(NodeId::from_u64(id), selected);
        self.dirty = true;
        Ok(())
    }
    pub fn select_key(&mut self, id: u64, key: &str) -> Result<bool, String> {
        self.select_index(id)?;
        self.resolve();
        let changed = self.document.select_key(NodeId::from_u64(id), key);
        self.dirty = true;
        Ok(changed)
    }
    pub fn select_pointer(
        &mut self,
        id: u64,
        x: f64,
        y: f64,
        commit: bool,
    ) -> Result<bool, String> {
        self.select_index(id)?;
        if !x.is_finite() || !y.is_finite() {
            return Err("ui-invalid-pointer: expected finite coordinates".into());
        }
        self.resolve();
        let changed = self
            .document
            .select_pointer(NodeId::from_u64(id), x, y, commit);
        self.dirty = true;
        Ok(changed)
    }
    pub fn select_close(&mut self, id: u64) -> Result<(), String> {
        self.select_index(id)?;
        self.document.select_close(NodeId::from_u64(id));
        self.dirty = true;
        Ok(())
    }
    pub fn input_checked(&self, id: u64) -> Result<bool, String> {
        self.element(id)?;
        self.document
            .input_checked(NodeId::from_u64(id))
            .ok_or_else(|| "ui-invalid-node: expected a checkbox or radio input".into())
    }
    pub fn set_input_checked(&mut self, id: u64, checked: bool) -> Result<(), String> {
        self.input_checked(id)?;
        self.document
            .set_input_checked(NodeId::from_u64(id), checked);
        self.dirty = true;
        Ok(())
    }
    pub fn radio_group(&self, id: u64) -> Result<Vec<u64>, String> {
        self.input_checked(id)?;
        Ok(self
            .document
            .radio_group(NodeId::from_u64(id))
            .into_iter()
            .map(NodeId::as_u64)
            .collect())
    }
    pub fn set_input_value(&mut self, id: u64, value: &str) -> Result<(), String> {
        self.input_value(id)?;
        self.document.set_input_value(NodeId::from_u64(id), value);
        self.dirty = true;
        Ok(())
    }
    pub fn form_owner(&self, id: u64) -> Result<u64, String> {
        self.element(id)?;
        Ok(self.document.form_owner(NodeId::from_u64(id)).map_or(0, NodeId::as_u64))
    }
    pub fn reset_form(&mut self, id: u64) -> Result<(), String> {
        self.element(id)?;
        if !self.document.reset_form(NodeId::from_u64(id)) {
            return Err("ui-invalid-node: expected a form".into());
        }
        self.dirty = true;
        Ok(())
    }
    /// Pointer defaults and painting use the same native value and thumb geometry.
    pub fn range_pointer(&mut self, id: u64, x: f64, y: f64) -> Result<(), String> {
        if !x.is_finite() || !y.is_finite() {
            return Err("ui-invalid-coordinate: expected finite coordinates".into());
        }
        let rect = self.rect(id)?;
        let node = self.node(id)?;
        let constraints = node
            .element_data()
            .unwrap()
            .range_constraints()
            .ok_or("ui-invalid-node: expected a range input")?;
        let (vertical, reversed) = node.range_axis();
        let thumb = blitz_dom::node::RANGE_THUMB_SIZE.min(rect[2]).min(rect[3]);
        let (position, length) = if vertical {
            (y - rect[1], rect[3])
        } else {
            (x - rect[0], rect[2])
        };
        let ratio = if length > thumb {
            ((position - thumb / 2.0) / (length - thumb)).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let ratio = if reversed { 1.0 - ratio } else { ratio };
        let value = constraints.min * (1.0 - ratio) + constraints.max * ratio;
        self.set_input_value(id, &value.to_string())
    }
    pub fn range_key(&mut self, id: u64, key: &str) -> Result<(), String> {
        self.resolve();
        let node = self.element(id)?;
        let element = node.element_data().unwrap();
        let constraints = element
            .range_constraints()
            .ok_or("ui-invalid-node: expected a range input")?;
        let value = element.range_value().unwrap();
        let (_, reversed) = node.range_axis();
        let step = constraints
            .step
            .unwrap_or((constraints.max - constraints.min) / 100.0);
        let page = ((constraints.max - constraints.min) / 10.0).max(step);
        let value = match key {
            "Home" => constraints.min,
            "End" => constraints.max,
            "ArrowRight" => value + if reversed { -step } else { step },
            "ArrowLeft" => value + if reversed { step } else { -step },
            "ArrowUp" => value + step,
            "ArrowDown" => value - step,
            "PageUp" => value + page,
            "PageDown" => value - page,
            _ => return Err("ui-invalid-key: expected a range navigation key".into()),
        };
        self.set_input_value(id, &value.to_string())
    }
    /// Number button hit-testing reuses the native transformed/clipped hit path.
    pub fn number_stepper_hit(&mut self, id: u64, x: f64, y: f64) -> Result<i32, String> {
        self.element(id)?;
        self.resolve();
        let Some(hit) = self.document.hit(x as f32, y as f32) else { return Ok(0); };
        if hit.node_id != NodeId::from_u64(id) { return Ok(0); }
        let Some(rect) = self.node(id)?.number_stepper_rect() else { return Ok(0); };
        let point = vello_common::kurbo::Point::new(f64::from(hit.x), f64::from(hit.y));
        Ok(if !rect.contains(point) { 0 } else if point.y < rect.center().y { 1 } else { -1 })
    }
    /// User number stepping accepts step=any as a unit increment, as native browsers do.
    pub fn number_step(&mut self, id: u64, count: i32) -> Result<(), String> {
        self.resolve();
        let node = self.element(id)?;
        if !self.document.can_focus(NodeId::from_u64(id)) || node.attr(blitz_dom::local_name!("readonly")).is_some() { return Ok(()); }
        let mut constraints = node.element_data().unwrap().numeric_constraints().ok_or("InvalidStateError: expected a numeric input")?;
        if let Some(value) = constraints.stepped_by_user(&self.input_value(id)?, count) {
            self.set_input_value(id, &value.to_string())?;
        }
        Ok(())
    }
    pub fn input_step(&mut self, id: u64, count: i32) -> Result<(), String> {
        let element = self.element(id)?.element_data().unwrap();
        let constraints = element
            .numeric_constraints()
            .ok_or("InvalidStateError: expected a numeric input")?;
        let step = constraints.step.ok_or("InvalidStateError: step is any")?;
        if let Some(value) = element.range_value() {
            self.set_input_value(id, &(value + step * f64::from(count)).to_string())
        } else if let Some(value) = constraints.stepped(&self.input_value(id)?, count) {
            self.set_input_value(id, &value.to_string())
        } else { Ok(()) }
    }
    pub fn input_text(&self, id: u64) -> Result<String, String> {
        self.element(id)?;
        self.document
            .input_text(NodeId::from_u64(id))
            .ok_or_else(|| "ui-invalid-node: expected a text input".into())
    }
    pub fn set_input_text(&mut self, id: u64, value: &str) -> Result<bool, String> {
        self.element(id)?;
        self.resolve();
        let node_id = NodeId::from_u64(id);
        if !self.document.can_focus(node_id) {
            return Ok(false);
        }
        let accepted = self.document.set_input_text(node_id, value);
        self.dirty |= accepted;
        Ok(accepted)
    }
    pub fn input_bad_input(&self, id: u64) -> Result<bool, String> {
        self.input_value(id)?;
        Ok(self.document.input_bad_input(NodeId::from_u64(id)))
    }
    /// Collect only detached subtrees with no reachable JS node wrappers. A
    /// retained descendant also retains its parents and siblings, as in DOM.
    pub fn collect_detached(&mut self, retained: &[u64]) -> Result<usize, String> {
        let mut roots = std::collections::HashSet::new();
        roots.insert(self.document.root_node().id);
        for (_, node) in self.document.tree().iter() {
            if let Some(contents) = node
                .element_data()
                .and_then(|element| element.template_contents)
            {
                roots.insert(contents);
            }
        }
        for &raw in retained {
            let mut node = self.node(raw)?;
            while let Some(parent) = node.parent.or(node.shadow_host_id()) {
                node = self.document.get_node(parent).unwrap();
            }
            roots.insert(node.id);
        }
        let garbage: Vec<_> = self
            .document
            .tree()
            .iter()
            .filter(|(id, node)| {
                node.parent.is_none()
                    && !roots.contains(id)
                    && matches!(
                        node.data,
                        NodeData::Element(_)
                            | NodeData::Text(_)
                            | NodeData::Comment { .. }
                            | NodeData::DocumentFragment(_)
                    )
                    && node.shadow_host_id().is_none()
            })
            .map(|(id, _)| id)
            .collect();
        let before = self.document.tree().len();
        for id in garbage {
            self.document.mutate().remove_and_drop_node(id);
        }
        Ok(before - self.document.tree().len())
    }
    /// Empty means unchanged. Otherwise wasm-bindgen copies the complete RGBA
    /// buffer into JS-owned bytes; no Rust pointer survives across modules.
    pub fn paint(&mut self) -> Result<Vec<u8>, String> {
        if !self.dirty {
            return Ok(vec![]);
        }
        self.resolve();
        let viewport = self.document.get_viewport();
        let width = viewport.window_size.0;
        let height = viewport.window_size.1;
        let scale = f64::from(viewport.scale());
        // Record the real paint commands before entering the legacy CPU raster.
        // Its upstream color-matrix path panics after borrowing the document;
        // report unsupported input before raster so callers can recover safely.
        let mut recorded = anyrender::recording::Scene::new();
        paint_scene(
            &mut recorded,
            &mut self.document,
            scale,
            width,
            height,
            0,
            0,
        );
        for command in &recorded.commands {
            if let anyrender::recording::RenderCommand::PushLayer(layer) = command {
                if layer.filter.as_ref().is_some_and(|filter| {
                    filter.nodes().iter().any(|node| {
                        matches!(
                            node.effect,
                            anyrender::filters::FilterEffect::ColorMatrix(_)
                        )
                    })
                }) {
                    return Err(
                        "ui-cpu-unsupported-filter: ColorMatrix requires the GPU UI renderer"
                            .into(),
                    );
                }
            }
        }
        let mut bytes = Vec::new();
        if !matches!(self.painter, Some(Painter::Cpu(_))) {
            self.painter = Some(Painter::Cpu(VelloCpuImageRenderer::new(width, height)));
        }
        let Some(Painter::Cpu(painter)) = self.painter.as_mut() else {
            unreachable!()
        };
        painter.reset();
        painter.render_to_vec(
            |scene| {
                scene.append_scene(recorded, vello_common::kurbo::Affine::IDENTITY);
            },
            &mut bytes,
        );
        self.dirty = false;
        Ok(bytes)
    }

    /// Owns only CPU preparation bytes. The Renderer owns device, textures and submission.
    pub fn paint_gpu(&mut self) -> Result<JsValue, String> {
        if !self.dirty {
            return Ok(JsValue::NULL);
        }
        let frame = self.prepare_gpu()?;
        let value = frame
            .serialize(&serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true))
            .map_err(|error| format!("ui-gpu-serialization: {error}"))?;
        self.dirty = false;
        Ok(value)
    }
}

impl UiDocument {
    fn prepare_gpu(&mut self) -> Result<vello_gpu::portable::Frame, String> {
        self.resolve();
        let viewport = self.document.get_viewport();
        let (width, height) = viewport.window_size;
        let scale = f64::from(viewport.scale());
        if !matches!(self.painter, Some(Painter::Gpu(_))) {
            self.painter = Some(Painter::Gpu(gpu::GpuPainter::new(width, height)?));
        }
        let Some(Painter::Gpu(painter)) = self.painter.as_mut() else {
            unreachable!()
        };
        painter.begin(width, height);
        paint_scene(painter, &mut self.document, scale, width, height, 0, 0);
        painter.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn doc(html: &str) -> UiDocument {
        UiDocument::new(html, 100, 100, 1.0, vec![]).unwrap()
    }
    fn find(doc: &UiDocument, selector: &str) -> u64 {
        doc.query(doc.root(), selector).unwrap()[0]
    }

    #[test]
    fn input_inline_client_metrics_exclude_padding_without_resizing_controls() {
        let mut doc = doc("<style>input,textarea,div{box-sizing:content-box;width:76px;height:20px;padding:5px;border:1px solid}div{overflow:auto}</style><input type=number value=2.4><textarea></textarea><div></div>");
        let input = find(&doc, "input");
        let metrics = doc.scroll_metrics(input).unwrap();
        assert_eq!(metrics[4], 76.0);
        assert_eq!(metrics[2], 76.0);
        assert_eq!(metrics[5], 30.0);
        assert_eq!(metrics[6], 6.0);
        assert_eq!(metrics[7], 1.0);
        assert_eq!(doc.rect(input).unwrap()[2], 88.0);
        for selector in ["textarea", "div"] {
            let element = find(&doc, selector);
            let metrics = doc.scroll_metrics(element).unwrap();
            assert_eq!(metrics[4], 86.0);
            assert_eq!(metrics[2], 86.0);
        }
    }

    #[test]
    fn input_programmatic_scroll_moves_the_existing_editor_and_clamps_after_shrink() {
        let mut doc = UiDocument::new(
            "<style>input{box-sizing:content-box;width:80px;height:20px;padding:7px 11px;border:2px solid}</style><input>",
            240, 100, 1.0,
            include_bytes!("../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf").to_vec(),
        ).unwrap();
        let input = find(&doc, "input");
        doc.set_input_value(input, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789").unwrap();
        let before = doc.scroll_metrics(input).unwrap();
        assert!(before[2] > before[4] + 80.0);
        doc.scroll_to(input, 10000.0, 10000.0).unwrap();
        let end = doc.scroll_metrics(input).unwrap();
        assert!((end[0] - (end[2] - end[4])).abs() < 0.01);
        assert_eq!(end[1], 0.0);
        assert_eq!(f64::from(doc.node(input).unwrap().element_data().unwrap().text_input_data().unwrap().scroll_offset), end[0]);
        assert_eq!(doc.node(input).unwrap().scroll_offset().x, 0.0);
        doc.set_input_value(input, "short").unwrap();
        assert_eq!(doc.scroll_metrics(input).unwrap()[0], 0.0);
    }

    #[test]
    fn scripting_capability_drives_parsing_serialization_and_ua_after_device_rebuild() {
        let mut doc = doc("<noscript><b>Fallback &amp; value</b></noscript>");
        let fallback = find(&doc, "noscript");
        assert!(doc.query(fallback, "b").unwrap().is_empty());
        assert_eq!(
            doc.text_content(fallback).unwrap(),
            "<b>Fallback &amp; value</b>"
        );
        assert_eq!(
            doc.inner_html(fallback).unwrap(),
            "<b>Fallback &amp; value</b>"
        );
        assert_eq!(doc.computed_style(fallback, "display").unwrap(), "none");
        doc.set_inner_html(fallback, "<i>Replacement &lt; text</i>")
            .unwrap();
        assert!(doc.query(fallback, "i").unwrap().is_empty());
        assert_eq!(
            doc.inner_html(fallback).unwrap(),
            "<i>Replacement &lt; text</i>"
        );
        doc.set_viewport(140, 120, 1.0).unwrap();
        assert_eq!(doc.computed_style(fallback, "display").unwrap(), "none");
        assert_eq!(doc.rect(fallback).unwrap(), vec![0.0; 4]);
    }

    #[test]
    fn noscript_template_owner_survives_detachment_clone_and_adoption() {
        let mut doc = doc("<template><noscript><b>Initial &amp; value</b></noscript></template>");
        let template = find(&doc, "template");
        let content = doc.template_content(template).unwrap();
        let fallback = doc.query(content, "noscript").unwrap()[0];
        assert_eq!(
            doc.text_content(fallback).unwrap(),
            "<b>Initial &amp; value</b>"
        );
        assert_eq!(
            doc.inner_html(fallback).unwrap(),
            "&lt;b&gt;Initial &amp;amp; value&lt;/b&gt;"
        );
        doc.set_inner_html(fallback, "<i>Inert &amp; value</i>")
            .unwrap();
        assert_eq!(doc.text_content(fallback).unwrap(), "Inert & value");
        doc.set_text_content(fallback, "<b>Text & value</b>")
            .unwrap();
        doc.remove(fallback).unwrap();
        let clone = doc.clone_node(fallback, true).unwrap();
        assert_eq!(
            doc.inner_html(clone).unwrap(),
            "&lt;b&gt;Text &amp; value&lt;/b&gt;"
        );
        doc.insert(find(&doc, "body"), fallback, 0).unwrap();
        assert_eq!(doc.inner_html(fallback).unwrap(), "<b>Text & value</b>");
        doc.set_inner_html(fallback, "<i>Active &amp; value</i>")
            .unwrap();
        assert_eq!(
            doc.text_content(fallback).unwrap(),
            "<i>Active &amp; value</i>"
        );
        doc.insert(content, fallback, 0).unwrap();
        assert_eq!(
            doc.inner_html(fallback).unwrap(),
            "&lt;i&gt;Active &amp;amp; value&lt;/i&gt;"
        );
        let host = doc.create_element("div").unwrap();
        let shadow = doc.attach_shadow(host).unwrap();
        doc.set_inner_html(shadow, "<noscript><b>Shadow</b></noscript>")
            .unwrap();
        let shadow_fallback = doc.query(shadow, "noscript").unwrap()[0];
        doc.insert(content, host, 0).unwrap();
        assert_eq!(
            doc.inner_html(shadow_fallback).unwrap(),
            "&lt;b&gt;Shadow&lt;/b&gt;"
        );
        doc.insert(find(&doc, "body"), host, 0).unwrap();
        assert_eq!(doc.inner_html(shadow_fallback).unwrap(), "<b>Shadow</b>");
    }

    #[test]
    fn button_input_values_keep_the_attribute_and_existing_label_synchronized() {
        for kind in ["button", "submit", "reset"] {
            let mut doc = UiDocument::new(
                &format!("<form><input type={kind} value=Generate></form>"),
                300,
                200,
                1.0,
                Vec::new(),
            )
            .unwrap();
            let id = find(&doc, "input");
            let native_id = NodeId::from_u64(id);
            assert_eq!(doc.input_value(id).unwrap(), "Generate");
            let label = doc.document.get_node(native_id).unwrap().children[0];
            for value in ["Apply", "Retry", "", "Generate again"] {
                doc.set_input_value(id, value).unwrap();
                assert_eq!(doc.input_value(id).unwrap(), value);
                let node = doc.document.get_node(native_id).unwrap();
                assert_eq!(node.children, vec![label]);
                assert_eq!(node.text_content(), value);
            }
            doc.set_attribute(id, "value".into(), Some("From attribute".into()))
                .unwrap();
            assert_eq!(doc.input_value(id).unwrap(), "From attribute");
            assert_eq!(
                doc.document.get_node(native_id).unwrap().text_content(),
                "From attribute"
            );
            doc.set_attribute(id, "value".into(), None).unwrap();
            assert_eq!(doc.input_value(id).unwrap(), "");
            assert_eq!(
                doc.document.get_node(native_id).unwrap().text_content(),
                match kind {
                    "submit" => "Submit",
                    "reset" => "Reset",
                    _ => "",
                }
            );
        }
    }

    #[test]
    fn scripting_media_queries_and_disabled_document_keep_distinct_native_semantics() {
        for enabled in [false, true] {
            let mut document = HtmlDocument::from_html(
                "<style>p{width:1px;height:1px}@media(scripting){p{width:2px}}@media(scripting:enabled){p{height:2px}}@media(scripting:none){p{width:3px;height:3px}}@media(scripting:initial-only){p{width:4px}}</style><p></p><noscript><b>Fallback &amp; value</b></noscript>",
                DocumentConfig {
                    scripting_enabled: enabled,
                    html_parser_provider: Some(Arc::new(blitz_html::HtmlProvider)),
                    ..Default::default()
                },
            );
            document.resolve(0.0);
            let p = document.query_selector("p").unwrap().unwrap();
            let fallback = document.query_selector("noscript").unwrap().unwrap();
            assert_eq!(
                document.resolved_style_value(p, "width"),
                if enabled { "2px" } else { "3px" }
            );
            assert_eq!(
                document.resolved_style_value(p, "height"),
                if enabled { "2px" } else { "3px" }
            );
            assert_eq!(document.query_selector("b").unwrap().is_none(), enabled);
            assert_eq!(
                document.resolved_style_value(fallback, "display"),
                if enabled { "none" } else { "inline" }
            );
            document
                .mutate()
                .set_inner_html(fallback, "<i>Replacement &amp; value</i>");
            assert_eq!(document.query_selector("i").unwrap().is_none(), enabled);
            let inner = document.get_node(fallback).unwrap().children[0];
            assert_eq!(
                document.get_node(inner).unwrap().outer_html(),
                "<i>Replacement &amp; value</i>"
            );
        }
    }
    #[test]
    fn native_text_defaults_survive_control_type_changes_without_poisoning() {
        let mut doc = doc("<input type=number value=0.35>");
        let field = find(&doc, "input");
        assert!(doc.set_input_text(field, "0.8").unwrap());
        doc.set_attribute(field, "type", Some("checkbox".into()))
            .unwrap();
        assert_eq!(doc.input_value(field).unwrap(), "0.8");
        assert_eq!(
            doc.attribute(field, "value").unwrap().as_deref(),
            Some("0.8")
        );
        assert!(!doc.set_input_text(field, "retired").unwrap());
        assert!(
            !doc.document
                .set_input_text(NodeId::from_u64(field), "retired")
        );
        doc.set_attribute(field, "type", None).unwrap();
        assert_eq!(doc.input_value(field).unwrap(), "0.8");
        doc.set_attribute(field, "value", Some("0.9".into())).unwrap();
        assert_eq!(doc.input_value(field).unwrap(), "0.9");
        doc.paint().unwrap();
    }

    #[test]
    fn checked_state_defaults_and_radio_groups_have_native_ownership() {
        let mut doc = doc(
            "<form id=a><input id=c type=checkbox checked><input id=r1 type=radio name=x checked><input id=r2 type=radio name=x><input id=peer type=checkbox name=x checked></form><form id=b><input id=other type=radio name=x checked></form><div></div>",
        );
        let checkbox = find(&doc, "#c");
        assert!(doc.input_checked(checkbox).unwrap());
        assert_eq!(doc.input_value(checkbox).unwrap(), "on");
        doc.set_attribute(checkbox, "checked", None).unwrap();
        assert!(!doc.input_checked(checkbox).unwrap());
        doc.set_input_checked(checkbox, true).unwrap();
        doc.set_attribute(checkbox, "checked", Some("false".into()))
            .unwrap();
        doc.set_attribute(checkbox, "checked", None).unwrap();
        assert!(doc.input_checked(checkbox).unwrap());
        assert!(doc.matches(checkbox, ":checked").unwrap());
        let shadow = doc.attach_shadow(find(&doc, "div")).unwrap();
        doc.set_inner_html(shadow, "<input type=radio name=x checked>")
            .unwrap();
        let shadow_radio = doc.query(shadow, "input").unwrap()[0];
        let radio = find(&doc, "#r2");
        doc.set_input_checked(radio, true).unwrap();
        assert!(!doc.input_checked(find(&doc, "#r1")).unwrap());
        assert!(doc.input_checked(find(&doc, "#peer")).unwrap());
        assert!(doc.input_checked(find(&doc, "#other")).unwrap());
        assert!(doc.input_checked(shadow_radio).unwrap());
        assert_eq!(doc.radio_group(radio).unwrap().len(), 2);
        doc.set_attribute(radio, "form", Some("b".into())).unwrap();
        assert!(!doc.input_checked(find(&doc, "#other")).unwrap());
        assert!(doc.input_checked(shadow_radio).unwrap());
    }

    #[test]
    fn transformed_range_client_rects_hit_the_same_painted_control() {
        let mut doc = doc(
            "<style>body{margin:0}section{position:absolute;left:50px;top:50px;width:80px;height:40px;transform:translate(-50%,-50%)}input{position:absolute;left:0;top:0;margin:0;width:80px;height:16px}</style><section><input type=range value=0></section>",
        );
        let input = find(&doc, "input");
        assert_eq!(doc.rect(input).unwrap(), vec![10.0, 30.0, 80.0, 16.0]);
        assert_eq!(doc.hit(18.0, 38.0).unwrap(), input);
        doc.range_pointer(input, 82.0, 38.0).unwrap();
        assert_eq!(doc.input_value(input).unwrap(), "100");
    }

    #[test]
    fn white_label_checkbox_keeps_checked_fill_and_tick_visible_at_its_position() {
        let mut doc = doc(
            "<style>body{margin:0;color:white}input{position:absolute;left:40px;top:30px;margin:0;width:20px;height:20px;border:0;padding:0}</style><input type=checkbox checked>",
        );
        let input = find(&doc, "input");
        let checked = doc.paint().unwrap();
        let pixel = |bytes: &[u8], x: usize, y: usize| {
            let i = (y * 100 + x) * 4;
            [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]
        };
        let fill = pixel(&checked, 50, 34);
        assert!(fill[0] < 30 && fill[2] > 200 && fill[3] > 200);
        let tick = pixel(&checked, 46, 42);
        assert!(tick[0] > 200 && tick[1] > 200 && tick[2] > 200);
        doc.set_input_checked(input, false).unwrap();
        let unchecked = doc.paint().unwrap();
        assert_eq!(pixel(&unchecked, 50, 34), [255, 255, 255, 255]);
    }

    #[test]
    fn select_cached_text_and_popup_follow_device_scale_transitions() {
        let html = "<style>body{margin:0;background:#123}select{position:absolute;left:12px;top:12px;font:13px sans-serif;width:140px}</style><select><option>One</option><option disabled>Unavailable</option><option>Three</option></select>";
        let create = |scale: u32| UiDocument::new(
            html, 200 * scale, 160 * scale, scale as f32,
            include_bytes!("../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf").to_vec(),
        ).unwrap();
        let mut resized = create(1);
        let select = find(&resized, "select");
        resized.paint().unwrap();
        for scale in [2, 3, 1] {
            resized.set_viewport(200 * scale, 160 * scale, scale as f32).unwrap();
            let mut fresh = create(scale);
            let fresh_select = find(&fresh, "select");
            assert_eq!(resized.rect(select).unwrap(), fresh.rect(fresh_select).unwrap());
            assert!(resized.paint().unwrap() == fresh.paint().unwrap(),
                "select glyph pixels after a DPR{scale} transition must equal a fresh document");
            resized.select_key(select, " ").unwrap();
            fresh.select_key(fresh_select, " ").unwrap();
            resized.select_key(select, "ArrowDown").unwrap();
            fresh.select_key(fresh_select, "ArrowDown").unwrap();
            let preview = resized.paint().unwrap();
            assert!(preview == fresh.paint().unwrap(),
                "open select popup must use the current DPR{scale} text layouts");
            assert_eq!(resized.input_value(select).unwrap(), "One");
            fresh.select_key(fresh_select, "Enter").unwrap();
            let committed = fresh.paint().unwrap();
            let rect = fresh.rect(fresh_select).unwrap();
            // Compare the field interior; the popup has its own adjoining border.
            for y in ((rect[1] + 1.0) * f64::from(scale)) as usize..((rect[1] + rect[3] - 1.0) * f64::from(scale)) as usize {
                let start = (y * 200 * scale as usize + ((rect[0] + 1.0) * f64::from(scale)) as usize) * 4;
                let end = start + ((rect[2] - 2.0) * f64::from(scale)) as usize * 4;
                assert!(preview[start..end] == committed[start..end],
                    "the open control previews the highlighted label before its value commits (DPR{scale}, row {y})");
            }
            resized.select_key(select, "Escape").unwrap();
            assert_eq!(resized.input_value(select).unwrap(), "Three");
            resized.select_key(select, "Home").unwrap();
            resized.paint().unwrap();
        }
    }

    #[test]
    fn select_defaults_values_and_native_popup_commit_share_option_state() {
        let mut doc = doc(
            "<style>body{margin:0}select{position:absolute;left:10px;top:10px;width:60px;height:20px}</style><select><option value=a>Alpha</option><option value=b selected>Beta</option><option value=c disabled>Gamma</option></select>",
        );
        let select = find(&doc, "select");
        let options = doc.select_options(select).unwrap();
        assert_eq!(doc.select_index(select).unwrap(), 1);
        assert_eq!(doc.input_value(select).unwrap(), "b");
        assert!(doc.option_selected(options[1]).unwrap());
        doc.set_input_value(select, "a").unwrap();
        assert_eq!(doc.select_index(select).unwrap(), 0);
        doc.set_attribute(options[0], "selected", None).unwrap();
        assert_eq!(doc.input_value(select).unwrap(), "a");
        doc.set_input_value(select, "missing").unwrap();
        assert_eq!(doc.select_index(select).unwrap(), -1);
        doc.set_select_index(select, 1).unwrap();
        assert!(doc.select_key(select, "Home").unwrap());
        assert_eq!(doc.input_value(select).unwrap(), "a");
        assert!(doc.select_key(select, "ArrowDown").unwrap());
        assert!(!doc.select_key(select, "ArrowDown").unwrap());
        assert_eq!(doc.input_value(select).unwrap(), "b");
        doc.paint().unwrap();
        doc.select_pointer(select, 20.0, 20.0, false).unwrap();
        let popup = doc
            .document
            .select_popup_rect(NodeId::from_u64(select))
            .unwrap();
        assert_eq!(
            doc.hit((popup[0] + 4.0) as f32, (popup[1] + 4.0) as f32)
                .unwrap(),
            select
        );
        assert!(
            doc.select_pointer(select, popup[0] + 4.0, popup[1] + 4.0, true)
                .unwrap()
        );
        assert_eq!(doc.input_value(select).unwrap(), "a");
        assert!(
            doc.document
                .select_popup_rect(NodeId::from_u64(select))
                .is_none()
        );
        let clone = doc.clone_node(select, true).unwrap();
        assert_eq!(doc.input_value(clone).unwrap(), "a");
        doc.set_option_selected(options[1], true).unwrap();
        assert_eq!(doc.input_value(select).unwrap(), "b");
    }

    #[test]
    fn range_value_mutations_and_pointer_defaults_move_native_thumb_pixels() {
        let mut doc = doc(
            "<style>body{margin:0}input{position:absolute;left:0;top:0;margin:0;width:100px;height:16px}</style><input type=range min=0 max=100 value=0>",
        );
        let input = find(&doc, "input");
        assert_eq!(doc.input_value(input).unwrap(), "0");
        let first = doc.paint().unwrap();
        doc.range_pointer(input, 92.0, 8.0).unwrap();
        assert_eq!(doc.input_value(input).unwrap(), "100");
        let last = doc.paint().unwrap();
        let blue = |bytes: &[u8], x: usize, y: usize| {
            let i = (y * 100 + x) * 4;
            bytes[i + 2] > 200 && bytes[i] < 30 && bytes[i + 3] > 200
        };
        assert!(blue(&first, 8, 2));
        assert!(!blue(&first, 92, 2));
        assert!(blue(&last, 92, 2));
        assert!(!blue(&last, 8, 2));
        doc.set_attribute(input, "value", Some("23".into()))
            .unwrap();
        assert_eq!(doc.input_value(input).unwrap(), "100");
        doc.set_attribute(input, "max", Some("1".into())).unwrap();
        doc.set_attribute(input, "step", Some("0.2".into()))
            .unwrap();
        doc.set_input_value(input, ".3").unwrap();
        assert_eq!(doc.input_value(input).unwrap(), "0.4");
        doc.range_key(input, "ArrowRight").unwrap();
        assert_eq!(doc.input_value(input).unwrap(), "0.6");
        let cloned = doc.clone_node(input, true).unwrap();
        assert_eq!(doc.input_value(cloned).unwrap(), "0.6");
        doc.set_attribute(input, "step", Some("any".into()))
            .unwrap();
        assert!(
            doc.input_step(input, 1)
                .unwrap_err()
                .contains("InvalidStateError")
        );
    }

    #[test]
    fn shadow_cascade_and_layout_preserve_light_tree_boundaries() {
        let mut doc = doc(
            "<style>body{margin:0}span{display:block;width:90px;height:10px;background:red}</style><section></section><aside></aside><span>outside</span>",
        );
        let host = find(&doc, "section");
        let shadow = doc.attach_shadow(host).unwrap();
        doc.set_inner_html(shadow, "<style>:host{display:block;width:60px}span{display:block;width:20px;height:10px;background:blue}:host(.wide) span{width:40px}</style><span>inside</span>").unwrap();
        let second = doc.attach_shadow(find(&doc, "aside")).unwrap();
        doc.set_inner_html(second, "<style>:host{display:block}span{display:block;width:30px;height:10px;background:green}</style><span>other</span>").unwrap();
        let child = doc.query(shadow, "span").unwrap()[0];
        let other = doc.query(second, "span").unwrap()[0];
        assert_eq!(doc.query(doc.root(), "span").unwrap().len(), 1);
        assert_eq!(doc.parent(child).unwrap(), shadow);
        assert_eq!(doc.parent(shadow).unwrap(), 0);
        assert_eq!(doc.rect(child).unwrap()[2], 20.0);
        assert_eq!(doc.rect(other).unwrap()[2], 30.0);
        assert_eq!(doc.rect(find(&doc, "span")).unwrap()[2], 90.0);
        doc.set_attribute(host, "class", Some("wide".into()))
            .unwrap();
        assert_eq!(doc.rect(child).unwrap()[2], 40.0);
        let pixels = doc.paint().unwrap();
        assert_eq!(&pixels[4 * 505..4 * 505 + 4], &[0, 0, 255, 255]);
        doc.remove(host).unwrap();
        doc.insert(find(&doc, "body"), host, 0).unwrap();
        assert_eq!(doc.rect(child).unwrap()[2], 40.0);
        let extra = doc.create_element("span").unwrap();
        doc.insert(shadow, extra, 0).unwrap();
        assert_eq!(doc.rect(extra).unwrap()[2], 40.0);
        doc.set_text_content(
            doc.query(shadow, "style").unwrap()[0],
            "span{display:block;width:55px;height:10px}",
        )
        .unwrap();
        assert_eq!(doc.rect(extra).unwrap()[2], 55.0);
    }

    #[test]
    fn shadow_host_inheritance_paint_and_hit_testing_share_the_flat_tree() {
        let mut doc = UiDocument::new(
            "<style>body{margin:0}</style><section style='position:absolute;inset:0;pointer-events:none'></section>",
            100, 100, 1.0, include_bytes!("../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf").to_vec(),
        ).unwrap();
        let host = find(&doc, "section");
        let shadow = doc.attach_shadow(host).unwrap();
        doc.set_inner_html(shadow, "<style>:host{display:block;color:white;background:#102334;font:20px sans-serif}button{pointer-events:auto;width:80px;height:30px}</style><div style='pointer-events:none'><span>Title</span><button>Go</button></div>").unwrap();
        let text = doc.query(shadow, "span").unwrap()[0];
        let button = doc.query(shadow, "button").unwrap()[0];
        assert_eq!(
            doc.computed_style(host, "color").unwrap(),
            "rgb(255, 255, 255)"
        );
        assert_eq!(
            doc.computed_style(text, "color").unwrap(),
            "rgb(255, 255, 255)"
        );
        let rect = doc.rect(button).unwrap();
        assert_eq!(
            doc.hit(
                (rect[0] + rect[2] / 2.0) as f32,
                (rect[1] + rect[3] / 2.0) as f32
            )
            .unwrap(),
            button
        );
        let rect = doc.rect(text).unwrap();
        let pixels = doc.paint().unwrap();
        let white = (rect[1].ceil() as usize..(rect[1] + rect[3]).floor() as usize)
            .flat_map(|y| {
                (rect[0].ceil() as usize..(rect[0] + rect[2]).floor() as usize)
                    .map(move |x| 4 * (y * 100 + x))
            })
            .filter(|&i| pixels[i] > 220 && pixels[i + 1] > 220 && pixels[i + 2] > 220)
            .count();
        assert!(
            white > 30,
            "inherited light text must be visible on the dark host"
        );
    }

    #[test]
    fn prepared_font_renders_system_ui_controls_and_current_numbers() {
        let mut doc = UiDocument::new(
            "<style>body{margin:0}button,input{position:absolute;left:0;width:100px;height:40px;padding:0;border:0;background:white;color:black;font-size:20px}button{top:0}input{top:50px}</style><button>Go</button><input type=number value=3.25>",
            100, 100, 1.0,
            include_bytes!("../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf").to_vec(),
        ).unwrap();
        let pixels = doc.paint().unwrap();
        let ink = |top: usize| {
            (top..top + 40)
                .flat_map(|y| (0..100).map(move |x| 4 * (y * 100 + x)))
                .filter(|&i| {
                    pixels[i] < 80
                        && pixels[i + 1] < 80
                        && pixels[i + 2] < 80
                        && pixels[i + 3] > 200
                })
                .count()
        };
        assert!(ink(0) > 30, "button system-ui glyphs must be visible");
        assert!(ink(50) > 30, "input current number glyphs must be visible");
        doc.set_input_value(find(&doc, "input"), "9.75").unwrap();
        let changed = doc.paint().unwrap();
        assert_ne!(pixels[4 * 5000..4 * 9000], changed[4 * 5000..4 * 9000]);
    }

    #[test]
    fn number_input_has_intrinsic_line_height_without_explicit_height() {
        let mut doc = UiDocument::new(
            "<style>body{margin:0}input{width:80px;padding:8px;border:0;background:white;color:black;font-size:20px}</style><input type=number value=3.25>",
            100, 100, 1.0, include_bytes!("../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf").to_vec(),
        ).unwrap();
        let input = find(&doc, "input");
        assert!(
            doc.rect(input).unwrap()[3] >= 36.0,
            "number input must reserve a text line plus padding"
        );
        let pixels = doc.paint().unwrap();
        assert!(
            pixels
                .chunks_exact(4)
                .filter(|p| p[0] < 80 && p[1] < 80 && p[2] < 80 && p[3] > 200)
                .count()
                > 30
        );
    }

    #[test]
    fn persistent_grid_mutation_flushes_on_read_and_paint_is_cached() {
        let mut doc = doc(
            "<style>body{margin:0;display:grid;grid-template-columns:1fr 1fr;height:100px}section{background:red}aside{background:blue}</style><section></section><aside></aside>",
        );
        let section = find(&doc, "section");
        let aside = find(&doc, "aside");
        assert_eq!(doc.rect(section).unwrap(), vec![0.0, 0.0, 50.0, 100.0]);
        let before = doc.paint().unwrap();
        assert_eq!(&before[4 * 2525..4 * 2525 + 4], &[255, 0, 0, 255]);
        assert!(doc.paint().unwrap().is_empty());
        doc.set_style(find(&doc, "body"), "grid-template-columns", "3fr 1fr", "")
            .unwrap();
        assert_eq!(doc.rect(aside).unwrap(), vec![75.0, 0.0, 25.0, 100.0]);
        assert_eq!(find(&doc, "section"), section);
        assert_eq!(doc.paint().unwrap().len(), before.len());
    }

    #[test]
    fn inner_html_detaches_referenced_nodes_without_destroying_identity() {
        let mut doc = doc("<section><span>original</span></section>");
        let section = find(&doc, "section");
        let original = find(&doc, "span");
        doc.set_inner_html(section, "<b>replacement</b>").unwrap();
        assert_eq!(doc.text_content(original).unwrap(), "original");
        assert_eq!(doc.parent(original).unwrap(), 0);
        doc.insert(section, original, 0).unwrap();
        assert_eq!(doc.text_content(section).unwrap(), "replacementoriginal");
    }

    #[test]
    fn mutations_reject_cycles_and_stale_ids_before_changing_tree() {
        let mut doc = doc("<section><span></span></section>");
        let section = find(&doc, "section");
        let span = find(&doc, "span");
        assert!(
            doc.insert(span, section, 0)
                .unwrap_err()
                .starts_with("HierarchyRequestError")
        );
        assert_eq!(doc.parent(span).unwrap(), section);
        assert!(
            doc.remove(u64::MAX)
                .unwrap_err()
                .starts_with("ui-stale-node")
        );
        doc.remove(span).unwrap();
        doc.set_text_content(span, "reused").unwrap();
        doc.insert(section, span, 0).unwrap();
        assert_eq!(doc.text_content(section).unwrap(), "reused");
    }

    #[test]
    fn dynamic_input_and_detached_collection_keep_core_authority() {
        let mut doc = doc("<section></section>");
        let input = doc.create_element("input").unwrap();
        doc.set_attribute(input, "type", Some("number".into()))
            .unwrap();
        doc.set_input_value(input, "3.25").unwrap();
        doc.set_attribute(input, "value", Some("5".into())).unwrap();
        assert_eq!(doc.input_value(input).unwrap(), "3.25");
        assert_eq!(doc.collect_detached(&[input]).unwrap(), 0);
        assert_eq!(doc.collect_detached(&[]).unwrap(), 1);
        assert!(
            doc.input_value(input)
                .unwrap_err()
                .starts_with("ui-stale-node")
        );
        let next = doc.create_element("input").unwrap();
        assert_ne!(input, next);
    }

    #[test]
    fn text_shadow_paints_inherited_offsets_blur_and_front_to_back_order() {
        let font = include_bytes!(
            "../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf"
        )
        .to_vec();
        let mut doc = UiDocument::new("<style>body{margin:0;color:white;font:24px sans-serif}div{position:absolute;left:5px;top:5px;text-shadow:30px 0 red,30px 0 blue,60px 0 6px lime}</style><div><span>I</span></div>",100,60,1.0,font).unwrap();
        let pixels = doc.paint().unwrap();
        let red = pixels
            .chunks_exact(4)
            .filter(|p| p[0] > 180 && p[1] < 20 && p[2] < 20 && p[3] > 180)
            .count();
        let green_fringe = pixels
            .chunks_exact(4)
            .filter(|p| p[1] > 1 && p[0] == 0 && p[2] == 0 && p[3] < 160)
            .count();
        let red_columns: std::collections::HashSet<_> = pixels
            .chunks_exact(4)
            .enumerate()
            .filter(|(_, p)| p[0] > 1 && p[1] == 0 && p[2] == 0)
            .map(|(i, _)| i % 100)
            .collect();
        let green_columns: std::collections::HashSet<_> = pixels
            .chunks_exact(4)
            .enumerate()
            .filter(|(_, p)| p[1] > 1 && p[0] == 0 && p[2] == 0)
            .map(|(i, _)| i % 100)
            .collect();
        assert!(
            red > 15,
            "first listed inherited shadow must cover the blue shadow: {red}"
        );
        assert!(
            green_fringe > 30,
            "blur must create a soft shadow fringe: {green_fringe}"
        );
        assert!(
            green_columns.len() > red_columns.len() + 4,
            "blur must spread beyond the crisp glyph: {} vs {}",
            green_columns.len(),
            red_columns.len()
        );
    }

    #[test]
    fn transform_keyframes_and_opacity_transition_follow_host_milliseconds() {
        let mut doc = doc(
            "<style>body{margin:0}div{position:absolute;left:20px;top:20px;width:40px;height:10px;background:red;animation:spin 1000ms linear infinite}section{position:absolute;top:60px;width:40px;height:20px;background:blue;transition:opacity 100ms linear}@keyframes spin{to{transform:rotate(360deg)}}</style><div></div><section></section>",
        );
        let element = find(&doc, "div");
        let fading = find(&doc, "section");
        let initial = doc.paint().unwrap();
        doc.set_time(250.0).unwrap();
        assert_ne!(doc.computed_style(element, "transform").unwrap(), "none");
        assert_ne!(initial, doc.paint().unwrap());
        doc.set_style(fading, "opacity", "0", "").unwrap();
        doc.paint().unwrap();
        doc.set_time(300.0).unwrap();
        let opacity: f32 = doc
            .computed_style(fading, "opacity")
            .unwrap()
            .parse()
            .unwrap();
        assert!((opacity - 0.5).abs() < 0.01, "halfway opacity: {opacity}");
        doc.set_time(350.0).unwrap();
        assert!(
            doc.computed_style(fading, "opacity")
                .unwrap()
                .parse::<f32>()
                .unwrap()
                < 0.00001
        );
    }

    #[test]
    fn reduced_motion_media_query_cancels_and_restores_shadow_animations() {
        let mut doc = doc("<style>body{margin:0}</style><section></section>");
        let shadow = doc.attach_shadow(find(&doc, "section")).unwrap();
        doc.set_inner_html(shadow, "<style>div{width:30px;height:10px;background:red;animation:spin 1s linear infinite;transition:opacity 150ms ease}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){div{animation:none;transition:none}}@media(prefers-reduced-motion:no-preference){div{color:blue}}</style><div></div>").unwrap();
        let spinner = doc.query(shadow, "div").unwrap()[0];
        doc.paint().unwrap();
        doc.set_time(250.0).unwrap();
        assert_ne!(doc.computed_style(spinner, "transform").unwrap(), "none");
        doc.set_reduced_motion(true);
        assert_eq!(
            doc.computed_style(spinner, "animation-name").unwrap(),
            "none"
        );
        assert_eq!(
            doc.computed_style(spinner, "transition-duration").unwrap(),
            "0s"
        );
        assert_eq!(doc.computed_style(spinner, "transform").unwrap(), "none");
        doc.paint().unwrap();
        doc.set_time(500.0).unwrap();
        assert!(
            doc.paint().unwrap().is_empty(),
            "reduced-motion spinner stops invalidating pixels"
        );
        doc.set_viewport(120, 120, 1.0).unwrap();
        assert_eq!(
            doc.computed_style(spinner, "animation-name").unwrap(),
            "none"
        );
        doc.set_reduced_motion(false);
        assert_eq!(
            doc.computed_style(spinner, "animation-name").unwrap(),
            "spin"
        );
    }

    #[test]
    fn hidden_loading_subtree_cancels_ticks_and_showing_restarts_animation() {
        let mut doc = doc(
            "<style>body{margin:0}section{position:absolute;inset:0}div{position:absolute;left:30px;top:30px;width:30px;height:10px;background:red;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style><canvas></canvas><section><div></div></section>",
        );
        let loading = find(&doc, "section");
        let spinner = find(&doc, "div");
        let initial = doc.paint().unwrap();
        doc.set_time(250.0).unwrap();
        assert_ne!(doc.paint().unwrap(), initial);
        doc.set_style(loading, "display", "none", "").unwrap();
        doc.set_time(300.0).unwrap();
        doc.paint().unwrap();
        assert!(!doc.document.is_animating());
        doc.set_time(400.0).unwrap();
        assert!(doc.paint().unwrap().is_empty());
        doc.set_time(1400.0).unwrap();
        assert!(doc.paint().unwrap().is_empty());
        assert_eq!(find(&doc, "div"), spinner);
        doc.set_style(loading, "display", "block", "").unwrap();
        doc.set_time(1500.0).unwrap();
        let restarted = doc.paint().unwrap();
        assert_eq!(
            restarted, initial,
            "display restoration restarts the animation"
        );
        assert!(doc.document.is_animating());
        doc.set_time(1750.0).unwrap();
        assert_ne!(doc.paint().unwrap(), restarted);
    }

    #[test]
    fn number_stepper_geometry_tracks_native_text_layout_transform_and_eligibility() {
        let mut doc = UiDocument::new(
            "<style>body{margin:0;background:#123}section{transform:translate(20px,20px)}input{width:120px;height:32px;box-sizing:border-box;padding:6px;border:1px solid #789;color:white;background:#182d3e;font:13px sans-serif}</style><section><input type=number min=0.1 max=2 step=0.05 value=0.65></section>",
            240, 100, 1.0,
            include_bytes!("../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf").to_vec(),
        ).unwrap();
        let input = find(&doc, "input");
        let idle = doc.paint().unwrap();
        doc.set_hover(input).unwrap();
        let hover = doc.paint().unwrap();
        assert!(hover == idle, "native number buttons are already visible before hover");
        doc.focus(input, false).unwrap();
        let focused = doc.paint().unwrap();
        for y in 28..44 {
            let pixel = &focused[(y * 240 + 19) * 4..(y * 240 + 19) * 4 + 4];
            assert_eq!(pixel, &[255, 255, 255, 255], "the auto ring closes its outer left edge at {y}");
            for x in [20, 21] {
                let inner = &focused[(y * 240 + x) * 4..(y * 240 + x) * 4 + 4];
                assert_eq!(inner, &[16, 16, 16, 255], "the inner ring overlays the authored border");
            }
            let interior = &focused[(y * 240 + 22) * 4..(y * 240 + 22) * 4 + 4];
            assert_eq!(interior, &[24, 45, 62, 255], "the auto ring leaves no inner white rim");
        }
        let rect = doc.node(input).unwrap().number_stepper_rect().unwrap();
        let x = 20.0 + rect.center().x;
        let y = 20.0 + rect.y0 + rect.height() / 4.0;
        assert_eq!(doc.number_stepper_hit(input, x, y).unwrap(), 1);
        assert_eq!(doc.number_stepper_hit(input, x, y + rect.height() / 2.0).unwrap(), -1);
        assert_eq!(doc.number_stepper_hit(input, 24.0, y).unwrap(), 0);
        doc.number_step(input, 1).unwrap();
        assert_eq!(doc.input_value(input).unwrap(), "0.7");
        doc.number_step(input, -1).unwrap();
        assert_eq!(doc.input_value(input).unwrap(), "0.65");
        doc.set_input_value(input, "0.42").unwrap();
        doc.input_step(input, 1).unwrap();
        assert_eq!(doc.input_value(input).unwrap(), "0.45");
        doc.set_input_value(input, "0.42").unwrap();
        doc.input_step(input, -1).unwrap();
        assert_eq!(doc.input_value(input).unwrap(), "0.4");
        doc.set_attribute(input, "step", Some("any".into())).unwrap();
        assert!(doc.input_step(input, 1).is_err());
        doc.set_input_value(input, "0.43").unwrap();
        doc.number_step(input, 1).unwrap();
        assert_eq!(doc.input_value(input).unwrap(), "1.43");
        for attribute in ["readonly", "disabled"] {
            doc.set_attribute(input, attribute, Some(String::new())).unwrap();
            assert_eq!(doc.number_stepper_hit(input, x, y).unwrap(), 0);
            doc.number_step(input, -1).unwrap();
            assert_eq!(doc.input_value(input).unwrap(), "1.43");
            doc.set_attribute(input, attribute, None).unwrap();
        }
    }

    #[test]
    fn validation_popup_keeps_its_arrow_on_the_invalid_field_when_viewport_clamped() {
        let mut doc = UiDocument::new(
            "<style>body{margin:0}input{position:absolute;left:256px;top:340px;width:120px;height:32px;box-sizing:border-box}</style><input type=number required>",
            400, 400, 1.0,
            include_bytes!("../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf").to_vec(),
        ).unwrap();
        let input = find(&doc, "input");
        doc.focus(input, false).unwrap();
        doc.show_validation_message(input, "Please fill out this field.").unwrap();
        let popup = doc.document.validation_message_popup().unwrap();
        assert!(popup.above);
        assert!(popup.rect[0] + popup.rect[2] <= 396.0);
        assert!((popup.rect[0] + popup.arrow_x - 264.0).abs() < 0.1);
        assert!((popup.rect[1] + popup.rect[3] + 8.0 - 340.0).abs() < 0.1);
        doc.set_style(input, "top", "24px", "").unwrap();
        doc.paint().unwrap();
        let popup = doc.document.validation_message_popup().unwrap();
        assert!(!popup.above);
        assert!((popup.rect[1] - 64.0).abs() < 0.1);
        doc.set_attribute(input, "disabled", Some(String::new())).unwrap();
        doc.paint().unwrap();
        assert!(doc.document.validation_message_popup().is_none());
    }

    #[test]
    fn validation_feedback_uses_native_text_and_clears_with_control_lifecycle() {
        let mut doc = UiDocument::new(
            "<style>body{margin:0;background:#123}input{width:80px;height:20px}</style><input type=number><button>Next</button>",
            320, 160, 1.0,
            include_bytes!("../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf").to_vec(),
        ).unwrap();
        let input = find(&doc, "input");
        doc.focus(input, false).unwrap();
        let before = doc.paint().unwrap();
        doc.show_validation_message(input, "Please enter a valid number.").unwrap();
        let painted = doc.paint().unwrap();
        assert_ne!(painted, before);
        let popup = doc.document.validation_message_popup().unwrap();
        assert!(popup.layout.width() > 60.0 && popup.layout.height() > 10.0);
        assert!(popup.rect[0] >= 0.0 && popup.rect[0] + popup.rect[2] <= 320.0);
        doc.set_input_text(input, "0.8").unwrap();
        assert!(doc.document.validation_message_popup().is_none());
        doc.show_validation_message(input, "Please enter a valid number.").unwrap();
        doc.focus(find(&doc, "button"), false).unwrap();
        assert!(doc.document.validation_message_popup().is_none());
        doc.focus(input, false).unwrap();
        doc.show_validation_message(input, "Please enter a valid number.").unwrap();
        doc.remove(input).unwrap();
        doc.paint().unwrap();
        assert!(doc.document.validation_message_popup().is_none());
    }

    #[test]
    fn hidden_shadow_descendants_have_no_cssom_boxes_and_restore_identity() {
        let mut doc = doc("<style>body{margin:0}section{padding:12px}</style><section></section>");
        let host = find(&doc, "section");
        let shadow = doc.attach_shadow(host).unwrap();
        doc.set_inner_html(shadow, "<style>div{display:contents}button{width:40px;height:30px}</style><div><button>Go</button></div>").unwrap();
        let child = doc.query(shadow, "button").unwrap()[0];
        let before = doc.rect(child).unwrap();
        assert!(before[2] > 0.0);
        doc.set_style(host, "display", "none", "").unwrap();
        assert_eq!(doc.rect(child).unwrap(), vec![0.0; 4]);
        assert_eq!(doc.scroll_metrics(child).unwrap(), vec![0.0; 8]);
        let id = NodeId::from_u64(child);
        assert!(doc.document.node_client_rects(id).is_empty());
        let offset = doc.document.offset_rect(id).unwrap();
        assert_eq!([offset.x, offset.y, offset.width, offset.height], [0.0; 4]);
        doc.set_style(host, "display", "block", "").unwrap();
        assert_eq!(doc.query(shadow, "button").unwrap()[0], child);
        assert_eq!(doc.rect(child).unwrap(), before);
    }

    #[test]
    fn scrolling_moves_descendant_client_rects_but_not_the_scrollport() {
        let mut doc = doc("<style>body{margin:0}section{margin:10px;width:60px;height:40px;overflow:auto}div{width:140px;height:160px}</style><section><div></div></section>");
        let host = find(&doc, "section");
        let content = find(&doc, "div");
        let host_before = doc.rect(host).unwrap();
        let content_before = doc.rect(content).unwrap();
        doc.scroll_to(host, 20.0, 30.0).unwrap();
        assert_eq!(doc.rect(host).unwrap(), host_before);
        let content_after = doc.rect(content).unwrap();
        assert_eq!(content_after[0], content_before[0] - 20.0);
        assert_eq!(content_after[1], content_before[1] - 30.0);
    }

    #[test]
    fn layout_shrink_clamps_existing_scroll_offsets_before_geometry_reads() {
        let mut doc = doc("<style>html,body{margin:0}section{height:50vh;width:60px;overflow:auto}div{height:160px;width:140px}</style><section><div></div></section>");
        let host = find(&doc, "section");
        let content = find(&doc, "div");
        doc.scroll_to(host, 1000.0, 1000.0).unwrap();
        assert!(doc.scroll_metrics(host).unwrap()[1] > 100.0);
        doc.set_viewport(100, 400, 1.0).unwrap();
        assert_eq!(doc.scroll_metrics(host).unwrap()[1], 0.0);
        doc.set_style(content, "width", "20px", "").unwrap();
        assert_eq!(doc.scroll_metrics(host).unwrap()[0], 0.0);
        doc.set_style(host, "height", "600px", "").unwrap();
        let root = doc.document_element();
        doc.scroll_to(root, 0.0, 1000.0).unwrap();
        assert!(doc.scroll_metrics(root).unwrap()[1] > 0.0);
        doc.set_style(host, "height", "40px", "").unwrap();
        assert_eq!(doc.scroll_metrics(root).unwrap()[1], 0.0);
    }

    #[test]
    fn touch_pan_axes_reuse_computed_style_and_cross_shadow_hosts() {
        let mut doc = doc(
            "<style>body{margin:0}section{width:60px;height:50px;overflow:auto}</style><section><div style='width:140px;height:120px'></div></section>",
        );
        let section = find(&doc, "section");
        let target = find(&doc, "div");
        for (value, expected) in [
            ("auto", 3),
            ("none", 0),
            ("pan-x", 1),
            ("pan-y", 2),
            ("manipulation", 3),
        ] {
            doc.set_style(target, "touch-action", value, "").unwrap();
            assert_eq!(doc.touch_pan_axes(target).unwrap(), expected, "{value}");
        }
        doc.set_style(target, "touch-action", "pan-x", "").unwrap();
        doc.set_style(section, "touch-action", "pan-y", "").unwrap();
        assert_eq!(doc.touch_pan_axes(target).unwrap(), 0);
        doc.set_style(section, "touch-action", "auto", "").unwrap();
        doc.set_style(target, "touch-action", "auto", "").unwrap();
        doc.set_style(find(&doc, "body"), "touch-action", "none", "")
            .unwrap();
        assert_eq!(
            doc.touch_pan_axes(target).unwrap(),
            3,
            "the nearest scroller consumes both axes before body"
        );
        let shadow = doc.attach_shadow(section).unwrap();
        doc.set_inner_html(
            shadow,
            "<style>div{width:140px;height:120px}</style><div>Touch</div>",
        )
        .unwrap();
        let inner = doc.query(shadow, "div").unwrap()[0];
        doc.set_style(section, "touch-action", "none", "").unwrap();
        assert_eq!(
            doc.touch_pan_axes(inner).unwrap(),
            0,
            "host policy applies to shadow descendants"
        );
    }

    #[test]
    fn scroll_chain_crosses_shadow_hosts_and_updates_rect_hit_and_clip() {
        let mut doc = doc(
            "<style>body{margin:0}section{width:80px;height:60px;overflow:auto}</style><section></section>",
        );
        let host = find(&doc, "section");
        let shadow = doc.attach_shadow(host).unwrap();
        doc.set_inner_html(shadow, "<style>div{height:140px}button{display:block;width:60px;height:30px;margin-top:100px;background:red}</style><div><button>Go</button></div>").unwrap();
        let button = doc.query(shadow, "button").unwrap()[0];
        assert!(doc.scroll_metrics(host).unwrap()[3] >= 140.0);
        let before = doc.rect(button).unwrap();
        let changed = doc.scroll_by_user(button, 0.0, 100.0).unwrap();
        assert!(
            changed.contains(&host),
            "scroll must chain across the shadow root"
        );
        assert!(doc.scroll_metrics(host).unwrap()[1] > 0.0);
        assert!(doc.rect(button).unwrap()[1] < before[1]);
        doc.scroll_to(host, 0.0, 10000.0).unwrap();
        let metrics = doc.scroll_metrics(host).unwrap();
        assert!(metrics[1] <= metrics[3] - metrics[5] + 0.01);
        let rect = doc.rect(button).unwrap();
        if rect[1] >= 0.0 && rect[1] < 55.0 {
            assert_eq!(doc.hit(10.0, (rect[1] + 3.0) as f32).unwrap(), button);
        }
        assert_ne!(
            doc.hit(10.0, 80.0).unwrap(),
            button,
            "overflow clip rejects the child outside the scrollport"
        );
        doc.scroll_to(host, 0.0, 0.0).unwrap();
        assert_eq!(doc.rect(button).unwrap(), before);
    }

    #[test]
    fn clone_template_number_draft_and_focus_preserve_native_dom_state() {
        let mut doc = doc(
            "<template><input type=number value=3.25></template><section><input type=number><button disabled>Disabled</button><span tabindex=-1>Focus</span></section>",
        );
        let template = find(&doc, "template");
        let original = doc.template_content(template).unwrap();
        let cloned = doc.clone_node(template, true).unwrap();
        let contents = doc.template_content(cloned).unwrap();
        assert_ne!(original, contents);
        let input = doc.query(contents, "input").unwrap()[0];
        doc.set_input_value(input, "7.5").unwrap();
        assert_eq!(
            doc.input_value(doc.query(original, "input").unwrap()[0])
                .unwrap(),
            "3.25"
        );
        let shallow = doc.clone_node(template, false).unwrap();
        let shallow_contents = doc.template_content(shallow).unwrap();
        assert!(doc.children(shallow_contents).unwrap().is_empty());
        let dynamic = doc.create_element("template").unwrap();
        doc.set_inner_html(dynamic, "<label><input type=number value=8></label>")
            .unwrap();
        let dynamic_content = doc.template_content(dynamic).unwrap();
        assert_eq!(doc.query(dynamic_content, "input").unwrap().len(), 1);
        assert!(doc.children(dynamic).unwrap().is_empty());
        assert!(doc.inner_html(dynamic).unwrap().contains("<label>"));
        doc.set_inner_html(dynamic, "<span>replacement</span>")
            .unwrap();
        assert_eq!(doc.query(dynamic_content, "input").unwrap().len(), 0);
        assert_eq!(doc.query(dynamic_content, "span").unwrap().len(), 1);
        let input = find(&doc, "section input");
        doc.set_input_text(input, "1e-").unwrap();
        assert_eq!(doc.input_text(input).unwrap(), "1e-");
        assert_eq!(doc.input_value(input).unwrap(), "");
        assert!(doc.input_bad_input(input).unwrap());
        doc.set_input_value(input, "bad").unwrap();
        assert!(!doc.input_bad_input(input).unwrap());
        doc.set_input_text(input, "1e-2").unwrap();
        assert_eq!(doc.input_value(input).unwrap(), "1e-2");
        doc.focus(input, false).unwrap();
        assert_eq!(doc.focused(), input);
        doc.set_attribute(input, "disabled", Some(String::new()))
            .unwrap();
        assert_eq!(doc.focused(), 0);
        doc.focus(input, false).unwrap();
        assert_eq!(doc.focused(), 0);
        let span = find(&doc, "span");
        doc.focus(span, false).unwrap();
        assert_eq!(
            doc.focused(),
            span,
            "negative tabindex supports programmatic focus"
        );
        doc.remove(span).unwrap();
        assert_eq!(doc.focused(), 0);
        doc.focus(span, false).unwrap();
        assert_eq!(doc.focused(), 0);
    }

    #[test]
    fn details_and_shadow_interaction_pseudo_classes_update_live_layout() {
        let mut doc = doc("<section></section>");
        let host = find(&doc, "section");
        let shadow = doc.attach_shadow(host).unwrap();
        doc.set_inner_html(shadow,"<style>:host(:hover){color:red}:host(:active){background:blue}</style><details><summary>Diagnostics</summary><pre>message</pre></details>").unwrap();
        let details = doc.query(shadow, "details").unwrap()[0];
        let summary = doc.query(shadow, "summary").unwrap()[0];
        let pre = doc.query(shadow, "pre").unwrap()[0];
        assert_eq!(doc.computed_style(pre, "display").unwrap(), "none");
        doc.set_attribute(details, "open", Some(String::new()))
            .unwrap();
        assert_ne!(doc.computed_style(pre, "display").unwrap(), "none");
        doc.set_hover(summary).unwrap();
        assert_eq!(doc.computed_style(host, "color").unwrap(), "rgb(255, 0, 0)");
        doc.set_active(summary).unwrap();
        assert_eq!(
            doc.computed_style(host, "background-color").unwrap(),
            "rgb(0, 0, 255)"
        );
        doc.set_active(0).unwrap();
        doc.set_hover(0).unwrap();
        assert_ne!(doc.computed_style(host, "color").unwrap(), "rgb(255, 0, 0)");
    }

    #[test]
    fn input_selection_uses_the_native_editor_and_only_paints_while_focused() {
        let mut doc = UiDocument::new(
            "<style>body{margin:0}input{width:80px;height:24px;color:white;background:#182b3a}</style><input value=0.65><button>Next</button>",
            140, 60, 1.0,
            include_bytes!("../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf").to_vec(),
        ).unwrap();
        let input = find(&doc, "input");
        let button = find(&doc, "button");
        let selection = |doc: &UiDocument| {
            doc.element(input).unwrap().element_data().unwrap()
                .text_input_data().unwrap().editor.selected_text().map(str::to_owned)
        };
        assert!(!doc.select_input_text(input).unwrap());
        doc.focus(input, false).unwrap();
        assert_eq!(selection(&doc), None);
        assert!(doc.select_input_text(input).unwrap());
        assert_eq!(selection(&doc).as_deref(), Some("0.65"));
        doc.set_input_value(input, "0.65").unwrap();
        assert_eq!(selection(&doc).as_deref(), Some("0.65"));
        let selected_pixels = |rgba: &[u8]| rgba.chunks_exact(4)
            .filter(|pixel| **pixel == [25, 103, 210, 255]).count();
        assert!(selected_pixels(&doc.paint().unwrap()) > 10);
        doc.set_input_text(input, "0.8").unwrap();
        assert_eq!(selection(&doc), None);
        assert!(doc.select_input_text(input).unwrap());
        doc.focus(button, false).unwrap();
        assert!(!doc.select_input_text(input).unwrap());
        assert_eq!(doc.focused(), button);
        assert_eq!(selected_pixels(&doc.paint().unwrap()), 0);
    }

    #[test]
    fn focus_eligibility_resolves_targets_without_transferring_current_focus() {
        let mut doc = doc("<input id=current><section><input id=next></section>");
        let current = find(&doc, "#current");
        let next = find(&doc, "#next");
        let section = find(&doc, "section");
        doc.focus(current, false).unwrap();
        assert!(doc.can_focus(next).unwrap());
        assert_eq!(doc.focused(), current);
        assert!(doc.matches(current, ":focus-visible").unwrap());
        assert!(!doc.matches(next, ":focus").unwrap());
        doc.set_attribute(next, "disabled", Some(String::new())).unwrap();
        assert!(!doc.can_focus(next).unwrap());
        assert_eq!(doc.focused(), current);
        doc.set_attribute(next, "disabled", None).unwrap();
        doc.set_style(section, "display", "none", "").unwrap();
        assert!(!doc.can_focus(next).unwrap());
        assert_eq!(doc.focused(), current);
        doc.set_style(section, "display", "block", "").unwrap();
        assert!(doc.can_focus(next).unwrap());
        assert_eq!(doc.focused(), current);
        doc.remove(next).unwrap();
        assert!(!doc.can_focus(next).unwrap());
        assert_eq!(doc.focused(), current);
    }

    #[test]
    fn native_focus_outline_paints_and_retires_with_control_eligibility() {
        let mut doc = UiDocument::new(
            "<style>body{margin:0}section>*{position:absolute;left:20px;top:20px;width:60px;height:24px;margin:0;padding:0;border:0;display:block}</style><section><button></button><input type=checkbox><select><option>A</option></select><a href=\"#target\"></a><span tabindex=-1></span></section>",
            100, 100, 1.0,
            include_bytes!("../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf").to_vec(),
        ).unwrap();
        let section = find(&doc, "section");
        let unfocused = doc.paint().unwrap();
        for selector in ["button", "input", "select", "a", "span"] {
            let control = find(&doc, selector);
            doc.focus(control, false).unwrap();
            assert_eq!(doc.focused(), control, "{selector}");
            assert!(doc.matches(control, ":focus").unwrap());
            assert_eq!(
                doc.computed_style(control, "outline-style").unwrap(),
                "auto",
                "{selector}"
            );
            assert_eq!(doc.computed_style(control, "outline-width").unwrap(), "1px");
            assert_eq!(
                doc.computed_style(control, "outline-color").unwrap(),
                "rgb(16, 16, 16)"
            );
            let pixels = doc.paint().unwrap();
            let pixel = &pixels[4 * 3019..4 * 3019 + 4];
            assert_eq!(
                pixel[3] > 0, true,
                "{selector} outline must paint outside its box"
            );
            assert_ne!(pixels, unfocused, "{selector} focus paints a visible ring");
            doc.focus(0, false).unwrap();
            assert_eq!(
                doc.computed_style(control, "outline-style").unwrap(),
                "none"
            );
            assert_eq!(
                doc.paint().unwrap(),
                unfocused,
                "{selector} outline retires"
            );
        }
        let button = find(&doc, "button");
        doc.focus(button, false).unwrap();
        doc.set_attribute(button, "disabled", Some(String::new()))
            .unwrap();
        assert_eq!(doc.focused(), 0);
        doc.focus(button, false).unwrap();
        assert_eq!(doc.focused(), 0);
        doc.set_attribute(button, "disabled", None).unwrap();
        doc.focus(button, false).unwrap();
        doc.set_style(section, "display", "none", "").unwrap();
        assert_eq!(doc.computed_style(section, "display").unwrap(), "none");
        assert_eq!(doc.focused(), 0);
        doc.focus(button, false).unwrap();
        assert_eq!(doc.focused(), 0);
        doc.set_style(section, "display", "block", "").unwrap();
        doc.focus(button, false).unwrap();
        assert_eq!(doc.focused(), button);
        doc.set_style(button, "outline", "none", "").unwrap();
        assert_eq!(doc.computed_style(button, "outline-style").unwrap(), "none");
        doc.remove(button).unwrap();
        assert_eq!(doc.focused(), 0);
    }

    #[test]
    fn raster_bytes_are_premultiplied_rgba_with_group_opacity() {
        let mut doc = doc(
            "<style>body{margin:0}section{width:50px;height:50px;background:red;opacity:.5}div{width:50px;height:50px;background:blue}</style><section><div></div></section>",
        );
        let bytes = doc.paint().unwrap();
        assert_eq!(&bytes[4 * 1010..4 * 1010 + 4], &[0, 0, 128, 128]);
        assert_eq!(&bytes[4 * 9090..4 * 9090 + 4], &[0, 0, 0, 0]);
    }

    #[test]
    fn prepared_regular_font_synthesizes_requested_bold_weight() {
        let mut doc = UiDocument::new("<style>body{margin:0}div{font:24px sans-serif;color:white;height:30px}b{font-weight:700}</style><div>HIM</div><div><b>HIM</b></div>",100,100,1.0,include_bytes!("../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf").to_vec()).unwrap();
        let pixels = doc.paint().unwrap();
        let coverage = |top: usize| {
            pixels[top * 400..(top + 30) * 400]
                .chunks_exact(4)
                .map(|p| u64::from(p[3]))
                .sum::<u64>()
        };
        assert!(
            coverage(30) > coverage(0) * 11 / 10,
            "bold synthesis must increase glyph coverage: {} vs {}",
            coverage(30),
            coverage(0)
        );
    }
}

#[cfg(test)]
mod resource_tests {
    use super::*;

    fn resource_document(html: &str) -> UiDocument {
        UiDocument::with_resources(
            html,
            180,
            60,
            1.0,
            vec![],
            None,
            Some("https://ui.test/guide/".into()),
        )
        .unwrap()
    }

    #[test]
    fn nested_stylesheets_resolve_against_their_source_and_transport_failure_unblocks() {
        let mut doc =
            resource_document("<link rel=stylesheet href=css/main.css><div id=box></div>");
        let requests = doc.resource_requests();
        assert_eq!(requests.len(), 1);
        let first = requests[0];
        assert_eq!(
            doc.resource_url(first).unwrap(),
            "https://ui.test/guide/css/main.css"
        );
        doc.resource_response(
            first,
            b"@import './nested.css'; #box { width: 90px; height: 20px }".to_vec(),
        )
        .unwrap();
        let nested = doc.resource_requests()[0];
        assert_eq!(
            doc.resource_url(nested).unwrap(),
            "https://ui.test/guide/css/nested.css"
        );
        doc.resource_failed(nested, "package resource absent".into())
            .unwrap();
        assert_eq!(
            doc.resource_errors(),
            vec![
                "https://ui.test/guide/css/nested.css",
                "package resource absent"
            ]
        );
        assert!(doc.resource_requests().is_empty());
        assert!(!doc.document.has_pending_critical_resources());
        let box_id = doc.query(doc.root(), "#box").unwrap()[0];
        assert_eq!(doc.rect(box_id).unwrap()[2], 90.0);
        assert!(doc.resource_response(first, vec![]).is_err());
    }

    #[test]
    fn verified_data_url_image_requires_no_host_resource_reader() {
        let mut doc = resource_document(
            "<style>body{margin:0}img{width:20px;height:20px}</style><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='>",
        );
        assert!(doc.resource_requests().is_empty());
        assert!(doc.resource_errors().is_empty());
        let pixels = doc.paint().unwrap();
        let offset = (10 * 180 + 10) * 4;
        assert_eq!(&pixels[offset..offset + 4], &[255, 0, 0, 255]);
    }

    #[test]
    fn removed_font_stylesheet_rejects_its_late_response() {
        let mut doc = resource_document(
            "<style id=font>@font-face{font-family:Late;src:url(late.woff2)}</style><style>span{display:inline-block;font:32px Late}</style><span>iiiWW</span>",
        );
        let requests = doc.resource_requests();
        assert_eq!(requests.len(), 1);
        let span = doc.query(doc.root(), "span").unwrap()[0];
        let before = doc.rect(span).unwrap()[2];
        let style = doc.query(doc.root(), "#font").unwrap()[0];
        doc.remove(style).unwrap();
        let font = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2")).unwrap();
        doc.resource_response(requests[0], font).unwrap();
        assert_eq!(
            doc.rect(span).unwrap()[2],
            before,
            "retired font source cannot change live text layout"
        );
    }

    #[test]
    fn companion_png_decodes_into_real_image_pixels() {
        let mut doc = resource_document(
            "<style>body{margin:0}img{width:20px;height:20px}</style><img src=red.png>",
        );
        let id = doc.resource_requests()[0];
        doc.resource_response(
            id,
            vec![
                137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0,
                1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248,
                207, 192, 240, 31, 0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68,
                174, 66, 96, 130,
            ],
        )
        .unwrap();
        assert!(doc.resource_errors().is_empty());
        let pixels = doc.paint().unwrap();
        let offset = (10 * 180 + 10) * 4;
        assert_eq!(&pixels[offset..offset + 4], &[255, 0, 0, 255]);
    }

    #[test]
    fn malformed_font_and_image_report_the_real_requested_url() {
        let mut doc = resource_document(
            "<style>@font-face { font-family: Demo; src: url('bad.woff2') } img { width:20px; height:20px }</style><img src=bad.png>",
        );
        for id in doc.resource_requests() {
            doc.resource_response(id, b"invalid payload".to_vec())
                .unwrap();
        }
        let errors = doc.resource_errors();
        assert_eq!(errors.len(), 4);
        assert!(
            errors
                .iter()
                .any(|value| value == "https://ui.test/guide/bad.woff2")
        );
        assert!(
            errors
                .iter()
                .any(|value| value == "https://ui.test/guide/bad.png")
        );
        assert!(errors.iter().any(|value| value.contains("Invalid WOFF2")));
        assert!(UiDocument::new("", 10, 10, 1.0, b"invalid font".to_vec()).is_err());
    }

    #[test]
    fn loaded_font_family_falls_back_for_missing_author_glyphs() {
        let font = include_bytes!(
            "../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf"
        )
        .to_vec();
        let mut doc = UiDocument::with_resources(
            "<style>@font-face{font-family:PublishedFallback;src:url(fallback.woff2)}html,body{margin:0;background:white}span{display:block;color:black;font:32px/40px 'Inventory Fixture'}</style><span>× ± é €</span>",
            240, 40, 1.0, font, Some("Inventory Fixture".into()), Some("https://fonts.test/".into()),
        ).unwrap();
        let span = doc.query(doc.root(), "span").unwrap()[0];
        let uncovered = doc.paint().unwrap();
        let fallback = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2")).unwrap();
        for request in doc.resource_requests() {
            doc.resource_response(request, fallback.clone()).unwrap();
        }
        assert!(doc.resource_errors().is_empty());
        let implicit = doc.paint().unwrap();
        assert!(
            implicit != uncovered,
            "loading a covering font must replace missing-glyph runs"
        );
        let node = doc.document.get_node(NodeId::from_u64(span)).unwrap();
        let layout = &node
            .element_data()
            .unwrap()
            .inline_layout_data
            .as_ref()
            .unwrap()
            .layout;
        for line in layout.lines() {
            for run in line.runs() {
                assert!(
                    run.clusters()
                        .flat_map(|cluster| cluster.glyphs())
                        .all(|glyph| glyph.id != 0),
                    "every published symbol must select a covered glyph"
                );
            }
        }
        doc.set_attribute(
            span,
            "style",
            Some("font-family:'Inventory Fixture',PublishedFallback".into()),
        )
        .unwrap();
        assert!(
            doc.paint().unwrap() == implicit,
            "implicit fallback must preserve author precedence and use the published glyphs"
        );
    }

    #[test]
    fn authored_latin_family_uses_published_bootstrap_for_missing_arrow() {
        let package = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../devkit/node_modules/@fontsource-variable/noto-sans-sc");
        let font =
            std::fs::read(package.join("files/noto-sans-sc-latin-wght-normal.woff2")).unwrap();
        let mut doc = UiDocument::with_resources(
            "<link rel=stylesheet href=index.css><style>@font-face{font-family:Companion;src:url(files/noto-sans-sc-latin-wght-normal.woff2)}body{margin:0;background:white}span{display:block;font:32px/40px Companion;color:black}</style><span>→</span>",
            80, 40, 1.0, font, Some("Noto Sans SC Variable".into()), Some("https://fonts.test/".into()),
        ).unwrap();
        loop {
            let requests = doc.resource_requests();
            if requests.is_empty() {
                break;
            }
            for id in requests {
                let url = doc.resource_url(id).unwrap();
                let path = url.strip_prefix("https://fonts.test/").unwrap();
                doc.resource_response(id, std::fs::read(package.join(path)).unwrap())
                    .unwrap();
            }
        }
        assert!(doc.resource_errors().is_empty());
        let fallback = doc.paint().unwrap();
        let span = doc.query(doc.root(), "span").unwrap()[0];
        doc.set_attribute(
            span,
            "style",
            Some("font-family:'Noto Sans SC Variable'".into()),
        )
        .unwrap();
        let explicit = doc.paint().unwrap();
        assert!(
            fallback == explicit,
            "implicit fallback must use the published glyph, not tofu"
        );
        doc.set_text_content(span, "\u{10ffff}").unwrap();
        assert!(
            doc.paint().unwrap() != explicit,
            "arrow must differ from an uncovered glyph"
        );
    }

    #[test]
    fn published_woff2_subsets_extend_system_ui_with_distinct_chinese_glyphs() {
        // Exact production font dependency, with OFL license, owned by DevKit.
        // No font discovery or machine-system font participates in this gate.
        let package = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../devkit/node_modules/@fontsource-variable/noto-sans-sc");
        let font =
            std::fs::read(package.join("files/noto-sans-sc-latin-wght-normal.woff2")).unwrap();
        let mut doc = UiDocument::with_resources(
            "<link rel=stylesheet href=index.css><style>body { margin:0; font:32px/40px system-ui; color:black; background:white }</style>你好中文",
            160, 40, 1.0, font, Some("Noto Sans SC Variable".into()), Some("https://fonts.test/".into()),
        ).unwrap();
        let mut count = 0;
        loop {
            let requests = doc.resource_requests();
            if requests.is_empty() {
                break;
            }
            for id in requests {
                let url = doc.resource_url(id).unwrap();
                let path = url.strip_prefix("https://fonts.test/").unwrap();
                doc.resource_response(id, std::fs::read(package.join(path)).unwrap())
                    .unwrap();
                count += 1;
            }
        }
        assert!(
            count > 100,
            "complete companion stylesheet must be followed"
        );
        assert!(doc.resource_errors().is_empty());
        let pixels = doc.paint().unwrap();
        let tiles: Vec<Vec<u8>> = (0..4)
            .map(|tile| {
                (0..40)
                    .flat_map(|y| {
                        pixels[(y * 160 + tile * 32) * 4..(y * 160 + tile * 32 + 32) * 4]
                            .iter()
                            .copied()
                    })
                    .collect()
            })
            .collect();
        for index in 0..4 {
            assert!(
                tiles[index]
                    .chunks_exact(4)
                    .filter(|pixel| pixel[0] < 128 && pixel[3] > 128)
                    .count()
                    > 50
            );
            for other in 0..index {
                assert_ne!(
                    tiles[index], tiles[other],
                    "Chinese coverage must not collapse to one missing-glyph box"
                );
            }
        }
    }
}
