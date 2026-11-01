//! The "helpful" editing features — the ones most likely to get in the way.
//! Every rule here has a matching undo path and is tested against the annoying
//! case, not the happy case.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoCloseAction {
    Insert(&'static str),
    Skip(usize),
    Wrap { open: char, close: char },
}

pub fn matching_closer(open: char) -> Option<char> {
    match open {
        '(' => Some(')'),
        '[' => Some(']'),
        '{' => Some('}'),
        '"' => Some('"'),
        '\'' => Some('\''),
        '`' => Some('`'),
        _ => None,
    }
}

pub fn is_opener(ch: char) -> bool {
    matching_closer(ch).is_some()
}

pub fn is_closer(ch: char) -> bool {
    matches!(ch, ')' | ']' | '}' | '"' | '\'' | '`')
}

fn is_word_char(ch: Option<char>) -> bool {
    match ch {
        Some(value) => value.is_alphanumeric() || value == '_' || value == '$',
        None => false,
    }
}

fn pair_text(open: char, close: char) -> &'static str {
    match (open, close) {
        ('(', ')') => "()",
        ('[', ']') => "[]",
        ('{', '}') => "{}",
        ('"', '"') => "\"\"",
        ('\'', '\'') => "''",
        ('`', '`') => "``",
        _ => "",
    }
}

/// Decide what a single typed character should do.
///
/// - Typing a closer when the same character is already next to the caret steps
///   over it instead of doubling it.
/// - Typing an opener around a selection wraps the selection.
/// - Quotes are conservative near word characters, so a prose apostrophe in
///   `don't` does not turn into `don't'`.
pub fn decide_auto_close(
    typed: char,
    before: Option<char>,
    after: Option<char>,
    has_selection: bool,
) -> Option<AutoCloseAction> {
    if has_selection {
        return matching_closer(typed).map(|close| AutoCloseAction::Wrap { open: typed, close });
    }

    if is_closer(typed) && after == Some(typed) {
        return Some(AutoCloseAction::Skip(1));
    }

    let is_quote = matches!(typed, '"' | '\'' | '`');
    if is_quote && (is_word_char(before) || after == Some(typed) || is_word_char(after)) {
        return None;
    }

    let close = matching_closer(typed)?;
    if let Some(next) = after {
        let is_space = next.is_whitespace();
        if !is_space && !is_closer(next) {
            return None;
        }
    }

    Some(AutoCloseAction::Insert(pair_text(typed, close)))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewlineResult {
    pub text: String,
    pub caret: usize,
}

pub fn leading_whitespace(line_text: &str) -> &str {
    let end = line_text
        .char_indices()
        .find(|(_, ch)| *ch != ' ' && *ch != '\t')
        .map(|(index, _)| index)
        .unwrap_or(line_text.len());
    &line_text[..end]
}

/// Enter: keep indentation, open a block on `{`, and split `{|}` into three lines.
pub fn compute_newline(line_text: &str, column: usize, indent_unit: &str) -> NewlineResult {
    let indent = leading_whitespace(line_text);
    let characters: Vec<char> = line_text.chars().collect();
    let before = if column > 0 {
        characters.get(column - 1).copied()
    } else {
        None
    };
    let after = characters.get(column).copied();

    if let (Some(open), Some(close)) = (before, after) {
        if matching_closer(open) == Some(close) && is_opener(open) && is_closer(close) {
            let inner = format!("\n{indent}{indent_unit}");
            let text = format!("{inner}\n{indent}");
            let caret = inner.len();
            return NewlineResult { text, caret };
        }
    }

    if let Some(open) = before {
        if is_opener(open) {
            let text = format!("\n{indent}{indent_unit}");
            let caret = text.len();
            return NewlineResult { text, caret };
        }
    }

    if let Some(close) = after {
        let before_caret: String = characters.iter().take(column).collect();
        if is_closer(close) && before_caret.trim().is_empty() {
            let keep = indent.len().saturating_sub(indent_unit.len());
            let dedented = &indent[..keep];
            let text = format!("\n{dedented}");
            let caret = text.len();
            return NewlineResult { text, caret };
        }
    }

    let text = format!("\n{indent}");
    NewlineResult {
        caret: text.len(),
        text,
    }
}

/// Home key: first non-blank character first, column 0 on the second press.
pub fn smart_home_target(line_text: &str, column: usize) -> usize {
    let first_non_blank = leading_whitespace(line_text).chars().count();
    if column == first_non_blank {
        0
    } else {
        first_non_blank
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndentOptions {
    pub indent_unit: String,
    pub insert_spaces: bool,
}

impl Default for IndentOptions {
    fn default() -> Self {
        Self {
            indent_unit: "  ".to_string(),
            insert_spaces: true,
        }
    }
}

/// Detect the file's own convention so the editor does not fight it.
pub fn detect_indent(text: &str, fallback: IndentOptions) -> IndentOptions {
    let mut tabs: usize = 0;
    let mut spaces: usize = 0;
    let mut smallest_space_run: Option<usize> = None;

    for line in text.split('\n').take(2000) {
        if line.starts_with('\t') {
            tabs += 1;
        }
        let run = line.chars().take_while(|ch| *ch == ' ').count();
        if run > 0 {
            spaces += 1;
            smallest_space_run = Some(match smallest_space_run {
                Some(current) if current <= run => current,
                _ => run,
            });
        }
    }

    if tabs > spaces {
        return IndentOptions {
            indent_unit: "\t".to_string(),
            insert_spaces: false,
        };
    }
    if spaces == 0 {
        return fallback;
    }
    let width = smallest_space_run.unwrap_or(2).min(8);
    IndentOptions {
        indent_unit: " ".repeat(width),
        insert_spaces: true,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReindentDirection {
    Indent,
    Outdent,
}

/// Add or remove one indent level from a multi-line block.
pub fn reindent_block(
    lines: &[&str],
    options: &IndentOptions,
    direction: ReindentDirection,
) -> Vec<String> {
    lines
        .iter()
        .map(|line| match direction {
            ReindentDirection::Indent => {
                if options.insert_spaces || !line.starts_with('\t') {
                    format!("{}{}", options.indent_unit, line)
                } else {
                    format!("\t{line}")
                }
            }
            ReindentDirection::Outdent => {
                if options.indent_unit == "\t" {
                    if let Some(rest) = line.strip_prefix('\t') {
                        return rest.to_string();
                    }
                    let removable = line.chars().take_while(|ch| *ch == ' ').count().min(4);
                    return line[removable..].to_string();
                }
                let mut index = 0usize;
                let mut remove = options.indent_unit.len();
                for ch in line.chars() {
                    if remove == 0 || ch != ' ' {
                        break;
                    }
                    index += 1;
                    remove -= 1;
                }
                line[index.min(line.len())..].to_string()
            }
        })
        .collect()
}

pub fn toggle_line_comment_text(line: &str, prefix: Option<&str>) -> String {
    let Some(prefix) = prefix else {
        return line.to_string();
    };
    if line.trim().is_empty() {
        return line.to_string();
    }
    let indent = leading_whitespace(line);
    let rest = &line[indent.len()..];
    let with_space = format!("{prefix} ");
    if let Some(stripped) = rest.strip_prefix(&with_space) {
        return format!("{indent}{stripped}");
    }
    if let Some(stripped) = rest.strip_prefix(prefix) {
        return format!("{indent}{stripped}");
    }
    format!("{indent}{prefix} {rest}")
}

/// Comment every non-blank line, or uncomment them all if they are already commented.
pub fn toggle_comment_block(lines: &[&str], prefix: Option<&str>) -> Vec<String> {
    let Some(prefix) = prefix else {
        return lines.iter().map(|line| line.to_string()).collect();
    };
    let meaningful: Vec<&&str> = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if meaningful.is_empty() {
        return lines.iter().map(|line| line.to_string()).collect();
    }
    let all_commented = meaningful
        .iter()
        .all(|line| line.trim_start().starts_with(prefix));

    lines
        .iter()
        .map(|line| {
            if line.trim().is_empty() {
                return line.to_string();
            }
            let indent = leading_whitespace(line);
            if all_commented {
                let rest = &line[indent.len()..];
                let rest = rest.strip_prefix(prefix).unwrap_or(rest);
                let rest = rest.strip_prefix(' ').unwrap_or(rest);
                format!("{indent}{rest}")
            } else {
                format!("{indent}{prefix} {}", &line[indent.len()..])
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_a_selection_in_the_matching_pair() {
        assert_eq!(
            decide_auto_close('(', None, None, true),
            Some(AutoCloseAction::Wrap {
                open: '(',
                close: ')'
            })
        );
        assert_eq!(decide_auto_close('x', None, None, true), None);
    }

    #[test]
    fn skips_over_an_existing_closer() {
        assert_eq!(
            decide_auto_close(')', Some('('), Some(')'), false),
            Some(AutoCloseAction::Skip(1))
        );
    }

    #[test]
    fn inserts_a_pair_at_a_clean_boundary() {
        assert_eq!(
            decide_auto_close('(', Some(' '), Some(' '), false),
            Some(AutoCloseAction::Insert("()"))
        );
        assert_eq!(
            decide_auto_close('{', None, None, false),
            Some(AutoCloseAction::Insert("{}"))
        );
    }

    #[test]
    fn refuses_to_pair_against_another_word() {
        assert_eq!(decide_auto_close('(', Some('a'), Some('b'), false), None);
    }

    #[test]
    fn is_conservative_with_apostrophes() {
        assert_eq!(decide_auto_close('\'', Some('n'), Some('t'), false), None);
        assert_eq!(
            decide_auto_close('"', Some(' '), Some('"'), false),
            Some(AutoCloseAction::Skip(1))
        );
        assert_eq!(
            decide_auto_close('"', Some(' '), Some(' '), false),
            Some(AutoCloseAction::Insert("\"\""))
        );
    }

    #[test]
    fn keeps_indentation_on_enter() {
        let result = compute_newline("    let x = 1;", 14, "  ");
        assert_eq!(result.text, "\n    ");
        assert_eq!(result.caret, 5);
    }

    #[test]
    fn splits_a_brace_pair_into_three_lines() {
        let result = compute_newline("  {}", 3, "  ");
        assert_eq!(result.text, "\n    \n  ");
        assert_eq!(result.caret, 5);
    }

    #[test]
    fn opens_a_block_after_an_opening_brace() {
        let result = compute_newline("if (x) {", 8, "  ");
        assert_eq!(result.text, "\n  ");
    }

    #[test]
    fn dedents_a_blank_line_before_a_closer() {
        let result = compute_newline("    }", 4, "  ");
        assert_eq!(result.text, "\n  ");
        assert_eq!(result.caret, 3);
    }

    #[test]
    fn smart_home_toggles_between_column_zero_and_first_text() {
        assert_eq!(smart_home_target("    code", 8), 4);
        assert_eq!(smart_home_target("    code", 4), 0);
        assert_eq!(smart_home_target("code", 0), 0);
    }

    #[test]
    fn detects_tabs_and_space_widths() {
        let tabs = detect_indent("a\n\tb\n\tc", IndentOptions::default());
        assert!(!tabs.insert_spaces);
        assert_eq!(tabs.indent_unit, "\t");

        let spaces = detect_indent("a\n    b\n    c", IndentOptions::default());
        assert!(spaces.insert_spaces);
        assert_eq!(spaces.indent_unit, "    ");

        let empty = detect_indent("no indent here", IndentOptions::default());
        assert_eq!(empty, IndentOptions::default());
    }

    #[test]
    fn reindents_a_block_both_ways() {
        let options = IndentOptions {
            indent_unit: "  ".to_string(),
            insert_spaces: true,
        };
        let indented = reindent_block(&["a", "  b"], &options, ReindentDirection::Indent);
        assert_eq!(indented, vec!["  a", "    b"]);
        let borrowed: Vec<&str> = indented.iter().map(|line| line.as_str()).collect();
        let outdented = reindent_block(&borrowed, &options, ReindentDirection::Outdent);
        assert_eq!(outdented, vec!["a", "  b"]);
    }

    #[test]
    fn outdents_tabs_without_removing_text() {
        let options = IndentOptions {
            indent_unit: "\t".to_string(),
            insert_spaces: false,
        };
        assert_eq!(
            reindent_block(&["\tdeep", "shallow"], &options, ReindentDirection::Outdent),
            vec!["deep", "shallow"]
        );
    }

    #[test]
    fn toggles_a_line_comment() {
        assert_eq!(toggle_line_comment_text("code", Some("//")), "// code");
        assert_eq!(toggle_line_comment_text("// code", Some("//")), "code");
        assert_eq!(toggle_line_comment_text("  code", Some("//")), "  // code");
        assert_eq!(toggle_line_comment_text("   ", Some("//")), "   ");
        assert_eq!(toggle_line_comment_text("code", None), "code");
    }

    #[test]
    fn comments_and_uncomments_a_block_together() {
        let lines = ["a", "", "  b"];
        let commented = toggle_comment_block(&lines, Some("//"));
        assert_eq!(commented, vec!["// a", "", "  // b"]);
        let back = toggle_comment_block(
            &commented
                .iter()
                .map(|line| line.as_str())
                .collect::<Vec<_>>(),
            Some("//"),
        );
        assert_eq!(back, vec!["a", "", "  b"]);
    }

    #[test]
    fn leaving_a_block_untouched_without_a_comment_prefix() {
        let lines = ["a", "b"];
        assert_eq!(toggle_comment_block(&lines, None), vec!["a", "b"]);
        assert_eq!(
            toggle_comment_block(&["", "  "], Some("//")),
            vec!["", "  "]
        );
    }
}
