//! WinterCave's editor engine, in Rust.
//!
//! This crate is the platform-neutral half of the editor: it owns the document
//! model, edit application, undo, search, the syntax tokenizer and the smart
//! editing rules. It has no DOM, no filesystem and no async runtime, so the same
//! code can power the web shell (via `wintercave-wasm`), a CLI or a native
//! window.
//!
//! Two portability details matter:
//!
//! * **Byte offsets.** The TypeScript core indexes UTF-16 code units. Rust
//!   strings cannot be indexed mid-codepoint, so everything here is byte offsets
//!   and every slice goes through a boundary check. The wasm boundary converts.
//! * **Immutable documents.** [`document::TextDocument`] never mutates: edits
//!   return a new document, which keeps undo and recovery snapshots honest.
//!
//! It is deliberately dependency-light — `regex` and `unicode-segmentation` and
//! nothing else — so `cargo test` runs anywhere and the wasm build stays small.

pub mod commands;
pub mod document;
pub mod edits;
pub mod fuzzy;
pub mod history;
pub mod keymap;
pub mod language;
pub mod limits;
pub mod search;
pub mod selection;
pub mod smart_edit;
pub mod text;

pub use document::TextDocument;
pub use edits::{AppliedEdit, TextEdit};
pub use history::{EditKind, History, HistoryRecord};
pub use keymap::Keymap;
pub use language::{HighlightState, LanguageDef, Token, TokenType};
pub use limits::{classify_size, should_highlight, SizeClass, LIMITS};
pub use search::{Search, SearchOptions};
pub use selection::Selection;
pub use text::LineEnding;

/// Crate version, surfaced in the app's About dialog and the wasm smoke test.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
