# 羽毛笔 · 用户版 / QuillPen (User Edition)

把「笔记」面板插件与「羽毛笔」AI 助手模式装进 DSH。**这是给最终用户用的版本。**

A DSH plugin that adds a **Notes** panel and a **QuillPen** AI assistant mode.
**This is the end-user edition.**

> **中文**在前，**English** 在后 ｜ Chinese first, English below.
> English readers: jump to [English](#english)

---

# 中文

## 这是什么

- **「笔记」面板** —— 笔记、白板（可手绘图形）、待办、标签、回收站、附件、文档读取（含扫描版 PDF）。
- **「羽毛笔」模式** —— 一个 DSH Agent 预设，内置 **42 个笔记工具**，可以直接让 AI 帮你写笔记、画白板、整理资料。

移植自 [Quill](https://github.com/)（本地优先的笔记 / 待办 / 白板应用），适配 DSH 的插件架构。

## 与开发版的区别（只有一处功能差异）

| | 开发版 | **用户版（本版）** |
|---|---|---|
| 笔记 / 白板 / 待办 / 标签 / 回收站 / 附件 / 文档读取 | ✅ | ✅ 完全一样 |
| AI 助手模式（42 个笔记工具） | ✅ 叫「笔记助手」 | ✅ 叫「**羽毛笔**」 |
| **新建云数据目录** | ✅ 内置创建能力 | ❌ **没有**（软件里既没有入口，也没有创建所需凭据） |
| 用 key 连接已有云数据目录 | ✅ | ✅ **保留**（由管理员创建并发放 key） |
| 默认笔记库 | 沿用原有配置 | **干净新库** `~/Documents/QuillNotes` |

> **云数据目录怎么来**：由管理员创建好后把一串 `QC1-…` 或 `QS2-…` 的 key 给你，
> 在「笔记本 → 云端库 → 连接云数据目录」里粘贴即可。**key 请勿公开分享**（里面含该目录的凭据）。

## 安装

1. **要求**：DSH 桌面版。**目前仅支持 Windows x64**（macOS 尚未适配，但代码里已预留平台分支，未写死路径）。
2. 在 DSH 里让 Agent 执行安装：

   ```
   plugin_manager install_bundle <本目录>/packages/dsh-quill-user
   ```

3. 装好后：侧边栏出现「笔记」入口；新建会话时模式下拉里出现「**羽毛笔**」。
4. 首次打开会自动在 `~/Documents/QuillNotes` 建一个空库。
   想用别的目录：在插件配置里写 `libraryRoot`，或设置环境变量 `DSH_QUILL_LIBRARY_ROOT`。

> 详细的逐步安装说明（写给另一台电脑上的 AI 看的）：见 **《安装说明-给AI.md》**。

## 用 key 连接云数据目录

云数据目录由管理员创建，他给你一串 key 后在「笔记本 → 云端库 → 连接云数据目录」里粘贴。

**正常情况下你不需要做任何配置** —— 服务器地址写在插件目录里的 `cloud-endpoint.json`（打包时一并带上）。

如果提示「连不上云服务器」，说明插件没拿到服务器地址：

1. **地址文件没跟着过来**（比如用 `git archive` 导出，会漏掉它 —— 它在 `.gitignore` 里）。
   解决：在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加下面这段，然后重启 DSH：

   ```yaml
   - id: quill-notes-user
     name: 'dsh-quill-user'
     config:
       cloudHost: '<管理员告诉你的服务器地址>'
       cloudPort: 22
   ```

2. **管理员还没给你地址** → 找他要。

> 如果拿到的是 `QC1-…` 开头的**长 key**（700 多字符），它自带地址，无需任何配置。

## 为什么"没有新建云数据目录"也能放心

软件里**不存在**创建云目录所需的任何东西 —— 这既是产品决定，也是安全设计：

| 层 | 具体做法 |
|---|---|
| 没有凭据 | 包里**不含** `provision.key`（连一个私钥文件都没有） |
| 没有代码 | 创建函数（`createCloudDir`）与密钥读取（`provisionKey`）**已删除** |
| 没有通道 | `cloud:create` 通道**已删除**（即使有会话凭据也调不到） |
| 没有入口 | 对话框只保留「用 key 连接」 |
| 构建期兜底 | `node tools/check-user-edition.mjs` 扫描：出现任何创建相关符号或私钥 → **失败** |

即使有人（或 AI）拿到完全的文件权限，也无法在这台机器上创建云目录 ——
除非他去别处拿到管理员的服务器凭据。**这也是本版本发布时该守的边界。**

## 主要功能

### 笔记
Markdown 编辑（CodeMirror）、实时预览、frontmatter 标题、库内搜索、标签、笔记夹拖拽整理。

### 白板
- 卡片（文字 / 图片 / 笔记引用 / 外部链接）四边连线
- **手绘图形**：矩形、椭圆、三角形、菱形、直线、箭头、曲线、自由绘制
- 曲线是"点两下成线 → 点线段中部插控制点 → 拖动变形 → 点空白锁定"（Adobe 手感）
- 图形与卡片同级：可框选、拖动、复制粘贴、删除
- **连线画下即固定**：接在哪条边由创建时决定，之后移动卡片不会自己改（想换就删了重画）

### 待办
收件箱式快速添加、截止日期、标签、与笔记双向关联。

### 文档读取
PDF（含扫描件，逐页渲染成图）、Word / Excel / PPT、HTML、CSV、纯文本 —— 都能转成文字喂给 AI。

## 常见问题

**Q：粘贴 key 后提示"key 无效，或这个云目录已经不存在了"？**
A：key 没复制全（含空格/换行），或该云目录已被管理员删除。先确认 key 完整，再找管理员确认。

**Q：提示"连不上云服务器"？**
A：见上文「用 key 连接云数据目录」。多半是地址文件没跟着过来。

**Q：我原来的笔记去哪了？**
A：用户版是**干净新库**，不会自动接管旧库。要沿用旧目录：在插件配置里写 `libraryRoot`，
或设环境变量 `DSH_QUILL_LIBRARY_ROOT`。

**Q：能不能同时装开发版和用户版？**
A：技术上可以（包名、面板 key、路由、样式作用域、数据目录、技能目录都已区分），
但**不建议同时打开同一个笔记库**（两个进程会争同一份索引）。推荐一台机器只装一个。

**Q：画白板时拖拽会选中卡片里的文字？**
A：已在 CSS 层处理（世界层 `user-select: none`，只有双击进入编辑态才允许选字）。若仍能选中，说明装的是旧版本。

## 开发与验证

```powershell
# 安装依赖
pnpm install

# 构建（css → host → client）
node build.mjs all

# 用户版专属验收（无创建能力 / 无密钥 / 通道已删 / 干净新库 / 命名）
node tools/check-user-edition.mjs

# 全量测试（36 套，含真浏览器端到端）
node tools/run-all.mjs

# 只跑快的（跳过真浏览器与云端套件）
node tools/run-all.mjs --fast
```

> `tools/run-all.mjs` 会自动发现 `tools/` 下所有 `check-*.mjs` / `smoke-*.mjs` 并汇总。
> 其中几套需要真浏览器（用系统已装的 Edge/Chrome，无需额外配置）。

## 许可

MIT（见 [LICENSE](LICENSE)）。本项目移植自 Quill（本地笔记 / 待办 / 白板）。
云数据目录需要自备服务端；**源码中不含任何服务器地址或凭据**（通过插件配置 / 环境变量提供）。

---

# English

## What is this

- **Notes panel** — notes, whiteboards (with freehand shapes), todos, tags, trash, attachments, document reading (including scanned PDFs).
- **QuillPen mode** — a DSH agent preset bundling **42 note tools**, so an AI can write notes, draw whiteboards and organise material for you.

Ported from [Quill](https://github.com/) (a local-first notes / todos / whiteboard app) onto DSH's plugin architecture.

## Difference from the developer edition

Only **one** functional difference:

| | Developer edition | **User edition (this one)** |
|---|---|---|
| Notes / whiteboards / todos / tags / trash / attachments / doc reading | ✅ | ✅ identical |
| AI assistant mode (42 note tools) | ✅ named "笔记助手" | ✅ named "**QuillPen / 羽毛笔**" |
| **Create a cloud data directory** | ✅ built in | ❌ **absent** — no UI entry point *and* no credentials to do it |
| Connect to an existing cloud directory via key | ✅ | ✅ **kept** (the admin creates it and hands you a key) |
| Default library | existing config | **fresh empty library** at `~/Documents/QuillNotes` |

> **Where do cloud directories come from?** An administrator creates one and gives you a `QC1-…` or `QS2-…` key.
> Paste it in *Notebook → Cloud library → Connect cloud directory*.
> **Please don't share the key publicly** — it contains credentials for that directory.

## Installation

1. **Requires** the DSH desktop app. **Windows x64 only for now** (macOS is not yet supported, though the code has platform branches and no hard-coded paths).
2. Ask the DSH agent to install it:

   ```
   plugin_manager install_bundle <this-dir>/packages/dsh-quill-user
   ```

3. Afterwards: a **Notes** entry appears in the sidebar, and **QuillPen** appears in the mode dropdown for new sessions.
4. On first launch an empty library is created at `~/Documents/QuillNotes`.
   To use another directory, set `libraryRoot` in the plugin config or the `DSH_QUILL_LIBRARY_ROOT` env var.

> A step-by-step guide written *for the AI on the target machine*: see **《安装说明-给AI.md》** (Chinese).

## Connecting to a cloud directory with a key

An administrator creates the cloud directory and hands you a key; paste it in
*Notebook → Cloud library → Connect cloud directory*.

**Normally you need no configuration at all** — the server address lives in `cloud-endpoint.json`
inside the plugin folder (shipped with the package).

If you see *"cannot reach the cloud server"*, the plugin didn't get the address:

1. **The address file didn't travel with the package** (e.g. it was exported with `git archive`, which skips it — it's in `.gitignore`).
   Fix: append this to `~/.dsh/profiles/desktop/cordis.patch.yml`, then restart DSH:

   ```yaml
   - id: quill-notes-user
     name: 'dsh-quill-user'
     config:
       cloudHost: '<the server address your admin gave you>'
       cloudPort: 22
   ```

2. **The admin hasn't given you an address yet** → ask them.

> If you received a **long key** starting with `QC1-…` (700+ chars), it carries the address itself — no config needed.

## Why it's safe that "create cloud directory" is missing

**Nothing** required to create a cloud directory exists in this software. That's both a product decision and a security design:

| Layer | What was done |
|---|---|
| No credentials | The package contains **no** `provision.key` — not a single private key file |
| No code | The creation function (`createCloudDir`) and key reader (`provisionKey`) were **deleted** |
| No channel | The `cloud:create` IPC channel was **deleted** (unreachable even with session credentials) |
| No entry point | The dialog only offers "connect with a key" |
| Build-time guard | `node tools/check-user-edition.mjs` fails the build if any creation symbol or private key shows up |

Even with full filesystem access, neither a person nor an AI can create a cloud directory on this machine —
they'd have to obtain the admin's server credentials elsewhere. **That is the boundary this edition is built to hold.**

## Features

### Notes
Markdown editing (CodeMirror), live preview, frontmatter titles, in-library search, tags, drag-and-drop folder organisation.

### Whiteboard
- Cards (text / image / note reference / external link) with connecting edges on all four sides
- **Freehand shapes**: rectangle, ellipse, triangle, diamond, line, arrow, curve, freehand
- Curves work the Adobe way: click twice to make a line → click the middle of a segment to insert a control point → drag to reshape → click empty space to lock
- Shapes behave like cards: marquee-select, drag, copy/paste, delete
- **Edges are frozen once drawn**: which side they attach to is decided at creation time; moving a card won't re-route them (delete and redraw to change)

### Todos
Inbox-style quick add, due dates, tags, two-way linking with notes.

### Document reading
PDF (including scanned documents, rendered page by page), Word / Excel / PowerPoint, HTML, CSV, plain text — all convertible to text for the AI.

## FAQ

**Q: After pasting a key I get "invalid key, or this cloud directory no longer exists"?**
A: Either the key wasn't copied in full (stray spaces/newlines), or the admin deleted that directory. Verify the key first, then ask the admin.

**Q: "Cannot reach the cloud server"?**
A: See *Connecting to a cloud directory* above — usually the address file didn't travel with the package.

**Q: Where did my existing notes go?**
A: The user edition starts with a **fresh empty library**; it won't take over an old one. To reuse an old directory,
set `libraryRoot` in the plugin config or the `DSH_QUILL_LIBRARY_ROOT` env var.

**Q: Can I install the developer edition and the user edition side by side?**
A: Technically yes (package name, panel key, route, style scope, data dir and skill dir are all distinct),
but **don't open the same library in both** — two processes would fight over one index. One per machine is recommended.

**Q: Dragging on the whiteboard selects text inside cards?**
A: Fixed at the CSS layer (`user-select: none` on the world layer; text becomes selectable only after double-clicking into edit mode). If you still see it, you're running an older build.

## Development & verification

```powershell
# Install dependencies
pnpm install

# Build (css → host → client)
node build.mjs all

# User-edition acceptance (no creation ability / no keys / channel removed / fresh library / naming)
node tools/check-user-edition.mjs

# Full test suite (36 suites, including real-browser end-to-end)
node tools/run-all.mjs

# Fast subset (skips real-browser and cloud suites)
node tools/run-all.mjs --fast
```

> `tools/run-all.mjs` auto-discovers every `check-*.mjs` / `smoke-*.mjs` under `tools/` and summarises the results.
> A few suites drive a real browser (using the Edge/Chrome already installed on the system — no extra setup).

## License

MIT — see [LICENSE](LICENSE). Ported from Quill (local-first notes / todos / whiteboard).
Cloud directories require your own server; **the source contains no server address or credentials**
(they're supplied via plugin config or environment variables).
