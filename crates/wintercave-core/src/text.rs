use unicode_segmentation::UnicodeSegmentation;

/// Line endings are normalised to LF internally and restored on save so a file
/// round-trips byte-for-byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    Crlf,
}

impl LineEnding {
    pub fn as_str(self) -> &'static str {
        match self {
            LineEnding::Lf => "\n",
            LineEnding::Crlf => "\r\n",
        }
    }
}

pub fn clamp(value: usize, min: usize, max: usize) -> usize {
    if max < min {
        return min;
    }
    value.max(min).min(max)
}

pub fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    haystack.match_indices(needle).count()
}

pub fn detect_line_ending(text: &str) -> LineEnding {
    let crlf = count_occurrences(text, "\r\n");
    let lf = count_occurrences(text, "\n").saturating_sub(crlf);
    if crlf > lf {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    }
}

/// Collapses `\r\n` and lone `\r` to `\n`.
pub fn normalize_newlines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(current) = chars.next() {
        if current == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(current);
        }
    }
    out
}

pub fn restore_line_ending(text: &str, eol: LineEnding) -> String {
    match eol {
        LineEnding::Lf => text.to_string(),
        LineEnding::Crlf => text.replace('\n', "\r\n"),
    }
}

/// Rust strings are byte-indexed; every slice we take must land on a boundary.
pub fn floor_char_boundary(text: &str, offset: usize) -> usize {
    let mut at = offset.min(text.len());
    while at > 0 && !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// Offset of the grapheme boundary before `offset` — never splits an emoji or a
/// combining sequence.
pub fn previous_grapheme_boundary(text: &str, offset: usize) -> usize {
    let at = floor_char_boundary(text, offset);
    if at == 0 {
        return 0;
    }
    text[..at]
        .grapheme_indices(true)
        .last()
        .map(|(index, _)| index)
        .unwrap_or(0)
}

pub fn next_grapheme_boundary(text: &str, offset: usize) -> usize {
    let at = floor_char_boundary(text, offset);
    if at >= text.len() {
        return text.len();
    }
    match text[at..].graphemes(true).next() {
        Some(grapheme) => at + grapheme.len(),
        None => text.len(),
    }
}

pub fn grapheme_length(text: &str) -> usize {
    text.graphemes(true).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_the_dominant_ending() {
        assert_eq!(detect_line_ending("a\r\nb\r\nc"), LineEnding::Crlf);
        assert_eq!(detect_line_ending("a\nb\nc"), LineEnding::Lf);
        assert_eq!(detect_line_ending(""), LineEnding::Lf);
        assert_eq!(detect_line_ending("solo"), LineEnding::Lf);
    }

    #[test]
    fn round_trips_crlf_byte_for_byte() {
        let original = "line one\r\nline two\r\n";
        let normalized = normalize_newlines(original);
        assert_eq!(normalized, "line one\nline two\n");
        assert_eq!(restore_line_ending(&normalized, LineEnding::Crlf), original);
    }

    #[test]
    fn normalizing_twice_is_idempotent() {
        assert_eq!(normalize_newlines(&normalize_newlines("a\r\nb")), "a\nb");
        assert_eq!(restore_line_ending("a\nb", LineEnding::Lf), "a\nb");
    }

    #[test]
    fn converts_lone_carriage_returns() {
        assert_eq!(normalize_newlines("a\rb\r\nc"), "a\nb\nc");
    }

    #[test]
    fn counts_non_overlapping_occurrences() {
        assert_eq!(count_occurrences("aaaa", "aa"), 2);
        assert_eq!(count_occurrences("aaa", ""), 0);
    }

    #[test]
    fn never_splits_a_surrogate_pair_or_emoji() {
        let text = "a😀b";
        assert_eq!(grapheme_length(text), 3);
        assert_eq!(next_grapheme_boundary(text, 1), 5);
        assert_eq!(previous_grapheme_boundary(text, 5), 1);
        assert_eq!(previous_grapheme_boundary(text, 6), 5);
    }

    #[test]
    fn keeps_combining_marks_with_their_base() {
        let text = "e\u{0301}x";
        assert_eq!(grapheme_length(text), 2);
        assert_eq!(next_grapheme_boundary(text, 0), 3);
        assert_eq!(previous_grapheme_boundary(text, 3), 0);
    }

    #[test]
    fn handles_zero_width_joiner_sequences() {
        let family = "👨‍👩‍👧";
        assert_eq!(previous_grapheme_boundary(family, family.len()), 0);
        assert_eq!(next_grapheme_boundary(family, 0), family.len());
    }

    #[test]
    fn clamps_at_the_edges() {
        assert_eq!(previous_grapheme_boundary("abc", 0), 0);
        assert_eq!(next_grapheme_boundary("abc", 3), 3);
        assert_eq!(next_grapheme_boundary("abc", 99), 3);
        assert_eq!(floor_char_boundary("aé", 2), 1);
    }

    #[test]
    fn clamp_bounds_values() {
        assert_eq!(clamp(5, 0, 3), 3);
        assert_eq!(clamp(0, 2, 3), 2);
    }
}
