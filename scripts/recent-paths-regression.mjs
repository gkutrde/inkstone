import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "inkstone-recent-paths-"));
try {
  const pathSource = (await readFile(join(project, "src", "lib", "path.ts"), "utf8"))
    .replace('import { convertFileSrc } from "@tauri-apps/api/core";', "const convertFileSrc = (path) => path;");
  await writeFile(join(temporary, "path.mts"), pathSource);
  const recentSource = (await readFile(join(project, "src", "lib", "recentPaths.ts"), "utf8"))
    .replace('from "./path";', 'from "./path.mts";');
  await writeFile(join(temporary, "recentPaths.mts"), recentSource);
  const paths = await import(pathToFileURL(join(temporary, "recentPaths.mts")).href);
  const entries = [
    { path: "C:/notes/today.md", name: "today.md", at: 1 },
    { path: "C:/notes/archive/old.md", name: "old.md", at: 2 },
    { path: "C:/notes-other/keep.md", name: "keep.md", at: 3 }
  ];

  const renamedFile = paths.renameRecentEntries(entries, "C:\\notes\\today.md", "C:/notes/renamed.md", false);
  assert.deepEqual(renamedFile[0], { path: "C:/notes/renamed.md", name: "renamed.md", at: 1 });
  assert.equal(renamedFile[1], entries[1]);
  assert.equal(renamedFile[2], entries[2]);

  const renamedFolder = paths.renameRecentEntries(entries, "C:/notes/archive", "D:/writing/archive", true);
  assert.deepEqual(renamedFolder[1], { path: "D:/writing/archive/old.md", name: "old.md", at: 2 });
  assert.equal(paths.remapAffectedPath("C:/notes-other", "C:/notes", "D:/notes", true), "C:/notes-other");
  assert.equal(paths.remapAffectedPath("C:\\NOTES\\archive\\old.md", "c:/notes/archive", "D:/archive", true), "D:/archive/old.md");

  const removedFolder = paths.removeRecentEntries(entries, "C:/notes", true);
  assert.deepEqual(removedFolder.map((item) => item.path), ["C:/notes-other/keep.md"]);
  const removedFile = paths.removeRecentEntries(entries, "C:/notes/today.md", false);
  assert.deepEqual(removedFile.map((item) => item.path), ["C:/notes/archive/old.md", "C:/notes-other/keep.md"]);
  assert.equal(paths.isPathAffected("C:/notes-other", "C:/notes", true), false);
  assert.equal(paths.isPathAffected("C:/notes/archive/old.md", "C:/notes", true), true);
  console.log(JSON.stringify({ status: "passed", checks: 10 }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
