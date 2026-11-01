//! Subsequence matcher for the command palette and quick open.
//! Not fuzzy in the "typo-tolerant" sense — predictable beats clever.

pub const BONUS_CONSECUTIVE: i64 = 8;
pub const BONUS_WORD_START: i64 = 12;
pub const BONUS_CAMEL: i64 = 6;
pub const BONUS_EXACT_CASE: i64 = 1;
pub const PENALTY_GAP: i64 = 1;
pub const BASE_MATCH: i64 = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FuzzyMatch {
    pub score: i64,
    /// Indices (in characters) that matched, for highlighting.
    pub positions: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RankedMatch {
    pub index: usize,
    pub score: i64,
    pub positions: Vec<usize>,
}

fn lower(ch: char) -> char {
    ch.to_lowercase().next().unwrap_or(ch)
}

fn is_boundary(target: &[char], index: usize) -> bool {
    if index == 0 {
        return true;
    }
    let previous = target[index - 1];
    let current = target[index];
    previous.is_whitespace()
        || matches!(previous, '.' | '_' | '-' | '/' | '\\' | ':')
        || (previous.is_ascii_lowercase() && current.is_ascii_uppercase())
}

pub fn fuzzy_match(query: &str, target: &str) -> Option<FuzzyMatch> {
    let query_chars: Vec<char> = query.chars().collect();
    let target_chars: Vec<char> = target.chars().collect();

    if query_chars.is_empty() {
        return Some(FuzzyMatch {
            score: 0,
            positions: Vec::new(),
        });
    }
    if query_chars.len() > target_chars.len() {
        return None;
    }

    let lowered_target: Vec<char> = target_chars.iter().map(|ch| lower(*ch)).collect();
    let mut positions: Vec<usize> = Vec::with_capacity(query_chars.len());
    let mut score: i64 = 0;
    let mut cursor = 0usize;
    let mut previous_index: Option<usize> = None;

    for (query_index, wanted) in query_chars.iter().enumerate() {
        let needle = lower(*wanted);
        let mut found: Option<usize> = None;
        for (offset, candidate) in lowered_target.iter().enumerate().skip(cursor) {
            if *candidate == needle {
                found = Some(offset);
                break;
            }
        }
        let found = found?;

        score += BASE_MATCH;
        match previous_index {
            Some(previous) if found == previous + 1 => score += BONUS_CONSECUTIVE,
            Some(previous) => {
                score -= (PENALTY_GAP * (found as i64 - previous as i64 - 1)).min(10);
            }
            None => {}
        }
        if is_boundary(&target_chars, found) {
            score += BONUS_WORD_START;
        }
        let actual = target_chars[found];
        if actual == query_chars[query_index] {
            if actual.is_ascii_uppercase() {
                score += BONUS_CAMEL;
            }
            score += BONUS_EXACT_CASE;
        }

        positions.push(found);
        previous_index = Some(found);
        cursor = found + 1;
    }

    let lowered_query: Vec<char> = query_chars.iter().map(|ch| lower(*ch)).collect();
    if lowered_target == lowered_query {
        score += 40;
    } else if lowered_target.starts_with(&lowered_query) {
        score += 25;
    } else if lowered_target
        .windows(lowered_query.len())
        .any(|window| window == lowered_query.as_slice())
    {
        score += 10;
    }
    score -= ((target_chars.len() / 12) as i64).min(8);

    Some(FuzzyMatch { score, positions })
}

/// Rank items by match score, then by target length. Returns original indices.
pub fn fuzzy_filter<T, F>(items: &[T], query: &str, to_text: F, limit: usize) -> Vec<RankedMatch>
where
    F: Fn(&T) -> String,
{
    let mut ranked: Vec<(RankedMatch, usize)> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let text = to_text(item);
        if let Some(found) = fuzzy_match(query, &text) {
            ranked.push((
                RankedMatch {
                    index,
                    score: found.score,
                    positions: found.positions,
                },
                text.chars().count(),
            ));
        }
    }
    ranked.sort_by(|a, b| b.0.score.cmp(&a.0.score).then(a.1.cmp(&b.1)));
    ranked
        .into_iter()
        .take(limit)
        .map(|(matched, _)| matched)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_an_empty_query_everywhere() {
        let found = fuzzy_match("", "anything").expect("match");
        assert_eq!(found.score, 0);
        assert!(found.positions.is_empty());
    }

    #[test]
    fn rejects_missing_characters() {
        assert!(fuzzy_match("xyz", "abc").is_none());
        assert!(fuzzy_match("abcdef", "abc").is_none());
    }

    #[test]
    fn matches_subsequences_and_reports_positions() {
        let found = fuzzy_match("sp", "src/palette.ts").expect("match");
        assert_eq!(found.positions, vec![0, 4]);
    }

    #[test]
    fn ranks_prefixes_above_scattered_matches() {
        let prefix = fuzzy_match("save", "saveFile").expect("match").score;
        let scattered = fuzzy_match("save", "s-a-v-e-things").expect("match").score;
        assert!(prefix > scattered);
    }

    #[test]
    fn prefers_exact_matches() {
        let exact = fuzzy_match("file.save", "file.save").expect("match").score;
        let partial = fuzzy_match("file.save", "file.saveAs").expect("match").score;
        assert!(exact > partial);
    }

    #[test]
    fn rewards_word_boundaries_and_camel_case() {
        let camel = fuzzy_match("so", "SerializedObject").expect("match").score;
        let plain = fuzzy_match("so", "xxsxoxx").expect("match").score;
        assert!(camel > plain);
    }

    #[test]
    fn is_case_insensitive_but_rewards_exact_case() {
        assert!(fuzzy_match("readme", "README.md").is_some());
        let exact = fuzzy_match("README", "README.md").expect("match").score;
        let inexact = fuzzy_match("readme", "README.md").expect("match").score;
        assert!(exact > inexact);
    }

    #[test]
    fn filters_and_ranks_items() {
        let items = ["file.save", "file.saveAs", "edit.toggleComment"];
        let ranked = fuzzy_filter(&items, "save", |item| item.to_string(), 10);
        assert_eq!(ranked.len(), 2);
        assert_eq!(items[ranked[0].index], "file.save");
    }

    #[test]
    fn respects_the_limit() {
        let items = ["a", "ab", "abc", "abcd"];
        assert_eq!(fuzzy_filter(&items, "a", |item| item.to_string(), 2).len(), 2);
    }
}
