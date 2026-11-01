use std::collections::BTreeMap;
use std::collections::BTreeSet;

pub type Keymap = BTreeMap<String, String>;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyEvent {
    pub key: String,
    pub ctrl: bool,
    pub meta: bool,
    pub alt: bool,
    pub shift: bool,
}

impl KeyEvent {
    pub fn new(key: &str) -> Self {
        Self {
            key: key.to_string(),
            ..Self::default()
        }
    }
}

fn named_key(raw: &str) -> Option<&'static str> {
    let named = match raw.to_ascii_lowercase().as_str() {
        "esc" | "escape" => "Escape",
        "enter" | "return" => "Enter",
        "space" | "spacebar" => "Space",
        "tab" => "Tab",
        "backspace" => "Backspace",
        "del" | "delete" => "Delete",
        "ins" | "insert" => "Insert",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        "arrowup" | "up" => "ArrowUp",
        "arrowdown" | "down" => "ArrowDown",
        "arrowleft" | "left" => "ArrowLeft",
        "arrowright" | "right" => "ArrowRight",
        _ => return None,
    };
    Some(named)
}

fn canonical_key(raw: &str) -> String {
    if raw.chars().count() == 1 {
        return raw.to_lowercase();
    }
    match named_key(raw) {
        Some(named) => named.to_string(),
        None => raw.to_string(),
    }
}

fn is_modifier_key(key: &str) -> bool {
    matches!(
        key,
        "Shift" | "Control" | "Alt" | "Meta" | "CapsLock" | "AltGraph" | "OS"
    )
}

/// Canonical form so `shift+mod+p`, `Mod+Shift+P` and `Mod+Shift+p` agree.
pub fn normalize_combo(combo: &str) -> String {
    let parts: Vec<&str> = combo.split('+').filter(|part| !part.is_empty()).collect();
    let Some((key, modifiers)) = parts.split_last() else {
        return String::new();
    };

    let mut found: BTreeSet<&'static str> = BTreeSet::new();
    for part in modifiers {
        match part.to_ascii_lowercase().as_str() {
            "mod" | "cmd" | "command" => {
                found.insert("Mod");
            }
            "meta" => {
                found.insert("Meta");
            }
            "ctrl" | "control" => {
                found.insert("Ctrl");
            }
            "alt" | "option" | "opt" => {
                found.insert("Alt");
            }
            "shift" => {
                found.insert("Shift");
            }
            _ => {}
        }
    }

    let order = ["Mod", "Ctrl", "Meta", "Alt", "Shift"];
    let mut pieces: Vec<String> = order
        .iter()
        .filter(|modifier| found.contains(**modifier))
        .map(|modifier| modifier.to_string())
        .collect();
    pieces.push(canonical_key(key));
    pieces.join("+")
}

pub fn combo_from_event(event: &KeyEvent, is_mac: bool) -> String {
    if is_modifier_key(&event.key) {
        return String::new();
    }
    let mut modifiers: Vec<&str> = Vec::new();
    if is_mac {
        if event.meta {
            modifiers.push("Mod");
        }
        if event.ctrl {
            modifiers.push("Ctrl");
        }
    } else {
        if event.ctrl {
            modifiers.push("Mod");
        }
        if event.meta {
            modifiers.push("Meta");
        }
    }
    if event.alt {
        modifiers.push("Alt");
    }
    if event.shift {
        modifiers.push("Shift");
    }
    modifiers.push(&canonical_key(&event.key));
    modifiers.join("+")
}

pub fn is_mac_platform(user_agent: &str) -> bool {
    let lowered = user_agent.to_ascii_lowercase();
    ["mac", "iphone", "ipad", "ipod"]
        .iter()
        .any(|needle| lowered.contains(needle))
}

/// Defaults follow VS Code / Sublime where a convention exists.
pub const DEFAULT_BINDINGS: &[(&str, &str)] = &[
    ("Mod+n", "file.new"),
    ("Mod+o", "file.open"),
    ("Mod+s", "file.save"),
    ("Mod+Shift+s", "file.saveAs"),
    ("Mod+w", "file.close"),
    ("Mod+p", "palette.quickOpen"),
    ("Mod+Shift+p", "palette.commands"),
    ("F1", "palette.commands"),
    ("Mod+f", "find.open"),
    ("Mod+h", "find.replace"),
    ("Mod+g", "goto.line"),
    ("Mod+z", "history.undo"),
    ("Mod+Shift+z", "history.redo"),
    ("Mod+y", "history.redo"),
    ("Mod+a", "select.all"),
    ("Mod+d", "cursor.addNextOccurrence"),
    ("Mod+Alt+ArrowUp", "cursor.addAbove"),
    ("Mod+Alt+ArrowDown", "cursor.addBelow"),
    ("Mod+/", "edit.toggleComment"),
    ("Alt+ArrowUp", "edit.moveLineUp"),
    ("Alt+ArrowDown", "edit.moveLineDown"),
    ("Shift+Alt+ArrowDown", "edit.duplicateLine"),
    ("Shift+Alt+ArrowUp", "edit.duplicateLineUp"),
    ("Mod+Shift+k", "edit.deleteLine"),
    ("Mod+]", "edit.indent"),
    ("Mod+[", "edit.outdent"),
    ("Mod+=", "view.zoomIn"),
    ("Mod+-", "view.zoomOut"),
    ("Mod+0", "view.zoomReset"),
];

pub fn default_bindings() -> Keymap {
    normalize_keymap(DEFAULT_BINDINGS.iter().copied())
}

pub fn normalize_keymap<'a, I>(bindings: I) -> Keymap
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut result = Keymap::new();
    for (combo, command) in bindings {
        let normalized = normalize_combo(combo);
        if !normalized.is_empty() {
            result.insert(normalized, command.to_string());
        }
    }
    result
}

pub fn resolve_command<'a>(bindings: &'a Keymap, combo: &str) -> Option<&'a str> {
    if combo.is_empty() {
        return None;
    }
    if let Some(command) = bindings.get(combo) {
        return Some(command.as_str());
    }
    bindings
        .get(&normalize_combo(combo))
        .map(|value| value.as_str())
}

/// Combos that map to more than one command.
pub fn find_conflicts<'a, I>(bindings: I) -> Vec<(String, Vec<String>)>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut by_combo: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (combo, command) in bindings {
        by_combo
            .entry(normalize_combo(combo))
            .or_default()
            .insert(command.to_string());
    }
    by_combo
        .into_iter()
        .filter(|(_, commands)| commands.len() > 1)
        .map(|(combo, commands)| (combo, commands.into_iter().collect()))
        .collect()
}

/// Human-readable shortcut for menus, adapted to the platform.
pub fn format_combo(combo: &str, is_mac: bool) -> String {
    let normalized = normalize_combo(combo);
    let mut parts: Vec<&str> = normalized.split('+').collect();
    let key = parts.pop().unwrap_or("");

    let symbol = |part: &str| -> String {
        match part {
            "Mod" => {
                if is_mac {
                    "⌘".to_string()
                } else {
                    "Ctrl".to_string()
                }
            }
            "Ctrl" => {
                if is_mac {
                    "⌃".to_string()
                } else {
                    "Ctrl".to_string()
                }
            }
            "Meta" => "⌘".to_string(),
            "Alt" => {
                if is_mac {
                    "⌥".to_string()
                } else {
                    "Alt".to_string()
                }
            }
            "Shift" => {
                if is_mac {
                    "⇧".to_string()
                } else {
                    "Shift".to_string()
                }
            }
            other => other.to_string(),
        }
    };

    let named_key = match key {
        "ArrowUp" => "↑",
        "ArrowDown" => "↓",
        "ArrowLeft" => "←",
        "ArrowRight" => "→",
        "Enter" => "↵",
        "Escape" => "Esc",
        "Space" => "Space",
        other => other,
    };

    let mut pieces: Vec<String> = parts.iter().map(|part| symbol(part)).collect();
    pieces.push(named_key.to_string());
    pieces.join(if is_mac { "" } else { "+" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_modifier_order_and_case() {
        assert_eq!(normalize_combo("shift+mod+p"), "Mod+Shift+p");
        assert_eq!(normalize_combo("Mod+Shift+P"), "Mod+Shift+p");
        assert_eq!(normalize_combo("Cmd+S"), "Mod+s");
        assert_eq!(normalize_combo("Ctrl+Alt+delete"), "Ctrl+Alt+Delete");
        assert_eq!(normalize_combo("Option+Up"), "Alt+ArrowUp");
        assert_eq!(normalize_combo(""), "");
        assert_eq!(normalize_combo("+"), "");
    }

    #[test]
    fn builds_combos_from_events_per_platform() {
        let mut event = KeyEvent::new("p");
        event.ctrl = true;
        event.shift = true;
        assert_eq!(combo_from_event(&event, false), "Mod+Shift+p");

        let mut mac = KeyEvent::new("p");
        mac.meta = true;
        assert_eq!(combo_from_event(&mac, true), "Mod+p");

        let mut mac_ctrl = KeyEvent::new("p");
        mac_ctrl.ctrl = true;
        assert_eq!(combo_from_event(&mac_ctrl, true), "Ctrl+p");
    }

    #[test]
    fn ignores_bare_modifier_presses() {
        assert_eq!(combo_from_event(&KeyEvent::new("Shift"), false), "");
        assert_eq!(combo_from_event(&KeyEvent::new("Meta"), false), "");
    }

    #[test]
    fn resolves_default_bindings() {
        let bindings = default_bindings();
        assert_eq!(resolve_command(&bindings, "Mod+s"), Some("file.save"));
        assert_eq!(
            resolve_command(&bindings, "Mod+ALT+UP"),
            Some("edit.moveLineUp")
        );
        assert_eq!(
            resolve_command(&bindings, "Mod+/"),
            Some("edit.toggleComment")
        );
        assert_eq!(resolve_command(&bindings, ""), None);
        assert_eq!(resolve_command(&bindings, "Mod+q"), None);
    }

    #[test]
    fn reports_conflicts_between_bindings() {
        let conflicts = find_conflicts([("Mod+p", "a"), ("mod+P", "b"), ("Mod+o", "c")]);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].0, "Mod+p");
        assert_eq!(conflicts[0].1, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn finds_no_conflicts_in_the_defaults() {
        assert!(find_conflicts(DEFAULT_BINDINGS.iter().copied()).is_empty());
    }

    #[test]
    fn formats_combos_for_each_platform() {
        assert_eq!(format_combo("Mod+Shift+p", false), "Ctrl+Shift+p");
        assert_eq!(format_combo("Mod+Shift+p", true), "⌘⇧p");
        assert_eq!(format_combo("Alt+ArrowUp", false), "Alt+↑");
        assert_eq!(format_combo("Mod+=", true), "⌘=");
    }

    #[test]
    fn detects_mac_user_agents() {
        assert!(is_mac_platform(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)"
        ));
        assert!(is_mac_platform("Mozilla/5.0 (iPad; CPU OS 17_0)"));
        assert!(!is_mac_platform("Mozilla/5.0 (X11; Linux x86_64)"));
    }
}
