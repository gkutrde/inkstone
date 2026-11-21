# Inkstone v0.1.8

本版改进 Windows 写作界面的动效和键盘交互，并修复 LaTeX 编辑问题。

- 侧栏、画布、菜单和通知采用更一致的玻璃材质、圆角层级和过渡动效。
- 命令中心、查找栏、弹窗和侧栏菜单改进键盘导航及焦点恢复。
- 行内 LaTeX 编辑保留原公式，各公式的预览状态互不影响。
- 保持原应用标识、当前用户安装目录和文稿格式，可从 v0.1.7 覆盖安装。

## 验证

- Windows x64 GNU Release 构建、前端类型检查与 NSIS 打包通过。
- Rust 后端 17 项通过；键盘交互 5 项、iOS 动效及无障碍 12 项、Markdown 93 项通过；LaTeX 编辑及保存回归通过。
- 修复生产 CSS 在强制颜色等辅助模式下未关闭模糊滤镜的问题；普通浅色桌面主题在相同窗口大小下完成升级前后对照。
- 当前用户从 v0.1.7 覆盖安装：已验证安装二进制、真实窗口和测试文稿的打开、编辑与保存，安装前的应用数据文件保持不变。
- 未验证其他 Windows 机器上的全新安装。

## 发行文件

- `Inkstone-Setup-0.1.8-windows-x64.exe`：当前用户安装包。
- `Inkstone-0.1.8-windows-x64.zip`：Windows x64 便携版。
- `Inkstone-0.1.8-source.zip`：仅包含 Git 跟踪源码。
- `SHA256SUMS.txt`：发行文件的 SHA-256 校验值。

便携包的 `BUILD-INFO.json` 记录源码提交、可执行文件哈希和本轮验证。Windows 需要 Microsoft Edge WebView2。安装包和主程序未做 Authenticode 签名，SmartScreen 可能提示未知发布者。
