# Inkstone · iOS 风格改版

基于 [gkutrde/inkstone](https://github.com/gkutrde/inkstone) 的固定提交 `9719221f67601e38da50eeed10ceebec7c3b285b`，作为 v0.1.3 Windows 发行版集成。iOS 仅指界面风格，不是移动端移植。当前发行验证见 [v0.1.3 发行记录](RELEASE-0.1.3.md)。

## 设计

- 灰白分层、连续侧栏和圆角白色写作画布；蓝色只强调可操作与选中状态。
- 系统无衬线字体、宽松正文行距、清晰的标题层级；不依赖在线字体。
- iOS 式分段切换、分组设置、绿色开关、磨砂弹层和 Spotlight 式命令中心。
- 浅色、暖色、深色三套配色；继续支持减少透明、减少动画、专注模式与打印。
- 55 个原创细线 SVG 图标，统一 24 点网格和 1.7 线宽。借鉴 iOS 的视觉语言，没有使用 Apple 的 SF Symbols 专有图形、字体或品牌资产。
- 新应用 SVG 标识与网页图标。未替换 Windows 安装包内的 ICO/PNG 资源。
- 新欢迎页、侧栏“新建文稿 / 打开文件”快捷操作、可编辑的本机示例草稿。

| 内容 | 浅色 | 深色 |
| --- | --- | --- |
| 页面底色 | `#f5f5f7` | `#111113` |
| 内容画布 | `#ffffff` | `#1c1c1e` |
| 主要文字 | `#1d1d1f` | `#f5f5f7` |
| 强调颜色 | `#0071e3` | `#64a7ff` |

## 主要改动位置

- [视觉样式](../src/ios.css)：独立样式层，不替换编辑器行为与原始打印逻辑。
- [主工作台](../src/App.tsx) 与 [侧栏](../src/components/Sidebar.tsx)：欢迎页、示例、新入口、主题与无障碍状态。
- [图标组件](../src/components/IosIcons.tsx) 与 [应用标识](../src/assets/brand-mark.svg)。
- [代码高亮](../src/lib/codeTheme.ts)：沿用 CodeMirror 语义标签，颜色跟随 CSS 主题即时变化。
- [桌面玻璃配色](../src/lib/windowGlass.ts)：匹配新浅色、暖色与深色界面。
- [组件检查脚本](../scripts/ios-ui-check.mjs)。

富文本 / 源码切换、文件树、全文搜索、自动保存、保存冲突保护、草稿恢复、导出与快捷键继续沿用上游实现；Rust 文件读写逻辑没有改动。补齐上游直接使用却未声明的 `@codemirror/language-data@6.5.2`，与已有锁定版本一致。

## 运行

需要 Node.js 20.19+ / 22.12+（建议当前 LTS）和 pnpm。

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

访问 <http://127.0.0.1:1420>。网页里可以新建与编辑草稿、体验示例、切换主题；本地文件对话框、文件系统、系统打印等桌面能力需要 Tauri，网页预览不冒充这些能力。

```powershell
pnpm tauri dev
```

常规 Windows 开发推荐 Rust MSVC 工具链、Visual Studio Build Tools 和 WebView2，详见 [上游运行说明](../README.md)。本轮发行在当前主机使用 GNU 工具链生成 x64 EXE 与 NSIS，准确环境及验收范围见 [发行记录](RELEASE-0.1.3.md)。

## 验证

```powershell
pnpm exec tsc --noEmit
pnpm build
node scripts/ios-ui-check.mjs
```

组件检查不需要浏览器二进制，覆盖图标渲染、主界面结构、三套主题、窄屏初始状态、草稿恢复、侧栏 / 大纲 / 命令 / 输入弹层的渲染，以及 Markdown 大纲、前言和草稿存储回归。它不是浏览器布局或真实点击测试。

原始源码包在受限环境中仅完成组件与构建检查；这属于源码包的历史验证范围。v0.1.3 的本轮验证已增加真实 Chromium 生产前端交互、93 项 Markdown 回归以及同场景的前后截图。浏览器中的文件系统使用仓库 IPC 测试替身，不能代替原生 Rust 读写验证；Windows 构建、后端测试与桌面烟测的准确结果统一记录在 [发行记录](RELEASE-0.1.3.md)。

验收结果：**TypeScript 类型检查通过、生产构建通过、组件渲染与回归 75 项通过 / 0 项失败**。构建仍有上游编辑器大分块（>500 KB）的提示，此次没有做编辑器拆包优化。检查结果见 [组件检查报告](ios-ui-check.json)。这里的 75 项仅指组件检查；独立的浏览器交互、原生桌面及升级验收结果见 [发行记录](RELEASE-0.1.3.md)。

## 列表对齐修正

修正了编号与“人物简介”等首行文字垂直错位的问题：去掉原有 `0.62em` 顶部偏移，以及 Crepe 标签默认的 `32px` 高度和 `4px` 内边距，改用首行基线对齐。编号继承正文的字体设置，列表内标题的首块不再保留顶部外边距；多位编号向左扩展，不改变正文起点。任务图标改为参与首行行盒。新增两项样式回归检查；[人工检查样例](../scripts/fixtures/ios-list-alignment.md) 覆盖普通列表、加粗、换行、嵌套、标题、两位 / 三位编号和任务列表。v0.1.3 已补充同一测试文稿、1440×900 视口、17px 字号、740px 版心及浅色/深色主题的前后截图，见 [发行记录](RELEASE-0.1.3.md)。
