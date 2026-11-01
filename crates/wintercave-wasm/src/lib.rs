//! JavaScript bindings for [`wintercave_core`].
//!
//! The web shell is synchronous, so every call here is synchronous too: no
//! promises, no callbacks, no shared mutable global. `Engine` owns a document
//! and its undo stack; the free functions are stateless helpers that the shell
//! calls directly (auto-close, newline, fuzzy ranking, keymap formatting).
//!
//! Conventions that the TypeScript side relies on:
//!
//! * Offsets are **byte** offsets. The shell keeps its own UTF-16 ↔ byte
//!   translation at the DOM boundary.
//! * Tokens are packed into a `Uint32Array` of `[line, start, end, kind]`
//!   quadruples so a 25k-line window costs one array copy, not 25k objects.
//! * Capability queries never panic: invalid input returns an error object or
//!   an empty result, because a panic in wasm takes the whole editor down.

use wasm_bindgen::prelude::*;

use wintercave_core::commands::CommandMeta;
use wintercave_core::edits::{create_edits, TextEdit};
use wintercave_core::fuzzy::{fuzzy_filter, fuzzy_match};
use wintercave_core::history::{EditKind, History, HistoryRecord};
use wintercave_core::keymap::{
    combo_from_event, default_bindings, find_conflicts, format_combo, normalize_combo, KeyEvent,
    Keymap,
};
use wintercave_core::language::{
    get_language, languages, tokenize_line, HighlightState, TokenType,
};
use wintercave_core::limits::{classify_size, format_bytes, should_highlight};
use wintercave_core::search::{Search, SearchOptions};
use wintercave_core::selection::Selection;
use wintercave_core::smart_edit::{
    compute_newline, decide_auto_close, detect_indent, reindent_block, smart_home_target,
    toggle_comment_block, toggle_line_comment_text, AutoCloseAction, IndentOptions,
    ReindentDirection,
};
use wintercave_core::{TextDocument, VERSION};

fn array_of_strings(values: &[String]) -> js_sys::Array {
    let out = js_sys::Array::new();
    for value in values {
        out.push(&JsValue::from_str(value));
    }
    out
}

fn set(object: &js_sys::Object, key: &str, value: &JsValue) {
    let _ = js_sys::Reflect::set(object.as_ref(), &JsValue::from_str(key), value);
}

fn token_code(kind: TokenType) -> u32 {
    match kind {
        TokenType::Keyword => 0,
        TokenType::Str => 1,
        TokenType::Comment => 2,
        TokenType::Number => 3,
        TokenType::Constant => 4,
        TokenType::Function => 5,
        TokenType::Type => 6,
        TokenType::Tag => 7,
        TokenType::Attribute => 8,
        TokenType::Operator => 9,
        TokenType::Heading => 10,
        TokenType::Emphasis => 11,
        TokenType::Strong => 12,
        TokenType::Link => 13,
        TokenType::Code => 14,
        TokenType::List => 15,
        TokenType::Meta => 16,
    }
}

const TOKEN_NAMES: [&str; 17] = [
    "keyword",
    "string",
    "comment",
    "number",
    "constant",
    "function",
    "type",
    "tag",
    "attribute",
    "operator",
    "heading",
    "emphasis",
    "strong",
    "link",
    "code",
    "list",
    "meta",
];

#[wasm_bindgen]
pub fn version() -> String {
    VERSION.to_string()
}

/// Class name for a packed token kind, so the shell never hard-codes numbers.
#[wasm_bindgen]
pub fn token_kind_name(code: u32) -> String {
    TOKEN_NAMES
        .get(code as usize)
        .map(|name| name.to_string())
        .unwrap_or_default()
}

/// `[[id, name, extensions], ...]` for the language picker.
#[wasm_bindgen]
pub fn language_catalog() -> js_sys::Array {
    let out = js_sys::Array::new();
    for language in languages() {
        let entry = js_sys::Array::new();
        entry.push(&JsValue::from_str(language.id));
        entry.push(&JsValue::from_str(language.name));
        entry.push(&array_of_strings(
            &language
                .extensions
                .iter()
                .map(|extension| extension.to_string())
                .collect::<Vec<_>>(),
        ));
        out.push(&entry);
    }
    out
}

#[wasm_bindgen]
pub fn language_for(filename: &str) -> String {
    wintercave_core::language::language_for_filename(filename)
        .id
        .to_string()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Insert,
    Delete,
    Replace,
}

impl Mode {
    fn kind(self) -> EditKind {
        match self {
            Mode::Insert => EditKind::Insert,
            Mode::Delete => EditKind::Delete,
            Mode::Replace => EditKind::Replace,
        }
    }
}

/// A document plus its undo stack, owned by JavaScript.
#[wasm_bindgen]
pub struct Engine {
    doc: TextDocument,
    history: History,
    selections: Vec<Selection>,
    language_id: String,
    clock: u64,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new(text: &str, language_id: &str) -> Engine {
        Engine {
            doc: TextDocument::new(text),
            history: History::default(),
            selections: vec![Selection::caret(0)],
            language_id: language_id.to_string(),
            clock: 0,
        }
    }

    pub fn text(&self) -> String {
        self.doc.get_text()
    }

    pub fn length(&self) -> usize {
        self.doc.len()
    }

    pub fn line_count(&self) -> usize {
        self.doc.line_count()
    }

    pub fn line_texts(&self) -> js_sys::Array {
        array_of_strings(
            &self
                .doc
                .lines()
                .into_iter()
                .map(|line| line.to_string())
                .collect::<Vec<_>>(),
        )
    }

    pub fn line_text(&self, line: usize) -> String {
        self.doc.line_text(line).to_string()
    }

    pub fn line_of(&self, offset: usize) -> usize {
        self.doc.line_at(offset)
    }

    /// `[line, column]`, both in bytes.
    pub fn position_at(&self, offset: usize) -> Vec<u32> {
        let (line, column) = self.doc.position_at(offset);
        vec![line as u32, column as u32]
    }

    pub fn offset_at(&self, line: usize, column: usize) -> usize {
        self.doc.offset_at(line, column)
    }

    #[wasm_bindgen(getter)]
    pub fn language(&self) -> String {
        self.language_id.clone()
    }

    pub fn set_language(&mut self, language_id: &str) {
        self.language_id = get_language(language_id).id.to_string();
    }

    pub fn set_selections(&mut self, offsets: &[u32]) {
        self.selections = offsets
            .iter()
            .map(|offset| Selection::caret(*offset as usize))
            .collect();
        if self.selections.is_empty() {
            self.selections.push(Selection::caret(0));
        }
    }

    pub fn selections(&self) -> Vec<u32> {
        self.selections
            .iter()
            .map(|selection| selection.head as u32)
            .collect()
    }

    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    fn record(&mut self, edit: TextEdit, mode: Mode, before: Selection, after: Selection) {
        let at = self.tick();
        let edits = create_edits(&self.doc, &[edit]);
        self.doc = wintercave_core::edits::apply_applied_sequential(&self.doc, &edits);
        self.history.push(HistoryRecord {
            edits,
            sel_before: vec![before],
            sel_after: vec![after],
            kind: mode.kind(),
            at,
        });
        self.selections = vec![after];
    }

    pub fn insert(&mut self, offset: usize, text: &str) {
        let clamped = offset.min(self.doc.len()).max(0);
        let after = Selection::caret(clamped + text.len());
        self.record(
            TextEdit::insert(clamped, text),
            Mode::Insert,
            Selection::caret(clamped),
            after,
        );
    }

    pub fn remove(&mut self, from: usize, to: usize) {
        let start = from.min(self.doc.len());
        let end = to.min(self.doc.len()).max(start);
        self.record(
            TextEdit::delete(start, end),
            Mode::Delete,
            Selection::caret(end),
            Selection::caret(start),
        );
    }

    pub fn replace(&mut self, from: usize, to: usize, text: &str) {
        let start = from.min(self.doc.len());
        let end = to.min(self.doc.len()).max(start);
        self.record(
            TextEdit::replace(start, end, text),
            Mode::Replace,
            Selection::caret(end),
            Selection::caret(start + text.len()),
        );
    }

    /// Returns the new caret, or -1 when there was nothing to undo.
    pub fn undo(&mut self) -> i32 {
        match self.history.undo(&self.doc) {
            Some((doc, selections)) => {
                self.doc = doc;
                self.selections = selections;
                self.selections.first().map(|s| s.head as i32).unwrap_or(0)
            }
            None => -1,
        }
    }

    pub fn redo(&mut self) -> i32 {
        match self.history.redo(&self.doc) {
            Some((doc, selections)) => {
                self.doc = doc;
                self.selections = selections;
                self.selections.first().map(|s| s.head as i32).unwrap_or(0)
            }
            None => -1,
        }
    }

    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    pub fn clear_history(&mut self) {
        self.history.clear();
    }

    /// Packed tokens for `[from, to)` lines: `[line, start, end, kind]` each.
    /// State is replayed from line 0, so a comment opened above the window is
    /// still coloured correctly.
    pub fn tokens(&self, from: usize, to: usize) -> Vec<u32> {
        let language = get_language(&self.language_id);
        let mut state = HighlightState::default();
        let mut packed: Vec<u32> = Vec::new();
        let end = to.min(self.doc.line_count());
        for index in 0..end {
            let line = self.doc.line_text(index);
            let (tokens, next) = tokenize_line(line, language, state);
            state = next;
            if index < from {
                continue;
            }
            for token in tokens {
                packed.push(index as u32);
                packed.push(token.start as u32);
                packed.push(token.end as u32);
                packed.push(token_code(token.kind));
            }
        }
        packed
    }

    /// Packed matches: `[start, end, start, end, ...]`.
    pub fn search(
        &self,
        query: &str,
        case_sensitive: bool,
        whole_word: bool,
        regex: bool,
    ) -> Vec<u32> {
        let search = Search::new(SearchOptions {
            query: query.to_string(),
            case_sensitive,
            whole_word,
            regex,
        });
        let mut packed: Vec<u32> = Vec::new();
        for (start, end) in search.matches(self.doc.text()) {
            packed.push(start as u32);
            packed.push(end as u32);
        }
        packed
    }

    pub fn search_error(&self, query: &str, regex: bool) -> String {
        let search = Search::new(SearchOptions {
            query: query.to_string(),
            regex,
            ..SearchOptions::default()
        });
        search.error().unwrap_or("").to_string()
    }

    /// `[newText, replacedCount]`.
    pub fn replace_all(
        &mut self,
        query: &str,
        replacement: &str,
        case_sensitive: bool,
        whole_word: bool,
        regex: bool,
    ) -> js_sys::Array {
        let search = Search::new(SearchOptions {
            query: query.to_string(),
            case_sensitive,
            whole_word,
            regex,
        });
        let (next, count) = search.replace_all(self.doc.text(), replacement);
        let out = js_sys::Array::new();
        if count > 0 {
            let edit = TextEdit::replace(0, self.doc.len(), &next);
            let edits = create_edits(&self.doc, &[edit]);
            let at = self.tick();
            self.doc = self.doc.with_text(&next);
            self.history.push(HistoryRecord {
                edits,
                sel_before: self.selections.clone(),
                sel_after: self.selections.clone(),
                kind: EditKind::Replace,
                at,
            });
        }
        out.push(&JsValue::from_str(&next));
        out.push(&JsValue::from_f64(count as f64));
        out
    }
}

/// `[score, ...positions]`, or an empty array when the query does not match.
#[wasm_bindgen]
pub fn fuzzy(query: &str, target: &str) -> js_sys::Array {
    let out = js_sys::Array::new();
    if let Some(found) = fuzzy_match(query, target) {
        out.push(&JsValue::from_f64(found.score as f64));
        for position in found.positions {
            out.push(&JsValue::from_f64(position as f64));
        }
    }
    out
}

/// Ranked indices for the command palette: `[index, score, ...positions]`.
#[wasm_bindgen]
pub fn rank(labels: Vec<String>, query: &str, limit: usize) -> Vec<u32> {
    let mut packed: Vec<u32> = Vec::new();
    for ranked in fuzzy_filter(&labels, query, |label| label.clone(), limit) {
        packed.push(ranked.index as u32);
        packed.push(ranked.score.max(0) as u32);
        packed.push(ranked.positions.len() as u32);
        for position in ranked.positions {
            packed.push(position as u32);
        }
    }
    packed
}

/// `{ type: 'insert' | 'skip' | 'wrap', ... }`, or undefined when nothing should happen.
#[wasm_bindgen]
pub fn auto_close(typed: &str, before: &str, after: &str, has_selection: bool) -> JsValue {
    let typed_char = typed.chars().next();
    let Some(typed_char) = typed_char else {
        return JsValue::UNDEFINED;
    };
    let Some(action) = decide_auto_close(
        typed_char,
        before.chars().next_back(),
        after.chars().next(),
        has_selection,
    ) else {
        return JsValue::UNDEFINED;
    };

    let object = js_sys::Object::new();
    match action {
        AutoCloseAction::Insert(text) => {
            set(&object, "type", &JsValue::from_str("insert"));
            set(&object, "text", &JsValue::from_str(text));
        }
        AutoCloseAction::Skip(advance) => {
            set(&object, "type", &JsValue::from_str("skip"));
            set(&object, "advance", &JsValue::from_f64(advance as f64));
        }
        AutoCloseAction::Wrap { open, close } => {
            set(&object, "type", &JsValue::from_str("wrap"));
            set(&object, "open", &JsValue::from_str(&open.to_string()));
            set(&object, "close", &JsValue::from_str(&close.to_string()));
        }
    }
    object.into()
}

/// `[textToInsert, caretOffset]` for the Enter key.
#[wasm_bindgen]
pub fn newline(line_text: &str, column: usize, indent_unit: &str) -> js_sys::Array {
    let result = compute_newline(line_text, column, indent_unit);
    let out = js_sys::Array::new();
    out.push(&JsValue::from_str(&result.text));
    out.push(&JsValue::from_f64(result.caret as f64));
    out
}

/// Target column for the Home key.
#[wasm_bindgen]
pub fn smart_home(line_text: &str, column: usize) -> usize {
    smart_home_target(line_text, column)
}

/// `[indentUnit, insertSpaces(bool)]`.
#[wasm_bindgen]
pub fn detect_indentation(text: &str, fallback_unit: &str, fallback_spaces: bool) -> js_sys::Array {
    let options = detect_indent(
        text,
        IndentOptions {
            indent_unit: fallback_unit.to_string(),
            insert_spaces: fallback_spaces,
        },
    );
    let out = js_sys::Array::new();
    out.push(&JsValue::from_str(&options.indent_unit));
    out.push(&JsValue::from_bool(options.insert_spaces));
    out
}

/// Reindent a block; `indent` is true for Tab, false for Shift+Tab.
#[wasm_bindgen]
pub fn reindent(
    lines: Vec<String>,
    indent_unit: &str,
    insert_spaces: bool,
    indent: bool,
) -> js_sys::Array {
    let options = IndentOptions {
        indent_unit: indent_unit.to_string(),
        insert_spaces,
    };
    let direction = if indent {
        ReindentDirection::Indent
    } else {
        ReindentDirection::Outdent
    };
    let borrowed: Vec<&str> = lines.iter().map(|line| line.as_str()).collect();
    array_of_strings(&reindent_block(&borrowed, &options, direction))
}

/// Comment or uncomment every non-blank line.
#[wasm_bindgen]
pub fn toggle_comment(lines: Vec<String>, prefix: Option<String>) -> js_sys::Array {
    let borrowed: Vec<&str> = lines.iter().map(|line| line.as_str()).collect();
    array_of_strings(&toggle_comment_block(&borrowed, prefix.as_deref()))
}

#[wasm_bindgen]
pub fn toggle_comment_line(line: &str, prefix: Option<String>) -> String {
    toggle_line_comment_text(line, prefix.as_deref())
}

#[wasm_bindgen]
pub fn key_combo(
    key: &str,
    ctrl: bool,
    meta: bool,
    alt: bool,
    shift: bool,
    is_mac: bool,
) -> String {
    combo_from_event(
        &KeyEvent {
            key: key.to_string(),
            ctrl,
            meta,
            alt,
            shift,
        },
        is_mac,
    )
}

#[wasm_bindgen]
pub fn key_normalize(combo: &str) -> String {
    normalize_combo(combo)
}

#[wasm_bindgen]
pub fn key_format(combo: &str, is_mac: bool) -> String {
    format_combo(combo, is_mac)
}

#[wasm_bindgen]
pub fn key_defaults() -> js_sys::Array {
    let bindings: Keymap = default_bindings();
    let out = js_sys::Array::new();
    for (combo, command) in bindings {
        let pair = js_sys::Array::new();
        pair.push(&JsValue::from_str(&combo));
        pair.push(&JsValue::from_str(&command));
        out.push(&pair);
    }
    out
}

#[wasm_bindgen]
pub fn key_conflicts(bindings: Vec<String>) -> js_sys::Array {
    let pairs: Vec<(String, String)> = bindings
        .chunks(2)
        .filter(|chunk| chunk.len() == 2)
        .map(|chunk| (chunk[0].clone(), chunk[1].clone()))
        .collect();
    let conflicts = find_conflicts(pairs.iter().map(|(a, b)| (a.as_str(), b.as_str())));
    let out = js_sys::Array::new();
    for (combo, commands) in conflicts {
        let entry = js_sys::Object::new();
        set(&entry, "combo", &JsValue::from_str(&combo));
        set(&entry, "commands", &array_of_strings(&commands));
        out.push(&entry);
    }
    out
}

/// Size policy for the shell's status bar.
#[wasm_bindgen]
pub fn size_report(bytes: f64, lines: usize) -> js_sys::Array {
    let bytes = if bytes.is_finite() && bytes > 0.0 {
        bytes as usize
    } else {
        0
    };
    let class = match classify_size(bytes) {
        wintercave_core::SizeClass::Ok => "ok",
        wintercave_core::SizeClass::Warn => "warn",
        wintercave_core::SizeClass::Refuse => "refuse",
    };
    let out = js_sys::Array::new();
    out.push(&JsValue::from_str(class));
    out.push(&JsValue::from_str(&format_bytes(bytes)));
    out.push(&JsValue::from_bool(should_highlight(bytes, lines)));
    out
}

/// `[{ id, title, category, keys }]` for palette rendering.
#[wasm_bindgen]
pub fn command_labels(
    ids: Vec<String>,
    titles: Vec<String>,
    categories: Vec<String>,
) -> js_sys::Array {
    let out = js_sys::Array::new();
    for index in 0..ids.len().min(titles.len()).min(categories.len()) {
        let entry = CommandMeta::new(&ids[index], &titles[index], &categories[index]);
        let object = js_sys::Object::new();
        set(&object, "id", &JsValue::from_str(&entry.id));
        set(&object, "label", &JsValue::from_str(&entry.label()));
        out.push(&object);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_codes_round_trip_through_names() {
        for (code, name) in TOKEN_NAMES.iter().enumerate() {
            assert_eq!(token_kind_name(code as u32), *name);
        }
        assert_eq!(token_kind_name(99), "");
    }

    #[test]
    fn token_code_matches_the_published_order() {
        assert_eq!(token_code(TokenType::Keyword), 0);
        assert_eq!(token_code(TokenType::Str), 1);
        assert_eq!(token_code(TokenType::Meta), 16);
        assert_eq!(TOKEN_NAMES.len(), 17);
    }
}
