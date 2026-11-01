use crate::document::TextDocument;
use crate::edits::{apply_applied_sequential, invert_edits, AppliedEdit};
use crate::selection::Selection;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditKind {
    Insert,
    Delete,
    Replace,
    Paste,
    Indent,
    Structure,
}

#[derive(Clone, Debug)]
pub struct HistoryRecord {
    pub edits: Vec<AppliedEdit>,
    pub sel_before: Vec<Selection>,
    pub sel_after: Vec<Selection>,
    pub kind: EditKind,
    pub at: u64,
}

fn is_single_caret(selections: &[Selection]) -> bool {
    selections.len() == 1 && selections[0].is_collapsed()
}

/// Undo/redo over edit records (not whole-document snapshots), so a 10 MB file
/// does not allocate 10 GB of history. Sequential edits invert in reverse order.
pub struct History {
    undo_stack: Vec<HistoryRecord>,
    redo_stack: Vec<HistoryRecord>,
    limit: usize,
    group_window: u64,
}

impl Default for History {
    fn default() -> Self {
        Self::new(1000, 500)
    }
}

impl History {
    pub fn new(limit: usize, group_window: u64) -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            limit: limit.max(1),
            group_window,
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    pub fn undo_depth(&self) -> usize {
        self.undo_stack.len()
    }

    pub fn redo_depth(&self) -> usize {
        self.redo_stack.len()
    }

    pub fn clear(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
    }

    pub fn push(&mut self, record: HistoryRecord) {
        if record.edits.is_empty() {
            return;
        }
        self.redo_stack.clear();

        if let Some(top) = self.undo_stack.last_mut() {
            if self.should_group(top, &record) {
                top.edits.extend(record.edits);
                top.sel_after = record.sel_after;
                top.at = record.at;
                return;
            }
        }

        self.undo_stack.push(record);
        if self.undo_stack.len() > self.limit {
            self.undo_stack.remove(0);
        }
    }

    fn should_group(&self, top: &HistoryRecord, record: &HistoryRecord) -> bool {
        if top.kind != record.kind {
            return false;
        }
        if !matches!(top.kind, EditKind::Insert | EditKind::Delete) {
            return false;
        }
        if record.at.saturating_sub(top.at) > self.group_window {
            return false;
        }
        if !is_single_caret(&top.sel_after) || !is_single_caret(&record.sel_before) {
            return false;
        }
        top.sel_after[0].head == record.sel_before[0].head
    }

    pub fn undo(&mut self, doc: &TextDocument) -> Option<(TextDocument, Vec<Selection>)> {
        let record = self.undo_stack.pop()?;
        let reverted = apply_applied_sequential(doc, &invert_edits(&record.edits));
        let selections = record
            .sel_before
            .iter()
            .map(|selection| selection.clamped(reverted.len()))
            .collect();
        self.redo_stack.push(record);
        Some((reverted, selections))
    }

    pub fn redo(&mut self, doc: &TextDocument) -> Option<(TextDocument, Vec<Selection>)> {
        let record = self.redo_stack.pop()?;
        let reapplied = apply_applied_sequential(doc, &record.edits);
        let selections = record
            .sel_after
            .iter()
            .map(|selection| selection.clamped(reapplied.len()))
            .collect();
        self.undo_stack.push(record);
        Some((reapplied, selections))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edits::create_edits;
    use crate::edits::TextEdit;

    fn typed(
        history: &mut History,
        doc: &TextDocument,
        offset: usize,
        text: &str,
        caret_before: usize,
        caret_after: usize,
        at: u64,
    ) -> TextDocument {
        let edits = create_edits(doc, &[TextEdit::insert(offset, text)]);
        let next = doc.insert(offset, text);
        history.push(HistoryRecord {
            edits,
            sel_before: vec![Selection::caret(caret_before)],
            sel_after: vec![Selection::caret(caret_after)],
            kind: EditKind::Insert,
            at,
        });
        next
    }

    #[test]
    fn undoes_and_redoes_one_edit() {
        let mut history = History::new(1000, 500);
        let start = TextDocument::new("abc");
        let after = typed(&mut history, &start, 1, "X", 1, 2, 0);

        let (undone, selections) = history.undo(&after).expect("undo");
        assert_eq!(undone.text(), "abc");
        assert_eq!(selections, vec![Selection::caret(1)]);

        let (redone, selections) = history.redo(&undone).expect("redo");
        assert_eq!(redone.text(), "aXbc");
        assert_eq!(selections, vec![Selection::caret(2)]);
    }

    #[test]
    fn groups_a_typing_burst() {
        let mut history = History::new(1000, 500);
        let mut doc = TextDocument::empty();
        let mut caret = 0usize;
        let mut clock = 0u64;
        for ch in "hello".chars() {
            clock += 100;
            doc = typed(
                &mut history,
                &doc,
                caret,
                &ch.to_string(),
                caret,
                caret + 1,
                clock,
            );
            caret += 1;
        }
        assert_eq!(doc.text(), "hello");
        assert_eq!(history.undo_depth(), 1);
        assert_eq!(history.undo(&doc).expect("undo").0.text(), "");
    }

    #[test]
    fn starts_a_new_group_after_a_pause() {
        let mut history = History::new(1000, 500);
        let mut doc = TextDocument::empty();
        let mut caret = 0usize;
        for ch in "ab".chars() {
            doc = typed(
                &mut history,
                &doc,
                caret,
                &ch.to_string(),
                caret,
                caret + 1,
                0,
            );
            caret += 1;
        }
        doc = typed(&mut history, &doc, caret, "c", caret, caret + 1, 2000);
        assert_eq!(history.undo_depth(), 2);
        assert_eq!(history.undo(&doc).expect("undo").0.text(), "ab");
    }

    #[test]
    fn does_not_group_typing_that_jumps() {
        let mut history = History::new(1000, 5000);
        let mut doc = TextDocument::new("abcdef");
        doc = typed(&mut history, &doc, 0, "X", 0, 1, 10);
        doc = typed(&mut history, &doc, 6, "Y", 6, 7, 20);
        assert_eq!(doc.text(), "XabcdeYf");
        assert_eq!(history.undo_depth(), 2);
        assert_eq!(history.undo(&doc).expect("undo").0.text(), "Xabcdef");
    }

    #[test]
    fn clears_redo_when_new_typing_arrives() {
        let mut history = History::new(1000, 500);
        let doc = TextDocument::new("abc");
        let after = typed(&mut history, &doc, 0, "X", 0, 1, 0);
        let (undone, _) = history.undo(&after).expect("undo");
        assert!(history.can_redo());
        typed(&mut history, &undone, 3, "Z", 3, 4, 5000);
        assert!(!history.can_redo());
    }

    #[test]
    fn enforces_the_undo_limit() {
        let mut history = History::new(3, 0);
        let mut doc = TextDocument::empty();
        for index in 0..5u64 {
            let caret = doc.len();
            doc = typed(
                &mut history,
                &doc,
                caret,
                &index.to_string(),
                caret,
                caret + 1,
                index * 1000,
            );
        }
        assert_eq!(history.undo_depth(), 3);
        let mut current = doc;
        for _ in 0..3 {
            current = history.undo(&current).expect("undo").0;
        }
        assert!(history.undo(&current).is_none());
    }

    #[test]
    fn returns_none_when_there_is_nothing_to_undo() {
        let mut history = History::new(10, 500);
        let doc = TextDocument::empty();
        assert!(history.undo(&doc).is_none());
        assert!(history.redo(&doc).is_none());
    }

    #[test]
    fn clamps_restored_selections() {
        let mut history = History::new(1000, 500);
        let start = TextDocument::new("abc");
        let edits = create_edits(&start, &[TextEdit::delete(1, 3)]);
        history.push(HistoryRecord {
            edits,
            sel_before: vec![Selection::caret(3)],
            sel_after: vec![Selection::caret(1)],
            kind: EditKind::Delete,
            at: 0,
        });
        let (undone, selections) = history.undo(&start.remove(1, 3)).expect("undo");
        assert_eq!(undone.text(), "abc");
        assert_eq!(selections, vec![Selection::caret(3)]);
    }
}
