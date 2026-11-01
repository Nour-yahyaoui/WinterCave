//! Word completion.
//!
//! Deliberately local and explainable: the candidates are the open language's
//! keywords and constants plus the identifiers already in the buffer. There is
//! no language server, no model and no network call, which keeps the editor's
//! promise — the text never leaves the machine to get a suggestion.
//!
//! Everything here is byte offsets, like the rest of the engine. The DOM counts
//! UTF-16 code units, so [`utf16_to_byte`] and [`byte_to_utf16`] sit at the edge.

use std::collections::BTreeMap;

use crate::fuzzy::fuzzy_match;
use crate::language::LanguageDef;

/// What a suggestion is, so the page can label it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionKind {
    Keyword,
    Constant,
    Word,
}

impl CompletionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CompletionKind::Keyword => "keyword",
            CompletionKind::Constant => "constant",
            CompletionKind::Word => "word",
        }
    }

    fn order(self) -> u8 {
        match self {
            CompletionKind::Keyword => 0,
            CompletionKind::Constant => 1,
            CompletionKind::Word => 2,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion {
    pub label: String,
    pub kind: CompletionKind,
}

/// A prefix longer than this is not an identifier being typed.
pub const MAX_PREFIX: usize = 64;
/// Upper bound on suggestions, whatever the caller asks for.
pub const MAX_SUGGESTIONS: usize = 64;

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

/// Start byte of the identifier that ends at `caret`, and the text between.
pub fn word_at(text: &str, caret: usize) -> (usize, &str) {
    let mut caret = caret.min(text.len());
    while caret > 0 && !text.is_char_boundary(caret) {
        caret -= 1;
    }

    let mut start = caret;
    for (index, ch) in text[..caret].char_indices().rev() {
        if is_word_char(ch) {
            start = index;
        } else {
            break;
        }
    }
    (start, &text[start..caret])
}

/// Suggestions for the word being typed at `caret` (a byte offset).
///
/// Returns the byte offset the accepted suggestion must replace from.
pub fn complete(
    text: &str,
    caret: usize,
    language: &LanguageDef,
    limit: usize,
) -> (usize, Vec<Completion>) {
    let (start, prefix) = word_at(text, caret);
    let limit = limit.clamp(1, MAX_SUGGESTIONS);

    let begins_with_letter = prefix
        .chars()
        .next()
        .is_some_and(|ch| ch.is_alphabetic() || ch == '_');
    if prefix.is_empty() || prefix.len() > MAX_PREFIX || !begins_with_letter {
        return (start, Vec::new());
    }

    // A map keeps the list unique and its order deterministic: language words
    // win over an identical buffer identifier.
    let mut candidates: BTreeMap<String, CompletionKind> = BTreeMap::new();
    for keyword in language.keywords {
        candidates.insert((*keyword).to_string(), CompletionKind::Keyword);
    }
    for constant in language.constants {
        candidates
            .entry((*constant).to_string())
            .or_insert(CompletionKind::Constant);
    }
    for word in text.split(|ch: char| !is_word_char(ch)) {
        let length = word.chars().count();
        if length < 2 || length > MAX_PREFIX {
            continue;
        }
        if word.starts_with(|ch: char| ch.is_numeric()) {
            continue;
        }
        candidates
            .entry(word.to_string())
            .or_insert(CompletionKind::Word);
    }

    let lowered = prefix.to_lowercase();
    // (bucket, -score, length, kind order, lowercase, label, kind)
    let mut scored: Vec<(u8, i64, usize, u8, String, String, CompletionKind)> = Vec::new();
    for (label, kind) in candidates {
        if label == prefix {
            // Typing the whole word again would change nothing.
            continue;
        }
        let (bucket, score) = if label.starts_with(prefix) {
            (0_u8, 0_i64)
        } else if label.to_lowercase().starts_with(lowered.as_str()) {
            (1_u8, 0_i64)
        } else {
            match fuzzy_match(prefix, &label) {
                Some(found) => (2_u8, found.score),
                None => continue,
            }
        };
        scored.push((
            bucket,
            -score,
            label.chars().count(),
            kind.order(),
            label.to_lowercase(),
            label,
            kind,
        ));
    }

    scored.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
            .then(left.3.cmp(&right.3))
            .then(left.4.cmp(&right.4))
            .then(left.5.cmp(&right.5))
    });

    let items = scored
        .into_iter()
        .take(limit)
        .map(|(_, _, _, _, _, label, kind)| Completion { label, kind })
        .collect();

    (start, items)
}

/// Byte offset for a UTF-16 code-unit offset — what `selectionStart` reports.
pub fn utf16_to_byte(text: &str, offset: usize) -> usize {
    let mut units = 0_usize;
    for (index, ch) in text.char_indices() {
        if units >= offset {
            return index;
        }
        units += ch.len_utf16();
    }
    text.len()
}

/// UTF-16 code-unit offset for a byte offset — what the page needs back.
pub fn byte_to_utf16(text: &str, offset: usize) -> usize {
    let mut byte = offset.min(text.len());
    while byte > 0 && !text.is_char_boundary(byte) {
        byte -= 1;
    }
    text[..byte].chars().map(char::len_utf16).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::language::get_language;

    fn rust() -> &'static LanguageDef {
        get_language("rust")
    }

    #[test]
    fn finds_the_word_under_the_caret() {
        let text = "let value = valu";
        let (start, prefix) = word_at(text, text.len());
        assert_eq!(prefix, "valu");
        assert_eq!(start, text.len() - 4);

        // A caret after a space sees no word at all.
        let (start, prefix) = word_at("alpha beta ", 11);
        assert_eq!(prefix, "");
        assert_eq!(start, 11);
    }

    #[test]
    fn completes_a_keyword_from_the_language() {
        let language = rust();
        let keyword = language
            .keywords
            .iter()
            .copied()
            .find(|word| word.len() > 3 && word.is_ascii())
            .expect("a keyword to type");
        let text = keyword[..3].to_string();
        let (from, items) = complete(&text, text.len(), language, MAX_SUGGESTIONS);
        assert_eq!(from, 0);
        assert!(
            items.iter().any(|item| item.label == keyword),
            "expected {keyword} in {items:?}"
        );
        assert_eq!(
            items
                .iter()
                .find(|item| item.label == keyword)
                .map(|item| item.kind),
            Some(CompletionKind::Keyword)
        );
    }

    #[test]
    fn completes_an_identifier_from_the_buffer() {
        let text = "fn main() {\n    counter_total += 1;\n    cou";
        let (from, items) = complete(text, text.len(), rust(), 8);
        assert_eq!(from, text.len() - 3);
        assert_eq!(items[0].label, "counter_total");
        assert_eq!(items[0].kind, CompletionKind::Word);
    }

    #[test]
    fn language_words_beat_identical_buffer_words() {
        let text = "match thing; ma";
        let (_, items) = complete(text, text.len(), rust(), 8);
        let entry = items.iter().find(|item| item.label == "match").expect("match");
        assert_eq!(entry.kind, CompletionKind::Keyword);
        assert_eq!(
            items.iter().filter(|item| item.label == "match").count(),
            1,
            "duplicates are dropped"
        );
    }

    #[test]
    fn ignores_numbers_and_one_letter_words() {
        let text = "12345 a alpha beta be";
        let (_, items) = complete(text, text.len(), rust(), 24);
        assert!(items.iter().any(|item| item.label == "beta"), "{items:?}");
        assert!(items.iter().all(|item| item.label != "12345"));
        assert!(items.iter().all(|item| item.label != "alpha"));
        assert!(items.iter().all(|item| item.label != "a"));
        // The word being typed is never suggested back to the typist.
        assert!(items.iter().all(|item| item.label != "be"));
    }

    #[test]
    fn returns_nothing_for_an_empty_or_numeric_prefix() {
        assert!(complete("", 0, rust(), 8).1.is_empty());
        assert!(complete("x = 42", 6, rust(), 8).1.is_empty());
    }

    #[test]
    fn respects_the_limit() {
        let text = "alpha albert alps album also";
        let (_, items) = complete(text, text.len(), rust(), 2);
        assert!(items.len() <= 2);
    }

    #[test]
    fn falls_back_to_a_subsequence_match() {
        // "ct" is not a prefix of "counter_total" but is a subsequence.
        let text = "counter_total ct";
        let (_, items) = complete(text, text.len(), rust(), 8);
        assert!(items.iter().any(|item| item.label == "counter_total"));
    }

    #[test]
    fn converts_between_utf16_and_utf8_offsets() {
        let text = "a🌍b";
        assert_eq!(utf16_to_byte(text, 0), 0);
        assert_eq!(utf16_to_byte(text, 1), 1);
        // Between the two halves of the surrogate pair: snap to its start.
        assert_eq!(utf16_to_byte(text, 2), 1);
        assert_eq!(utf16_to_byte(text, 3), 5);
        assert_eq!(utf16_to_byte(text, 99), text.len());

        assert_eq!(byte_to_utf16(text, 1), 1);
        assert_eq!(byte_to_utf16(text, 5), 3);
        assert_eq!(byte_to_utf16(text, 2), 1);
        assert_eq!(byte_to_utf16(text, 99), 4);
    }
}
