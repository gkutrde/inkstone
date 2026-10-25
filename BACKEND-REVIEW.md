# Inkstone 后端审查与优化记录

日期：2026-10-25

## 本轮范围

审查 Rust/Tauri 文件命令、前端调用和现有测试，重点核对自动保存加入后的写入可靠性。优先处理可直接复现、能由回归测试验证的问题，不把本地写作工具扩张成未经验证的完整安全沙箱。

## 已落地

| 领域 | 修改 | 验证 |
| --- | --- | --- |
| Windows 名称与路径 | 名称必须是单个普通路径组件；拒绝驱动器前缀、ADS 冒号、设备名、控制字符及末尾点/空格；join 后复核父目录 | 路径模块测试及三个文件命令的负向测试 |
| 保存可靠性 | 同目录临时文件、完整写入与同步、原子替换；保留现有权限；失败保留原文件 | 连续替换、只读失败、临时文件清理测试 |
| 保存冲突 | 写入接受预期修改时间和大小；替换前复核；冲突返回 SAVE_CONFLICT，前端暂停该标签自动保存 | 旧版本写入拒绝测试、桌面外部编辑场景 |
| 应用内并发 | 文件保存、创建、重命名、回收站、图片和导出由后端修改锁串行化；前端同一标签保存排队 | 版本回归与桌面保存测试 |
| 主线程阻塞 | 文件树、读写、搜索、回收站、图片等重 I/O 使用 Tauri command(async) | 命令编译与完整桌面回归 |
| 新建与重命名 | 新建使用 create_new，不再先检查后覆盖；支持 Windows 仅改大小写的重命名 | 防覆盖和 case-only 测试 |
| 图片 | 64 MiB 上限、Unicode 名称、时间戳 + 原子计数器 + create_new；assets 链接/真实位置检查 | 同名不同内容、中文名、路径内验证 |
| 搜索与遍历 | 根目录先验证；不跟随文件符号链接；仅对子目录应用跳过规则；统一 16 层；隐藏 Markdown 可搜索；结果稳定排序；非 UTF-8 路径跳过 | target 根、隐藏文件、13 层文档和缺失根测试 |
| 导出 | DOCX 在本机按需生成，二进制导出采用原子写入；图片读取限制 64 MiB，导出文件限制 128 MiB | 真实 DOCX ZIP、python-docx 结构与 LibreOffice 页面验收 |
| 大文件 | 单篇文档和单张图片设置 64 MiB 上限并给出明确错误 | 元数据与输入大小检查 |

## 仍需后续架构工作

- **完整授权目录模型尚未实现。** 打开、另存、导出等命令仍接受用户显式选择的绝对路径，这是当前产品行为； capabilities 不能替代自定义命令授权。若要把“主 WebView 被注入脚本”纳入完整防护，需要 AppState 维护 canonical workspace 与单文件 grant、opaque id、目录句柄相对打开，并同步收窄 asset protocol scope。当前未发现也不声称存在 XSS 入口。
- **跨进程 TOCTOU 不能完全消除。** expected mtime + size 能阻止常见外部编辑覆盖，但不等价于内容哈希或 OS 文件锁；替换前仍理论存在极短竞争窗口。后端修改锁只约束本应用进程。
- **重命名不是完整的跨平台 no-replace API。** 应用内竞争已由修改锁约束；外部进程在检查与 rename 之间创建目标的极端情况仍需平台专用 renameat2 / renamex_np / Windows no-replace 方案。
- **搜索资源预算与结果元数据仍有限。** 当前会整读文本并创建 lowercase 副本，非 UTF-8 内容和部分遍历错误会跳过，50 条上限尚无 truncated 字段。后续可加入分块搜索、取消、总字节预算和 structured skipped/truncated。
- **非 UTF-8 文件名采用明确跳过。** 展示名仍可有损转换，但可操作 path 不再从非法 Unicode 路径伪造；完整支持需要 opaque id 而不是字符串路径。

## 测试入口

- Rust：在 src-tauri 中运行 cargo test。
- 浏览器：启动 Vite 后运行 scripts/ui-redesign-check.py。
- 真实桌面：以 WebView2 9222 调试端口启动发行程序，运行 scripts/tauri-e2e.py 与 scripts/tauri-autosave-e2e.py。
- 导出：Tauri 开发实例运行 scripts/export-e2e.py，再以 bundled Python 运行 scripts/validate-export.py；LibreOffice 渲染最终 DOCX 检查页面。
- 商业前端：运行 scripts/commercial-ui-check.py 与 scripts/tauri-commercial-e2e.py，覆盖命令中心、专注写作、键盘模型、弹层和按需加载。
