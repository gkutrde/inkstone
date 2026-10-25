/**
 * Inert Tauri 2 IPC mock for the Inkstone typing-smoothness harness.
 *
 * Inject this file with page.add_init_script() BEFORE the page navigates. It
 * installs window.__TAURI_INTERNALS__ so the real @tauri-apps/api and
 * @tauri-apps/plugin-dialog bundles run inside plain Chromium, backed by an
 * in-memory filesystem instead of Rust.
 *
 * Seed data is read from two globals that the driver sets before this script:
 *   window.__PERF_FS         {"C:/perf/workspace/name.md": "<content>", ...}
 *   window.__PERF_WORKSPACE  "C:/perf/workspace"
 *   window.__PERF_DIALOG     optional preset path returned by dialog open/save
 *
 * Assertions can inspect window.__perfFs afterwards:
 *   files    path -> content (plain object, JSON serialisable)
 *   writes   [{path, content, at}] appended by every write_text_file call
 *   exports  path -> {bytes, text} for write_export / write_export_bytes
 *   dirs     path -> true for every known directory
 *
 * Command names and argument shapes mirror inkstone/src/lib/api.ts and
 * src-tauri/src/lib.rs (camelCase over the IPC boundary).
 */
(function installPerfTauriMock() {
  "use strict";

  // Fixed epoch (2025-01-01T00:00:00Z) so every run reports identical metadata.
  var BASE_MS = 1735689600000;
  var SAVE_CONFLICT =
    "SAVE_CONFLICT: 磁盘文件已在 Inkstone 之外被修改。请另存为或重新打开。";
  var MARKDOWN_EXT = ["md", "markdown", "mdown", "mkd", "txt"];
  var IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];

  // ---------------------------------------------------------------- paths ---

  function normPath(value) {
    if (typeof value !== "string") return "";
    var path = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return path;
  }

  function dirOf(path) {
    var index = path.lastIndexOf("/");
    if (index < 0) return "";
    if (index === 0) return "/";
    // Keep "C:/" rather than the bare "C:" so ancestor walks terminate.
    if (index === 2 && /^[A-Za-z]:$/.test(path.slice(0, 2))) return path.slice(0, 2) + "/";
    return path.slice(0, index);
  }

  function baseOf(path) {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  function extOf(path) {
    var name = baseOf(path);
    var dot = name.lastIndexOf(".");
    return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
  }

  function joinPath(parent, name) {
    var root = normPath(parent);
    var leaf = String(name == null ? "" : name).replace(/^[\/\\]+/, "").replace(/[\/\\]+$/, "");
    return root ? root + "/" + leaf : leaf;
  }

  function has(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key);
  }

  function byteLength(text) {
    return new TextEncoder().encode(text).length;
  }

  // ----------------------------------------------------------------- state ---

  var seeded = window.__PERF_FS && typeof window.__PERF_FS === "object" ? window.__PERF_FS : {};
  var workspace = normPath(window.__PERF_WORKSPACE || "C:/perf/workspace");

  var files = {};   // absolute path -> string content
  var meta = {};    // absolute path -> {modifiedMs, size}
  var dirs = Object.create(null);   // absolute path -> true
  var exports_ = Object.create(null); // absolute path -> {bytes, text}
  var writes = [];
  var imageSerial = 0;
  var clock = BASE_MS;

  function nextModifiedMs() {
    clock += 1;
    return clock;
  }

  function ensureDirsFor(path) {
    var current = dirOf(path);
    while (current && !dirs[current]) {
      dirs[current] = true;
      var parent = dirOf(current);
      if (parent === current) break;
      current = parent;
    }
  }

  function storeFile(path, content, modifiedMs) {
    files[path] = content;
    meta[path] = { modifiedMs: modifiedMs, size: byteLength(content) };
    ensureDirsFor(path);
  }

  // Seed the fixture document(s).
  Object.keys(seeded).forEach(function (rawPath) {
    var path = normPath(rawPath);
    if (!path) return;
    storeFile(path, String(seeded[rawPath] == null ? "" : seeded[rawPath]), BASE_MS);
  });
  if (workspace) {
    var cursor = workspace;
    while (cursor && !dirs[cursor]) {
      dirs[cursor] = true;
      var parent = dirOf(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }

  // ------------------------------------------------------------ filesystem ---

  function listDirectory(rawPath) {
    var path = normPath(rawPath);
    if (!dirs[path]) throw "工作区不是目录: " + path;
    var lower = path.toLowerCase();
    var nodes = [];

    Object.keys(dirs).forEach(function (dir) {
      if (dir === path) return;
      if (dirOf(dir).toLowerCase() !== lower) return;
      // read_workspace returns the whole tree, so children are recursive.
      nodes.push({ name: baseOf(dir), path: dir, isDir: true, children: listDirectory(dir) });
    });
    Object.keys(files).forEach(function (file) {
      if (dirOf(file).toLowerCase() !== lower) return;
      if (MARKDOWN_EXT.indexOf(extOf(file)) < 0) return;
      nodes.push({ name: baseOf(file), path: file, isDir: false, children: [] });
    });

    nodes.sort(function (left, right) {
      if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
      var a = left.name.toLowerCase();
      var b = right.name.toLowerCase();
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return nodes;
  }

  function readTextFile(rawPath) {
    var path = normPath(rawPath);
    if (!has(files, path)) throw "无法读取文件信息: " + path;
    var info = meta[path] || { modifiedMs: BASE_MS, size: byteLength(files[path]) };
    return {
      path: path,
      name: baseOf(path),
      content: files[path],
      modifiedMs: info.modifiedMs,
      size: info.size
    };
  }

  function writeTextFile(args) {
    var path = normPath(args.path);
    var content = typeof args.content === "string" ? args.content : String(args.content == null ? "" : args.content);
    var expectedModifiedMs = args.expectedModifiedMs;
    var expectedSize = args.expectedSize;
    var hasModified = expectedModifiedMs !== undefined && expectedModifiedMs !== null;
    var hasSize = expectedSize !== undefined && expectedSize !== null;

    // Same contract as write_text_file in src-tauri/src/lib.rs.
    if (hasModified !== hasSize) throw "保存版本信息不完整。";
    if (hasModified) {
      var current = meta[path];
      if (!current || current.modifiedMs !== expectedModifiedMs || current.size !== expectedSize) {
        throw SAVE_CONFLICT;
      }
    }
    if (!has(files, path) && !hasModified) {
      throw "无法写入文件: " + path;
    }

    storeFile(path, content, nextModifiedMs());
    writes.push({ path: path, content: content, at: Date.now() });
    return { modifiedMs: meta[path].modifiedMs, size: meta[path].size };
  }

  function createFile(args) {
    var parent = normPath(args.parent);
    var path = joinPath(parent, args.name);
    if (!dirs[parent]) throw "父目录不存在: " + parent;
    if (has(files, path) || dirs[path]) throw "目标已存在: " + path;
    storeFile(path, String(args.content == null ? "" : args.content), nextModifiedMs());
    return path;
  }

  function createFolder(args) {
    var parent = normPath(args.parent);
    var path = joinPath(parent, args.name);
    if (!dirs[parent]) throw "父目录不存在: " + parent;
    if (dirs[path] || has(files, path)) throw "文件夹已存在: " + path;
    dirs[path] = true;
    return path;
  }

  function renamePath(args) {
    var source = normPath(args.path);
    var target = joinPath(dirOf(source), args.newName);
    var isFile = has(files, source);
    var isDir = !isFile && !!dirs[source];
    if (!isFile && !isDir) throw "路径不存在: " + source;
    if (source === target) return target;
    if (has(files, target) || dirs[target]) throw "目标已存在: " + target;

    if (isFile) {
      storeFile(target, files[source], meta[source].modifiedMs);
      delete files[source];
      delete meta[source];
      return target;
    }
    // Move a directory together with everything below it.
    var prefix = source + "/";
    dirs[target] = true;
    Object.keys(dirs).forEach(function (dir) {
      if (dir.indexOf(prefix) !== 0) return;
      dirs[target + "/" + dir.slice(prefix.length)] = true;
      delete dirs[dir];
    });
    Object.keys(files).forEach(function (file) {
      if (file.indexOf(prefix) !== 0) return;
      var moved = target + "/" + file.slice(prefix.length);
      storeFile(moved, files[file], meta[file].modifiedMs);
      delete files[file];
      delete meta[file];
    });
    delete dirs[source];
    return target;
  }

  function trashPath(args) {
    var path = normPath(args.path);
    if (has(files, path)) {
      delete files[path];
      delete meta[path];
      return undefined;
    }
    if (!dirs[path]) throw "路径不存在: " + path;
    var prefix = path + "/";
    Object.keys(files).forEach(function (file) {
      if (file.indexOf(prefix) === 0) {
        delete files[file];
        delete meta[file];
      }
    });
    Object.keys(dirs).forEach(function (dir) {
      if (dir === path || dir.indexOf(prefix) === 0) delete dirs[dir];
    });
    return undefined;
  }

  function searchWorkspace(args) {
    var root = normPath(args.root);
    var needle = String(args.query == null ? "" : args.query).trim().toLowerCase();
    if (!needle) return [];
    if (!dirs[root]) throw "搜索位置不是目录: " + root;
    var scope = root.toLowerCase() + "/";
    var results = [];
    Object.keys(files).forEach(function (file) {
      if (file.toLowerCase().indexOf(scope) !== 0) return;
      if (MARKDOWN_EXT.indexOf(extOf(file)) < 0) return;
      var hit = files[file].toLowerCase().indexOf(needle) >= 0 ||
        baseOf(file).toLowerCase().indexOf(needle) >= 0;
      if (!hit) return;
      results.push({ name: baseOf(file), path: file, isDir: false, children: [] });
    });
    results.sort(function (a, b) {
      return a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1;
    });
    return results;
  }

  function saveImage(args) {
    var root = normPath(args.workspace);
    var rawName = baseOf(String(args.fileName == null ? "image.png" : args.fileName).replace(/\\/g, "/"));
    var ext = extOf(rawName) || "png";
    if (IMAGE_EXT.indexOf(ext) < 0) throw "不支持的图片格式。";
    var stem = "";
    var chars = Array.from(rawName.slice(0, rawName.length - (ext ? ext.length + 1 : 0)));
    chars.slice(0, 64).forEach(function (ch) {
      stem += /[A-Za-z0-9_-]/.test(ch) ? ch : "-";
    });
    while (stem.indexOf("--") >= 0) stem = stem.replace(/--/g, "-");
    stem = stem.replace(/^-+|-+$/g, "");
    if (!stem) stem = "image";
    var bytes = Array.isArray(args.bytes) ? args.bytes : [];
    var fileName = stem + "-" + Date.now() + "-" + imageSerial++ + "." + ext;
    var path = joinPath(root, "assets/" + fileName);
    storeFile(path, "", nextModifiedMs());
    exports_[path] = { bytes: bytes, text: null };
    return "assets/" + fileName;
  }

  function writeExport(args) {
    var path = normPath(args.path);
    var content = typeof args.content === "string" ? args.content : String(args.content == null ? "" : args.content);
    storeFile(path, content, nextModifiedMs());
    exports_[path] = { bytes: null, text: content };
    return undefined;
  }

  function writeExportBytes(args) {
    var path = normPath(args.path);
    var bytes = Array.isArray(args.bytes) ? args.bytes : [];
    storeFile(path, "", nextModifiedMs());
    meta[path].size = bytes.length;
    exports_[path] = { bytes: bytes, text: null };
    return undefined;
  }

  function readExportImage(args) {
    var path = normPath(args.path);
    var record = exports_[path];
    if (!record || !Array.isArray(record.bytes)) throw "无法读取图片信息: " + path;
    return record.bytes;
  }

  // --------------------------------------------------------------- dialogs ---

  function presetDialog() {
    return has(window, "__PERF_DIALOG") ? window.__PERF_DIALOG : null;
  }

  // -------------------------------------------------------------- dispatch ---

  async function invoke(cmd, args, options) {
    var payload = args || {};
    switch (cmd) {
      case "read_workspace":
        return listDirectory(payload.path);
      case "read_text_file":
        return readTextFile(payload.path);
      case "write_text_file":
        return writeTextFile(payload);
      case "create_file":
        return createFile(payload);
      case "create_folder":
        return createFolder(payload);
      case "rename_path":
        return renamePath(payload);
      case "trash_path":
        return trashPath(payload);
      case "reveal_in_explorer":
        return undefined;
      case "write_export":
        return writeExport(payload);
      case "write_export_bytes":
        return writeExportBytes(payload);
      case "read_export_image":
        return readExportImage(payload);
      case "search_workspace":
        return searchWorkspace(payload);
      case "take_pending_open":
        return { paths: [], errors: [] };
      case "plugin:event|listen":
        return 1;
      case "plugin:event|unlisten":
        return undefined;
      case "workspace_writable":
        return true;
      case "save_image":
        return saveImage(payload);
      case "plugin:dialog|open":
      case "plugin:dialog|save":
        return presetDialog();
      case "plugin:dialog|message":
      case "plugin:dialog|ask":
      case "plugin:dialog|confirm":
        return true;
      case "plugin:opener|reveal_item_in_dir":
        return undefined;
      default:
        throw new Error("unmocked command: " + cmd);
    }
  }

  // Callbacks are keyed by an incrementing id, as the real IPC layer does.
  var callbackSeq = 0;
  var callbacks = Object.create(null);

  function transformCallback(callback, once) {
    var id = ++callbackSeq;
    callbacks[id] = { callback: callback, once: !!once };
    window.__perfCallbacks = callbacks;
    return id;
  }

  function convertFileSrc(path) {
    return path;
  }

  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  Object.assign(window.__TAURI_INTERNALS__, {
    invoke: invoke,
    convertFileSrc: convertFileSrc,
    transformCallback: transformCallback,
    callbacks: callbacks,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" }
    }
  });

  window.__perfFs = {
    files: files,
    writes: writes,
    dirs: dirs,
    exports: exports_,
    workspace: workspace,
    meta: meta
  };
})();
