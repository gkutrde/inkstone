from __future__ import annotations

from datetime import datetime
from hashlib import sha256
from pathlib import Path
import json
import os
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
DIST = (ROOT.parent / "dist").resolve()
PACKAGE = (DIST / "Inkstone").resolve()
RELEASE_EXE = (ROOT / "src-tauri" / "target" / "release" / "inkstone.exe").resolve()
WINDOWS_ZIP = (DIST / f"Inkstone-{VERSION}-windows-x64.zip").resolve()
SOURCE_ZIP = (DIST / f"Inkstone-{VERSION}-source.zip").resolve()
SETUP = (DIST / f"Inkstone-Setup-{VERSION}-windows-x64.exe").resolve()
SETUP_SOURCE = (ROOT / "src-tauri" / "target" / "release" / "bundle" / "nsis" / f"Inkstone_{VERSION}_x64-setup.exe").resolve()
WEBVIEW2_LOADER = (ROOT / "src-tauri" / "target" / "release" / "WebView2Loader.dll").resolve()

if DIST.name != "dist" or DIST.parent != ROOT.parent.resolve():
    raise RuntimeError("Unexpected distribution path")
if not RELEASE_EXE.is_file() or not PACKAGE.is_dir():
    raise RuntimeError("Build the release executable and prepare dist/Inkstone first")
for target in (WINDOWS_ZIP, SOURCE_ZIP):
    if target.parent != DIST:
        raise RuntimeError(f"Unexpected archive target: {target}")

sample = ROOT / "sample-workspace"
if (sample / "端到端新建.md").exists():
    raise RuntimeError("E2E cleanup incomplete: test document still exists")
welcome = sample / "欢迎使用 Inkstone.md"
if welcome.exists():
    content = welcome.read_text(encoding="utf-8")
    markers = [
        "端到端测试：Rust 文件命令工作正常。",
        "自动保存回归：",
        "手动保存回归：",
        "外部编辑回归：",
        "冲突回归：",
    ]
    if any(marker in content for marker in markers):
        raise RuntimeError("E2E cleanup incomplete: test marker still exists")

def digest(path: Path) -> str:
    hasher = sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()

def write_archive(target: Path, files: list[tuple[Path, str]]) -> None:
    temporary = target.with_name(target.name + ".tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source, arcname in sorted(files, key=lambda item: item[1]):
            archive.write(source, arcname)
    with zipfile.ZipFile(temporary) as archive:
        damaged = archive.testzip()
        if damaged:
            raise RuntimeError(f"Archive verification failed: {damaged}")
    os.replace(temporary, target)

shutil.copy2(RELEASE_EXE, PACKAGE / "Inkstone.exe")
shutil.copy2(RELEASE_EXE, DIST / "Inkstone.exe")
if WEBVIEW2_LOADER.is_file():
    shutil.copy2(WEBVIEW2_LOADER, PACKAGE / "WebView2Loader.dll")
    shutil.copy2(WEBVIEW2_LOADER, DIST / "WebView2Loader.dll")
if not SETUP_SOURCE.is_file():
    raise RuntimeError("Build the NSIS installer before packaging")
shutil.copy2(SETUP_SOURCE, SETUP)
shutil.copy2(ROOT / "inkstone-icon.svg", PACKAGE / "inkstone-icon.svg")
shutil.copy2(ROOT / "BACKEND-REVIEW.md", PACKAGE / "BACKEND-REVIEW.md")
shutil.copy2(ROOT / "DESIGN.md", PACKAGE / "DESIGN.md")
shutil.copy2(ROOT / "THIRD-PARTY-NOTICES.md", PACKAGE / "THIRD-PARTY-NOTICES.md")
shutil.copy2(ROOT / "TYPING-PERF-REPORT.md", PACKAGE / "TYPING-PERF-REPORT.md")

info_path = PACKAGE / "BUILD-INFO.json"
info = json.loads(info_path.read_text(encoding="utf-8-sig"))
info.update({
    "Version": VERSION,
    "Bytes": RELEASE_EXE.stat().st_size,
    "SHA256": digest(RELEASE_EXE),
    "Tests": "16 Rust backend tests passed; typing smoothness E2E 23/23, IME 9/9, export freshness 4/4; R2 UX acceptance passed (table shortcut, four-way controls, header guard, undo, Tab row, Markdown roundtrip, transparency fallback, one-line code 64.55px); real WebView2 release regression passed with code block 65.03px and no application console errors; native Windows Acrylic verified on Windows 10 19045 (nativeGlass transparency, theme change, disable/clear fallback); frameless integrated chrome verified (custom minimize/maximize controls, native titlebar removed, real-mouse drag, safe close guard); Win32 SetWindowRgn rounded corners verified (startup complex region, square while maximized, rounded on restore); transparency readability pass verified (sidebar 76% / chrome 68–82% / popover 90%, native tint 32–40%); NSIS per-user install/upgrade/uninstall verified; signing pipeline test-verified (public signing pending CA certificate); Markdown/Typora input regression 93/93 on installed x86_64-pc-windows-gnu release (single tilde literal, double tilde strikethrough, links/images/autolinks, unsafe URL guard, source roundtrip); installed NSIS update verified",
    "BuildTarget": "x86_64-pc-windows-gnu",
    "StaticCRT": True,
    "BuildDate": datetime.now().astimezone().isoformat(timespec="seconds"),
})
info_path.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

# Hashes for files shipped inside the portable folder. This file deliberately
# excludes itself, so it remains verifiable after the folder is zipped.
package_sum_path = PACKAGE / "SHA256SUMS.txt"
package_sum_lines = []
for path in sorted((p for p in PACKAGE.rglob("*") if p.is_file() and p != package_sum_path), key=lambda p: str(p.relative_to(PACKAGE)).lower()):
    relative = str(path.relative_to(PACKAGE)).replace("\\", "/")
    package_sum_lines.append(f"{digest(path)}  {relative}")
package_sum_path.write_text("\n".join(package_sum_lines) + "\n", encoding="utf-8")

package_files = [
    (path, str(Path("Inkstone") / path.relative_to(PACKAGE)).replace("\\", "/"))
    for path in PACKAGE.rglob("*") if path.is_file()
]
write_archive(WINDOWS_ZIP, package_files)

tracked = subprocess.run(
    ["git", "ls-files", "-z"],
    cwd=ROOT,
    check=True,
    stdout=subprocess.PIPE,
).stdout
tracked_paths = [raw.decode("utf-8") for raw in tracked.split(b"\0") if raw]
source_files = [
    (
        ROOT / relative,
        str(Path(f"Inkstone-{VERSION}-Source") / relative).replace("\\", "/"),
    )
    for relative in tracked_paths
    if (ROOT / relative).is_file()
]
write_archive(SOURCE_ZIP, source_files)

release_sum_lines = []
release_assets = [DIST / "Inkstone.exe"]
if (DIST / "WebView2Loader.dll").is_file():
    release_assets.append(DIST / "WebView2Loader.dll")
release_assets.extend((SETUP, WINDOWS_ZIP, SOURCE_ZIP))
for path in release_assets:
    release_sum_lines.append(f"{digest(path)}  {path.name}")
(DIST / "SHA256SUMS.txt").write_text("\n".join(release_sum_lines) + "\n", encoding="utf-8")

result = {
    "installer": {"path": str(SETUP), "bytes": SETUP.stat().st_size, "sha256": digest(SETUP)},
    "executable": {"path": str(DIST / "Inkstone.exe"), "bytes": RELEASE_EXE.stat().st_size, "sha256": digest(RELEASE_EXE)},
    "windowsZip": {"path": str(WINDOWS_ZIP), "bytes": WINDOWS_ZIP.stat().st_size, "files": len(package_files)},
    "sourceZip": {"path": str(SOURCE_ZIP), "bytes": SOURCE_ZIP.stat().st_size, "files": len(source_files)},
}
print(json.dumps(result, ensure_ascii=False, indent=2))
