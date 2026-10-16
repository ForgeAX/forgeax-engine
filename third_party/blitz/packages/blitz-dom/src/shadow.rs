//! Shadow trees retain their DOM topology. Only style/layout traversal uses
//! flattened children; document queries and serialization stay in one tree.
use crate::{BaseDocument, DocumentMutator, Node, NodeData, NodeId};
use style::invalidation::element::restyle_hints::RestyleHint;
use style::servo_arc::Arc;
use style::stylesheet_set::AuthorStylesheetSet;
use style::stylist::{CascadeData, CascadeDataDifference};

pub struct ShadowData {
    pub host: NodeId,
    pub cascade: Option<Arc<CascadeData>>,
}

impl Node {
    /// DOM root, without crossing a ShadowRoot into its host.
    pub fn tree_root_id(&self) -> NodeId {
        let mut node = self;
        while let Some(parent) = node.parent {
            node = self.with(parent);
        }
        node.id
    }

    pub fn shadow_root_id(&self) -> Option<NodeId> {
        self.element_data().and_then(|data| data.shadow_root)
    }

    pub fn shadow_host_id(&self) -> Option<NodeId> {
        match &self.data {
            NodeData::DocumentFragment(data) => data.shadow.as_ref().map(|shadow| shadow.host),
            _ => None,
        }
    }

    pub fn containing_shadow_id(&self) -> Option<NodeId> {
        let mut node = self;
        while let Some(parent) = node.parent {
            node = self.with(parent);
            if node.shadow_host_id().is_some() {
                return Some(node.id);
            }
        }
        None
    }

    pub fn flat_children(&self) -> &[NodeId] {
        match self.shadow_root_id() {
            Some(id) => &self.with(id).children,
            None => &self.children,
        }
    }

    pub fn flat_parent(&self) -> Option<NodeId> {
        if let Some(host) = self.shadow_host_id() {
            return Some(host);
        }
        self.parent
            .map(|id| self.with(id).shadow_host_id().unwrap_or(id))
    }

    pub(crate) fn shadow_cascade(&self) -> Option<&CascadeData> {
        match &self.data {
            NodeData::DocumentFragment(data) => data.shadow.as_ref()?.cascade.as_deref(),
            _ => None,
        }
    }
}

impl DocumentMutator<'_> {
    pub fn create_document_fragment(&mut self) -> NodeId {
        self.doc
            .create_node(NodeData::DocumentFragment(Box::default()))
    }

    pub fn attach_shadow(&mut self, host: NodeId) -> Result<NodeId, &'static str> {
        let node = self.doc.get_node(host).ok_or("NotFoundError")?;
        let data = node.element_data().ok_or("NotSupportedError")?;
        if data.shadow_root.is_some() {
            return Err("NotSupportedError: host already has a shadow root");
        }
        let tag: &str = data.name.local.as_ref();
        if !tag.contains('-')
            && !matches!(
                tag,
                "article"
                    | "aside"
                    | "blockquote"
                    | "body"
                    | "div"
                    | "footer"
                    | "h1"
                    | "h2"
                    | "h3"
                    | "h4"
                    | "h5"
                    | "h6"
                    | "header"
                    | "main"
                    | "nav"
                    | "p"
                    | "section"
                    | "span"
            )
        {
            return Err("NotSupportedError: this element cannot host a shadow root");
        }
        let connected = node.flags.is_in_document();
        let in_template_document = node
            .flags
            .contains(crate::node::NodeFlags::IS_IN_TEMPLATE_DOCUMENT);
        let root = self.create_document_fragment();
        if let NodeData::DocumentFragment(data) = &mut self.doc.nodes[root].data {
            data.shadow = Some(ShadowData {
                host,
                cascade: None,
            });
        }
        self.doc.nodes[root]
            .flags
            .set(crate::node::NodeFlags::IS_IN_DOCUMENT, connected);
        self.doc.nodes[root].flags.set(
            crate::node::NodeFlags::IS_IN_TEMPLATE_DOCUMENT,
            in_template_document,
        );
        self.doc.nodes[host].element_data_mut().unwrap().shadow_root = Some(root);
        self.doc.nodes[host].set_restyle_hint(RestyleHint::restyle_subtree());
        self.doc.nodes[host].insert_damage(crate::layout::damage::ALL_DAMAGE);
        self.doc.nodes[host].mark_ancestors_dirty();
        self.doc.stylesheet_generation += 1;
        Ok(root)
    }
}

impl BaseDocument {
    pub(crate) fn invalidate_shadow_styles(&mut self) {
        for (_, node) in self.nodes.iter_mut() {
            if let NodeData::DocumentFragment(data) = &mut node.data {
                if let Some(shadow) = &mut data.shadow {
                    shadow.cascade = None;
                }
            }
        }
    }

    /// Rebuild only after an author sheet or device changes. Each shadow tree
    /// gets Stylo's native author cascade; selectors are never rewritten.
    pub(crate) fn rebuild_shadow_styles(&mut self) {
        let roots: Vec<_> = self
            .nodes
            .iter()
            .filter_map(|(id, node)| node.shadow_host_id().map(|host| (id, host)))
            .collect();
        for (root, host) in roots {
            if self.nodes[root].shadow_cascade().is_some() {
                continue;
            }
            let mut sheets = AuthorStylesheetSet::new();
            let guard = self.guard.read();
            let mut stack: Vec<_> = self.nodes[root].children.iter().rev().copied().collect();
            while let Some(id) = stack.pop() {
                if let Some(sheet) = self.nodes_to_stylesheet.get(&id) {
                    sheets.append_stylesheet(None, &Default::default(), sheet.clone(), &guard);
                }
                stack.extend(self.nodes[id].children.iter().rev().copied());
            }
            let (flusher, _) = sheets.flush();
            let cascade = self
                .stylist
                .rebuild_author_data(
                    &CascadeData::new(),
                    flusher.sheets,
                    &guard,
                    &mut CascadeDataDifference::default(),
                )
                .expect("shadow author cascade allocation failed");
            drop(guard);
            if let NodeData::DocumentFragment(data) = &mut self.nodes[root].data {
                data.shadow.as_mut().unwrap().cascade =
                    Some(cascade.unwrap_or_else(|| Arc::new(CascadeData::new())));
            }
            self.nodes[host].set_restyle_hint(RestyleHint::restyle_subtree());
            self.nodes[host].mark_ancestors_dirty();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DocumentConfig, StyleThreading, qual_name};
    use blitz_traits::shell::{ColorScheme, Viewport};

    #[test]
    fn shadow_scope_mutation_detachment_and_drop_keep_one_tree() {
        let mut doc = BaseDocument::new(DocumentConfig {
            viewport: Some(Viewport::new(200, 200, 1.0, ColorScheme::Light)),
            style_threading: StyleThreading::Sequential,
            ..Default::default()
        });
        let root = doc.root_node().id;
        let mut m = doc.mutate();
        let html = m.create_element(qual_name!("html", html), vec![]);
        let host = m.create_element(qual_name!("section", html), vec![]);
        m.append_children(root, &[html]);
        m.append_children(html, &[host]);
        let shadow = m.attach_shadow(host).unwrap();
        assert!(m.attach_shadow(host).is_err());
        let style = m.create_element(qual_name!("style", html), vec![]);
        let css = m.create_text_node(":host{display:block;width:100px}span{display:block;width:20px;height:10px}:host(.wide) span{width:40px}:host(:hover){opacity:.25}span:active{opacity:.5}@media(prefers-reduced-motion:reduce){span{height:20px}}");
        m.append_children(style, &[css]);
        let child = m.create_element(qual_name!("span", html), vec![]);
        m.append_children(shadow, &[style, child]);
        drop(m);
        doc.resolve(0.0);
        assert!(doc.query_selector("span").unwrap().is_none());
        assert_eq!(doc.query_selector_in(shadow, "span").unwrap(), Some(child));
        assert_eq!(doc.nodes[child].parent, Some(shadow));
        assert!(doc.nodes[host].children.is_empty());
        assert_eq!(doc.nodes[child].final_layout().size.width, 20.0);
        doc.set_hover_element(Some(child));
        doc.set_active_element(Some(child));
        doc.resolve(0.0);
        assert_eq!(
            doc.nodes[host].primary_styles().unwrap().clone_opacity(),
            0.25
        );
        assert_eq!(
            doc.nodes[child].primary_styles().unwrap().clone_opacity(),
            0.5
        );
        doc.clear_hover();
        doc.unactive_node();
        let mut viewport = doc.get_viewport();
        viewport.prefers_reduced_motion = true;
        doc.set_viewport(viewport);
        doc.resolve(0.0);
        assert_eq!(doc.nodes[child].final_layout().size.height, 20.0);
        doc.mutate()
            .set_attribute(host, qual_name!("class"), "wide");
        doc.resolve(0.0);
        assert_eq!(doc.nodes[child].final_layout().size.width, 40.0);
        doc.mutate().remove_node(host);
        assert!(!doc.nodes[child].flags.is_in_document());
        doc.mutate().append_children(html, &[host]);
        doc.resolve(0.0);
        assert_eq!(doc.nodes[child].final_layout().size.width, 40.0);
        doc.mutate()
            .set_node_text(css, "span{display:block;width:50px;height:10px}");
        doc.resolve(0.0);
        assert_eq!(doc.nodes[child].final_layout().size.width, 50.0);
        doc.mutate().remove_and_drop_node(host);
        assert!(doc.get_node(shadow).is_none());
        assert!(doc.get_node(child).is_none());
    }
}
