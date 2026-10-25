use std::path::{Component, Path, PathBuf};

pub fn validated_child_path(parent: &Path, value: &str) -> Result<PathBuf, String> {
    let name = validate_child_name(value)?;
    let path = parent.join(name);
    if path.parent() != Some(parent) {
        return Err("名称解析后超出了目标目录。".into());
    }
    Ok(path)
}

/// Validate a user-provided child name before joining it to a parent directory.
/// Returns the trimmed name so callers keep the existing UI behaviour.
pub fn validate_child_name(value: &str) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    if value.ends_with([' ', '.']) {
        return Err("Windows 名称不能以空格或点结尾。".into());
    }

    let name = value.trim();
    if name.is_empty() {
        return Err("名称不能为空。".into());
    }
    if name.contains(['/', '\\']) {
        return Err("名称不能包含路径分隔符。".into());
    }

    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("名称必须是单个文件或文件夹名称，不能包含路径。".into());
    }

    #[cfg(target_os = "windows")]
    validate_windows_name(name)?;

    Ok(name.to_string())
}

#[cfg(target_os = "windows")]
fn validate_windows_name(name: &str) -> Result<(), String> {
    if name.chars().any(|character| {
        character <= '\u{1f}'
            || matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    }) {
        return Err("名称包含 Windows 不允许的字符。".into());
    }

    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        "COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³",
    ];
    if RESERVED.contains(&stem.as_str()) {
        return Err("名称是 Windows 保留设备名，请换一个名称。".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_child_name, validated_child_path};
    use std::path::Path;

    #[test]
    fn accepts_one_normal_unicode_component() {
        assert_eq!(validate_child_name("  写作笔记.md").unwrap(), "写作笔记.md");
        assert_eq!(validate_child_name("notes").unwrap(), "notes");
    }

    #[test]
    fn rejects_empty_nested_and_special_components() {
        for value in ["", "  ", ".", "..", "folder/a.md", "folder\\a.md", "/rooted"] {
            assert!(validate_child_name(value).is_err(), "should reject {:?}", value);
        }
    }

    #[test]
    fn joining_never_replaces_the_parent() {
        let parent = Path::new("workspace");
        assert_eq!(validated_child_path(parent, "note.md").unwrap(), parent.join("note.md"));
        for value in ["..", "folder/note.md", "/outside.md"] {
            assert!(validated_child_path(parent, value).is_err());
        }
        #[cfg(target_os = "windows")]
        assert!(validated_child_path(parent, "C:outside.md").is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_windows_escape_device_and_syntax_names() {
        for value in [
            "C:inkstone-outside.md",
            "C:\\outside.md",
            "note.md:stream",
            "CON",
            "con.md",
            "LPT1.md",
            "trailing.",
            "trailing ",
            "question?.md",
        ] {
            assert!(validate_child_name(value).is_err(), "should reject {:?}", value);
        }
    }
}
