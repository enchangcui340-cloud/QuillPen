# 安装说明（给 DSH 助手读）

> **这份文档是给"接收方电脑上的 DSH 助手"看的。**
> 人类用户：把整个 `dsh-quill-user` 文件夹交给你的 DSH，让它照这份文档装好即可。
> DSH 助手：请按下面步骤执行，遇到"需要人类确认"的地方再问。

---

## 一、这是什么

一个 DSH 插件包（提供面板插件 + Agent 预设）：

| 项 | 内容 |
|---|---|
| 面板 | 「笔记」（侧边栏入口） |
| Agent 模式 | 「羽毛笔」（能力等同标准模式，产物只落进笔记库） |
| 功能 | 笔记 / 白板 / 待办 / 标签 / 回收站 / 附件 / 文档读取（PDF、Word）+ 42 个笔记工具 |
| **不含** | **「新建云数据目录」能力** —— 这是**有意设计**：云目录由管理员创建并发放 key，本包没有创建所需的凭据与代码 |

---

## 二、安装（三步）

### 第 1 步：装插件

用 `plugin_manager` 安装 bundle，路径指向**本文件夹**下的插件包：

```
plugin_manager install_bundle <本文件夹绝对路径>/packages/dsh-quill-user
```

例如本文件夹在 `D:\软件\dsh-quill-user\`，则执行：

```
plugin_manager install_bundle D:\软件\dsh-quill-user\packages\dsh-quill-user
```

> 装好后 DSH 的 profile 会自动登记这个 bundle。

### 第 2 步：检查依赖是否可用

插件的宿主代码运行时要 import `ssh2` / `turndown` / `mammoth` / `pdfjs-dist` 等。
依赖已随包提供（`packages/dsh-quill-user/node_modules/`）。

**但要检查一件事**：如果这个文件夹是从**另一台电脑复制**过来的，
里面 pnpm 用的是 **junction（绝对路径链接）**，换路径后可能失效。
在 `packages/dsh-quill-user` 目录下执行：

```powershell
node -e "require.resolve('ssh2'); console.log('ssh2 OK')"
```

- 打印 `ssh2 OK` → 依赖没问题，跳到第 3 步。
- 报 `Cannot find module 'ssh2'` → 在该目录执行：

  ```powershell
  pnpm install
  ```

  （没有 pnpm 就用 `npm install`。）

### 第 3 步：云服务器地址（**只有要用云端目录时才需要**）

**背景**：管理员发给用户的 key（`QS2-…`，约 84 字符）**故意不含服务器地址** ——
为的是开源代码里不出现管理员的服务器。所以地址必须从外部提供。

地址的三个来源（按优先级）：

| 优先级 | 来源 | 谁准备 |
|---|---|---|
| ① | 环境变量 `DSH_QUILL_CLOUD_HOST` / `DSH_QUILL_CLOUD_PORT` | 使用者自己设 |
| ② | 插件配置 `config.cloudHost`（在 profile 的 `cordis.patch.yml`） | 使用者自己配 |
| ③ | **包内文件 `packages/dsh-quill-user/cloud-endpoint.json`** | **管理员打包时带上** |

**先检查 ③ 在不在**：

```powershell
Get-Content packages\dsh-quill-user\cloud-endpoint.json
```

- **有内容** → 什么都不用做，装完即可直接用短 key。**跳到第四节验证。**
- **不存在** → 需要向管理员要地址，然后在 `~/.dsh/profiles/desktop/cordis.patch.yml`
  末尾追加下面这段（`<服务器地址>` 换成管理员给的）：

  ```yaml
  - id: quill-notes-user
    name: 'dsh-quill-user'
    config:
      cloudHost: <服务器地址>
      cloudPort: 22
  ```

  改完**重启 DSH**（profile 配置在启动时读取）。

---

## 三、让改动生效

1. `plugin_manager` 装 bundle 时通常会自动生效；
2. 若面板没出现，把该 bundle **关掉再打开**（`set_bundle enabled=false` → `true`）强制重载；
3. 浏览器**强刷**（`Ctrl+Shift+R`）让客户端代码更新。

---

## 四、验证装好了

依次确认：

| # | 检查 | 预期 |
|---|---|---|
| 1 | 侧边栏 | 多出一个「笔记」入口 |
| 2 | 新建会话的模式下拉 | 有「羽毛笔」 |
| 3 | 打开「笔记 → 云端库 → 连接云数据目录」 | 只有一个输入框（**没有"创建新目录"那一栏**） |
| 4 | 粘贴管理员给的 key → 点「测试连接」 | 显示「key 有效：云端已有 N 个文件」 |
| 5 | 点「连接并使用」 | 提示已连接，面板切到该云目录 |

---

## 五、常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 侧边栏没有「笔记」 | bundle 没装上，或客户端未刷新 | 重装 bundle；强刷页面 |
| 点「连接」报**「连不上云服务器」** | 地址没配（第 3 步） | 检查 `cloud-endpoint.json` 是否存在；否则按第 3 步配 |
| 报**「key 无效，或这个云目录已经不存在了」** | key 抄错/少字符，或该云目录已被删除 | key 要**整串**复制（84 字符，`QS2-` 开头、6 位校验位结尾）；或找管理员 |
| 报**「key 不完整或已被改动：校验位对不上」** | key 复制不全 | 整串重新复制（不要手敲） |
| 报 `Cannot find module 'xxx'` | 依赖没装好（junction 失效） | 见第 2 步 |
| 面板打开是空白 / 报「面板渲染出错」 | 产物不完整 | 确认 `lib/` 下 `host.js`、`client.js` 都在；重新复制整包 |

---

## 六、本机要求

- **DSH 桌面版**，**Windows x64**（当前仅支持 Windows；代码里已预留 macOS/Linux 分支但未验证）
- 不需要联网也能用（依赖随包自带，除非第 2 步需要重装）

---

## 七、给管理员的话（如果你就是打包的人）

- 打包时**务必带上** `packages/dsh-quill-user/cloud-endpoint.json`（服务器地址）。
  它被 `.gitignore` 排除（**不进开源仓库**），但**会跟着文件夹复制**。
- **不要用 `git archive` 打包** —— 那样会漏掉上面那个文件。
  用"复制文件夹"或压缩整个目录。
- 若目标机路径与本机不同，建议提醒对方执行第 2 步的依赖检查。
