use crate::document::TextDocument;

/// A replacement of `[from, to)` with `text`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextEdit {
    pub from: usize,
    pub to: usize,
    pub text: String,
}

impl TextEdit {
    pub fn insert(at: usize, text: &str) -> Self {
        Self {
            from: at,
            to: at,
            text: text.to_string(),
        }
    }

    pub fn delete(from: usize, to: usize) -> Self {
        Self {
            from,
            to,
            text: String::new(),
        }
    }

    pub fn replace(from: usize, to: usize, text: &str) -> Self {
        Self {
            from,
            to,
            text: text.to_string(),
        }
    }
}

/// An edit that remembers what it destroyed — undo needs the removed text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppliedEdit {
    pub from: usize,
    pub to: usize,
    pub text: String,
    pub removed: String,
}

pub fn create_edits(doc: &TextDocument, edits: &[TextEdit]) -> Vec<AppliedEdit> {
    let text = doc.text();
    edits
        .iter()
        .map(|edit| {
            let from = edit.from.min(text.len());
            let to = edit.to.min(text.len()).max(from);
            AppliedEdit {
                from,
                to,
                text: edit.text.clone(),
                removed: text[from..to].to_string(),
            }
        })
        .collect()
}

/// Reverse a list of edits so it can be replayed to reach the previous state.
pub fn invert_edits(edits: &[AppliedEdit]) -> Vec<AppliedEdit> {
    edits
        .iter()
        .rev()
        .map(|edit| AppliedEdit {
            from: edit.from,
            to: edit.from + edit.text.len(),
            text: edit.removed.clone(),
            removed: edit.text.clone(),
        })
        .collect()
}

/// Apply edits one after another, each addressing the result of the previous.
pub fn apply_sequential(doc: &TextDocument, edits: &[TextEdit]) -> TextDocument {
    let mut current = doc.clone();
    for edit in edits {
        current = current.replace_range(edit.from, edit.to, &edit.text);
    }
    current
}

pub fn apply_applied_sequential(doc: &TextDocument, edits: &[AppliedEdit]) -> TextDocument {
    let plain: Vec<TextEdit> = edits
        .iter()
        .map(|edit| TextEdit::replace(edit.from, edit.to, &edit.text))
        .collect();
    apply_sequential(doc, &plain)
}

/// Collapse overlapping edits produced by independent cursors: two carets in
/// the same word both hitting backspace must delete once, not twice.
pub fn normalize_edits(edits: &[TextEdit]) -> Vec<TextEdit> {
    let mut sorted: Vec<TextEdit> = edits
        .iter()
        .filter(|edit| edit.from <= edit.to)
        .cloned()
        .collect();
    sorted.sort_by(|a, b| a.from.cmp(&b.from).then(a.to.cmp(&b.to)));

    let mut merged: Vec<TextEdit> = Vec::new();
    for edit in sorted {
        match merged.last_mut() {
            Some(last) => {
                let same_point_insert =
                    last.from == last.to && edit.from == edit.to && edit.from == last.from;
                let same_range =
                    last.from == edit.from && last.to == edit.to && last.from != last.to;
                if same_point_insert || same_range || edit.from < last.to {
                    last.to = last.to.max(edit.to);
                    last.text.push_str(&edit.text);
                    continue;
                }
                merged.push(edit);
            }
            None => merged.push(edit),
        }
    }
    merged
}

/// Apply a set of simultaneous edits (multi-cursor), right to left.
pub fn apply_concurrent(doc: &TextDocument, edits: &[TextEdit]) -> TextDocument {
    apply_concurrent_with_carets(doc, edits).0
}

struct Group {
    from: usize,
    to: usize,
    text: String,
    owners: Vec<usize>,
}

/// Apply simultaneous edits and report where each caret lands.
pub fn apply_concurrent_with_carets(
    doc: &TextDocument,
    edits: &[TextEdit],
) -> (TextDocument, Vec<usize>) {
    let mut indexed: Vec<(usize, &TextEdit)> = edits
        .iter()
        .enumerate()
        .filter(|(_, edit)| edit.from <= edit.to)
        .collect();
    indexed.sort_by(|(a_index, a), (b_index, b)| {
        a.from
            .cmp(&b.from)
            .then(a.to.cmp(&b.to))
            .then(a_index.cmp(b_index))
    });

    let mut groups: Vec<Group> = Vec::new();
    for (index, edit) in indexed {
        match groups.last_mut() {
            Some(last) => {
                let same_point_insert =
                    last.from == last.to && edit.from == edit.to && edit.from == last.from;
                let same_range =
                    last.from == edit.from && last.to == edit.to && last.from != last.to;
                if same_point_insert || same_range || edit.from < last.to {
                    last.to = last.to.max(edit.to);
                    last.text.push_str(&edit.text);
                    last.owners.push(index);
                    continue;
                }
                groups.push(Group {
                    from: edit.from,
                    to: edit.to,
                    text: edit.text.clone(),
                    owners: vec![index],
                });
            }
            None => groups.push(Group {
                from: edit.from,
                to: edit.to,
                text: edit.text.clone(),
                owners: vec![index],
            }),
        }
    }

    let mut text = doc.text().to_string();
    for group in groups.iter().rev() {
        let end = group.to.min(text.len());
        let start = group.from.min(end);
        text.replace_range(start..end, &group.text);
    }

    // Walk left to right carrying the running offset change: a caret lands after
    // its own insertion and after every edit to its left.
    let mut carets = vec![0usize; edits.len()];
    let mut shift: isize = 0;
    for group in &groups {
        let landing = (group.from as isize + shift + group.text.len() as isize).max(0) as usize;
        for owner in &group.owners {
            carets[*owner] = landing;
        }
        shift += group.text.len() as isize - (group.to as isize - group.from as isize);
    }

    (doc.with_text(&text), carets)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(text: &str) -> TextDocument {
        TextDocument::new(text)
    }

    #[test]
    fn merges_overlapping_deletes() {
        let merged = normalize_edits(&[TextEdit::delete(5, 10), TextEdit::delete(8, 12)]);
        assert_eq!(merged, vec![TextEdit::delete(5, 12)]);
    }

    #[test]
    fn joins_insertions_at_the_same_offset() {
        let merged = normalize_edits(&[TextEdit::insert(3, "a"), TextEdit::insert(3, "b")]);
        assert_eq!(merged, vec![TextEdit::insert(3, "ab")]);
    }

    #[test]
    fn keeps_disjoint_edits_separate_and_sorted() {
        let merged = normalize_edits(&[TextEdit::insert(9, "z"), TextEdit::insert(1, "y")]);
        assert_eq!(
            merged,
            vec![TextEdit::insert(1, "y"), TextEdit::insert(9, "z")]
        );
    }

    #[test]
    fn drops_inverted_edits() {
        assert!(normalize_edits(&[TextEdit::replace(8, 2, "x")]).is_empty());
    }

    #[test]
    fn applies_disjoint_edits_right_to_left() {
        let result = apply_concurrent(
            &doc("abcdef"),
            &[TextEdit::replace(1, 2, "B"), TextEdit::replace(4, 5, "E")],
        );
        assert_eq!(result.text(), "aBcdEf");
    }

    #[test]
    fn applies_an_overlapping_delete_once() {
        let result = apply_concurrent(
            &doc("abcdefghij"),
            &[TextEdit::delete(2, 5), TextEdit::delete(4, 7)],
        );
        assert_eq!(result.text(), "abhij");
    }

    #[test]
    fn lands_each_caret_after_its_own_insertion() {
        let (next, carets) = apply_concurrent_with_carets(
            &doc("abc"),
            &[TextEdit::insert(0, "x"), TextEdit::insert(2, "x")],
        );
        assert_eq!(next.text(), "xabxc");
        assert_eq!(carets, vec![1, 4]);
    }

    #[test]
    fn reports_one_caret_per_edit_when_edits_merge() {
        let (next, carets) = apply_concurrent_with_carets(
            &doc("abcdef"),
            &[TextEdit::delete(2, 4), TextEdit::delete(3, 5)],
        );
        assert_eq!(next.text(), "abf");
        assert_eq!(carets, vec![2, 2]);
    }

    #[test]
    fn handles_a_multi_cursor_wrap() {
        let (next, carets) = apply_concurrent_with_carets(
            &doc("one two one"),
            &[
                TextEdit::replace(0, 3, "ONE"),
                TextEdit::replace(8, 11, "ONE"),
            ],
        );
        assert_eq!(next.text(), "ONE two ONE");
        assert_eq!(carets, vec![3, 11]);
    }

    #[test]
    fn is_a_no_op_without_edits() {
        let (next, carets) = apply_concurrent_with_carets(&doc("abc"), &[]);
        assert_eq!(next.text(), "abc");
        assert!(carets.is_empty());
    }

    #[test]
    fn round_trips_through_inversion() {
        let source = doc("hello world");
        let edits = create_edits(&source, &[TextEdit::replace(6, 11, "there")]);
        assert_eq!(edits[0].removed, "world");
        let applied = apply_applied_sequential(&source, &edits);
        assert_eq!(applied.text(), "hello there");
        let reverted = apply_applied_sequential(&applied, &invert_edits(&edits));
        assert_eq!(reverted.text(), "hello world");
    }

    #[test]
    fn inverts_a_sequence_of_inserts_in_reverse_order() {
        let source = doc("abc");
        let edits = create_edits(
            &source,
            &[TextEdit::insert(0, "x"), TextEdit::insert(2, "y")],
        );
        let applied = apply_sequential(
            &source,
            &edits
                .iter()
                .map(|e| TextEdit::replace(e.from, e.to, &e.text))
                .collect::<Vec<_>>(),
        );
        assert_eq!(applied.text(), "xaybc");
        assert_eq!(
            apply_applied_sequential(&applied, &invert_edits(&edits)).text(),
            "abc"
        );
    }

    #[test]
    fn clamps_out_of_range_edits() {
        let source = doc("abc");
        let edits = create_edits(&source, &[TextEdit::delete(2, 99)]);
        assert_eq!(edits[0].to, 3);
        assert_eq!(
            apply_concurrent(&source, &[TextEdit::delete(2, 99)]).text(),
            "ab"
        );
    }
}
