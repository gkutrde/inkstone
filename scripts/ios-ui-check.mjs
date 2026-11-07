import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
import React from 'react';
import { renderToString, renderToStaticMarkup } from 'react-dom/server';

// In-process checks: no browser binary, process pipes or extra dependencies.
// These are component/contract checks, NOT browser layout or native IPC tests.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = new Map();
globalThis.localStorage = {
  getItem: key => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: key => store.delete(key),
  clear: () => store.clear()
};
globalThis.window = { innerWidth: 1440 };
const checks = [];
function check(name, fn) { fn(); checks.push({ name, passed: true }); }
const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  server: { middlewareMode: true, hmr: false, watch: null },
  logLevel: 'error'
});
try {
  const { default: App } = await server.ssrLoadModule('/src/App.tsx');
  const icons = await server.ssrLoadModule('/src/components/IosIcons.tsx');
  const { default: Sidebar } = await server.ssrLoadModule('/src/components/Sidebar.tsx');
  const { default: Outline } = await server.ssrLoadModule('/src/components/Outline.tsx');
  const { default: CommandCenter } = await server.ssrLoadModule('/src/components/CommandCenter.tsx');
  const { default: PromptDialog } = await server.ssrLoadModule('/src/components/PromptDialog.tsx');
  const { extractOutline, countText } = await server.ssrLoadModule('/src/lib/metrics.ts');
  const { splitFrontmatter, restoreFrontmatter } = await server.ssrLoadModule('/src/lib/frontmatter.ts');
  const { loadDrafts, persistDrafts } = await server.ssrLoadModule('/src/lib/drafts.ts');
  const css = await readFile(path.join(root, 'src/ios.css'), 'utf8');
  const editorCss = await readFile(path.join(root, 'src/styles.css'), 'utf8');
  const appSource = await readFile(path.join(root, 'src/App.tsx'), 'utf8');
  const brand = await readFile(path.join(root, 'src/assets/brand-mark.svg'), 'utf8');

  const welcome = renderToString(React.createElement(App));
  check('welcome heading and actionable starter', () => {
    assert.ok(welcome.includes('一个安静的地方。'));
    assert.ok(welcome.includes('打开示例文稿'));
    assert.ok(welcome.includes('sidebar-compose'));
  });
  check('empty document disables save and export', () => {
    assert.match(welcome, /title="保存 \(Ctrl\+S\)"[^>]*disabled=""/);
    assert.match(welcome, /title="导出"[^>]*disabled=""/);
  });
  check('real callbacks connect new sidebar actions and starter', () => {
    assert.ok(appSource.includes('onNewDocument={newDocument}'));
    assert.ok(appSource.includes('onPickFile={() => void openFileDialog()}'));
    assert.ok(appSource.includes('onClick={openStarterDocument}'));
  });
  check('theme and editor controls expose selected states', () => {
    assert.ok(appSource.includes('aria-pressed={settings.theme === theme}'));
    assert.ok(appSource.includes('aria-pressed={activeTab.mode === "source"}'));
    assert.equal((appSource.match(/role="switch"/g) ?? []).length, 2);
  });

  for (const [name, Icon] of Object.entries(icons).filter(([, value]) => typeof value === 'function')) {
    check('symbol ' + name, () => {
      const html = renderToStaticMarkup(React.createElement(Icon, { size: 18, strokeWidth: 1.7, color: '#123456', className: 'review-symbol' }));
      assert.ok(html.includes('viewBox="0 0 24 24"'));
      assert.ok(html.includes('width="18"') && html.includes('height="18"'));
      assert.ok(html.includes('stroke="#123456"'));
      assert.ok(html.includes('stroke-width="1.7"'));
      assert.ok(html.includes('aria-hidden="true"'));
      assert.ok(html.includes('focusable="false"'));
      assert.ok(html.includes('class="review-symbol"'));
      assert.ok(html.includes('<path'));
    });
  }
  check('icon string sizes and accessibility overrides', () => {
    const html = renderToStaticMarkup(React.createElement(icons.Share, { size: '1em', 'aria-hidden': false, 'aria-label': '分享' }));
    assert.ok(html.includes('width="1em"'));
    assert.ok(html.includes('aria-hidden="false"'));
    assert.ok(html.includes('aria-label="分享"'));
  });

  for (const theme of ['paper', 'sepia', 'night']) {
    store.clear();
    localStorage.setItem('inkstone.settings.v1', JSON.stringify({ theme, showSidebar: true }));
    const html = renderToString(React.createElement(App));
    check('render theme ' + theme, () => assert.ok(html.includes('data-theme="' + theme + '"')));
  }
  store.clear();
  window.innerWidth = 390;
  localStorage.setItem('inkstone.settings.v1', JSON.stringify({ showSidebar: false, showOutline: false }));
  check('narrow initial state retains welcome without sidebar', () => {
    const html = renderToString(React.createElement(App));
    assert.ok(html.includes('class="welcome"'));
    assert.ok(!html.includes('class="sidebar"'));
    assert.ok(html.includes('显示文件树'));
  });
  window.innerWidth = 1440;
  store.clear();
  const draft = { id: 'review-draft', path: null, name: '写给今天的自己', content: '# 测试标题\n\n正文内容。', mode: 'source' };
  localStorage.setItem('inkstone.drafts.v1', JSON.stringify([draft]));
  check('persisted source draft restores tab and editor shell', () => {
    const html = renderToString(React.createElement(App));
    assert.ok(html.includes('写给今天的自己'));
    assert.ok(html.includes('source-editor-shell'));
    assert.match(html, /aria-pressed="true"[^>]*title="Markdown 源码/);
  });

  const noop = () => {};
  const node = { name: '灵感收集.md', path: 'C:/writing/灵感收集.md', isDir: false, children: [] };
  check('workspace file tree and quick actions render', () => {
    const html = renderToString(React.createElement(Sidebar, {
      workspace: 'C:/writing', tree: [node], activePath: node.path,
      onOpenFolder: noop, onNewDocument: noop, onPickFile: noop, onOpenFile: noop,
      onRefresh: noop, onCreateFile: noop, onCreateFolder: noop, onRename: noop,
      onTrash: noop, onReveal: noop, onClose: noop
    }));
    assert.ok(html.includes('tree-row is-active'));
    assert.ok(html.includes('aria-selected="true"'));
    assert.ok(html.includes('搜索标题或正文'));
    assert.ok(html.includes('sidebar-compose'));
    assert.ok(html.includes('sidebar-storage'));
  });
  check('outline preserves structure and stats', () => {
    const html = renderToString(React.createElement(Outline, { items: [{ text: '章节', level: 2, line: 3 }], onJump: noop, onClose: noop, wordCount: 128, minutes: 1 }));
    assert.ok(html.includes('outline-item level-2'));
    assert.ok(html.includes('章节') && html.includes('128'));
  });
  check('command palette renders with accessible dialog', () => {
    const html = renderToString(React.createElement(CommandCenter, { actions: [{ id: 'new', label: '新建文稿', section: '文稿', icon: React.createElement(icons.PenLine), run: noop }], onClose: noop }));
    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('新建文稿'));
    assert.ok(html.includes('command-option-icon'));
  });
  check('prompt renders form controls', () => {
    const html = renderToString(React.createElement(PromptDialog, { request: { title: '新建工作区', onSubmit: noop }, onClose: noop }));
    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('prompt-input'));
  });
  check('all themes, responsive and accessibility CSS contracts', () => {
    for (const selector of ['html[data-theme="sepia"]', 'html[data-theme="night"]', '@media (max-width: 760px)', '@media (max-width: 400px)', '@media (prefers-reduced-motion: reduce)', '@media (prefers-reduced-transparency: reduce)', '@media print']) assert.ok(css.includes(selector), selector);
    assert.ok(css.includes('.app.reduce-transparency'));
    assert.ok(css.includes('.app.is-focus .document-toolbar'));
    assert.ok(!css.includes('@import'));
  });
  check('app artwork is local SVG without executable or remote assets', () => {
    assert.ok(brand.includes('viewBox="0 0 128 128"'));
    assert.ok(!/<(?:script|image|foreignObject)\b/i.test(brand));
    assert.ok(!/href=["']https?:/i.test(brand));
  });
  check('list markers share the first text baseline without fixed offsets', () => {
    const row = editorCss.match(/\.ProseMirror \.list-item \{([^}]+)\}/)?.[1] ?? '';
    const wrapper = editorCss.match(/\.list-item > \.label-wrapper \{([^}]+)\}/)?.[1] ?? '';
    const label = editorCss.match(/\.list-item > \.label-wrapper > \.label \{([^}]+)\}/)?.[1] ?? '';
    assert.match(row, /align-items:\s*baseline/);
    for (const block of [wrapper, label]) {
      assert.match(block, /height:\s*auto/);
      assert.match(block, /padding:\s*0/);
      assert.match(block, /font:\s*inherit/);
      assert.ok(!block.includes('padding-top'));
    }
    assert.match(label, /width:\s*max-content/);
    assert.match(label, /white-space:\s*nowrap/);
  });
  check('list icons and heading content use the first line box', () => {
    const icon = editorCss.match(/\.list-item > \.label-wrapper > \.label svg \{([^}]+)\}/)?.[1] ?? '';
    const firstBlock = editorCss.match(/\.list-item > \.children > \.content-dom > :first-child \{([^}]+)\}/)?.[1] ?? '';
    assert.match(icon, /display:\s*inline-block/);
    assert.match(icon, /width:\s*0\.9em/);
    assert.match(icon, /vertical-align:\s*-0\.125em/);
    assert.match(firstBlock, /margin-top:\s*0/);
  });
  check('markdown outline excludes code fences', () => {
    const headings = extractOutline('```md\n# not a heading\n```\n\n# 第一章\n\n## 第二节');
    assert.deepEqual(headings.map(item => item.text), ['第一章', '第二节']);
  });
  check('frontmatter and draft storage remain lossless', () => {
    const markdown = '---\r\ntitle: 日常\r\n---\r\n\r\n# 正文\r\n';
    const split = splitFrontmatter(markdown);
    assert.equal(restoreFrontmatter(split.prefix, split.body), markdown);
    assert.equal(persistDrafts([{ ...draft, savedContent: '\u0000' }]), true);
    assert.equal(loadDrafts()[0].content, draft.content);
    assert.ok(countText('今天是美好的一天。').words > 0);
  });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  const report = { passed: checks.length, failed: 0, checks, limitations: ['No browser layout or interaction verification: Windows process-pipe policy blocks Chromium.', 'Native Tauri filesystem, dialogs and acrylic were not executed.'] };
  await writeFile(path.join(root, 'docs/ios-ui-check.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: checks.length, failed: 0, report: 'docs/ios-ui-check.json' }));
} finally {
  await server.close();
}
