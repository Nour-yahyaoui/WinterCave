//! Path handling for the file API — the same rules as `server/paths.ts`.
//!
//! The rule is boring on purpose: every request resolves to something inside the
//! workspace root, or it is rejected. No `..`, no absolute paths, no NUL bytes.
//! A rejected path never reaches the filesystem.

use std::path::{Component, Path, PathBuf};

use crate::error::ServerError;

const MAX_RELATIVE_LENGTH: usize = 4096;

/// Fold `.` and `..` lexically, without touching the filesystem.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Turn a possibly relative path into an absolute, lexically normalised one.
pub fn absolute(path: &Path) -> Result<PathBuf, ServerError> {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| ServerError::from_io(&error))?
            .join(path)
    };
    Ok(normalize(&joined))
}

/// Validate a client-supplied relative path without touching the disk.
pub fn assert_relative_path(requested: &str) -> Result<String, ServerError> {
    if requested.is_empty() {
        return Err(ServerError::bad_path("A file path is required."));
    }
    if requested.chars().count() > MAX_RELATIVE_LENGTH {
        return Err(ServerError::bad_path("Path is too long."));
    }
    if requested.contains('\0') {
        return Err(ServerError::bad_path("Path contains a NUL byte."));
    }

    let normalized = requested.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(ServerError::bad_path("Absolute paths are not allowed."));
    }

    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(ServerError::bad_path("Absolute paths are not allowed."));
    }

    for segment in normalized.split('/') {
        if segment == ".." {
            return Err(ServerError::bad_path("Path escapes the workspace."));
        }
        if segment.is_empty() || segment == "." {
            return Err(ServerError::bad_path("Path contains an empty segment."));
        }
    }

    Ok(normalized)
}

/// Join a validated relative path to the root, defending against prefix tricks.
pub fn resolve_inside(root: &Path, relative: &str) -> Result<PathBuf, ServerError> {
    let target = normalize(&root.join(relative));
    if !is_inside(root, &target) {
        return Err(ServerError::bad_path("Path escapes the workspace."));
    }
    Ok(target)
}

/// True when `candidate` is inside (or equal to) `root`.
pub fn is_inside(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

/// `foo/bar.txt` goes to `bar.txt`, `foo/bar/` goes to `bar`.
pub fn base_name(relative: &str) -> String {
    let normalized = relative.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    match trimmed.rsplit('/').next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => trimmed.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_absolute_and_traversal_paths() {
        assert!(assert_relative_path("").is_err());
        assert!(assert_relative_path("/etc/passwd").is_err());
        assert!(assert_relative_path("C:/windows").is_err());
        assert!(assert_relative_path("../outside.txt").is_err());
        assert!(assert_relative_path("a/../../outside.txt").is_err());
        assert!(assert_relative_path("a//b").is_err());
        assert!(assert_relative_path("./a").is_err());
        assert!(assert_relative_path("a\0b").is_err());
    }

    #[test]
    fn accepts_nested_relative_paths_and_normalises_separators() {
        assert_eq!(assert_relative_path("notes.md").unwrap(), "notes.md");
        assert_eq!(
            assert_relative_path("sub\\dir\\deep.txt").unwrap(),
            "sub/dir/deep.txt"
        );
    }

    #[test]
    fn resolve_keeps_everything_inside_the_root() {
        let root = Path::new("/srv/workspace");
        assert_eq!(
            resolve_inside(root, "a/b.txt").unwrap(),
            Path::new("/srv/workspace/a/b.txt")
        );
        // A sibling directory that merely shares a prefix is not inside.
        assert!(!is_inside(root, Path::new("/srv/workspace-evil")));
        assert!(is_inside(root, Path::new("/srv/workspace/a")));
        assert!(is_inside(root, root));
    }

    #[test]
    fn normalize_folds_dots() {
        assert_eq!(
            normalize(Path::new("/a/./b/../c")),
            Path::new("/a/c").to_path_buf()
        );
    }

    #[test]
    fn base_name_strips_directories() {
        assert_eq!(base_name("sub/dir/deep.txt"), "deep.txt");
        assert_eq!(base_name("sub/dir/"), "dir");
        assert_eq!(base_name("notes.md"), "notes.md");
    }
}
