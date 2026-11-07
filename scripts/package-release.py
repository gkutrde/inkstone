from __future__ import annotations
import argparse
from datetime import datetime
from hashlib import sha256
from pathlib import Path
import json
import os
import posixpath
import re
from urllib.parse import quote
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']

def digest(path: Path) -> str:
    h = sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def write_archive(target: Path, files: list[tuple[Path, str]]) -> None:
    temporary = target.with_name(target.name + '.tmp')
    with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for source, name in sorted(files, key=lambda x: x[1]):
            z.write(source, name)
    with zipfile.ZipFile(temporary) as z:
        bad = z.testzip()
        if bad:
            raise RuntimeError('Archive verification failed: ' + bad)
    os.replace(temporary, target)

def main() -> None:
    parser = argparse.ArgumentParser(description='Package built Inkstone artifacts without historical test claims.')
    parser.add_argument('--out-dir', type=Path, default=ROOT.parent / 'dist')
    parser.add_argument('--build-dir', type=Path, default=ROOT / 'src-tauri/target/release')
    parser.add_argument('--target', default='not recorded')
    parser.add_argument('--verification', type=Path, help='Fresh verification JSON; never reuse an old BUILD-INFO.')
    args = parser.parse_args()
    dist = args.out_dir.resolve()
    if dist == ROOT or dist == ROOT.parent or dist == Path(dist.anchor):
        raise RuntimeError('Unsafe distribution directory')
    build = args.build_dir.resolve()
    exe = build / 'inkstone.exe'
    loader = build / 'WebView2Loader.dll'
    if not loader.is_file():
        loader = ROOT / 'src-tauri/WebView2Loader.dll'
    setup = build / 'bundle/nsis' / f'Inkstone_{VERSION}_x64-setup.exe'
    for path in (exe, loader, setup):
        if not path.is_file():
            raise RuntimeError('Missing built artifact: ' + str(path))
    verification = {'version': VERSION, 'summary': 'No verification record supplied.'}
    if args.verification:
        verification = json.loads(args.verification.read_text(encoding='utf-8'))
        if verification.get('executable_sha256') != digest(exe):
            raise RuntimeError('Verification executable hash does not match the built artifact')
        if verification.get('version') != VERSION:
            raise RuntimeError('Verification version does not match package version')
        if not verification.get('checks') or not all(c.get('passed') is True for c in verification['checks']):
            raise RuntimeError('Verification has missing or failing release checks')
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode('utf-8').rstrip('\0').split('\0')
    required = {'src/ios.css', 'src/components/IosIcons.tsx', 'src/lib/codeTheme.ts', 'src/lib/editorFloatingMenus.ts', 'pnpm-lock.yaml'}
    if not required.issubset(tracked):
        raise RuntimeError('Stage the intended new source files before creating the source ZIP')
    source_files = []
    for name in tracked:
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts or name.startswith(('.git/', 'node_modules/', 'src-tauri/target/')):
            raise RuntimeError('Unexpected tracked path: ' + name)
        path = ROOT / relative
        if not path.is_file() or path.is_symlink():
            raise RuntimeError('Missing or symlinked tracked source: ' + name)
        source_files.append((path, f'Inkstone-{VERSION}-Source/' + relative.as_posix()))
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=ROOT).strip())
    dist.mkdir(parents=True, exist_ok=True)
    package = dist / 'Inkstone'
    package.mkdir(exist_ok=True)
    files: list[tuple[Path, str]] = []
    def ship(source: Path, name: str) -> None:
        target = package / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        files.append((target, name))
    ship(exe, 'Inkstone.exe')
    ship(loader, 'WebView2Loader.dll')
    for name in ['LICENSE.txt', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md', 'docs/IOS-REDESIGN.md', 'docs/RELEASE-0.1.3.md', 'docs/v0.1.2-editor-paper.png', 'docs/v0.1.3-editor-paper.png', 'docs/v0.1.3-welcome-paper.png', 'docs/v0.1.3-language-before.png', 'docs/v0.1.3-language-after.png']:
        source = ROOT / name
        if source.is_file():
            ship(source, name)
    readme = package / 'README.txt'
    readme.write_text('Inkstone ' + VERSION + '\n\n运行 Inkstone.exe。需要 Windows x64 和 Microsoft Edge WebView2。\n安装版、便携版使用相同应用标识；升级不会主动清除草稿、文稿或设置。\n本发行物未做 Authenticode 签名，Windows SmartScreen 可能显示未知发布者。\n本轮验证范围与限制见 BUILD-INFO.json 和 docs/RELEASE-0.1.3.md。\n', encoding='utf-8')
    files.append((readme, readme.name))
    # Developer references belong to the versioned source tree, not the portable runtime.
    shipped = {name for _, name in files}
    for target, name in files:
        if target.suffix != '.md':
            continue
        def reference(match):
            link = match.group(1)
            if '://' in link or link.startswith(('mailto:', '#')):
                return match.group(0)
            path, separator, fragment = link.strip('<>').partition('#')
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), path))
            if resolved in shipped:
                return match.group(0)
            if resolved not in tracked:
                raise RuntimeError('Unresolved portable documentation reference: ' + resolved)
            url = f'https://github.com/gkutrde/inkstone/blob/v{VERSION}/' + quote(resolved, safe='/')
            if separator:
                url += '#' + fragment
            return match.group(0).replace(link, url, 1)
        text = target.read_text(encoding='utf-8')
        target.write_text(re.sub(r'!?\[[^\]]*\]\(([^)]+)\)', reference, text), encoding='utf-8')
    info = {'Name': 'Inkstone', 'Version': VERSION, 'Platform': 'Windows x86_64',
            'Executable': 'Inkstone.exe', 'Bytes': exe.stat().st_size, 'SHA256': digest(exe),
            'SourceCommit': commit, 'TrackedWorkingTreeDirty': dirty, 'BuildTarget': args.target,
            'BuildDate': datetime.fromtimestamp(exe.stat().st_mtime).astimezone().isoformat(timespec='seconds'),
            'PackagedAt': datetime.now().astimezone().isoformat(timespec='seconds'),
            'Verification': verification}
    info_path = package / 'BUILD-INFO.json'
    info_path.write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    files.append((info_path, info_path.name))
    sums = package / 'SHA256SUMS.txt'
    sums.write_text(''.join(f'{digest(p)}  {name}\n' for p, name in sorted(files, key=lambda x: x[1])), encoding='utf-8')
    files.append((sums, sums.name))
    windows_zip = dist / f'Inkstone-{VERSION}-windows-x64.zip'
    source_zip = dist / f'Inkstone-{VERSION}-source.zip'
    installer = dist / f'Inkstone-Setup-{VERSION}-windows-x64.exe'
    shutil.copy2(setup, installer)
    shutil.copy2(exe, dist / 'Inkstone.exe')
    shutil.copy2(loader, dist / 'WebView2Loader.dll')
    write_archive(windows_zip, [(p, 'Inkstone/' + name) for p, name in files])
    write_archive(source_zip, source_files)
    assets = [installer, windows_zip, source_zip]
    (dist / 'SHA256SUMS.txt').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in assets), encoding='utf-8')
    print(json.dumps({'version': VERSION, 'sourceCommit': commit, 'dirty': dirty,
                      'assets': [{'file': p.name, 'bytes': p.stat().st_size, 'sha256': digest(p)} for p in assets],
                      'portableFiles': len(files), 'sourceFiles': len(source_files)}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
