//! The only module that touches the filesystem.
//!
//! Behaviour is a deliberate mirror of `server/fileService.ts`: the same error
//! codes, the same JSON shape, and the same atomic write (temp file beside the
//! target, flushed, then renamed) so a crash leaves either the old file or the
//! new one — never a half-written buffer.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use actix_web::http::StatusCode;
use serde::Serialize;

use crate::error::ServerError;
use crate::paths;

pub const DEFAULT_MAX_BYTES: u64 = 10_000_000;

const IGNORED_ENTRIES: [&str; 4] = [".git", "node_modules", "target", ".DS_Store"];
const BINARY_SNIFF_BYTES: usize = 8_000;

/// How deep quick open looks below the folder it was asked about.
pub const WALK_DEPTH: usize = 6;
/// Hard cap on the entries a single walk collects.
pub const WALK_ENTRIES: usize = 4_000;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct FileServiceOptions {
    /// Directory that every request is confined to.
    pub root: PathBuf,
    /// Refuse to read or write files larger than this.
    pub max_bytes: u64,
    /// Serve reads only; writes answer 403.
    pub read_only: bool,
}

impl Default for FileServiceOptions {
    fn default() -> Self {
        Self {
            root: PathBuf::from("."),
            max_bytes: DEFAULT_MAX_BYTES,
            read_only: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FileRecord {
    pub path: String,
    pub name: String,
    pub text: String,
    pub size: u64,
    pub mtime: f64,
    #[serde(rename = "lineEnding")]
    pub line_ending: &'static str,
    #[serde(rename = "readOnly")]
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WriteResult {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TreeEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TreeResult {
    pub path: String,
    pub entries: Vec<TreeEntry>,
}

#[derive(Debug, Clone, Copy)]
pub struct HealthInfo {
    pub max_bytes: u64,
    pub read_only: bool,
}

#[derive(Debug, Clone)]
pub struct FileService {
    root: PathBuf,
    max_bytes: u64,
    read_only: bool,
}

impl FileService {
    pub fn new(options: FileServiceOptions) -> Result<Self, ServerError> {
        Ok(Self {
            root: paths::absolute(&options.root)?,
            max_bytes: options.max_bytes,
            read_only: options.read_only,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn max_bytes(&self) -> u64 {
        self.max_bytes
    }

    pub fn read_only(&self) -> bool {
        self.read_only
    }

    /// Resolve a request path to an absolute path inside the root.
    pub fn absolute(&self, relative: &str) -> Result<(String, PathBuf), ServerError> {
        let normalized = paths::assert_relative_path(relative)?;
        let absolute = paths::resolve_inside(&self.root, &normalized)?;
        Ok((normalized, absolute))
    }

    /// Guard against symlinks that point outside the workspace: the deepest
    /// existing ancestor of the target must still be inside the real root.
    fn assert_contained(&self, absolute: &Path) -> Result<(), ServerError> {
        let real_root = std::fs::canonicalize(&self.root)
            .map_err(|error| ServerError::from_io(&error))?;

        // Check the target itself first. Checking only its parent permits a final
        // symlink to point outside the workspace (notably on reads).
        if let Ok(real_target) = std::fs::canonicalize(absolute) {
            if !paths::is_inside(&real_root, &real_target) {
                return Err(ServerError::bad_path(
                    "Path escapes the workspace through a link.",
                ));
            }
            return Ok(());
        }

        // A new file may not exist yet. In that case validate the deepest
        // existing ancestor; canonicalize follows symlinks in every component.
        let mut probe = absolute.parent().unwrap_or(&self.root).to_path_buf();
        loop {
            match std::fs::canonicalize(&probe) {
                Ok(real) => {
                    if !paths::is_inside(&real_root, &real) {
                        return Err(ServerError::bad_path(
                            "Path escapes the workspace through a link.",
                        ));
                    }
                    return Ok(());
                }
                Err(_) => match probe.parent() {
                    Some(parent) if parent != probe => probe = parent.to_path_buf(),
                    _ => {
                        return Err(ServerError::bad_path(
                            "The workspace path could not be verified.",
                        ));
                    }
                },
            }
        }
    }

    pub fn read(&self, relative: &str) -> Result<FileRecord, ServerError> {
        let (normalized, absolute) = self.absolute(relative)?;
        self.assert_contained(&absolute)?;

        let meta = std::fs::metadata(&absolute).map_err(|error| ServerError::from_io(&error))?;
        if meta.is_dir() {
            return Err(ServerError::is_a_directory());
        }
        if !meta.is_file() {
            return Err(ServerError::new(
                StatusCode::BAD_REQUEST,
                "not_a_file",
                "That path is not a regular file.",
            ));
        }
        if meta.len() > self.max_bytes {
            return Err(ServerError::too_large(format!(
                "File is larger than {} bytes.",
                self.max_bytes
            )));
        }

        let bytes = std::fs::read(&absolute).map_err(|error| ServerError::from_io(&error))?;
        let head = &bytes[..bytes.len().min(BINARY_SNIFF_BYTES)];
        if head.contains(&0) {
            return Err(ServerError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "binary",
                "That file looks binary.",
            ));
        }
        let size = bytes.len() as u64;
        let text = String::from_utf8(bytes).map_err(|_| {
            ServerError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "binary",
                "That file is not valid UTF-8.",
            )
        })?;

        let line_ending = detect_line_ending(&text);
        Ok(FileRecord {
            path: normalized.clone(),
            name: paths::base_name(&normalized),
            text,
            size,
            mtime: mtime_ms(&meta),
            line_ending,
            read_only: self.read_only,
        })
    }

    pub fn write(
        &self,
        relative: &str,
        text: Option<&str>,
        create: bool,
    ) -> Result<WriteResult, ServerError> {
        if self.read_only {
            return Err(ServerError::read_only());
        }
        let Some(text) = text else {
            return Err(ServerError::new(
                StatusCode::BAD_REQUEST,
                "bad_body",
                "Expected a \"text\" string.",
            ));
        };

        let (normalized, absolute) = self.absolute(relative)?;
        let bytes = text.len() as u64;
        if bytes > self.max_bytes {
            return Err(ServerError::too_large(format!(
                "Refusing to write more than {} bytes.",
                self.max_bytes
            )));
        }

        self.assert_contained(&absolute)?;

        let existing = std::fs::metadata(&absolute).ok();
        if let Some(ref meta) = existing {
            if meta.is_dir() {
                return Err(ServerError::is_a_directory());
            }
        }
        if existing.is_none() && !create {
            return Err(ServerError::not_found("No such file. Create it first."));
        }
        if existing.is_none() {
            if let Some(parent) = absolute.parent() {
                std::fs::create_dir_all(parent).map_err(|error| ServerError::from_io(&error))?;
            }
        }

        let mode = existing.as_ref().and_then(mode_of);
        write_atomically(&absolute, text, mode)?;

        let meta = std::fs::metadata(&absolute).map_err(|error| ServerError::from_io(&error))?;
        Ok(WriteResult {
            path: normalized.clone(),
            name: paths::base_name(&normalized),
            size: meta.len(),
            mtime: mtime_ms(&meta),
        })
    }

    pub fn remove(&self, relative: &str) -> Result<String, ServerError> {
        if self.read_only {
            return Err(ServerError::read_only());
        }
        let (normalized, absolute) = self.absolute(relative)?;
        self.assert_contained(&absolute)?;
        std::fs::remove_file(&absolute).map_err(|error| ServerError::from_io(&error))?;
        Ok(normalized)
    }

    pub fn tree(&self, relative: &str) -> Result<TreeResult, ServerError> {
        let normalized = if relative.is_empty() || relative == "." {
            String::new()
        } else {
            paths::assert_relative_path(relative)?
        };
        let directory = if normalized.is_empty() {
            self.root.clone()
        } else {
            paths::resolve_inside(&self.root, &normalized)?
        };
        self.assert_contained(&directory)?;

        let read = std::fs::read_dir(&directory).map_err(|error| ServerError::from_io(&error))?;
        let mut entries = Vec::new();

        for item in read {
            let item = item.map_err(|error| ServerError::from_io(&error))?;
            let name = item.file_name().to_string_lossy().to_string();
            if IGNORED_ENTRIES.contains(&name.as_str()) {
                continue;
            }
            let entry_path = if normalized.is_empty() {
                name.clone()
            } else {
                format!("{normalized}/{name}")
            };
            let file_type = item
                .file_type()
                .map_err(|error| ServerError::from_io(&error))?;
            if file_type.is_dir() {
                entries.push(TreeEntry {
                    name,
                    path: entry_path,
                    kind: "dir",
                    size: None,
                });
            } else if file_type.is_file() {
                let size = item.metadata().map(|meta| meta.len()).unwrap_or(0);
                entries.push(TreeEntry {
                    name,
                    path: entry_path,
                    kind: "file",
                    size: Some(size),
                });
            }
        }

        entries.sort_by(|left, right| {
            if left.kind != right.kind {
                return if left.kind == "dir" {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Greater
                };
            }
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.name.cmp(&right.name))
        });

        Ok(TreeResult {
            path: normalized,
            entries,
        })
    }

    /// Recursively list `relative`, depth-first.
    ///
    /// Bounded on purpose: quick open is a convenience, not an indexer. It stops
    /// at `WALK_DEPTH` levels and `WALK_ENTRIES` entries so a huge tree cannot
    /// stall the page.
    pub fn walk(&self, relative: &str) -> Result<Vec<TreeEntry>, ServerError> {
        let mut entries = Vec::new();
        self.walk_into(relative, WALK_DEPTH, &mut entries)?;
        Ok(entries)
    }

    fn walk_into(
        &self,
        relative: &str,
        depth: usize,
        entries: &mut Vec<TreeEntry>,
    ) -> Result<(), ServerError> {
        if depth == 0 || entries.len() >= WALK_ENTRIES {
            return Ok(());
        }

        let listing = self.tree(if relative.is_empty() { "." } else { relative })?;
        for entry in listing.entries {
            if entries.len() >= WALK_ENTRIES {
                return Ok(());
            }
            let descend = entry.kind == "dir";
            let path = entry.path.clone();
            entries.push(entry);
            if descend {
                self.walk_into(&path, depth - 1, entries)?;
            }
        }
        Ok(())
    }

    pub fn health(&self) -> HealthInfo {
        HealthInfo {
            max_bytes: self.max_bytes,
            read_only: self.read_only,
        }
    }
}

/// `lf` unless CRLF line endings outnumber bare LF ones.
pub fn detect_line_ending(text: &str) -> &'static str {
    let bytes = text.as_bytes();
    let mut crlf = 0_usize;
    let mut lf = 0_usize;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            if index > 0 && bytes[index - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    if crlf > lf {
        "crlf"
    } else {
        "lf"
    }
}

/// Milliseconds since the Unix epoch, the same unit the TypeScript server sends.
pub fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[cfg(unix)]
fn mode_of(meta: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(meta.permissions().mode())
}

#[cfg(not(unix))]
fn mode_of(_meta: &std::fs::Metadata) -> Option<u32> {
    None
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(directory: &Path) {
    if let Ok(handle) = std::fs::File::open(directory) {
        let _ = handle.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Path) {}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos())
        .unwrap_or(0);
    let count = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{}.{:x}{:x}", std::process::id(), nanos, count)
}

/// Write via a temp file in the same directory, then rename over the target.
fn write_atomically(target: &Path, text: &str, mode: Option<u32>) -> Result<(), ServerError> {
    let directory = target.parent().unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let temp = directory.join(format!(".{name}.{}.tmp", unique_suffix()));

    let result = (|| -> std::io::Result<()> {
        let mut handle = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        handle.write_all(text.as_bytes())?;
        handle.sync_all()?;
        drop(handle);
        if let Some(mode) = mode {
            set_mode(&temp, mode)?;
        }
        std::fs::rename(&temp, target)?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            sync_directory(directory);
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            Err(ServerError::from_io(&error))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_line_endings() {
        assert_eq!(detect_line_ending("a\nb\n"), "lf");
        assert_eq!(detect_line_ending("a\r\nb\r\n"), "crlf");
        assert_eq!(detect_line_ending("no newlines"), "lf");
    }

    #[test]
    fn writes_leave_no_temp_files_behind() {
        let root = std::env::temp_dir().join(format!("wintercave-files-{}", unique_suffix()));
        std::fs::create_dir_all(&root).unwrap();
        let service = FileService::new(FileServiceOptions {
            root: root.clone(),
            max_bytes: 1024,
            read_only: false,
        })
        .unwrap();

        service.write("notes.md", Some("hello\n"), true).unwrap();
        service.write("notes.md", Some("hello again\n"), false).unwrap();

        let names: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .map(|item| item.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["notes.md".to_string()]);

        assert!(service.write("missing.md", Some("x"), false).is_err());
        let record = service.read("notes.md").unwrap();
        assert_eq!(record.text, "hello again\n");
        assert_eq!(record.line_ending, "lf");

        std::fs::remove_dir_all(&root).unwrap();
    }
}
