//! Percent and form decoding, shared by the URL handlers and the no-JS form.

/// Percent-decode a request path or query value. `None` means malformed input.
pub fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                if index + 2 >= bytes.len() {
                    return None;
                }
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// Parse an `application/x-www-form-urlencoded` body into key/value pairs.
/// The no-JS save form is the only client of this.
pub fn parse_form(body: &[u8]) -> Vec<(String, String)> {
    let text = String::from_utf8_lossy(body);
    let mut fields = Vec::new();
    for pair in text.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (raw_key, raw_value) = match pair.split_once('=') {
            Some((key, value)) => (key, value),
            None => (pair, ""),
        };
        let key = percent_decode(&raw_key.replace('+', " ")).unwrap_or_default();
        let value = percent_decode(&raw_value.replace('+', " ")).unwrap_or_default();
        fields.push((key, value));
    }
    fields
}

/// Percent-encode everything outside the unreserved set, for building links.
pub fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for &byte in input.as_bytes() {
        let unreserved =
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/');
        if unreserved {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_percent_escapes_and_rejects_malformed_input() {
        assert_eq!(percent_decode("/a%20b").unwrap(), "/a b");
        assert_eq!(percent_decode("/plain").unwrap(), "/plain");
        assert!(percent_decode("/bad%2").is_none());
        assert!(percent_decode("/bad%zz").is_none());
    }

    #[test]
    fn parses_form_bodies() {
        let fields = parse_form(b"text=hello+world&other=%2Ftmp");
        assert_eq!(
            fields,
            vec![
                ("text".to_string(), "hello world".to_string()),
                ("other".to_string(), "/tmp".to_string())
            ]
        );
    }

    #[test]
    fn encodes_paths_for_links() {
        assert_eq!(percent_encode("sub/dir/a b.txt"), "sub/dir/a%20b.txt");
        assert_eq!(percent_encode("notes.md"), "notes.md");
    }
}
