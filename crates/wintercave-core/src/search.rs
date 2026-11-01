use regex::{Regex, RegexBuilder};

#[derive(Clone, Debug, Default)]
pub struct SearchOptions {
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
}

impl SearchOptions {
    pub fn literal(query: &str) -> Self {
        Self {
            query: query.to_string(),
            ..Self::default()
        }
    }
}

fn is_word_char(c: Option<char>) -> bool {
    match c {
        Some(ch) => ch.is_alphanumeric() || ch == '_' || ch == '$',
        None => false,
    }
}

/// Compiled search: literal or regex, optional case sensitivity and whole-word.
/// Invalid patterns surface as `error` instead of panicking.
pub struct Search {
    options: SearchOptions,
    regex: Option<Regex>,
    error: Option<String>,
}

impl Search {
    pub fn new(options: SearchOptions) -> Self {
        let mut regex = None;
        let mut error = None;

        if !options.query.is_empty() {
            let source = if options.regex {
                options.query.clone()
            } else {
                regex::escape(&options.query)
            };
            match RegexBuilder::new(&source)
                .case_insensitive(!options.case_sensitive)
                .build()
            {
                Ok(compiled) => regex = Some(compiled),
                Err(cause) => error = Some(cause.to_string()),
            }
        }

        Self {
            options,
            regex,
            error,
        }
    }

    pub fn options(&self) -> &SearchOptions {
        &self.options
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn is_valid(&self) -> bool {
        self.regex.is_some() && self.error.is_none()
    }

    pub fn is_empty(&self) -> bool {
        self.options.query.is_empty()
    }

    fn whole_word_ok(&self, text: &str, from: usize, to: usize) -> bool {
        if !self.options.whole_word || from == to {
            return true;
        }
        let before = text[..from].chars().next_back();
        let after = text[to..].chars().next();
        !is_word_char(before) && !is_word_char(after)
    }

    pub fn matches(&self, text: &str) -> Vec<(usize, usize)> {
        self.matches_limited(text, usize::MAX)
    }

    pub fn matches_limited(&self, text: &str, limit: usize) -> Vec<(usize, usize)> {
        let Some(regex) = &self.regex else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for found in regex.find_iter(text) {
            if out.len() >= limit {
                break;
            }
            if self.whole_word_ok(text, found.start(), found.end()) {
                out.push((found.start(), found.end()));
            }
        }
        out
    }

    /// Replace every match. Capture references (`$1`, `$name`) are expanded in
    /// regex mode only — literal search treats the replacement literally.
    pub fn replace_all(&self, text: &str, replacement: &str) -> (String, usize) {
        let Some(regex) = &self.regex else {
            return (text.to_string(), 0);
        };

        let mut out = String::with_capacity(text.len());
        let mut cursor = 0usize;
        let mut count = 0usize;

        for found in regex.find_iter(text) {
            if !self.whole_word_ok(text, found.start(), found.end()) {
                continue;
            }
            out.push_str(&text[cursor..found.start()]);
            if self.options.regex {
                let mut expanded = String::new();
                match regex.captures_at(text, found.start()) {
                    Some(captures)
                        if captures
                            .get(0)
                            .map(|whole| (whole.start(), whole.end()))
                            == Some((found.start(), found.end())) =>
                    {
                        captures.expand(replacement, &mut expanded);
                        out.push_str(&expanded);
                    }
                    _ => out.push_str(replacement),
                }
            } else {
                out.push_str(replacement);
            }
            cursor = found.end();
            count += 1;
        }

        if count == 0 {
            return (text.to_string(), 0);
        }
        out.push_str(&text[cursor..]);
        (out, count)
    }

    /// Index of the next/previous match relative to a caret offset, wrapping.
    pub fn next_index(
        &self,
        matches: &[(usize, usize)],
        offset: usize,
        forward: bool,
    ) -> Option<usize> {
        if matches.is_empty() {
            return None;
        }
        if forward {
            for (index, (from, _)) in matches.iter().enumerate() {
                if *from > offset {
                    return Some(index);
                }
            }
            Some(0)
        } else {
            for index in (0..matches.len()).rev() {
                if matches[index].1 <= offset {
                    return Some(index);
                }
            }
            Some(matches.len() - 1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_case_insensitive_by_default() {
        let search = Search::new(SearchOptions::literal("foo"));
        assert_eq!(search.matches("FOO foo Foo").len(), 3);
    }

    #[test]
    fn honours_case_sensitivity() {
        let search = Search::new(SearchOptions {
            query: "foo".into(),
            case_sensitive: true,
            ..SearchOptions::default()
        });
        assert_eq!(search.matches("FOO foo Foo"), vec![(4, 7)]);
    }

    #[test]
    fn treats_metacharacters_literally_by_default() {
        let search = Search::new(SearchOptions::literal("a.c"));
        assert_eq!(search.matches("abc a.c"), vec![(4, 7)]);
    }

    #[test]
    fn supports_regular_expressions() {
        let search = Search::new(SearchOptions {
            query: r"\d+".into(),
            regex: true,
            ..SearchOptions::default()
        });
        assert_eq!(search.matches("a1 bb22 c333"), vec![(1, 2), (5, 7), (9, 12)]);
    }

    #[test]
    fn reports_invalid_patterns_instead_of_panicking() {
        let search = Search::new(SearchOptions {
            query: "(".into(),
            regex: true,
            ..SearchOptions::default()
        });
        assert!(search.error().is_some());
        assert!(!search.is_valid());
        assert!(search.matches("anything").is_empty());
    }

    #[test]
    fn filters_whole_word_matches() {
        let search = Search::new(SearchOptions {
            query: "cat".into(),
            whole_word: true,
            ..SearchOptions::default()
        });
        assert_eq!(search.matches("concatenate cat cats _cat cat_"), vec![(12, 15)]);
    }

    #[test]
    fn returns_nothing_for_an_empty_query() {
        let search = Search::new(SearchOptions::literal(""));
        assert!(search.is_empty());
        assert!(search.matches("abc").is_empty());
    }

    #[test]
    fn survives_zero_length_patterns() {
        let search = Search::new(SearchOptions {
            query: "^|$".into(),
            regex: true,
            ..SearchOptions::default()
        });
        let matches = search.matches("ab\ncd");
        assert!(!matches.is_empty());
        assert!(matches.len() < 20);
    }

    #[test]
    fn respects_the_match_limit() {
        let search = Search::new(SearchOptions::literal("a"));
        assert_eq!(search.matches_limited(&"a".repeat(100), 10).len(), 10);
    }

    #[test]
    fn replaces_literally_without_expanding_dollars() {
        let search = Search::new(SearchOptions::literal("cat"));
        let (text, count) = search.replace_all("cat and cat", "$&$1");
        assert_eq!(count, 2);
        assert_eq!(text, "$&$1 and $&$1");
    }

    #[test]
    fn expands_capture_groups_in_regex_mode() {
        let search = Search::new(SearchOptions {
            query: r"(\w+)@(\w+)".into(),
            regex: true,
            ..SearchOptions::default()
        });
        let (text, count) = search.replace_all("me@example you@here", "$2:$1");
        assert_eq!(count, 2);
        assert_eq!(text, "example:me here:you");
    }

    #[test]
    fn replaces_case_insensitively() {
        let search = Search::new(SearchOptions::literal("foo"));
        assert_eq!(search.replace_all("FOO Foo", "bar").0, "bar bar");
    }

    #[test]
    fn leaves_text_untouched_when_nothing_matches() {
        let search = Search::new(SearchOptions::literal("zzz"));
        assert_eq!(search.replace_all("abc", "x"), ("abc".to_string(), 0));
    }

    #[test]
    fn replaces_only_whole_words_when_asked() {
        let search = Search::new(SearchOptions {
            query: "cat".into(),
            whole_word: true,
            ..SearchOptions::default()
        });
        assert_eq!(
            search.replace_all("concatenate cat", "dog").0,
            "concatenate dog"
        );
    }

    #[test]
    fn next_index_wraps_in_both_directions() {
        let search = Search::new(SearchOptions::literal("a"));
        let matches = search.matches("aaaa");
        assert_eq!(search.next_index(&matches, 0, true), Some(1));
        assert_eq!(search.next_index(&matches, 3, true), Some(0));
        assert_eq!(search.next_index(&matches, 4, false), Some(3));
        assert_eq!(search.next_index(&matches, 0, false), Some(3));
        assert_eq!(search.next_index(&[], 0, true), None);
    }
}
