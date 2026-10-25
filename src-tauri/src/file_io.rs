use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::UNIX_EPOCH;
use tempfile::NamedTempFile;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExpectedFile {
    pub modified_ms: u64,
    pub size: u64,
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn conflict_error() -> String {
    "SAVE_CONFLICT:磁盘上的文件已变化。请重新打开文稿，或使用另存为保留当前内容。".into()
}

fn verify_expected(path: &Path, expected: Option<ExpectedFile>) -> Result<(), String> {
    let Some(expected) = expected else { return Ok(()); };
    let metadata = fs::metadata(path).map_err(|_| conflict_error())?;
    if modified_ms(&metadata) != expected.modified_ms || metadata.len() != expected.size {
        return Err(conflict_error());
    }
    Ok(())
}

fn prepare_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建目录 {}: {error}", parent.display()))?;
        }
    }
    Ok(())
}

/// Write through a temporary file in the destination directory, then atomically
/// replace the destination. Existing permissions are retained where possible.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_versioned(path, bytes, None)
}

pub fn atomic_write_versioned(
    path: &Path,
    bytes: &[u8],
    expected: Option<ExpectedFile>,
) -> Result<(), String> {
    prepare_parent(path)?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let existing = fs::metadata(path).ok();
    if expected.is_some() && existing.is_none() {
        return Err(conflict_error());
    }
    if let Some(expected) = expected {
        verify_expected(path, Some(expected))?;
    }
    if let Some(metadata) = &existing {
        if !metadata.is_file() {
            return Err(format!("保存目标不是文件: {}", path.display()));
        }
        if metadata.permissions().readonly() {
            return Err(format!("目标文件为只读，无法保存: {}", path.display()));
        }
    }

    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|error| format!("无法创建临时文件: {error}"))?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("无法完整写入临时文件: {error}"))?;

    if let Some(metadata) = existing {
        temporary
            .as_file()
            .set_permissions(metadata.permissions())
            .map_err(|error| format!("无法保留文件权限: {error}"))?;
    }
    verify_expected(path, expected)?;
    temporary
        .persist(path)
        .map_err(|error| format!("无法替换目标文件 {}: {}", path.display(), error.error))?;
    Ok(())
}

/// Create a new file without ever replacing an existing path.
pub fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    prepare_parent(path)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                format!("文件已存在: {}", path.display())
            } else {
                format!("无法创建文件 {}: {error}", path.display())
            }
        })?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("无法完整创建文件 {}: {error}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_replace_keeps_the_latest_complete_content() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.md");
        atomic_write(&path, b"first").unwrap();
        atomic_write(&path, b"second complete version").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second complete version");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn failed_replace_preserves_the_original_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("readonly.md");
        atomic_write(&path, b"original").unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions.clone()).unwrap();

        assert!(atomic_write(&path, b"must not replace").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);

        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
    }

    #[test]
    fn stale_generation_is_rejected_without_touching_the_current_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("versioned.md");
        atomic_write(&path, b"current").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        let stale = ExpectedFile {
            modified_ms: modified_ms(&metadata).saturating_add(1000),
            size: metadata.len(),
        };
        assert!(atomic_write_versioned(&path, b"stale edit", Some(stale)).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "current");

        let current = ExpectedFile {
            modified_ms: modified_ms(&metadata),
            size: metadata.len(),
        };
        atomic_write_versioned(&path, b"accepted", Some(current)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "accepted");
    }

    #[test]
    fn create_new_never_overwrites_existing_content() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("new.md");
        write_new_file(&path, b"original").unwrap();
        assert!(write_new_file(&path, b"replacement").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
    }
}
