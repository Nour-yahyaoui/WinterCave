use crate::text::{
    clamp, detect_line_ending, floor_char_boundary, normalize_newlines, restore_line_ending,
    LineEnding,
};

fn compute_line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (index, ch) in text.char_indices() {
        if ch == '\n' {
            starts.push(index + 1);
        }
    }
    starts
}

/// Immutable text document: every mutation returns a new document.
///
/// That keeps undo, recovery snapshots and tests honest — a document reference
/// never changes under you. Newlines are stored as LF; `eol` remembers what the
/// file used so `get_text` can put it back on save.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextDocument {
    text: String,
    eol: LineEnding,
    starts: Vec<usize>,
}

impl TextDocument {
    pub fn new(text: &str) -> Self {
        Self::with_eol(text, detect_line_ending(text))
    }

    pub fn with_eol(text: &str, eol: LineEnding) -> Self {
        let normalized = normalize_newlines(text);
        let starts = compute_line_starts(&normalized);
        Self {
            text: normalized,
            eol,
            starts,
        }
    }

    pub fn empty() -> Self {
        Self::with_eol("", LineEnding::Lf)
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn eol(&self) -> LineEnding {
        self.eol
    }

    pub fn len(&self) -> usize {
        self.text.len()
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub fn line_count(&self) -> usize {
        self.starts.len()
    }

    pub fn line_starts(&self) -> &[usize] {
        &self.starts
    }

    pub fn line_end(&self, line: usize) -> usize {
        if line + 1 < self.starts.len() {
            self.starts[line + 1] - 1
        } else {
            self.text.len()
        }
    }

    pub fn line_text(&self, line: usize) -> &str {
        if line >= self.starts.len() {
            return "";
        }
        let start = floor_char_boundary(&self.text, self.starts[line]);
        let end = floor_char_boundary(&self.text, self.line_end(line));
        if end < start {
            return "";
        }
        &self.text[start..end]
    }

    pub fn line_range(&self, line: usize) -> (usize, usize) {
        let clamped = clamp(line, 0, self.starts.len().saturating_sub(1));
        (self.starts[clamped], self.line_end(clamped))
    }

    pub fn offset_at(&self, line: usize, column: usize) -> usize {
        let clamped = clamp(line, 0, self.starts.len().saturating_sub(1));
        let start = self.starts[clamped];
        let end = self.line_end(clamped);
        clamp(start + column, start, end)
    }

    /// Line index containing `offset` (binary search).
    pub fn line_at(&self, offset: usize) -> usize {
        let at = clamp(offset, 0, self.text.len());
        let mut low = 0usize;
        let mut high = self.starts.len().saturating_sub(1);
        while low < high {
            let mid = (low + high + 1) / 2;
            if self.starts[mid] <= at {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        low
    }

    pub fn position_at(&self, offset: usize) -> (usize, usize) {
        let at = clamp(offset, 0, self.text.len());
        let line = self.line_at(at);
        (line, at.saturating_sub(self.starts[line]))
    }

    pub fn with_text(&self, text: &str) -> Self {
        Self::with_eol(text, self.eol)
    }

    pub fn insert(&self, offset: usize, snippet: &str) -> Self {
        let at = floor_char_boundary(&self.text, clamp(offset, 0, self.text.len()));
        let added = normalize_newlines(snippet);
        let mut next = String::with_capacity(self.text.len() + added.len());
        next.push_str(&self.text[..at]);
        next.push_str(&added);
        next.push_str(&self.text[at..]);
        self.with_text(&next)
    }

    pub fn remove(&self, from: usize, to: usize) -> Self {
        self.replace_range(from, to, "")
    }

    pub fn replace_range(&self, from: usize, to: usize, replacement: &str) -> Self {
        let start = floor_char_boundary(&self.text, clamp(from.min(to), 0, self.text.len()));
        let end = floor_char_boundary(&self.text, clamp(from.max(to), 0, self.text.len()));
        let added = normalize_newlines(replacement);
        let mut next = String::with_capacity(self.text.len() + added.len());
        next.push_str(&self.text[..start]);
        next.push_str(&added);
        next.push_str(&self.text[end..]);
        self.with_text(&next)
    }

    /// Full text as it should be written to disk (original line endings).
    pub fn get_text(&self) -> String {
        restore_line_ending(&self.text, self.eol)
    }

    pub fn lines(&self) -> Vec<&str> {
        (0..self.starts.len()).map(|line| self.line_text(line)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_lines_and_ranges() {
        let doc = TextDocument::new("alpha\nbeta\ngamma");
        assert_eq!(doc.line_count(), 3);
        assert_eq!(doc.line_starts(), &[0, 6, 11]);
        assert_eq!(doc.lines(), vec!["alpha", "beta", "gamma"]);
        assert_eq!(doc.line_range(1), (6, 10));
        assert_eq!(doc.line_text(2), "gamma");
    }

    #[test]
    fn trailing_newline_is_an_empty_final_line() {
        let doc = TextDocument::new("a\n");
        assert_eq!(doc.line_count(), 2);
        assert_eq!(doc.lines(), vec!["a", ""]);
        assert_eq!(doc.line_range(0), (0, 1));
    }

    #[test]
    fn empty_document_is_one_empty_line() {
        let doc = TextDocument::empty();
        assert_eq!(doc.line_count(), 1);
        assert_eq!(doc.lines(), vec![""]);
        assert_eq!(doc.position_at(0), (0, 0));
        assert!(doc.is_empty());
    }

    #[test]
    fn maps_offsets_to_positions_and_back() {
        let doc = TextDocument::new("one\ntwo\nthree");
        for offset in 0..=doc.len() {
            let (line, column) = doc.position_at(offset);
            assert_eq!(doc.offset_at(line, column), offset);
        }
        assert_eq!(doc.position_at(4), (1, 0));
        assert_eq!(doc.position_at(13), (2, 5));
        assert_eq!(doc.line_at(7), 1);
        assert_eq!(doc.line_at(8), 2);
    }

    #[test]
    fn clamps_out_of_range_positions() {
        let doc = TextDocument::new("abc\ndef");
        assert_eq!(doc.offset_at(0, 99), 3);
        assert_eq!(doc.offset_at(99, 0), 4);
        assert_eq!(doc.offset_at(0, 0), 0);
        assert_eq!(doc.line_text(99), "");
        assert_eq!(doc.line_range(99), (4, 7));
    }

    #[test]
    fn is_immutable_across_edits() {
        let original = TextDocument::new("hello");
        let inserted = original.insert(0, "> ");
        assert_eq!(original.text(), "hello");
        assert_eq!(inserted.text(), "> hello");
        assert_eq!(inserted.remove(0, 2).text(), "hello");
        assert_eq!(inserted.replace_range(2, 7, "bye").text(), "> bye");
    }

    #[test]
    fn normalises_crlf_in_and_restores_it_out() {
        let doc = TextDocument::new("a\r\nb\r\nc");
        assert_eq!(doc.text(), "a\nb\nc");
        assert_eq!(doc.eol(), LineEnding::Crlf);
        assert_eq!(doc.get_text(), "a\r\nb\r\nc");
        assert_eq!(doc.insert(0, "x\ny").get_text(), "x\r\nya\r\nb\r\nc");
    }

    #[test]
    fn edits_preserve_the_newline_convention() {
        let doc = TextDocument::new("# notes");
        let edited = doc.replace_range(doc.len(), doc.len(), "\nsecond line");
        assert_eq!(edited.get_text(), "# notes\nsecond line");
        assert_eq!(edited.eol(), LineEnding::Lf);
    }

    #[test]
    fn swallows_inverted_ranges() {
        let doc = TextDocument::new("abcdef");
        assert_eq!(doc.remove(4, 2).text(), "abef");
        assert_eq!(doc.replace_range(4, 2, "X").text(), "abXef");
    }

    #[test]
    fn slicing_never_lands_inside_a_multibyte_char() {
        let doc = TextDocument::new("aé😀b");
        assert_eq!(doc.len(), 8);
        for offset in 0..=doc.len() {
            let removed = doc.remove(0, offset.min(doc.len()));
            assert!(removed.text().is_char_boundary(0));
        }
        assert_eq!(doc.remove(1, 2).text(), "a😀b");
    }

    #[test]
    fn handles_multiline_and_unicode_positions() {
        let doc = TextDocument::new("héllo\n😀");
        let (line, column) = doc.position_at(4);
        assert_eq!((line, column), (0, 3));
        assert_eq!(doc.offset_at(0, 3), 4);
        assert_eq!(doc.line_text(1), "😀");
    }
}
