mod file_io;
mod path_utils;

use file_io::{atomic_write, atomic_write_versioned, write_new_file, ExpectedFile};
use path_utils::validated_child_path;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager};
use walkdir::WalkDir;

#[cfg(target_os = "windows")]
mod window_shape {
    use std::ffi::c_void;

    type Hwnd = *mut c_void;
    type Hrgn = *mut c_void;

    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetWindowRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
        fn SetWindowRgn(hwnd: Hwnd, region: Hrgn, redraw: i32) -> i32;
        fn IsZoomed(hwnd: Hwnd) -> i32;
    }

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateRoundRectRgn(
            left: i32,
            top: i32,
            right: i32,
            bottom: i32,
            width: i32,
            height: i32,
        ) -> Hrgn;
        fn DeleteObject(object: *mut c_void) -> i32;
    }

    pub fn round_webview(window: &tauri::WebviewWindow) {
        if let Ok(hwnd) = window.hwnd() {
            apply(hwnd.0 as isize as Hwnd, window.scale_factor().unwrap_or(1.0));
        }
    }

    pub fn round_window(window: &tauri::Window) {
        if let Ok(hwnd) = window.hwnd() {
            apply(hwnd.0 as isize as Hwnd, window.scale_factor().unwrap_or(1.0));
        }
    }

    fn apply(hwnd: Hwnd, scale_factor: f64) {
        if hwnd.is_null() {
            return;
        }
        let mut rect = Rect::default();
        let measured = unsafe { GetWindowRect(hwnd, &mut rect) };
        if measured == 0 {
            return;
        }
        let width = (rect.right - rect.left).max(1);
        let height = (rect.bottom - rect.top).max(1);

        if unsafe { IsZoomed(hwnd) } != 0 {
            unsafe {
                SetWindowRgn(hwnd, std::ptr::null_mut(), 1);
            }
            return;
        }

        // 16 CSS-pixel radius. CreateRoundRectRgn expects the ellipse diameter.
        let diameter = ((32.0 * scale_factor).round() as i32).max(2);
        let region = unsafe { CreateRoundRectRgn(0, 0, width + 1, height + 1, diameter, diameter) };
        if region.is_null() {
            return;
        }
        let accepted = unsafe { SetWindowRgn(hwnd, region, 1) };
        if accepted == 0 {
            unsafe {
                DeleteObject(region);
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod window_shape {
    pub fn round_webview(_window: &tauri::WebviewWindow) {}
    pub fn round_window(_window: &tauri::Window) {}
}

static FILE_MUTATION_LOCK: Mutex<()> = Mutex::new(());
static IMAGE_COUNTER: AtomicU64 = AtomicU64::new(0);
const MAX_DIRECTORY_DEPTH: usize = 16;
const MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_EXPORT_BYTES: usize = 128 * 1024 * 1024;
const MAX_SEARCH_RESULTS: usize = 50;

fn file_mutation_guard() -> MutexGuard<'static, ()> {
    FILE_MUTATION_LOCK.lock().unwrap_or_else(|error| error.into_inner())
}

const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "txt"];
const SKIP_DIRECTORIES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    ".idea",
    ".vscode",
    ".obsidian",
    ".trash",
    "dist",
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<FileNode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextDocument {
    path: String,
    name: String,
    content: String,
    modified_ms: u64,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
    modified_ms: u64,
    size: u64,
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn is_markdown_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            MARKDOWN_EXTENSIONS
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        })
        .unwrap_or(false)
}

fn should_skip_dir(name: &str) -> bool {
    name.starts_with('.')
        || SKIP_DIRECTORIES
            .iter()
            .any(|candidate| name.eq_ignore_ascii_case(candidate))
}

fn read_directory(path: &Path, depth: usize) -> Result<Vec<FileNode>, String> {
    if depth > MAX_DIRECTORY_DEPTH {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(path).map_err(|error| format!("无法读取目录 {}: {error}", path.display()))?;
    let mut nodes = Vec::new();
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let Some(entry_path_text) = entry_path.to_str() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let metadata = match fs::symlink_metadata(&entry_path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            let children = read_directory(&entry_path, depth + 1).unwrap_or_default();
            nodes.push(FileNode {
                name,
                path: entry_path_text.to_string(),
                is_dir: true,
                children,
            });
        } else if metadata.is_file() && is_markdown_file(&entry_path) {
            nodes.push(FileNode {
                name,
                path: entry_path_text.to_string(),
                is_dir: false,
                children: Vec::new(),
            });
        }
    }
    nodes.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(nodes)
}

#[tauri::command(async)]
fn read_workspace(path: String) -> Result<Vec<FileNode>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("工作区不是目录: {path}"));
    }
    read_directory(&root, 0)
}

#[tauri::command(async)]
fn read_text_file(path: String) -> Result<TextDocument, String> {
    let file_path = PathBuf::from(&path);
    let metadata = fs::metadata(&file_path).map_err(|error| format!("无法读取文件信息: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("不是文件: {path}"));
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(format!("文件超过 64 MiB，无法安全打开: {path}"));
    }
    let content = fs::read_to_string(&file_path)
        .map_err(|error| format!("无法以 UTF-8 读取文件 {}: {error}", file_path.display()))?;
    Ok(TextDocument {
        path: file_path.to_string_lossy().to_string(),
        name: file_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "Untitled".into()),
        content,
        modified_ms: modified_ms(&metadata),
        size: metadata.len(),
    })
}

#[tauri::command(async)]
fn write_text_file(
    path: String,
    content: String,
    expected_modified_ms: Option<u64>,
    expected_size: Option<u64>,
) -> Result<SaveResult, String> {
    let _guard = file_mutation_guard();
    let file_path = PathBuf::from(&path);
    let expected = match (expected_modified_ms, expected_size) {
        (Some(modified_ms), Some(size)) => Some(ExpectedFile { modified_ms, size }),
        (None, None) => None,
        _ => return Err("保存版本信息不完整。".into()),
    };
    atomic_write_versioned(&file_path, content.as_bytes(), expected)?;
    let metadata = fs::metadata(&file_path).map_err(|error| format!("无法读取保存结果: {error}"))?;
    Ok(SaveResult {
        modified_ms: modified_ms(&metadata),
        size: metadata.len(),
    })
}

#[tauri::command(async)]
fn create_file(parent: String, name: String, content: String) -> Result<String, String> {
    let _guard = file_mutation_guard();
    let path = validated_child_path(Path::new(&parent), &name)?;
    write_new_file(&path, content.as_bytes())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command(async)]
fn create_folder(parent: String, name: String) -> Result<String, String> {
    let _guard = file_mutation_guard();
    let path = validated_child_path(Path::new(&parent), &name)?;
    fs::create_dir(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            format!("文件夹已存在: {}", path.display())
        } else {
            format!("无法创建文件夹: {error}")
        }
    })?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command(async)]
fn rename_path(path: String, new_name: String) -> Result<String, String> {
    let _guard = file_mutation_guard();
    let source = PathBuf::from(&path);
    if !source.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    let parent = source.parent().ok_or("无法确定父目录")?;
    let target = validated_child_path(parent, &new_name)?;
    if target.exists() {
        let same_file = match (fs::canonicalize(&source), fs::canonicalize(&target)) {
            (Ok(source), Ok(target)) => source == target,
            _ => false,
        };
        if !same_file {
            return Err(format!("目标已存在: {}", target.display()));
        }
        if source == target {
            return Ok(target.to_string_lossy().to_string());
        }
    }
    fs::rename(&source, &target).map_err(|error| format!("重命名失败: {error}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command(async)]
fn trash_path(path: String) -> Result<(), String> {
    let _guard = file_mutation_guard();
    trash::delete(PathBuf::from(&path)).map_err(|error| format!("无法移到回收站: {error}"))
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let argument = if target.is_dir() {
        target.to_string_lossy().to_string()
    } else {
        format!("/select,{}", target.to_string_lossy())
    };
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(argument)
            .spawn()
            .map_err(|error| format!("无法打开资源管理器: {error}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = argument;
        return Err("当前平台暂未实现打开资源管理器".into());
    }
    Ok(())
}

#[tauri::command(async)]
fn write_export(path: String, content: String) -> Result<(), String> {
    let _guard = file_mutation_guard();
    atomic_write(&PathBuf::from(&path), content.as_bytes())
}

#[tauri::command(async)]
fn write_export_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    if bytes.len() > MAX_EXPORT_BYTES {
        return Err("导出文件超过 128 MiB，无法写入。".into());
    }
    let _guard = file_mutation_guard();
    atomic_write(&PathBuf::from(&path), &bytes)
}

#[tauri::command(async)]
fn read_export_image(path: String) -> Result<Vec<u8>, String> {
    let file_path = PathBuf::from(&path);
    let metadata = fs::metadata(&file_path).map_err(|error| format!("无法读取图片信息: {error}"))?;
    if !metadata.is_file() {
        return Err("图片路径不是文件。".into());
    }
    if metadata.len() > MAX_IMAGE_BYTES as u64 {
        return Err("图片超过 64 MiB，无法嵌入导出。".into());
    }
    let bytes = fs::read(&file_path).map_err(|error| format!("无法读取图片 {}: {error}", file_path.display()))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片超过 64 MiB，无法嵌入导出。".into());
    }
    Ok(bytes)
}

#[tauri::command(async)]
fn save_image(workspace: String, file_name: String, bytes: Vec<u8>) -> Result<String, String> {
    let _guard = file_mutation_guard();
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片超过 64 MiB，无法保存。".into());
    }
    let workspace_path = PathBuf::from(&workspace);
    if !workspace_path.is_dir() {
        return Err("保存图片前需要先打开一个工作区。".into());
    }
    let canonical_workspace = fs::canonicalize(&workspace_path)
        .map_err(|error| format!("无法确认工作区位置: {error}"))?;
    let safe_name = Path::new(&file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("image.png");
    let extension = Path::new(safe_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].contains(&extension.as_str()) {
        return Err("不支持的图片格式。".into());
    }
    let stem_source = Path::new(safe_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let mut stem: String = stem_source
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .take(64)
        .collect();
    while stem.contains("--") {
        stem = stem.replace("--", "-");
    }
    stem = stem.trim_matches('-').to_string();
    if stem.is_empty() {
        stem = "image".into();
    }

    let assets = workspace_path.join("assets");
    match fs::symlink_metadata(&assets) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("图片目录不能是链接或非目录文件。".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&assets).map_err(|error| format!("无法创建图片目录: {error}"))?;
        }
        Err(error) => return Err(format!("无法检查图片目录: {error}")),
    }
    let canonical_assets = fs::canonicalize(&assets)
        .map_err(|error| format!("无法确认图片目录位置: {error}"))?;
    if !canonical_assets.starts_with(&canonical_workspace) {
        return Err("图片目录超出了当前工作区。".into());
    }

    let millis = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    for _ in 0..128 {
        let serial = IMAGE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let file_name = format!("{stem}-{millis}-{serial}.{extension}");
        let target = assets.join(&file_name);
        match write_new_file(&target, &bytes) {
            Ok(()) => return Ok(format!("assets/{file_name}")),
            Err(_) if target.exists() => continue,
            Err(error) => return Err(error),
        }
    }
    Err("无法分配唯一的图片文件名。".into())
}

#[tauri::command(async)]
fn search_workspace(root: String, query: String) -> Result<Vec<FileNode>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("搜索位置不是目录: {root}"));
    }
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let mut results = Vec::new();
    for entry in WalkDir::new(&root_path)
        .max_depth(MAX_DIRECTORY_DEPTH)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            if entry.file_type().is_symlink() {
                return false;
            }
            if entry.file_type().is_dir() {
                return !entry
                    .file_name()
                    .to_str()
                    .map(should_skip_dir)
                    .unwrap_or(false);
            }
            true
        })
        .flatten()
    {
        let path = entry.path();
        if entry.file_type().is_file() && is_markdown_file(path) {
            let Some(path_text) = path.to_str() else {
                continue;
            };
            if let Ok(content) = fs::read_to_string(path) {
                if content.to_lowercase().contains(&needle) {
                    results.push(FileNode {
                        name: path
                            .file_name()
                            .map(|name| name.to_string_lossy().to_string())
                            .unwrap_or_default(),
                        path: path_text.to_string(),
                        is_dir: false,
                        children: Vec::new(),
                    });
                    if results.len() >= MAX_SEARCH_RESULTS {
                        break;
                    }
                }
            }
        }
    }
    results.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(results)
}

#[tauri::command]
fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

// ------------------------------------------------------- launch / open with ---

#[derive(Default)]
struct OpenQueue {
    paths: Mutex<Vec<String>>,
    errors: Mutex<Vec<String>>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OpenPayload {
    paths: Vec<String>,
    errors: Vec<String>,
}

impl OpenPayload {
    fn is_empty(&self) -> bool {
        self.paths.is_empty() && self.errors.is_empty()
    }
}

/// Windows canonicalize returns \\?\C:\... — strip it so launch paths match
/// the paths the workspace tree already uses (and so the UI shows a real path).
fn strip_verbatim_prefix(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        value
    }
}

fn normalize_open_path(raw: &Path) -> Result<String, String> {
    let metadata = fs::metadata(raw).map_err(|_| format!("无法访问文件：{}", raw.display()))?;
    if !metadata.is_file() {
        return Err(format!("不是可打开的文件：{}", raw.display()));
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(format!("文件超过 64 MB，暂不支持：{}", raw.display()));
    }
    let extension = raw
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !MARKDOWN_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!(
            "不支持的文件类型（仅支持 Markdown / 文本）：{}",
            raw.display()
        ));
    }
    let canonical =
        fs::canonicalize(raw).map_err(|_| format!("无法解析路径：{}", raw.display()))?;
    Ok(strip_verbatim_prefix(&canonical))
}

/// Turn raw process arguments into validated files plus per-file error messages.
fn collect_open_payload(args: &[String]) -> OpenPayload {
    let mut payload = OpenPayload::default();
    for arg in args {
        let value = arg.trim();
        if value.is_empty() || value.starts_with('-') {
            continue;
        }
        match normalize_open_path(Path::new(value)) {
            Ok(path) => {
                if !payload.paths.iter().any(|item| item.eq_ignore_ascii_case(&path)) {
                    payload.paths.push(path);
                }
            }
            Err(message) => payload.errors.push(message),
        }
    }
    payload
}

fn queue_open_payload(queue: &OpenQueue, payload: OpenPayload) {
    let mut paths = queue.paths.lock().unwrap_or_else(|error| error.into_inner());
    for path in payload.paths {
        if !paths.iter().any(|item| item.eq_ignore_ascii_case(&path)) {
            paths.push(path);
        }
    }
    drop(paths);
    let mut errors = queue.errors.lock().unwrap_or_else(|error| error.into_inner());
    errors.extend(payload.errors);
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Probe whether the user can create files in a workspace. Used to show a
/// readable "read-only" state before the first failed save.
#[tauri::command]
fn workspace_writable(path: String) -> bool {
    let directory = PathBuf::from(&path);
    if !directory.is_dir() {
        return false;
    }
    let probe = directory.join(format!(".inkstone-write-probe-{}", std::process::id()));
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(file) => {
            drop(file);
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// The frontend calls this once after mounting, so an early file-open request
/// can never be lost to the "event fired before the page loaded" race.
#[tauri::command]
fn take_pending_open(state: tauri::State<OpenQueue>) -> OpenPayload {
    let paths = std::mem::take(&mut *state.paths.lock().unwrap_or_else(|error| error.into_inner()));
    let errors = std::mem::take(&mut *state.errors.lock().unwrap_or_else(|error| error.into_inner()));
    OpenPayload { paths, errors }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup_args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|value| value.to_string_lossy().to_string())
        .collect();
    let startup_payload = collect_open_payload(&startup_args);

    tauri::Builder::default()
        .manage(OpenQueue::default())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let payload = collect_open_payload(&argv.iter().skip(1).cloned().collect::<Vec<_>>());
            if payload.is_empty() {
                focus_main_window(app);
                return;
            }
            let queue = app.state::<OpenQueue>();
            queue_open_payload(&queue, payload.clone());
            let _ = app.emit("inkstone://open-paths", payload);
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let queue = app.state::<OpenQueue>();
            queue_open_payload(&queue, startup_payload);
            if let Some(window) = app.get_webview_window("main") {
                window_shape::round_webview(&window);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                window_shape::round_window(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_workspace,
            read_text_file,
            write_text_file,
            create_file,
            create_folder,
            rename_path,
            trash_path,
            reveal_in_explorer,
            write_export,
            write_export_bytes,
            read_export_image,
            save_image,
            search_workspace,
            get_platform,
            take_pending_open,
            workspace_writable
        ])
        .run(tauri::generate_context!())
        .expect("error while running Inkstone");
}


#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(label: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("inkstone-test-{label}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&path).expect("create temp workspace");
        path
    }

    #[test]
    fn workspace_document_roundtrip() {
        let root = temp_workspace("roundtrip");
        let path = root.join("hello.md");
        let path_text = path.to_string_lossy().to_string();
        let result = write_text_file(path_text.clone(), "# Hello\n\nWorld".into(), None, None)
            .expect("write document");
        assert!(result.size > 0);
        let document = read_text_file(path_text.clone()).expect("read document");
        assert_eq!(document.content, "# Hello\n\nWorld");
        let tree = read_workspace(root.to_string_lossy().to_string()).expect("read workspace");
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name, "hello.md");

        write_text_file(
            path_text.clone(),
            "# Updated".into(),
            Some(document.modified_ms),
            Some(document.size),
        )
        .expect("save current generation");
        let conflict = write_text_file(
            path_text.clone(),
            "stale edit".into(),
            Some(document.modified_ms),
            Some(document.size),
        )
        .err()
        .expect("stale generation must conflict");
        assert!(conflict.starts_with("SAVE_CONFLICT:"));
        assert_eq!(read_text_file(path_text).unwrap().content, "# Updated");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn create_rename_and_search() {
        let root = temp_workspace("files");
        let root_text = root.to_string_lossy().to_string();
        let file = create_file(root_text.clone(), "draft.md".into(), "needle in the haystack".into())
            .expect("create file");
        let folder = create_folder(root_text.clone(), "notes".into()).expect("create folder");
        assert!(create_file(root_text.clone(), "draft.md".into(), "replacement".into()).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "needle in the haystack");
        let renamed = rename_path(file.clone(), "final.md".into()).expect("rename file");
        assert!(Path::new(&renamed).exists());
        assert!(!Path::new(&file).exists());
        assert!(Path::new(&folder).is_dir());
        let matches = search_workspace(root_text.clone(), "needle".into()).expect("search");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].name, "final.md");
        let export = root.join("export.html");
        write_export(export.to_string_lossy().to_string(), "<h1>ok</h1>".into()).expect("export");
        assert!(export.exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn image_is_saved_inside_workspace_assets() {
        let root = temp_workspace("images");
        let relative = save_image(
            root.to_string_lossy().to_string(),
            "a photo with spaces.png".into(),
            vec![137, 80, 78, 71],
        )
        .expect("save image");
        assert!(relative.starts_with("assets/"));
        let target = root.join(&relative);
        assert!(target.exists());
        assert_eq!(fs::read(target).expect("read image"), vec![137, 80, 78, 71]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn image_names_are_unique_and_preserve_unicode() {
        let root = temp_workspace("image-unique");
        let first = save_image(root.to_string_lossy().to_string(), "中文 图片.png".into(), vec![1])
            .expect("first image");
        let second = save_image(root.to_string_lossy().to_string(), "中文 图片.png".into(), vec![2])
            .expect("second image");
        assert_ne!(first, second);
        assert!(first.contains("中文-图片"));
        assert_eq!(fs::read(root.join(first)).unwrap(), vec![1]);
        assert_eq!(fs::read(root.join(second)).unwrap(), vec![2]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn binary_export_and_image_read_roundtrip() {
        let root = temp_workspace("binary-export");
        let path = root.join("document.docx");
        let bytes = vec![80, 75, 3, 4, 0, 255];
        write_export_bytes(path.to_string_lossy().to_string(), bytes.clone()).expect("binary export");
        assert_eq!(read_export_image(path.to_string_lossy().to_string()).unwrap(), bytes);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn search_includes_hidden_files_and_deep_documents() {
        let parent = temp_workspace("search-rules");
        let root = parent.join("target");
        fs::create_dir(&root).unwrap();
        fs::write(root.join(".hidden.md"), "needle hidden").unwrap();
        let mut deep = root.clone();
        for index in 0..13 {
            deep = deep.join(format!("level-{index}"));
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("deep.md"), "needle deep").unwrap();
        let matches = search_workspace(root.to_string_lossy().to_string(), "needle".into()).unwrap();
        assert_eq!(matches.len(), 2);
        assert!(matches.iter().any(|item| item.name == ".hidden.md"));
        assert!(matches.iter().any(|item| item.name == "deep.md"));
        assert!(search_workspace(parent.join("missing").to_string_lossy().to_string(), "needle".into()).is_err());
        fs::remove_dir_all(&parent).ok();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_special_names_cannot_escape_or_replace() {
        let root = temp_workspace("windows-names");
        let root_text = root.to_string_lossy().to_string();
        let source = create_file(root_text.clone(), "source.md".into(), "original".into()).unwrap();
        for name in ["C:inkstone-outside.md", "file:ads", "CON.md", "name. "] {
            assert!(create_file(root_text.clone(), name.into(), "outside".into()).is_err());
            assert!(create_folder(root_text.clone(), name.into()).is_err());
            assert!(rename_path(source.clone(), name.into()).is_err());
        }
        assert_eq!(fs::read_to_string(&source).unwrap(), "original");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(&root).ok();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_case_only_rename_preserves_content() {
        let root = temp_workspace("case-rename");
        let file = create_file(root.to_string_lossy().to_string(), "note.md".into(), "content".into()).unwrap();
        let renamed = rename_path(file, "Note.md".into()).expect("case-only rename");
        assert_eq!(fs::read_to_string(renamed).unwrap(), "content");
        fs::remove_dir_all(&root).ok();
    }
}

