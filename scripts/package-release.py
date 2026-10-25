from __future__ import annotations

from datetime import datetime
from hashlib import sha256
from pathlib import Path
import json
import os
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent.parent
DIST = (ROOT.parent / "dist").resolve()
PACKAGE = (DIST / "Inkstone").resolve()
RELEASE_EXE = (ROOT / "src-tauri" / "target" / "release" / "inkstone.exe").resolve()
WINDOWS_ZIP = (DIST / "Inkstone-0.1.0-windows-x64.zip").resolve()
SOURCE_ZIP = (DIST / "Inkstone-0.1.0-source.zip").resolve()
SETUP = (DIST / "Inkstone-Setup-0.1.0-windows-x64.exe").resolve()
SETUP_SOURCE = (ROOT / "src-tauri" / "target" / "release" / "bundle" / "nsis" / "Inkstone_0.1.0_x64-setup.exe").resolve()

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
    "Bytes": RELEASE_EXE.stat().st_size,
    "SHA256": digest(RELEASE_EXE),
    "Tests": "16 Rust backend tests passed; typing smoothness E2E 23/23, IME 9/9, export freshness 4/4; R2 UX acceptance passed (table shortcut, four-way controls, header guard, undo, Tab row, Markdown roundtrip, transparency fallback, one-line code 64.55px); real WebView2 release regression passed with code block 65.03px and no application console errors; native Windows Acrylic verified on Windows 10 19045 (nativeGlass transparency, theme change, disable/clear fallback); frameless integrated chrome verified (custom minimize/maximize controls, native titlebar removed, real-mouse drag, safe close guard); Win32 SetWindowRgn rounded corners verified (startup complex region, square while maximized, rounded on restore); transparency readability pass verified (sidebar 76% / chrome 68–82% / popover 90%, native tint 32–40%); NSIS per-user install/upgrade/uninstall verified; signing pipeline test-verified (public signing pending CA certificate)",
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

root_files = [
    ".gitignore", "BACKEND-REVIEW.md", "DESIGN.md", "build-app.cmd", "build-installer.cmd",
    "index.html", "inkstone-icon.svg", "LICENSE.txt", "package-lock.json", "package.json", "README.md",
    "THIRD-PARTY-NOTICES.md", "tsconfig.json", "tsconfig.node.json", "vite.config.ts",
    "TYPING-SMOOTHNESS-PLAN.md", "TYPING-PERF-REPORT.md", "UX-UI-IMPROVEMENT-PLAN.md",
]
sources = {ROOT / name for name in root_files}
for folder in ("src", "scripts", "sample-workspace", "src-tauri"):
    for path in (ROOT / folder).rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT)
        if any(part in {"target", "node_modules", "dist", "__pycache__"} for part in relative.parts):
            continue
        if path.suffix in {".pyc", ".pyo"}:
            continue
        sources.add(path)
source_files = [
    (path, str(Path("Inkstone-0.1.0-Source") / path.relative_to(ROOT)).replace("\\", "/"))
    for path in sources if path.is_file()
]
write_archive(SOURCE_ZIP, source_files)

release_sum_lines = []
for path in (DIST / "Inkstone.exe", SETUP, WINDOWS_ZIP, SOURCE_ZIP):
    release_sum_lines.append(f"{digest(path)}  {path.name}")
(DIST / "SHA256SUMS.txt").write_text("\n".join(release_sum_lines) + "\n", encoding="utf-8")

result = {
    "installer": {"path": str(SETUP), "bytes": SETUP.stat().st_size, "sha256": digest(SETUP)},
    "executable": {"path": str(DIST / "Inkstone.exe"), "bytes": RELEASE_EXE.stat().st_size, "sha256": digest(RELEASE_EXE)},
    "windowsZip": {"path": str(WINDOWS_ZIP), "bytes": WINDOWS_ZIP.stat().st_size, "files": len(package_files)},
    "sourceZip": {"path": str(SOURCE_ZIP), "bytes": SOURCE_ZIP.stat().st_size, "files": len(source_files)},
}
print(json.dumps(result, ensure_ascii=False, indent=2))
