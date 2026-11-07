from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

import win32api
import win32con
import win32gui
import win32process
import win32clipboard
from PIL import ImageGrab

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT.parent / "analysis" / "data-safety"
OUT.mkdir(parents=True, exist_ok=True)
DOC = OUT / "native-close-test.md"
DOC.write_text("""# 原生关闭测试
""", encoding="utf-8")
EXE = Path(os.environ["INKSTONE_TEST_EXE"])


def visible_windows(pid: int):
    found = []
    def visit(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return
        if win32process.GetWindowThreadProcessId(hwnd)[1] != pid:
            return
        rect = win32gui.GetWindowRect(hwnd)
        found.append({
            "hwnd": hwnd,
            "title": win32gui.GetWindowText(hwnd),
            "area": max(0, rect[2] - rect[0]) * max(0, rect[3] - rect[1]),
        })
    win32gui.EnumWindows(visit, None)
    return sorted(found, key=lambda item: item["area"], reverse=True)


def wait_main(pid: int):
    for _ in range(100):
        windows = visible_windows(pid)
        if windows:
            return windows[0]
        time.sleep(0.15)
    raise RuntimeError("未找到原生应用主窗口")


def wait_dialog(pid: int):
    for _ in range(60):
        for window in visible_windows(pid):
            if "关闭 Inkstone" in window["title"]:
                return window
        time.sleep(0.1)
    raise RuntimeError("未出现关闭确认对话框")


def click_dialog_button(dialog_hwnd: int, label: str) -> None:
    matches = []
    def visit(child, _):
        if win32gui.GetWindowText(child) == label:
            matches.append(child)
    win32gui.EnumChildWindows(dialog_hwnd, visit, None)
    if not matches:
        raise RuntimeError("确认对话框没有按钮: " + label)
    win32gui.SendMessage(matches[0], win32con.BM_CLICK, 0, 0)


def focus_window(hwnd: int) -> None:
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass


def paste_edit() -> None:
    win32clipboard.OpenClipboard()
    win32clipboard.EmptyClipboard()
    win32clipboard.SetClipboardData(win32con.CF_UNICODETEXT, "x")
    win32clipboard.CloseClipboard()
    win32api.keybd_event(win32con.VK_CONTROL, 0, 0, 0)
    win32api.keybd_event(ord("V"), 0, 0, 0)
    win32api.keybd_event(ord("V"), 0, win32con.KEYEVENTF_KEYUP, 0)
    win32api.keybd_event(win32con.VK_CONTROL, 0, win32con.KEYEVENTF_KEYUP, 0)


def launch_dirty_document():
    proc = subprocess.Popen([str(EXE), str(DOC)])
    main_window = wait_main(proc.pid)
    time.sleep(5)
    focus_window(main_window["hwnd"])
    rect = win32gui.GetWindowRect(main_window["hwnd"])
    win32api.SetCursorPos((int((rect[0] + rect[2]) / 2), int((rect[1] + rect[3]) / 2)))
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0)
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0)
    paste_edit()
    # The editor shows the edit before autosave reaches the file; do not mistake
    # the pending autosave window for a failed native input.
    time.sleep(0.5)
    return proc, main_window


def stop_test_process(proc) -> None:
    if proc.poll() is None:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        proc.wait(timeout=5)


def main() -> None:
    existing = subprocess.run(["tasklist", "/FI", "IMAGENAME eq inkstone.exe"], capture_output=True, text=True)
    if "inkstone.exe" in existing.stdout:
        raise RuntimeError("已有 Inkstone 进程，停止以避免单实例转发干扰")
    result: dict[str, object] = {}

    proc, main_window = launch_dirty_document()
    try:
        win32gui.SendMessage(main_window["hwnd"], win32con.WM_CLOSE, 0, 0)
        dialog = wait_dialog(proc.pid)
        ImageGrab.grab().save(OUT / "native-close-cancel.png")
        click_dialog_button(dialog["hwnd"], "继续编辑")
        time.sleep(1)
        result["cancel"] = {
            "alive": proc.poll() is None,
            "mainWindowPresent": bool(visible_windows(proc.pid)),
            "dialog": dialog["title"],
        }
    finally:
        stop_test_process(proc)

    proc, main_window = launch_dirty_document()
    try:
        win32gui.SendMessage(main_window["hwnd"], win32con.WM_CLOSE, 0, 0)
        dialog = wait_dialog(proc.pid)
        ImageGrab.grab().save(OUT / "native-close-confirm.png")
        click_dialog_button(dialog["hwnd"], "放弃更改并关闭")
        result["confirm"] = {"exitCode": proc.wait(timeout=10)}
    finally:
        stop_test_process(proc)

    result["passed"] = (
        result["cancel"]["alive"] is True
        and result["cancel"]["mainWindowPresent"] is True
        and result["confirm"]["exitCode"] is not None
    )
    (OUT / "native-close.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result["passed"]:
        raise RuntimeError("原生关闭取消/确认路径未通过")


if __name__ == "__main__":
    main()
