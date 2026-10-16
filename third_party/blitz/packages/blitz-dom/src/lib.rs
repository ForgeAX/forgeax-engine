//! The core DOM abstraction in Blitz
//!
//! This crate implements a flexible headless DOM ([`BaseDocument`]), which is designed to emebedded in and "driven" by external code. Most users will want
//! to use a wrapper:
//!
//!  - [`HtmlDocument`](https://docs.rs/blitz-html/latest/blitz_html/struct.HtmlDocument.html) from the [blitz-html](https://docs.rs/blitz-html) crate.
//!    Allows you to parse HTML (or XHTML) into a Blitz [`BaseDocument`], and can be combined with a markdown-to-html converter like [comrak](https://docs.rs/comrak)
//!    or [pulldown-cmark](https://docs.rs/pulldown-cmark) to render/process markdown.
//!  - [`DioxusDocument`](https://docs.rs/dioxus-native/latest/dioxus_native/struct.DioxusDocument.html) from the [dioxus-native](https://docs.rs/dioxus-native) crate.
//!    Combines a [`BaseDocument`] with a Dioxus `VirtualDom` to enable dynamic rendering and event handling.
//!
//! It includes: A DOM tree respresentation, CSS parsing and resolution, layout and event handling. Additional functionality is available in
//! separate crates, including html parsing ([blitz-html](https://docs.rs/blitz-html)), networking ([blitz-net](https://docs.rs/blitz-html)),
//! rendering ([blitz-paint](https://docs.rs/blitz-paint)) and windowing ([blitz-shell](https://docs.rs/blitz-shell)).
//!
//! Most of the functionality in this crates is provided through the  struct.
//!
//! `blitz-dom` has a native Rust API that is designed for higher-level abstractions to be built on top (although it can also be used directly).
//!
//! The goal behind this crate is that any implementor can interact with the DOM and render it out using any renderer
//! they want.
//!

#![allow(clippy::collapsible_if)]

// TODO: Document features
// ## Feature flags
//  - `default`: Enables the features listed below.
//  - `tracing`: Enables tracing support.

pub const DEFAULT_CSS: &str = include_str!("../assets/default.css");
pub const BULLET_FONT: &[u8] = include_bytes!("../assets/moz-bullet-font.otf");

/// The DOM implementation.
///
/// This is the primary entry point for this crate.
mod document;

/// The nodes themsleves, and their data.
pub mod node;

mod config;
/// CSSOM stylesheet access (`document.styleSheets`, `CSSStyleSheet`, `CSSRule`)
mod cssom;
mod debug;
mod events;
mod focus_navigation;
mod font_metrics;
mod form;
mod html;
/// Loading of `<iframe>` elements into sub-documents.
mod iframe;
/// Integration of taffy and the DOM.
mod layout;
mod mutator;
mod query_selector;
mod resolve;
/// Computation of resolved CSS property values (`getComputedStyle()`)
mod resolved_style;
/// Scrolling of nodes and the viewport, and scroll animations.
mod scrolling;
mod selection;
/// Implementations that interact with servo's style engine
mod shadow;
mod stylo;
mod stylo_device;
mod stylo_to_cursor_icon;
mod stylo_to_kurbo;
mod stylo_to_parley;
pub mod traversal;
/// Versioned storage for the nodes of the DOM tree.
mod tree;
mod validation;

mod url;

pub use cssom::{CssRuleInfo, CssomError};
pub use resolved_style::{
    css_property_is_supported, parse_transform_matrix, resolved_style_property_names,
};
pub use stylo_to_kurbo::resolve_2d_transform;

pub mod net;
pub mod util;

#[cfg(feature = "accessibility")]
mod accessibility;

pub use crate::layout::paint_tree::{HoistedPaintChild, StackingContext, hoisted_child_position};
pub use crate::layout::replaced::IntrinsicSizes;
pub use crate::layout::text_transform::{full_size_kana, full_width};
#[cfg(feature = "custom-widget")]
pub use crate::node::Widget;

pub use blitz_traits::node_id::NodeId;
// Re-export taffy: it is part of blitz-dom's public API (e.g. `Node::style`,
// `Node::final_layout`)
pub use config::{DocumentConfig, StyleThreading};
pub use document::{BaseDocument, BoundingRect, DocGuard, DocGuardMut, Document, PlainDocument};
pub use markup5ever::{
    LocalName, Namespace, NamespaceStaticSet, Prefix, PrefixStaticSet, QualName, local_name,
    namespace_prefix, namespace_url, ns,
};
pub use mutator::DocumentMutator;
pub use node::{Attribute, DocumentData, ElementData, Node, NodeData, TextNodeData};
pub use parley::FontContext;
pub use scrolling::{ScrollBehavior, ScrollLogicalPosition};
pub use tree::NodeTree;

/// Convert a Blitz [`NodeId`] into a [`taffy::NodeId`] (which wraps a `u64`).
#[inline]
pub fn taffy_node_id(id: NodeId) -> taffy::NodeId {
    taffy::NodeId::from(id.as_u64())
}

/// Convert a [`taffy::NodeId`] produced by [`taffy_node_id`] back into a Blitz [`NodeId`].
#[inline]
pub fn dom_node_id(id: taffy::NodeId) -> NodeId {
    NodeId::from_u64(u64::from(id))
}
pub use style::Atom;
pub use style::invalidation::element::restyle_hints::RestyleHint;
pub use style::media_queries::MediaType;
pub use style::stylist::RegisterCustomPropertyResult;
pub type SelectorList = selectors::SelectorList<style::selector_parser::SelectorImpl>;
pub use events::{EventDriver, EventHandler, NoopEventHandler, touch_action_pan_axes};
pub use html::{DummyHtmlParserProvider, HtmlParserProvider};
pub use util::{Point, decode_font_bytes};

/// Convenience builder for the one-font case: produces a [`FontContext`] with
/// system-font discovery disabled and the supplied font registered as the
/// fallback for every generic family. The standard setup for WASM, where
/// browsers don't expose system fonts. WOFF/WOFF2 inputs are decoded
/// automatically.
pub fn build_single_font_ctx(font_data: &[u8]) -> FontContext {
    build_single_font_ctx_with_family(font_data, None).unwrap_or_default()
}

/// As above, with an optional CSS family alias. Later `@font-face` subsets
/// registered under that alias extend the same generic and script fallback family.
/// Invalid nonempty input is a construction error, not silent missing text.
pub fn build_single_font_ctx_with_family(
    font_data: &[u8],
    family_name: Option<&str>,
) -> Result<FontContext, String> {
    use parley::fontique::{
        Blob, Collection, CollectionOptions, FontInfoOverride, GenericFamily, SourceCache,
    };
    use std::sync::Arc;

    let mut ctx = FontContext {
        source_cache: SourceCache::new_shared(),
        collection: Collection::new(CollectionOptions {
            shared: false,
            system_fonts: false,
        }),
    };
    let decoded = decode_font_bytes(font_data).into_owned();
    let family_ids = register_font_with_fallback(
        &mut ctx.collection,
        Blob::new(Arc::new(decoded) as _),
        Some(FontInfoOverride {
            family_name,
            ..Default::default()
        }),
    );
    if !font_data.is_empty() && family_ids.is_empty() {
        return Err("Invalid bootstrap font data".into());
    }
    for generic in [
        GenericFamily::SansSerif,
        GenericFamily::Serif,
        GenericFamily::Monospace,
        GenericFamily::SystemUi,
    ] {
        ctx.collection
            .append_generic_families(generic, family_ids.iter().copied());
    }
    Ok(ctx)
}

/// Author fonts supply the portable last-resort collection when OS discovery is
/// unavailable. Explicit CSS families still win; shaping tests actual coverage.
fn register_font_with_fallback(
    collection: &mut parley::fontique::Collection,
    data: parley::fontique::Blob<u8>,
    overrides: Option<parley::fontique::FontInfoOverride<'_>>,
) -> Vec<parley::fontique::FamilyId> {
    use parley::fontique::{Script, ScriptExt};

    let family_ids: Vec<_> = collection
        .register_fonts(data, overrides)
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    for script in [*b"Zyyy", *b"Zinh", *b"Zzzz"]
        .into_iter()
        .map(Script::from_bytes)
        .chain(Script::all_samples().iter().map(|(script, _)| *script))
    {
        for family_id in &family_ids {
            // A companion stylesheet can register hundreds of subsets under
            // one family. The existing collection owns membership and order.
            if !collection
                .fallback_families(script)
                .any(|id| id == *family_id)
            {
                collection.append_fallbacks(script, std::iter::once(*family_id));
            }
        }
    }
    family_ids
}
