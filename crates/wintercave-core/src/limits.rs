//! Size policy. These numbers are the difference between "an editor" and
//! "a tab that hangs", so they live in the core where they can be tested.

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Above this, opening warns: highlighting may be reduced.
    pub warn_bytes: usize,
    /// Above this, refuse to open unless the user insists (read-only).
    pub refuse_bytes: usize,
    /// Highlighting is windowed, so these only guard pathological documents.
    pub highlight_bytes: usize,
    pub highlight_lines: usize,
    /// Total budget for the crash-recovery journal.
    pub journal_bytes: usize,
    pub journal_entries: usize,
    /// Saved versions kept per file for the local timeline.
    pub history_snapshots: usize,
    pub history_snapshot_bytes: usize,
}

pub const LIMITS: Limits = Limits {
    warn_bytes: 5_000_000,
    refuse_bytes: 50_000_000,
    highlight_bytes: 10_000_000,
    highlight_lines: 200_000,
    journal_bytes: 2_000_000,
    journal_entries: 12,
    history_snapshots: 20,
    history_snapshot_bytes: 400_000,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SizeClass {
    Ok,
    Warn,
    Refuse,
}

pub fn classify_size(bytes: usize) -> SizeClass {
    if bytes >= LIMITS.refuse_bytes {
        SizeClass::Refuse
    } else if bytes >= LIMITS.warn_bytes {
        SizeClass::Warn
    } else {
        SizeClass::Ok
    }
}

pub fn should_highlight(bytes: usize, line_count: usize) -> bool {
    bytes <= LIMITS.highlight_bytes && line_count <= LIMITS.highlight_lines
}

pub fn format_bytes(bytes: usize) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let value = bytes as f64;
    if value < KB {
        format!("{bytes} B")
    } else if value < MB {
        format!("{:.1} KB", value / KB)
    } else {
        format!("{:.1} MB", value / MB)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_sizes() {
        assert_eq!(classify_size(0), SizeClass::Ok);
        assert_eq!(classify_size(4_999_999), SizeClass::Ok);
        assert_eq!(classify_size(5_000_000), SizeClass::Warn);
        assert_eq!(classify_size(49_999_999), SizeClass::Warn);
        assert_eq!(classify_size(50_000_000), SizeClass::Refuse);
    }

    #[test]
    fn guards_highlighting() {
        assert!(should_highlight(1_000, 10));
        assert!(!should_highlight(10_000_001, 10));
        assert!(!should_highlight(1_000, 200_001));
    }

    #[test]
    fn formats_byte_sizes() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(5 * 1024 * 1024), "5.0 MB");
    }
}
