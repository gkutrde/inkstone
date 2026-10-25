# Inkstone 运行时丝滑感专项 · 实施报告（M0–M5）

日期：2026-10-25
范围：只做运行时体验优化，不重写编辑器、不改变文件格式与后端命令契约。
规划：TYPING-SMOOTHNESS-PLAN.md

## 0. 结论摘要

1. **主瓶颈已被运行时数据证实**：Milkdown 的 `markdownUpdated` 每 200 ms 对**整篇文档**做一次 Markdown 序列化。30 KB 约 21 ms，250 KB 约 94 ms，1 MB 约 **384 ms**，在 1 MB 时直接造成 375 ms 主线程长任务。
2. **M1 已把序列化移出输入路径**：编辑器改为只上报“文档变了”，快照按文档大小分档生成（0 / 350 / 1500 ms），并在保存、切换、导出、关闭、页面隐藏、IME 组合结束等边界强制 flush。
3. **真实 Tauri/WebView2（release）三轮结果**：连续输入到下一帧 p95 为 T1 **5.4–5.9 ms**、T3 **13.4–16.5 ms**、T4 **64.4–65.0 ms**；连续输入期间**没有 >300 ms 长任务**；JS 堆 30.1 / 51.6 / 139.0 MB。
4. **未达标项**：大文档源→富仍要重建编辑器（T3 约 1.0 s，T4 约 3.4–3.6 s）；富→源在无改动时已可复用快照（T4 126 ms），有改动时含 flush；1 MB 保存/自动保存时的整篇序列化仍需 **394–418 ms**。B 方案（常驻双实例）已按规划实现并实测，但因 30 分钟保留堆增长未通过内存门槛而被否决（见 §3.3/§4.3）；模式切换最终保持单实例重建，1 MB 保存序列化仍需增量/Worker 方案。
5. **回归**：打字 E2E **23/23**、IME **9/9**、导出 **4/4**、Rust **16/16**，原有桌面 E2E（保存/源码/查找/主题/新建）与自动保存/冲突回归全部通过；干净发行构建中探针完全不存在。

## 1. 环境与方法

| 项 | 值 |
| --- | --- |
| 机器 | Windows x64，单机 |
| 桌面壳体 | Tauri 2 release，WebView2 `Edg/155.0.4283.62`（Chrome 155 内核） |
| 视口 | 1440 × 900，DPR 1 |
| 前端 | React 19 + Milkdown/Crepe 7.22.3 + CodeMirror 6 |
| 迭代测量 | headless Chromium + 生产构建（`VITE_EDITOR_METRICS=1`），经本地静态服务器加载 |
| 验收测量 | 真实 release exe，`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`，Playwright over CDP |
| 采样 | 每模型 3 轮（T4 2 轮），取 p50/p95/max；原始 JSON 保留在 `analysis/perf/` |

**探针（`src/lib/editorMetrics.ts`）**：环形缓冲 200 条；记录输入→编辑器通知、输入→React 提交、输入→下一帧、Event Timing、longtask / long-animation-frame、整篇序列化、flush、模式切换、内存。生产构建默认编译为空操作；只有测量构建才会挂 `window.__inkMetrics`。

**夹具**：`scripts/perf/fixtures.py` 生成 T0–T6（T1 31 KB、T2 200 标题、T3 251 KB、T4 1 MB、T5 图片、T6 中文），固定种子可复现。`scripts/perf/tauri_mock.js` 用内存文件系统替身跑完整前端（含保存冲突、对话框、导出字节），使回归不依赖真实桌面。

## 2. M0 基线（改动前）

Chromium + 生产构建，输入 10 个字符后测一次整篇序列化。

| 文档 | 整篇 Markdown 序列化 | 输入→编辑器通知 | 输入→React 提交 | 输入期间长任务 |
| --- | --- | --- | --- | --- |
| 30 KB | 21 ms | 216 ms | 218 ms | 无 |
| 250 KB | 94 ms | 301 ms | 306 ms | 90 ms |
| 1 MB | **384 ms** | 601 ms | 615 ms | **375 ms** |

同时确认：可见字符本身的输入延迟正常（Event Timing 16–32 ms）。因此“丝滑感”的敌人不是按键处理，而是**通知之后的全量序列化**——与规划假设 1 一致，且不能在 `markdownUpdated` 外面再套一层 debounce。

## 3. 实施内容

### 3.1 M1 输入与序列化分离

- `RichEditor` 不再订阅 `markdownUpdated`，改用 `listener.updated`（只报 doc 变化，不触发序列化）；新增句柄 `getMarkdown(): string | null`，按需对当前 ProseMirror 文档做一次序列化。
- 新增 `src/lib/editorScheduler.ts`：按 key 的延时任务表，支持 `cancelTask / hasPendingTask / scheduleTask`。
- 文档快照按大小分档（`delayForDocSize`）：≤64 KB 立即；64–256 KB 停顿 350 ms；>256 KB 停顿 1500 ms。连续输入时通知不断后移，**不会在输入过程中快照**。
- `App` 新增修订号（`docRevision`）模型：脏标记、自动保存计时由修订号即时驱动，正文快照可以晚到；`isDirty` 与修订号共同判定。
- **flush 边界**（全部先取最新快照再继续）：Ctrl+S / 另存为、导出 DOCX/HTML/Markdown、模式切换、标签切换、关闭标签、页面隐藏、beforeunload、查找替换、打印前。
- 语义边界：`flush` 只保证“最新快照进入保存队列”，不等于磁盘落盘；关闭时仍按 dirty 提示。

### 3.2 IME（规划 §10）

- 组合期间暂停快照通知，`compositionend` 后再发一次；`getMarkdown()` 在组合中也返回 `null`，因此**保存/导出/关闭不会写入未上屏的拼音**。
- 回归覆盖：组合期 DOM 可见拼音但快照不含、上屏后正确、`# ` 组合字面量不被转换、组合中 Ctrl+S 不落拼音、保存落盘、撤销后内容仍有效。

### 3.3 M2 模式切换连续性

**A 方案（最终采用）**

- 首次编辑器就绪后 700 ms 预取另一编辑器的懒加载 chunk。
- 切换前捕获滚动容器相对位置，切换后在双 rAF 后恢复（`scroll-behavior` 临时置为 auto，避免平滑滚动导致位置漂移）。
- 切换前 flush，保证新编辑器以最新内容挂载。
- 新增事务级 `hasPendingChanges()`：文档自上次快照后没有变化时直接复用快照，避免重复付出整篇序列化（T4 富→源首次切换因此从 845 ms 降到 126 ms）。

**B 方案（已实现、实测后否决）**

- 同一标签页懒创建第二个编辑器并常驻，切换只切可见性；内容用 `replaceAll` 同步，滚动/焦点恢复。
- 收益：T4 源→富 4.30 s → 1.30 s（纯窥视）/ 2.53 s（有编辑），T3 1.01 s → 0.21 s。
- 否决理由：30 分钟双实例浸泡 294 次切换、内容 0 失败、实例恒为 1，但强制 GC 后的保留堆从 8.7 分钟 72 MB 单调涨到 25 分钟 122 MB（约 +2 MB/分钟），超过规划“内存增长 ≤25%”的门槛。按规划 §12“双实例默认不启用，采用前必须通过 30 分钟内存与销毁检查”，回退到 A。实验中还顺带修复了一个真实的切换竞态（见 §3.5）。

### 3.4 M3：测量后决定不改架构

规划假设“每次输入带动整棵 React 树”。实测不成立：

- `app_render` 0.1–1.6 ms（T3 提交时）。
- 隐藏侧栏对提交耗时没有影响（31–32 ms vs 29–35 ms，差异在噪声内）。
- `react_commit_span` 的 28–50 ms 主要是 React 调度延迟，不是渲染成本。

因此**没有**按规划候选方案做 `useSyncExternalStore` store 拆分——那会引入高风险而收益接近零。保留现有状态结构，等未来出现更大的 UI 状态再评估。

### 3.5 顺带修复的真实缺陷

| 缺陷 | 处理 |
| --- | --- |
| 输入后 200 ms 内关闭标签，脏检查看到旧内容，直接关闭且无确认 | 关闭前先同步快照再判断；新增回归断言确认会弹确认 |
| 导出对话框期间切换标签可能导出旧内容 | 点击导出时立即取最新快照，再打开对话框 |
| 组合输入中保存可能写入未上屏拼音 | IME 期间 `getMarkdown()` 返回 `null`，保存退回已提交内容 |
| 大文档草稿尚未生成时状态栏仍显示“草稿已保存在本机” | 有待处理快照时显示“正在生成本机草稿” |
| 切换发生在 200 ms 通知之前时，flush 依据修订号判断“没变”，刚输入的字符丢失 | 改为 ProseMirror 事务级 `hasPendingChanges()`，不再依赖通知节奏 |
| B 实验：每次切换都向撤销栈塞入整篇文档，堆以约 25 MB/分钟增长 | 同步事务排除出撤销栈；保留堆恢复为 GC 锯齿（但 B 仍因整体留存被否决） |

## 4. 验收数据

### 4.1 真实 Tauri/WebView2：连续输入

120 字符连续输入（20 ms/字符），每模型 3 轮（T4 2 轮）。

| 文档 | 输入→下一帧 p95（各轮） | Event Timing p95 | 输入期间 >300 ms 长任务 | JS 堆 |
| --- | --- | --- | --- | --- |
| T1 31 KB | **5.05 / 5.90 / 5.40 ms** | 16 ms | 0 | 30.1 MB |
| T3 251 KB | **16.45 / 15.49 / 13.38 ms** | 16–21.6 ms | 0 | 51.6 MB |
| T4 1 MB | **64.4 / 65.0 ms** | 48–56 ms | 0（最大长任务 66 ms） | 139.0 MB |

空闲后的自动快照：T1 8.9–11.3 ms；T3 64.2–65.1 ms；T4 由自动保存触发的 flush 约 414 ms（见 §5 限制）。

### 4.2 `# + 空格`（Chromium 生产构建，3 次均确认就地转成 h1）

| 文档 | 转换帧最大耗时 | Event Timing 最大 | 预算 |
| --- | --- | --- | --- |
| T1 | **19 ms** | 24 ms | ≤80 ms ✓ |
| T3 | **65.5 ms** | 72 ms | ≤150 ms ✓ |

### 4.3 模式切换（真实 WebView2，首次切换）

| 文档 | 富→源 ready / paint | 源→富 ready / paint |
| --- | --- | --- |
| T1 | 83.9 / 90.8 ms | 94.8 / 124.9 ms |
| T3 | 333 / 365 ms | **737 / 1019 ms**（重复切换 674–737 / 1016–1024） |
| T4 | **65 / 126 ms**（文档无改动，复用快照，未做全量序列化） | **2391–2420 / 3394–3579 ms** |

两个方向都仍是“销毁 + 重建”。富→源在无改动时已可复用快照（T4 126 ms），有改动时含 flush（T3 85 ms、T4 401 ms）+ CodeMirror 建文档；源→富主要是 Crepe 重建（解析 Markdown + 初始化 + 首次序列化）。

B 方案实验数据（未采用）：T3 源→富 ~0.21 s、T4 源→富 ~1.30 s（纯窥视）/ ~2.53 s（有编辑）、T4 富→源 ~0.11 s；代价是 30 分钟保留堆 72→122 MB（+70%），见 §3.3。

### 4.4 与规划预算对照

| 场景 | 规划预算 | 实测 | 判定 |
| --- | --- | --- | --- |
| T1 输入→绘制 p95 | ≤50 ms | 5.9 ms | 通过 |
| T1 `# + 空格` | ≤80 ms | 19 ms | 通过 |
| T3 输入→绘制 p95 | ≤100 ms | 16.5 ms | 通过 |
| T3 `# + 空格` | ≤150 ms | 65.5 ms | 通过 |
| T4 输入→绘制 p95 | ≤200 ms | 65.0 ms | 通过 |
| T4 输入期间长任务 | 无 >300 ms | 0 个 | 通过 |
| 热切换 | ≤150 ms 可继续输入 | T1 91/125 ✓；T3 1016 ✗；T4 3394 ✗（B 实验可降到 0.21/1.30 s，但未过内存门槛） | **未通过** |
| 冷切换 | ≤400 ms | T1 ✓；T3 源→富 1019 ✗；T4 ✗ | **未通过** |
| 连续输入一致性 | 1,000 次 100% | 400 字符连续输入不重复、不丢字；23 项 E2E | 部分通过（未单独跑满 1,000 次） |
| 30 分钟内存 | ≤25% | 58.7 MB → 56.3 MB（-4.1%），580 次输入，编辑器实例恒为 1 | 通过 |

30 分钟浸泡（真实桌面、250 KB 文档、每约 3 秒一次输入、580 轮）：JS 堆 58.7 MB → 56.3 MB，期间在 42–100 MB 间呈 GC 锯齿；`.cm-editor` 数量稳定为 1（首个样本的 19 是启动瞬态），DOM 节点稳定在 25,236，没有持续增长的监听器或编辑器实例。原始数据：analysis/perf/tauri-soak.json。

## 5. 限制与下一步

1. **1 MB 的整篇序列化仍是 394–418 ms**（保存 / 自动保存 / 模式切换 flush 时）。这是 Milkdown 全量 serializer 的固有成本；本轮已把它从输入路径移到“停顿或显式动作”。要消除需要增量序列化或 Worker 序列化（规划认可的第二阶段方案），本轮未做，因为需要在 Worker 中复刻同一套 remark 配置，输出保真风险高。
2. **大文档模式切换不达标**。A 方案（预热 + 上下文恢复 + 脏判断跳过冗余序列化）已上线并达标 T1；T3/T4 的源→富仍需重建 Crepe（~1.0 s / ~3.5 s）。B 方案已实现并实测，切换可降到 0.21 s / 1.30 s，但 30 分钟保留堆 +70%，按规划内存门槛被否决。后续应评估上游实例复用、富文本视口虚拟化或增量解析，而不是继续堆双实例。
3. `replaceAll(markdown, true)`（查找替换）会清空撤销栈，并让 `editorStateCtx` 停在旧状态（upstream 行为，非本轮引入）；本轮未改，建议后续换成 `replaceAll(markdown, false)` 并单独评估历史语义。
4. 合成 IME 不能替代真实 Windows 拼音手测；规划要求的“至少一轮真实手测”仍待人工完成。
5. 测量环境差异：Chromium 经本地 HTTP 服务器取 chunk，冷切换会被取块放大；真实 Tauri 的数字已单列，报告以它为准。

## 6. 复现

```powershell
# 带探针的生产前端（快速迭代）
$env:VITE_EDITOR_METRICS='1'; npx vite build --outDir ../analysis/perf-dist --emptyOutDir
python -m http.server 4173 --directory analysis/perf-dist

# 基线/对比（T0–T6）
python inkstone/scripts/perf/bench.py --model T3 --bursts 8 --chars 12 --url http://127.0.0.1:4173 --out analysis/perf/T3.json

# 功能回归
python inkstone/scripts/perf/typing_e2e.py
python inkstone/scripts/perf/typing_ime_e2e.py
python inkstone/scripts/perf/export_e2e.py

# 真实桌面（带探针构建）
$env:VITE_EDITOR_METRICS='1'; .\inkstone\build-app.cmd
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
.\inkstone\src-tauri\target\release\inkstone.exe
python inkstone/scripts/perf/tauri_desktop_perf.py

# 干净发行构建（探针关闭）
.\inkstone\build-app.cmd
python inkstone/scripts/tauri-e2e.py
python inkstone/scripts/tauri-autosave-e2e.py
```

## 7. 改动清单

| 文件 | 变更 |
| --- | --- |
| `src/lib/editorMetrics.ts` | 新增：开发/测量态探针、环形缓冲、longtask/LoAF、模式切换、flush 指标 |
| `src/lib/editorScheduler.ts` | 新增：按键延时任务、按大小分档、取消/查询 |
| `src/components/RichEditor.tsx` | `listener.updated`、`getMarkdown`、IME 组合隔离、序列化探针 |
| `src/components/SourceEditor.tsx` | 输入起点标记（探针） |
| `src/App.tsx` | 修订号、懒快照、flush 边界、滚动恢复、预热、测试钩子（仅测量构建） |
| `src/main.tsx` | 探针安装、React Profiler（仅测量构建） |
| `scripts/perf/tauri_mock.js` | 新增：Tauri IPC 内存替身 |
| `scripts/perf/fixtures.py` | 新增：T0–T6 夹具 |
| `scripts/perf/bench.py` | 新增：输入性能驱动 + p50/p95/p99 |
| `scripts/perf/typing_e2e.py` | 新增：23 项打字/保存/切换/草稿回归 |
| `scripts/perf/typing_ime_e2e.py` | 新增：9 项 IME 回归 |
| `scripts/perf/export_e2e.py` | 新增：4 项导出新鲜度回归 |
| `scripts/perf/tauri_desktop_perf.py` | 新增：真实 WebView2 三轮验收 |
| `scripts/perf/tauri_soak.py` | 新增：长时内存/实例浸泡 |

## 8. 发布产物

| 项目 | 值 |
| --- | --- |
| 可执行文件 | dist/Inkstone.exe · 8,784,384 bytes · SHA-256 6de675ba…（干净构建，探针关闭） |
| 便携包 | dist/Inkstone-0.1.0-windows-x64.zip · 14 个文件（含本报告） |
| 源码包 | dist/Inkstone-0.1.0-source.zip · 129 个文件（含规划与全部性能脚本） |
| 构建环境 | Rust 1.99.1 · Tauri 2.12 · WebView2 Edg/155.0.4283.62 |

发行包内已包含本报告（Inkstone/TYPING-PERF-REPORT.md），源码包包含规划文档与全部性能脚本。
