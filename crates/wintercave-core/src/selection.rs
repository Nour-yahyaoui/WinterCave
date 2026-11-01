/// A caret with an anchor: `anchor == head` means collapsed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selection {
    pub anchor: usize,
    pub head: usize,
}

impl Selection {
    pub fn caret(offset: usize) -> Self {
        Self {
            anchor: offset,
            head: offset,
        }
    }

    pub fn is_collapsed(&self) -> bool {
        self.anchor == self.head
    }

    pub fn start(&self) -> usize {
        self.anchor.min(self.head)
    }

    pub fn end(&self) -> usize {
        self.anchor.max(self.head)
    }

    pub fn length(&self) -> usize {
        self.end() - self.start()
    }

    pub fn clamped(&self, len: usize) -> Self {
        Self {
            anchor: self.anchor.min(len),
            head: self.head.min(len),
        }
    }
}

/// Order by position; the last element is the primary caret by convention.
pub fn sort_selections(selections: &[Selection]) -> Vec<Selection> {
    let mut sorted = selections.to_vec();
    sorted.sort_by(|a, b| a.start().cmp(&b.start()).then(a.end().cmp(&b.end())));
    sorted
}

pub fn dedupe_selections(selections: &[Selection]) -> Vec<Selection> {
    let mut result: Vec<Selection> = Vec::new();
    for selection in sort_selections(selections) {
        if !result.contains(&selection) {
            result.push(selection);
        }
    }
    if result.is_empty() {
        result.push(Selection::caret(0));
    }
    result
}

/// Merge overlapping regions so multi-cursor edits never double-apply.
pub fn merge_selections(selections: &[Selection]) -> Vec<Selection> {
    let sorted = dedupe_selections(selections);
    let mut merged: Vec<Selection> = Vec::new();
    for selection in sorted {
        match merged.last_mut() {
            Some(previous)
                if selection.start() < previous.end()
                    || (selection.start() == previous.start()
                        && selection.end() == previous.end()
                        && !selection.is_collapsed()) =>
            {
                let start = previous.start();
                let end = previous.end().max(selection.end());
                previous.anchor = start;
                previous.head = end;
            }
            _ => merged.push(selection),
        }
    }
    if merged.is_empty() {
        merged.push(Selection::caret(0));
    }
    merged
}

pub fn primary_selection(selections: &[Selection]) -> Selection {
    selections
        .last()
        .copied()
        .unwrap_or_else(|| Selection::caret(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caret_helpers() {
        let caret = Selection::caret(4);
        assert!(caret.is_collapsed());
        assert_eq!(caret.length(), 0);
        assert_eq!(Selection { anchor: 5, head: 2 }.start(), 2);
        assert_eq!(Selection { anchor: 5, head: 2 }.end(), 5);
        assert_eq!(Selection { anchor: 5, head: 2 }.length(), 3);
    }

    #[test]
    fn clamps_to_document_length() {
        let selection = Selection {
            anchor: 99,
            head: 4,
        };
        assert_eq!(selection.clamped(10), Selection { anchor: 10, head: 4 });
    }

    #[test]
    fn sorts_by_position() {
        let sorted = sort_selections(&[Selection::caret(9), Selection::caret(1)]);
        assert_eq!(sorted, vec![Selection::caret(1), Selection::caret(9)]);
    }

    #[test]
    fn drops_exact_duplicates() {
        let deduped = dedupe_selections(&[
            Selection::caret(2),
            Selection::caret(2),
            Selection::caret(5),
        ]);
        assert_eq!(deduped, vec![Selection::caret(2), Selection::caret(5)]);
    }

    #[test]
    fn always_keeps_one_selection() {
        assert_eq!(dedupe_selections(&[]), vec![Selection::caret(0)]);
        assert_eq!(merge_selections(&[]), vec![Selection::caret(0)]);
    }

    #[test]
    fn merges_overlapping_selections() {
        let merged = merge_selections(&[
            Selection { anchor: 2, head: 6 },
            Selection { anchor: 4, head: 9 },
        ]);
        assert_eq!(merged, vec![Selection { anchor: 2, head: 9 }]);
    }

    #[test]
    fn keeps_adjacent_carets_separate() {
        let merged = merge_selections(&[Selection::caret(2), Selection::caret(3)]);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn primary_is_the_last_selection() {
        let selections = [Selection::caret(1), Selection::caret(7)];
        assert_eq!(primary_selection(&selections), Selection::caret(7));
    }
}
