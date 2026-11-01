//! Syntax tokenizer. Byte offsets throughout; the wasm layer converts to UTF-16
//! offsets for the DOM.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenType {
    Keyword,
    Str,
    Comment,
    Number,
    Constant,
    Function,
    Type,
    Tag,
    Attribute,
    Operator,
    Heading,
    Emphasis,
    Strong,
    Link,
    Code,
    List,
    Meta,
}

impl TokenType {
    pub fn as_str(self) -> &'static str {
        match self {
            TokenType::Keyword => "keyword",
            TokenType::Str => "string",
            TokenType::Comment => "comment",
            TokenType::Number => "number",
            TokenType::Constant => "constant",
            TokenType::Function => "function",
            TokenType::Type => "type",
            TokenType::Tag => "tag",
            TokenType::Attribute => "attribute",
            TokenType::Operator => "operator",
            TokenType::Heading => "heading",
            TokenType::Emphasis => "emphasis",
            TokenType::Strong => "strong",
            TokenType::Link => "link",
            TokenType::Code => "code",
            TokenType::List => "list",
            TokenType::Meta => "meta",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Token {
    pub start: usize,
    pub end: usize,
    pub kind: TokenType,
}

/// Multi-line state carried from one line to the next.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct HighlightState {
    pub block_comment: Option<&'static str>,
    pub string: Option<char>,
    pub fence: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LanguageFamily {
    Plain,
    Code,
    Markup,
    Markdown,
    Style,
}

pub struct LanguageDef {
    pub id: &'static str,
    pub name: &'static str,
    pub extensions: &'static [&'static str],
    pub family: LanguageFamily,
    pub keywords: &'static [&'static str],
    pub constants: &'static [&'static str],
    pub line_comment: Option<&'static str>,
    pub block_comment: Option<(&'static str, &'static str)>,
    pub quotes: &'static [char],
    pub multiline_quotes: &'static [char],
    pub case_insensitive_keywords: bool,
    pub word_wrap_default: bool,
    pub spellcheck_default: bool,
}

const JS_KEYWORDS: &[&str] = &[
    "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
    "default", "delete", "do", "else", "enum", "export", "extends", "finally", "for", "from",
    "function", "get", "if", "implements", "import", "in", "instanceof", "interface", "let",
    "new", "of", "return", "set", "static", "super", "switch", "this", "throw", "try", "type",
    "typeof", "var", "void", "while", "with", "yield",
];

const TS_KEYWORDS: &[&str] = &[
    "abstract", "and", "as", "asserts", "async", "await", "break", "case", "catch", "class",
    "const", "continue", "debugger", "declare", "default", "delete", "do", "else", "enum",
    "export", "extends", "finally", "for", "from", "function", "get", "if", "implements",
    "import", "in", "infer", "instanceof", "interface", "is", "keyof", "let", "module",
    "namespace", "never", "new", "of", "override", "readonly", "return", "satisfies", "set",
    "static", "super", "switch", "this", "throw", "try", "type", "typeof", "unknown", "var",
    "void", "while", "with", "yield",
];

const PYTHON_KEYWORDS: &[&str] = &[
    "and", "as", "assert", "async", "await", "break", "case", "class", "continue", "def", "del",
    "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is",
    "lambda", "match", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while",
    "with", "yield",
];

const SHELL_KEYWORDS: &[&str] = &[
    "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
    "function", "return", "in", "select", "time", "export", "local", "readonly", "source",
    "alias", "unset", "set", "shift", "trap", "eval", "exec", "exit",
];

const SQL_KEYWORDS: &[&str] = &[
    "select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create",
    "table", "alter", "drop", "index", "view", "join", "left", "right", "inner", "outer",
    "full", "on", "group", "by", "order", "having", "limit", "offset", "union", "all",
    "distinct", "as", "and", "or", "not", "null", "case", "when", "then", "else", "end",
    "primary", "foreign", "key", "references",
];

const JS_CONSTANTS: &[&str] = &["true", "false", "null", "undefined", "NaN", "Infinity"];
const NO_CONSTANTS: &[&str] = &[];
const CODE_QUOTES: &[char] = &['"', '\'', '`'];

pub const LANGUAGES: &[LanguageDef] = &[
    LanguageDef {
        id: "plaintext",
        name: "Plain Text",
        extensions: &["txt", "log", "text", ""],
        family: LanguageFamily::Plain,
        keywords: &[],
        constants: NO_CONSTANTS,
        line_comment: None,
        block_comment: None,
        quotes: &[],
        multiline_quotes: &[],
        case_insensitive_keywords: false,
        word_wrap_default: true,
        spellcheck_default: true,
    },
    LanguageDef {
        id: "markdown",
        name: "Markdown",
        extensions: &["md", "markdown", "mdx"],
        family: LanguageFamily::Markdown,
        keywords: &[],
        constants: NO_CONSTANTS,
        line_comment: None,
        block_comment: None,
        quotes: &[],
        multiline_quotes: &[],
        case_insensitive_keywords: false,
        word_wrap_default: true,
        spellcheck_default: true,
    },
    LanguageDef {
        id: "javascript",
        name: "JavaScript",
        extensions: &["js", "mjs", "cjs", "jsx"],
        family: LanguageFamily::Code,
        keywords: JS_KEYWORDS,
        constants: JS_CONSTANTS,
        line_comment: Some("//"),
        block_comment: Some(("/*", "*/")),
        quotes: CODE_QUOTES,
        multiline_quotes: &['`'],
        case_insensitive_keywords: false,
        word_wrap_default: false,
        spellcheck_default: false,
    },
    LanguageDef {
        id: "typescript",
        name: "TypeScript",
        extensions: &["ts", "tsx", "mts", "cts"],
        family: LanguageFamily::Code,
        keywords: TS_KEYWORDS,
        constants: JS_CONSTANTS,
        line_comment: Some("//"),
        block_comment: Some(("/*", "*/")),
        quotes: CODE_QUOTES,
        multiline_quotes: &['`'],
        case_insensitive_keywords: false,
        word_wrap_default: false,
        spellcheck_default: false,
    },
    LanguageDef {
        id: "json",
        name: "JSON",
        extensions: &["json", "jsonc", "webmanifest"],
        family: LanguageFamily::Code,
        keywords: &[],
        constants: &["true", "false", "null"],
        line_comment: None,
        block_comment: None,
        quotes: &['"'],
        multiline_quotes: &[],
        case_insensitive_keywords: false,
        word_wrap_default: false,
        spellcheck_default: false,
    },
    LanguageDef {
        id: "html",
        name: "HTML",
        extensions: &["html", "htm", "xml", "svg", "vue", "svelte"],
        family: LanguageFamily::Markup,
        keywords: &[],
        constants: NO_CONSTANTS,
        line_comment: None,
        block_comment: Some(("<!--", "-->")),
        quotes: &['"', '\''],
        multiline_quotes: &[],
        case_insensitive_keywords: false,
        word_wrap_default: false,
        spellcheck_default: false,
    },
    LanguageDef {
        id: "css",
        name: "CSS",
        extensions: &["css", "scss", "less"],
        family: LanguageFamily::Style,
        keywords: &["@media", "@import", "@font-face", "@keyframes", "@supports", "@layer"],
        constants: NO_CONSTANTS,
        line_comment: None,
        block_comment: Some(("/*", "*/")),
        quotes: &['"', '\''],
        multiline_quotes: &[],
        case_insensitive_keywords: false,
        word_wrap_default: false,
        spellcheck_default: false,
    },
    LanguageDef {
        id: "python",
        name: "Python",
        extensions: &["py", "pyw", "pyi"],
        family: LanguageFamily::Code,
        keywords: PYTHON_KEYWORDS,
        constants: &["True", "False", "None", "self", "cls"],
        line_comment: Some("#"),
        block_comment: None,
        quotes: &['"', '\''],
        multiline_quotes: &[],
        case_insensitive_keywords: false,
        word_wrap_default: false,
        spellcheck_default: false,
    },
    LanguageDef {
        id: "shell",
        name: "Shell",
        extensions: &["sh", "bash", "zsh", "fish", "env"],
        family: LanguageFamily::Code,
        keywords: SHELL_KEYWORDS,
        constants: NO_CONSTANTS,
        line_comment: Some("#"),
        block_comment: None,
        quotes: &['"', '\''],
        multiline_quotes: &[],
        case_insensitive_keywords: false,
        word_wrap_default: false,
        spellcheck_default: false,
    },
    LanguageDef {
        id: "yaml",
        name: "YAML",
        extensions: &["yml", "yaml"],
        family: LanguageFamily::Code,
        keywords: &[],
        constants: &["true", "false", "null", "~", "yes", "no"],
        line_comment: Some("#"),
        block_comment: None,
        quotes: &['"', '\''],
        multiline_quotes: &[],
        case_insensitive_keywords: false,
        word_wrap_default: false,
        spellcheck_default: false,
    },
    LanguageDef {
        id: "sql",
        name: "SQL",
        extensions: &["sql"],
        family: LanguageFamily::Code,
        keywords: SQL_KEYWORDS,
        constants: &["null", "true", "false"],
        line_comment: Some("--"),
        block_comment: Some(("/*", "*/")),
        quotes: &['\'', '"'],
        multiline_quotes: &[],
        case_insensitive_keywords: true,
        word_wrap_default: false,
        spellcheck_default: false,
    },
];

pub fn languages() -> &'static [LanguageDef] {
    LANGUAGES
}

pub fn get_language(id: &str) -> &'static LanguageDef {
    LANGUAGES
        .iter()
        .find(|language| language.id == id)
        .unwrap_or(&LANGUAGES[0])
}

pub fn language_for_filename(filename: &str) -> &'static LanguageDef {
    let extension = match filename.rsplit_once('.') {
        Some((_, ext)) => ext.to_ascii_lowercase(),
        None => String::new(),
    };
    if extension.is_empty() {
        return &LANGUAGES[0];
    }
    LANGUAGES
        .iter()
        .find(|language| language.extensions.contains(&extension.as_str()))
        .unwrap_or(&LANGUAGES[0])
}

fn push_token(tokens: &mut Vec<Token>, start: usize, end: usize, kind: TokenType) {
    if end > start {
        tokens.push(Token { start, end, kind });
    }
}

fn next_char(line: &str, index: usize) -> Option<(char, usize)> {
    line[index..].chars().next().map(|ch| (ch, ch.len_utf8()))
}

fn is_ident_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_' || ch == '$' || ch == '@' || ch == '#'
}

fn is_ident_part(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '$'
}

fn scan_quoted(line: &str, from: usize, quote: char) -> (usize, bool) {
    let mut index = from;
    while index < line.len() {
        let Some((ch, size)) = next_char(line, index) else {
            break;
        };
        if ch == '\\' {
            index += size;
            if let Some((_, escaped)) = next_char(line, index) {
                index += escaped;
            }
            continue;
        }
        if ch == quote {
            return (index + size, true);
        }
        index += size;
    }
    (line.len(), false)
}

fn scan_number(line: &str, start: usize) -> usize {
    let bytes = line.as_bytes();
    let mut index = start;
    if bytes.get(index) == Some(&b'0') {
        match bytes.get(index + 1) {
            Some(b'x') | Some(b'X') => {
                index += 2;
                while index < line.len() && (bytes[index].is_ascii_hexdigit() || bytes[index] == b'_') {
                    index += 1;
                }
                return index;
            }
            Some(b'b') | Some(b'B') => {
                index += 2;
                while index < line.len() && matches!(bytes[index], b'0' | b'1' | b'_') {
                    index += 1;
                }
                return index;
            }
            Some(b'o') | Some(b'O') => {
                index += 2;
                while index < line.len() && matches!(bytes[index], b'0'..=b'7' | b'_') {
                    index += 1;
                }
                return index;
            }
            _ => {}
        }
    }
    while index < line.len() && (bytes[index].is_ascii_digit() || bytes[index] == b'_') {
        index += 1;
    }
    if index < line.len() && bytes[index] == b'.' {
        index += 1;
        while index < line.len() && (bytes[index].is_ascii_digit() || bytes[index] == b'_') {
            index += 1;
        }
    }
    if index < line.len() && (bytes[index] == b'e' || bytes[index] == b'E') {
        let mut probe = index + 1;
        if probe < line.len() && (bytes[probe] == b'+' || bytes[probe] == b'-') {
            probe += 1;
        }
        let digits_start = probe;
        while probe < line.len() && bytes[probe].is_ascii_digit() {
            probe += 1;
        }
        if probe > digits_start {
            index = probe;
        }
    }
    while index < line.len() && (bytes[index].is_ascii_alphabetic() || bytes[index] == b'%') {
        index += 1;
    }
    index
}

fn is_operator(ch: char) -> bool {
    matches!(
        ch,
        '=' | '+' | '-' | '*' | '/' | '%' | '<' | '>' | '!' | '&' | '|' | '^' | '~' | '?' | ':'
    )
}

fn tokenize_code_line(
    line: &str,
    language: &LanguageDef,
    state: HighlightState,
) -> (Vec<Token>, HighlightState) {
    let mut tokens = Vec::new();
    let mut next = state;
    let mut index = 0usize;

    while index < line.len() {
        if let Some(close) = next.block_comment {
            match line[index..].find(close) {
                Some(offset) => {
                    let end = index + offset + close.len();
                    push_token(&mut tokens, index, end, TokenType::Comment);
                    index = end;
                    next.block_comment = None;
                }
                None => {
                    push_token(&mut tokens, index, line.len(), TokenType::Comment);
                    return (tokens, next);
                }
            }
            continue;
        }

        if let Some(quote) = next.string {
            let (end, closed) = scan_quoted(line, index, quote);
            push_token(&mut tokens, index, end, TokenType::Str);
            index = end;
            if closed {
                next.string = None;
            }
            continue;
        }

        let Some((ch, size)) = next_char(line, index) else {
            break;
        };

        if let Some(prefix) = language.line_comment {
            if line[index..].starts_with(prefix) {
                push_token(&mut tokens, index, line.len(), TokenType::Comment);
                break;
            }
        }

        if let Some((open, close)) = language.block_comment {
            if line[index..].starts_with(open) {
                next.block_comment = Some(close);
                continue;
            }
        }

        if language.quotes.contains(&ch) {
            let (end, closed) = scan_quoted(line, index + size, ch);
            push_token(&mut tokens, index, end, TokenType::Str);
            if !closed && language.multiline_quotes.contains(&ch) {
                next.string = Some(ch);
            }
            index = end;
            continue;
        }

        let previous_is_ident = line[..index]
            .chars()
            .next_back()
            .map(is_ident_part)
            .unwrap_or(false);

        if ch.is_ascii_digit() && !previous_is_ident {
            let end = scan_number(line, index);
            push_token(&mut tokens, index, end, TokenType::Number);
            index = end;
            continue;
        }

        if is_ident_start(ch) {
            let mut end = index + size;
            while end < line.len() {
                match next_char(line, end) {
                    Some((part, part_size)) if is_ident_part(part) => end += part_size,
                    _ => break,
                }
            }
            let word = &line[index..end];
            let lowered = word.to_ascii_lowercase();
            let keyword = if language.case_insensitive_keywords {
                language.keywords.iter().any(|candidate| *candidate == lowered)
            } else {
                language.keywords.contains(&word)
            };
            let constant = if language.case_insensitive_keywords {
                language.constants.iter().any(|candidate| *candidate == lowered)
            } else {
                language.constants.contains(&word)
            };

            let kind = if keyword {
                Some(TokenType::Keyword)
            } else if constant {
                Some(TokenType::Constant)
            } else if line[end..].starts_with('(') {
                Some(TokenType::Function)
            } else if word.chars().next().map(|first| first.is_ascii_uppercase()).unwrap_or(false) {
                Some(TokenType::Type)
            } else {
                None
            };
            if let Some(kind) = kind {
                push_token(&mut tokens, index, end, kind);
            }
            index = end;
            continue;
        }

        if is_operator(ch) {
            let mut end = index + size;
            while end < line.len() {
                match next_char(line, end) {
                    Some((operator, operator_size)) if is_operator(operator) => end += operator_size,
                    _ => break,
                }
            }
            push_token(&mut tokens, index, end, TokenType::Operator);
            index = end;
            continue;
        }

        index += size;
    }

    (tokens, next)
}

fn tokenize_style_line(
    line: &str,
    language: &LanguageDef,
    state: HighlightState,
) -> (Vec<Token>, HighlightState) {
    let (mut tokens, next) = tokenize_code_line(line, language, state);

    // `.selector` / `#selector`
    let mut index = 0usize;
    while index < line.len() {
        let Some((ch, size)) = next_char(line, index) else {
            break;
        };
        if ch == '.' || ch == '#' {
            let mut end = index + size;
            while end < line.len() {
                match next_char(line, end) {
                    Some((part, part_size)) if part.is_ascii_alphanumeric() || part == '-' || part == '_' => {
                        end += part_size
                    }
                    _ => break,
                }
            }
            if end > index + size {
                push_token(&mut tokens, index, end, TokenType::Tag);
                index = end;
                continue;
            }
        }
        index += size;
    }

    // `property:`
    let mut index = 0usize;
    while index < line.len() {
        let at_boundary = index == 0
            || line[..index]
                .chars()
                .next_back()
                .map(|previous| matches!(previous, '{' | ';' | ' ' | '\t'))
                .unwrap_or(false);
        if at_boundary {
            let mut end = index;
            while end < line.len() {
                match next_char(line, end) {
                    Some((part, part_size)) if part.is_ascii_alphanumeric() || part == '-' => end += part_size,
                    _ => break,
                }
            }
            if end > index {
                let mut probe = end;
                while probe < line.len() && (line.as_bytes()[probe] == b' ' || line.as_bytes()[probe] == b'\t') {
                    probe += 1;
                }
                if probe < line.len() && line.as_bytes()[probe] == b':' {
                    push_token(&mut tokens, index, end, TokenType::Attribute);
                }
                index = end.max(index + 1);
                continue;
            }
        }
        index += next_char(line, index).map(|(_, size)| size).unwrap_or(1);
    }

    tokens.sort_by(|a, b| a.start.cmp(&b.start).then(a.end.cmp(&b.end)));
    (tokens, next)
}

fn tokenize_markup_line(
    line: &str,
    language: &LanguageDef,
    state: HighlightState,
) -> (Vec<Token>, HighlightState) {
    let mut tokens = Vec::new();
    let mut next = state;
    let mut index = 0usize;

    while index < line.len() {
        if let Some(close) = next.block_comment {
            match line[index..].find(close) {
                Some(offset) => {
                    let end = index + offset + close.len();
                    push_token(&mut tokens, index, end, TokenType::Comment);
                    index = end;
                    next.block_comment = None;
                }
                None => {
                    push_token(&mut tokens, index, line.len(), TokenType::Comment);
                    return (tokens, next);
                }
            }
            continue;
        }

        if let Some((open, close)) = language.block_comment {
            if line[index..].starts_with(open) {
                next.block_comment = Some(close);
                continue;
            }
        }

        if line[index..].starts_with('<') {
            let end = match line[index..].find('>') {
                Some(offset) => index + offset + 1,
                None => line.len(),
            };
            push_token(&mut tokens, index, end, TokenType::Tag);

            let inner_start = index + 1;
            let inner_end = if end > inner_start { end - 1 } else { inner_start };
            let inner = &line[inner_start.min(inner_end)..inner_end.max(inner_start)];
            let mut cursor = 0usize;
            while cursor < inner.len() {
                let Some((ch, size)) = next_char(inner, cursor) else {
                    break;
                };
                if is_ident_start(ch) {
                    let mut word_end = cursor + size;
                    while word_end < inner.len() {
                        match next_char(inner, word_end) {
                            Some((part, part_size))
                                if part.is_ascii_alphanumeric() || part == '-' || part == '_' || part == ':' =>
                            {
                                word_end += part_size
                            }
                            _ => break,
                        }
                    }
                    let mut probe = word_end;
                    while probe < inner.len() && inner.as_bytes()[probe] == b' ' {
                        probe += 1;
                    }
                    if probe < inner.len() && inner.as_bytes()[probe] == b'=' {
                        push_token(&mut tokens, inner_start + cursor, inner_start + word_end, TokenType::Attribute);
                        let mut value_start = probe + 1;
                        while value_start < inner.len() && inner.as_bytes()[value_start] == b' ' {
                            value_start += 1;
                        }
                        if let Some((quote, quote_size)) = next_char(inner, value_start) {
                            if quote == '"' || quote == '\'' {
                                let (value_end, _) =
                                    scan_quoted(inner, value_start + quote_size, quote);
                                push_token(
                                    &mut tokens,
                                    inner_start + value_start,
                                    inner_start + value_end,
                                    TokenType::Str,
                                );
                            }
                        }
                    }
                    cursor = word_end;
                    continue;
                }
                cursor += size;
            }
            tokens.sort_by(|a, b| a.start.cmp(&b.start).then(a.end.cmp(&b.end)));
            index = end;
            continue;
        }

        index += next_char(line, index).map(|(_, size)| size).unwrap_or(1);
    }

    (tokens, next)
}

fn markdown_inline(line: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut index = 0usize;

    while index < line.len() {
        let rest = &line[index..];
        let Some((ch, size)) = next_char(line, index) else {
            break;
        };

        if ch == '`' {
            if let Some(offset) = rest[1..].find('`') {
                let end = index + 1 + offset + 1;
                push_token(&mut tokens, index, end, TokenType::Code);
                index = end;
                continue;
            }
        }

        if rest.starts_with("**") {
            if let Some(offset) = rest[2..].find("**") {
                let end = index + 2 + offset + 2;
                push_token(&mut tokens, index, end, TokenType::Strong);
                index = end;
                continue;
            }
        }

        if rest.starts_with("__") {
            if let Some(offset) = rest[2..].find("__") {
                let end = index + 2 + offset + 2;
                push_token(&mut tokens, index, end, TokenType::Strong);
                index = end;
                continue;
            }
        }

        if ch == '*' || ch == '_' {
            if let Some(offset) = rest[1..].find(ch) {
                let end = index + 1 + offset + 1;
                push_token(&mut tokens, index, end, TokenType::Emphasis);
                index = end;
                continue;
            }
        }

        if ch == '[' {
            if let Some(close) = rest.find(']') {
                let after = index + close + 1;
                if line[after..].starts_with('(') {
                    if let Some(paren) = line[after..].find(')') {
                        let end = after + paren + 1;
                        push_token(&mut tokens, index, end, TokenType::Link);
                        index = end;
                        continue;
                    }
                }
            }
        }

        index += size;
    }

    tokens
}

fn tokenize_markdown_line(
    line: &str,
    _language: &LanguageDef,
    state: HighlightState,
) -> (Vec<Token>, HighlightState) {
    let trimmed = line.trim_start();
    let is_fence = trimmed.starts_with("```") || trimmed.starts_with("~~~");

    if state.fence {
        if is_fence {
            return (
                vec![Token {
                    start: 0,
                    end: line.len(),
                    kind: TokenType::Meta,
                }],
                HighlightState {
                    fence: false,
                    ..state
                },
            );
        }
        return (
            vec![Token {
                start: 0,
                end: line.len(),
                kind: TokenType::Code,
            }],
            state,
        );
    }

    if is_fence {
        return (
            vec![Token {
                start: 0,
                end: line.len(),
                kind: TokenType::Meta,
            }],
            HighlightState {
                fence: true,
                ..state
            },
        );
    }

    let indent = line.len() - trimmed.len();
    let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
    if hashes > 0 && hashes <= 6 && trimmed[hashes..].starts_with(' ') {
        return (
            vec![Token {
                start: 0,
                end: line.len(),
                kind: TokenType::Heading,
            }],
            state,
        );
    }

    if is_horizontal_rule(trimmed) {
        return (
            vec![Token {
                start: 0,
                end: line.len(),
                kind: TokenType::Meta,
            }],
            state,
        );
    }

    let mut tokens = Vec::new();
    if trimmed.starts_with('>') {
        push_token(&mut tokens, 0, line.len(), TokenType::Meta);
    }

    if let Some(marker_len) = list_marker_len(trimmed) {
        push_token(&mut tokens, indent, indent + marker_len, TokenType::List);
    }

    tokens.extend(markdown_inline(line));
    tokens.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));

    let mut clean: Vec<Token> = Vec::new();
    for token in tokens {
        match clean.last_mut() {
            Some(last) if token.start < last.end => {
                if token.end > last.end {
                    last.end = token.end;
                }
            }
            _ => clean.push(token),
        }
    }

    (clean, state)
}

fn is_horizontal_rule(trimmed: &str) -> bool {
    let mut chars = trimmed.chars().filter(|ch| !ch.is_whitespace());
    let Some(first) = chars.next() else {
        return false;
    };
    if !matches!(first, '-' | '*' | '_') {
        return false;
    }
    let mut count = 1;
    for ch in chars {
        if ch != first {
            return false;
        }
        count += 1;
    }
    count >= 3
}

fn list_marker_len(trimmed: &str) -> Option<usize> {
    let mut chars = trimmed.char_indices();
    match chars.next() {
        Some((_, '-')) | Some((_, '*')) | Some((_, '+')) => {
            let next = trimmed.chars().nth(1);
            if next == Some(' ') || next == Some('\t') {
                Some(1)
            } else {
                None
            }
        }
        Some((_, digit)) if digit.is_ascii_digit() => {
            let mut length = 0usize;
            for (offset, ch) in trimmed.char_indices() {
                if ch.is_ascii_digit() {
                    length = offset + ch.len_utf8();
                } else {
                    break;
                }
            }
            let rest = &trimmed[length..];
            if rest.starts_with('.') || rest.starts_with(')') {
                if rest[1..].starts_with(' ') {
                    return Some(length + 1);
                }
            }
            None
        }
        _ => None,
    }
}

pub fn tokenize_line(
    line: &str,
    language: &LanguageDef,
    state: HighlightState,
) -> (Vec<Token>, HighlightState) {
    match language.family {
        LanguageFamily::Plain => (Vec::new(), HighlightState::default()),
        LanguageFamily::Markdown => tokenize_markdown_line(line, language, state),
        LanguageFamily::Markup => tokenize_markup_line(line, language, state),
        LanguageFamily::Style => tokenize_style_line(line, language, state),
        LanguageFamily::Code => tokenize_code_line(line, language, state),
    }
}

/// Collapse layered tokens into non-overlapping runs; later tokens win.
pub fn flatten_tokens(line: &str, tokens: &[Token]) -> Vec<Token> {
    if tokens.is_empty() || line.is_empty() {
        return Vec::new();
    }
    let mut layers: Vec<Option<TokenType>> = vec![None; line.len()];
    for token in tokens {
        let start = token.start.min(line.len());
        let end = token.end.min(line.len());
        for slot in layers.iter_mut().take(end).skip(start) {
            *slot = Some(token.kind);
        }
    }

    let mut runs: Vec<Token> = Vec::new();
    let mut current: Option<(usize, TokenType)> = None;
    for (index, slot) in layers.iter().enumerate() {
        match slot {
            Some(kind) => match current {
                Some((start, existing)) if existing != *kind => {
                    runs.push(Token {
                        start,
                        end: index,
                        kind: existing,
                    });
                    current = Some((index, *kind));
                }
                Some(_) => {}
                None => current = Some((index, *kind)),
            },
            None => {
                if let Some((start, existing)) = current.take() {
                    runs.push(Token {
                        start,
                        end: index,
                        kind: existing,
                    });
                }
            }
        }
    }
    if let Some((start, kind)) = current {
        runs.push(Token {
            start,
            end: line.len(),
            kind,
        });
    }
    runs
}

/// Tokenize a window of lines, replaying state from the top so a block comment
/// opened above the window is still coloured correctly.
pub fn tokenize_lines(
    lines: &[&str],
    language: &LanguageDef,
    from: usize,
    to: usize,
) -> Vec<(usize, Vec<Token>)> {
    let mut state = HighlightState::default();
    let mut out = Vec::new();
    let end = to.min(lines.len());
    for index in 0..end {
        let (tokens, next) = tokenize_line(lines[index], language, state);
        state = next;
        if index >= from {
            out.push((index, tokens));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(line: &str, id: &str) -> Vec<String> {
        let language = get_language(id);
        let (tokens, _) = tokenize_line(line, language, HighlightState::default());
        flatten_tokens(line, &tokens)
            .into_iter()
            .map(|token| format!("{}:{}", token.kind.as_str(), &line[token.start..token.end]))
            .collect()
    }

    #[test]
    fn maps_extensions_to_languages() {
        assert_eq!(language_for_filename("app.ts").id, "typescript");
        assert_eq!(language_for_filename("style.css").id, "css");
        assert_eq!(language_for_filename("README.md").id, "markdown");
        assert_eq!(language_for_filename("no-extension").id, "plaintext");
        assert_eq!(language_for_filename("weird.zzz").id, "plaintext");
    }

    #[test]
    fn falls_back_to_plain_text_for_unknown_ids() {
        assert_eq!(get_language("klingon").id, "plaintext");
    }

    #[test]
    fn marks_keywords_strings_numbers_and_comments() {
        assert_eq!(
            render("const answer = 42; // yes", "javascript"),
            vec!["keyword:const", "operator:=", "number:42", "comment:// yes"]
        );
    }

    #[test]
    fn does_not_treat_a_keyword_prefix_as_a_keyword() {
        assert_eq!(render("constant = 1", "javascript"), vec!["operator:=", "number:1"]);
    }

    #[test]
    fn does_not_highlight_keywords_inside_strings() {
        assert_eq!(
            render("const s = \"const return\"", "javascript"),
            vec!["keyword:const", "operator:=", "string:\"const return\""]
        );
    }

    #[test]
    fn carries_block_comments_across_lines() {
        let language = get_language("javascript");
        let (_, state) = tokenize_line("code /* start", language, HighlightState::default());
        assert_eq!(state.block_comment, Some("*/"));
        let (tokens, next) = tokenize_line("still comment */ code()", language, state);
        assert_eq!(next.block_comment, None);
        assert_eq!(tokens[0], Token { start: 0, end: 16, kind: TokenType::Comment });
    }

    #[test]
    fn carries_template_literals_across_lines() {
        let language = get_language("typescript");
        let (_, state) = tokenize_line("const t = `line one", language, HighlightState::default());
        assert_eq!(state.string, Some('`'));
        let (_, next) = tokenize_line("line two`", language, state);
        assert_eq!(next.string, None);
    }

    #[test]
    fn handles_escapes_inside_strings() {
        assert_eq!(
            render("const s = \"a\\\"b\";", "javascript"),
            vec!["keyword:const", "operator:=", "string:\"a\\\"b\""]
        );
    }

    #[test]
    fn highlights_json_constants() {
        assert_eq!(
            render("{\"a\": true}", "json"),
            vec!["string:\"a\"", "operator::", "constant:true"]
        );
    }

    #[test]
    fn highlights_css_properties_and_selectors() {
        let tokens = render(".card { color: red; }", "css");
        assert!(tokens.contains(&"tag:.card".to_string()));
        assert!(tokens.contains(&"attribute:color".to_string()));
    }

    #[test]
    fn highlights_html_attributes_and_values() {
        let tokens = render("<a href=\"/x\">go</a>", "html");
        assert_eq!(tokens[0], "tag:<a ");
        assert!(tokens.contains(&"attribute:href".to_string()));
        assert!(tokens.contains(&"string:\"/x\"".to_string()));
        assert!(tokens.contains(&"tag:</a>".to_string()));
    }

    #[test]
    fn treats_sql_keywords_case_insensitively() {
        assert!(render("SELECT * FROM t", "sql").contains(&"keyword:SELECT".to_string()));
    }

    #[test]
    fn produces_no_tokens_for_plain_text() {
        assert!(render("just words", "plaintext").is_empty());
    }

    #[test]
    fn highlights_markdown_structure() {
        assert_eq!(render("## Title", "markdown"), vec!["heading:## Title"]);
        assert_eq!(render("- item", "markdown"), vec!["list:-"]);
        assert_eq!(
            render("a `code` and **bold**", "markdown"),
            vec!["code:`code`", "strong:**bold**"]
        );
    }

    #[test]
    fn marks_fenced_code_and_closes_it() {
        let language = get_language("markdown");
        let (_, open) = tokenize_line("```js", language, HighlightState::default());
        assert!(open.fence);
        let (inside, _) = tokenize_line("const x = 1;", language, open);
        assert_eq!(inside[0], Token { start: 0, end: 12, kind: TokenType::Code });
        let (_, close) = tokenize_line("```", language, open);
        assert!(!close.fence);
    }

    #[test]
    fn does_not_read_inline_markers_inside_a_fence() {
        let language = get_language("markdown");
        let (_, state) = tokenize_line("```", language, HighlightState::default());
        let (tokens, _) = tokenize_line("# not a heading", language, state);
        assert_eq!(tokens[0].kind, TokenType::Code);
    }

    #[test]
    fn tokenizes_a_window_with_replayed_state() {
        let lines = ["/* open", "still", "close */", "const a = 1;"];
        let tokenized = tokenize_lines(&lines, get_language("javascript"), 1, 4);
        assert_eq!(tokenized[0].0, 1);
        assert_eq!(tokenized[0].1[0].kind, TokenType::Comment);
        assert!(tokenized[2]
            .1
            .iter()
            .any(|token| token.kind == TokenType::Keyword));
    }

    #[test]
    fn flatten_lets_later_tokens_win() {
        let line = "abcdef";
        let flat = flatten_tokens(
            line,
            &[
                Token { start: 0, end: 4, kind: TokenType::Tag },
                Token { start: 2, end: 3, kind: TokenType::Attribute },
            ],
        );
        assert_eq!(
            flat,
            vec![
                Token { start: 0, end: 2, kind: TokenType::Tag },
                Token { start: 2, end: 3, kind: TokenType::Attribute },
                Token { start: 3, end: 4, kind: TokenType::Tag },
            ]
        );
    }

    #[test]
    fn flatten_ignores_out_of_range_tokens() {
        assert!(flatten_tokens("ab", &[Token { start: 5, end: 9, kind: TokenType::Str }]).is_empty());
    }

    #[test]
    fn token_offsets_stay_on_char_boundaries() {
        let line = "const s = \"héllo 😀\";";
        let language = get_language("javascript");
        let (tokens, _) = tokenize_line(line, language, HighlightState::default());
        for token in flatten_tokens(line, &tokens) {
            assert!(line.is_char_boundary(token.start));
            assert!(line.is_char_boundary(token.end));
        }
    }
}
