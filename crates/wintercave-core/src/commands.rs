//! Palette metadata. The executable half of a command lives in the shell
//! (it needs DOM access); ranking and filtering live here so both the web shell
//! and any future native front end show the same palette order.

use crate::fuzzy::{fuzzy_filter, RankedMatch};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandMeta {
    pub id: String,
    pub title: String,
    pub category: String,
    /// Combos shown in the palette and menus (already normalised).
    pub keys: Vec<String>,
    /// Hidden commands still run; they just do not clutter the palette.
    pub hidden: bool,
}

impl CommandMeta {
    pub fn new(id: &str, title: &str, category: &str) -> Self {
        Self {
            id: id.to_string(),
            title: title.to_string(),
            category: category.to_string(),
            keys: Vec::new(),
            hidden: false,
        }
    }

    pub fn with_keys(mut self, keys: &[&str]) -> Self {
        self.keys = keys.iter().map(|key| key.to_string()).collect();
        self
    }

    pub fn hidden(mut self) -> Self {
        self.hidden = true;
        self
    }

    pub fn label(&self) -> String {
        format!("{}: {}", self.category, self.title)
    }
}

/// Indices of palette entries: visible, ordered by category then title.
pub fn palette_entries(commands: &[CommandMeta]) -> Vec<usize> {
    let mut entries: Vec<usize> = commands
        .iter()
        .enumerate()
        .filter(|(_, command)| !command.hidden)
        .map(|(index, _)| index)
        .collect();
    entries.sort_by(|a, b| {
        commands[*a]
            .category
            .cmp(&commands[*b].category)
            .then(commands[*a].title.cmp(&commands[*b].title))
    });
    entries
}

pub fn search(commands: &[CommandMeta], query: &str, limit: usize) -> Vec<RankedMatch> {
    let entries = palette_entries(commands);
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return entries
            .into_iter()
            .take(limit)
            .map(|index| RankedMatch {
                index,
                score: 0,
                positions: Vec::new(),
            })
            .collect();
    }
    let candidates: Vec<usize> = entries;
    fuzzy_filter(&candidates, trimmed, |index| commands[*index].label(), limit)
        .into_iter()
        .map(|ranked| RankedMatch {
            index: candidates[ranked.index],
            score: ranked.score,
            positions: ranked.positions,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<CommandMeta> {
        vec![
            CommandMeta::new("file.save", "Save", "File").with_keys(&["Mod+s"]),
            CommandMeta::new("file.saveAs", "Save As…", "File"),
            CommandMeta::new("edit.toggleComment", "Toggle Line Comment", "Edit"),
            CommandMeta::new("internal.secret", "Secret", "Internal").hidden(),
        ]
    }

    #[test]
    fn hides_hidden_commands_and_sorts_entries() {
        let commands = sample();
        let entries = palette_entries(&commands);
        let ids: Vec<&str> = entries
            .iter()
            .map(|index| commands[*index].id.as_str())
            .collect();
        assert_eq!(ids, vec!["edit.toggleComment", "file.save", "file.saveAs"]);
    }

    #[test]
    fn returns_everything_for_an_empty_query() {
        let commands = sample();
        assert_eq!(search(&commands, "", 50).len(), 3);
        assert_eq!(search(&commands, "   ", 2).len(), 2);
    }

    #[test]
    fn ranks_by_title_and_category() {
        let commands = sample();
        let ranked = search(&commands, "save", 10);
        assert_eq!(ranked.len(), 2);
        assert_eq!(commands[ranked[0].index].id, "file.save");
    }

    #[test]
    fn never_surfaces_hidden_commands() {
        let commands = sample();
        assert!(search(&commands, "secret", 10).is_empty());
    }

    #[test]
    fn matches_on_category() {
        let commands = sample();
        let ranked = search(&commands, "edit", 10);
        assert_eq!(commands[ranked[0].index].id, "edit.toggleComment");
    }

    #[test]
    fn labels_read_category_colon_title() {
        assert_eq!(
            CommandMeta::new("a", "Save", "File").label(),
            "File: Save"
        );
    }
}
