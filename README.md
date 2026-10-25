> 本仓库创建于 2026年10月2日 10:33，配套的快捷命令让你能直接联通 GitHub 仓库。

# dsh-git-tools

给 DeepSeek Harness 的 agent 用的 Git 工具，git 在**宿主进程**中执行。

## 版本与测试环境

| 项目 | 版本 |
|---|---|
| **已验证的 DSH 版本** | **`0.1.1-rc.2`** 与 **`0.1.7-rc.2`** |
| Node.js | `v24.9.0`（DSH 随包自带） |
| Git | `2.55.0.windows.3` |
| 操作系统 | Windows 11（build 10.0.26200） |

### 兼容性范围

本插件已在**两个不同年代的 DSH 版本**上实测通过，两者都能正常加载并注册全部
8 个 agent 工具与 13 个斜杠命令：

| DSH 版本 | 场景 | 结果 |
|---|---|---|
| `0.1.1-rc.2` | 全局 CLI（`dsh web --port 8080`） | ✅ 通过 |
| `0.1.7-rc.2` | DSH Desktop | ✅ 通过 |

之所以能跨这两个版本，是因为插件**只使用两者共有的 API**：

- 宿主服务 `ctx.subprocess`（执行 git）与 `ctx.commands`（注册斜杠命令）
- 命令注册字段仅用 `name` / `description` / `handler` / `input.hint`

### 刻意避开的字段

`CommandDefinitionId`（来自 `@deepseek-ai/dsh-commands/brand`）**只存在于较新版本**，
`0.1.1-rc.2` 的 `brand` 模块仅导出 `CommandId`。它的类型声明是：

```ts
export interface CommandDefinition {
    readonly name: string;
    readonly description: string;
    readonly input?: CommandInputDescriptor;
    readonly recordInput?: boolean;
    readonly handler: (invocation) => CommandResult | Promise<CommandResult>;
}
```

**没有 `definitionId`。** 早期版本曾依赖该字段，导致在 `0.1.1-rc.2` 上加载时报：

```
SyntaxError: The requested module '@deepseek-ai/dsh-commands/brand'
does not provide an export named 'CommandDefinitionId'
```

现已完全移除。因为 `definitionId` 在新版中本就是**可选**字段，移除不影响新版行为，
却让旧版也能加载。

### 其他说明

- `package.json` 的 `peerDependencies` 声明了 `@deepseek-ai/cordis@^4.0.1` 与
  `@deepseek-ai/dsh-tools@^0.1.1-rc.2`（下限设为已验证的最低版本，以便旧版也能安装）。
  这两个包由 DSH 运行时注入，**不需要 pnpm 安装**，安装时若出现 `missing peer` 警告可以忽略。
- **升级 DSH 后请重新验证。** 尤其是斜杠命令的注册契约与命令名规则
  （`/^[a-z][a-z0-9_-]*$/`）属于宿主内部约定，跨版本可能变化；本插件之所以兼容两个版本，
  正是因为它只依赖这些约定中最稳定的部分。
- 使用新版本专有 API 会立刻破坏旧版兼容。若确需使用，请在本文档的兼容表中
  注明最低版本要求。

## 为什么需要它

agent 的 shell 运行在 `workspace-write` 文件沙箱里，实测该环境**无法访问网络**：
受限进程拿不到 TLS 凭据句柄，任何 `https://` 请求都会失败（包括 GitHub、gitee、百度）。
同时 **git 不读 Windows 系统代理（WinINET）**，所以即使 FLClash 开着系统代理，
沙箱内的 `git fetch` / `pull` / `push` 依然失败。

本插件通过 `ctx.subprocess` 在宿主进程里 spawn git。宿主进程不受 agent 沙箱约束，
因此这些联网操作可以正常工作。这与官方 `dsh-workspace-changes` 插件执行
`git diff-tree` 的方式一致。

## 提供的工具

| 工具 | 作用 | 是否联网 |
|---|---|---|
| `git_status` | 分支、upstream、ahead/behind、逐文件状态 | 否 |
| `git_diff` | 工作区 / 暂存区 / 指定 rev 的 diff | 否 |
| `git_log` | 最近提交列表 | 否 |
| `git_stage` | 暂存或取消暂存（`all` 或指定路径） | 否 |
| `git_commit` | 创建提交（支持 `all`、`amend`） | 否 |
| `git_remote` | 列出 / 添加 / 改写远端，并说明其认证方式 | 否 |
| `git_branch` | 列出 / 创建 / 切换 / 重命名 / 删除分支 | 否 |
| `git_fetch` | 抓取远端并报告 ahead/behind | **是** |
| `git_pull` | 抓取并集成（支持 `rebase`） | **是** |
| `git_push` | 推送到远端（支持 `set-upstream`） | **是** |

所有工具都接受可选 `cwd`，默认使用当前会话的工作目录。

### `git_remote`

`action: list | add | set-url`

- `list`（默认）列出每个远端、它的 URL，以及**这个 URL 会怎样认证**——即一次推送会不会弹凭据框。
- `add` 在名字已存在时拒绝，并指出改用 `set-url`；`set-url` 在远端不存在时拒绝。把远端名当 URL 传也会被拒绝并给出示例。
- `preferSsh: true` 会把 HTTPS URL 改写为同主机的 SSH 形式：
  `https://gitee.com/u/r.git` → `git@gitee.com:u/r.git`。带非标准端口、路径无法安全改写的 URL 会**原样保留并说明原因**，不会硬改。

加好远端后，输出会直接给出下一步该敲的命令。

### `git_branch`

`action: list | create | switch | delete | rename`

删除默认走 `git branch -d`（安全形式）：未合并的分支会被拒绝，并提示需要 `force: true` 才改用 `-D`。删除当前已检出的分支会被直接拒绝。`create` 与 `rename` 都会先过 `git check-ref-format`，非法名字进不到 git。

## 提供的斜杠命令（人类使用）

在输入框直接输入即可，**不经过模型**，在宿主进程中执行 git：

| 命令 | 选项 | 是否联网 |
|---|---|---|
| `/git` | — | 否 |
| `/git-status` | `cwd=<dir>` | 否 |
| `/git-diff` | `--staged` `rev=<rev>` `cwd=<dir>` | 否 |
| `/git-log` | `n` `cwd=<dir>` | 否 |
| `/git-commit` | `--all` `--amend` `<message>` `cwd=<dir>` | 否 |
| `/git-fetch` | `--prune` `remote=<name>` `cwd=<dir>` | **是** |
| `/git-pull` | `--rebase` `remote=<name>` `branch=<name>` `cwd=<dir>` | **是** |
| `/git-push` | `--set-upstream` `remote=<name>` `branch=<name>` `cwd=<dir>` | **是** |
| `/git-name-set` | `name=<name>` `email=<email>` `remote=<url>` `cwd=<dir>` | 否 |
| `/git-tag-show` | `[version]` `cwd=<dir>` | 否 |
| `/git-tag` | `<version>` `[<remote>]` `message=<text>` `rev=<rev>` `cwd=<dir>`；或 `--push [version] [<remote>]` | **是** |

**每一个命令都支持 `cwd=<dir>`**，用于指定仓库所在目录（见下方「关于仓库定位」）。

### 参数类型约定

| 记号 | 含义 | 例子 |
|---|---|---|
| `<x>` | 必填值 | `<message>` |
| `[x]` | 可选 | `[cwd=<dir>]` |
| `--flag` | 开关，写了就生效，**不带值** | `--staged` |
| `key=<v>` | 键值对，**必须带 `=`** | `cwd=D:\repo` |

⚠️ **值参数漏掉 `=` 会失效**：`cwd=D:\repo` ✅；`cwd D:\repo` ❌（被当成两个无关的词）。

## 两个关键参数：`cwd` 与 `remote`

这两个是**寻址参数**——它们不提供新能力，只负责把命令指向正确的目标。

### `cwd=<dir>`：指定操作哪个仓库

**所有 9 个命令都支持**，这是最常用的参数。

| 项目 | 说明 |
|---|---|
| 指定什么 | git 在**哪个目录**执行，也就是操作哪个仓库 |
| 默认值 | 省略时使用**当前会话的工作目录** |
| 写法 | `cwd=D:\path\to\repo` 或 `cwd=D:/path/to/repo`（两种斜杠都行） |
| 必须是仓库 | 目录不是 git 仓库时会明确报错，**不会静默失败** |
| 路径含空格 | **支持**，把值用引号包起来即可（见下） |

**值里含空格时加引号**：

```
/git-status cwd="D:\My Projects\repo"
/git-commit "a message with spaces" cwd="D:\My Projects\repo"
```

单引号等价；也可以只转义空格本身：`cwd=D:\My\ Projects\repo`。

只有出现在**词首**或**紧跟 `=` 之后**的引号才会开启引用，所以 `it's` 这种词中间的撇号会原样保留，不会被当成引号吞掉。

**什么情况下必须写 `cwd=`：**

会话工作目录本身不是 git 仓库时。典型情形是工作区指向一个"容器目录"，
真正的仓库在它的子目录里：

```
工作区根      D:\Githubrep                              ← 不是仓库
真正的仓库    D:\Githubrep\skills-introduction-to-github  ← 仓库在这里
```

此时每个命令都要带 `cwd=`：

```
/git-status cwd=D:\Githubrep\skills-introduction-to-github
/git-commit cwd=D:\Githubrep\skills-introduction-to-github "改了什么"
/git-push   cwd=D:\Githubrep\skills-introduction-to-github
```

**一劳永逸的替代方案**：把 DSH 工作区直接指向仓库根目录。
之后所有命令零参数，也不再需要 `cwd=`。

### `remote=<...>`：指定远端——**注意语义有两种**

`remote=` 在两类命令里含义**完全不同**，这是最容易搞混的地方。
（下表只列出**涉及远端**的命令，不是命令全集；全集见上面的命令表。）

| 命令 | `remote=` 填什么 | 例子 | 效果 |
|---|---|---|---|
| `/git-push`<br>`/git-pull`<br>`/git-fetch` | **远端名** | `remote=origin` | 对哪个已配置的远端操作 |
| `/git-name-set` | **URL** | `remote=https://github.com/you/repo.git` | 把这个仓库的 origin **改指向**新地址 |

**为什么容易错**：`remote=upstream` 在 push/pull/fetch 里是合法的（"名叫 upstream 的远端"），
但在 `/git-name-set` 里会被**拒绝**，因为它期待一个 URL。

```
/git-push remote=upstream                    ✅ 远端名，推到名为 upstream 的远端
/git-name-set name=X email=x@y.com remote=upstream          ❌ 被拒绝：这需要 URL
/git-name-set name=X email=x@y.com remote=https://...git    ✅ URL，改写 origin
```

**基本信息：**

| 项目 | 说明 |
|---|---|
| 适用命令 | 只有 `/git-push`、`/git-pull`、`/git-fetch`（其余命令不涉及远端） |
| 默认值 | `origin`——git 克隆仓库时自动创建的默认远端 |
| 什么时候需要改 | 见下方「多个远端的场景」 |

**多个远端的场景**（默认 `origin` 不够用时）：

```powershell
# 先在终端里添加一个远端（插件没有添加远端的命令）
git remote add gitee https://gitee.com/you/repo.git
git remote add upstream https://github.com/original/repo.git
```

之后就能用 `remote=` 区分：

```
/git-push remote=gitee          推到 Gitee 而不是 GitHub
/git-fetch remote=upstream      从原始仓库（你 fork 的来源）取更新
/git-pull remote=upstream branch=main   把原始仓库的 main 合并进来
```

**查看当前有哪些远端**：插件没有专门命令，用终端 `git remote -v`，
或让 agent 执行。

### `/git-name-set`：配置提交身份与仓库指向

一次性设置**提交身份**，并可选地把当前仓库指向另一个远端地址：

```
/git-name-set name=ZhangSan email=zhangsan@example.com
/git-name-set name=ZhangSan email=zhangsan@example.com remote=https://github.com/zhangsan/repo.git
```

| 参数 | 必填 | 写入位置 | 作用范围 |
|---|---|---|---|
| `name=<name>` | ✅ | `git config --global user.name` | **全机器所有仓库** |
| `email=<email>` | ✅ | `git config --global user.email` | **全机器所有仓库** |
| `remote=<url>` | — | 目标仓库的 `origin`（`remote set-url`） | **仅该仓库** |
| `cwd=<dir>` | — | — | 指定要改远端的仓库 |

**两点必须理解清楚：**

1. **身份是全局的，不是临时的。** `git config --global` 写入 `~/.gitconfig`，
   之后本机所有仓库的提交都用这个名字和邮箱。想只影响单个仓库，请手动用
   `git config --local`。
2. **`remote=` 必须填 URL，不能填远端名。** 填 `remote=upstream` 会被拒绝，
   因为这是"远端名"而非地址。它的作用是**改变这个仓库推送的目标地址**，
   而不是新建一个远端。

所有校验都在写入之前完成：**参数有误时不会有任何副作用**（不会写配置、不会改 remote）。

示例：

```
/git 列出全部命令与用法
/git-status
/git-commit 修复登录跳转
/git-commit --all 批量更新文档
/git-push --set-upstream
/git-pull --rebase
/git-diff --staged
```

也支持 `key=value` 形式的选项，用于覆盖默认值：

```
/git-status cwd=D:\some\other\repo
/git-push remote=upstream branch=release
/git-diff rev=origin/main...HEAD
```

**关于仓库定位**：命令默认以「会话工作目录」为仓库根。如果该目录本身不是仓库
（例如工作区指向 `D:\Githubrep` 而仓库在其子目录），命令会返回一条明确提示，
此时用 `cwd=<路径>` 指向真正的仓库，或直接把工作区改到仓库根目录。

## 版本管理（标签）

### 先理解：版本是什么

git 里**没有自动的版本号**。每 `git commit` 一次就产生一个提交，但提交只由哈希
（如 `9f6af9d`）标识，无法用 `v1.0.0` 这样称呼它。

**标签（tag）就是给某个提交起的名字**，这才是"版本"：

```
提交 b237987 ──▶ C1
提交 8985e21 ──▶ C2
提交 816bced ──▶ C3  ◀── 标签 v1.0.0 指向这里
```

关键性质：

- **标签指向一个提交**，所以任何版本都能被永久取回（只要该提交存在）
- **标签是本地对象**，`git tag` 只写进你的本地仓库
- **必须推送到远端**（`/git-tag` 创建时就会推送），GitHub 才会在 **Tags** 和 **Releases** 页显示它
- **删掉标签不影响提交**；提交本身不会被标签"绑定"

### 两个命令

打标签与推送被合并进同一条命令，读写分离：**`/git-tag-show` 只读**，**`/git-tag` 负责写和推**。

| 命令 | 作用 | 联网 |
|---|---|---|
| `/git-tag-show` | 列出所有版本（最新在前，含哈希、日期、主题） | 否 |
| `/git-tag-show <version>` | 查看某个版本：标签信息 + 改动的文件 | 否 |
| `/git-tag <version> [<remote>]` | 打标签并推送到远端（默认 `origin`） | **是** |
| `/git-tag --push [version]` | 推送已存在的标签；省略版本则推送全部 | **是** |

### 完整工作流

```
# 1. 确认当前状态，想清楚给哪个提交打版本
/git-status cwd=D:\Githubrep\skills-introduction-to-github
/git-log 5 cwd=D:\Githubrep\skills-introduction-to-github

# 2. 打版本标签并推送（一步完成；省略远端则用 origin）
/git-tag v1.0.0 message=首个可用版本 cwd=D:\Githubrep\skills-introduction-to-github

# 3. 本地确认（列出全部版本）
/git-tag-show cwd=D:\Githubrep\skills-introduction-to-github

# 4. 若推送失败（标签已留在本地），只重推不重复创建
/git-tag --push v1.0.0 cwd=D:\Githubrep\skills-introduction-to-github

# 5. 随时回顾某个版本改了什么
/git-tag-show v1.0.0 cwd=D:\Githubrep\skills-introduction-to-github
```

### 参数细节

**`/git-tag <version>`**（创建 + 推送）

| 参数 | 必填 | 说明 |
|---|---|---|
| `<version>` | ✅ | 版本名，如 `v1.0.0`。**第一个**位置参数 |
| `[<remote>]` | — | **推送目标**，**第二个**位置参数，如 `/git-tag v1.0.0 origin`；省略则用默认远端 `origin`。也可写成 `remote=<name>`，两者等价 |
| `message=<text>` | — | 给出则创建**附注标签**（带说明与打标签者信息）；省略则创建**轻量标签** |
| `rev=<rev>` | — | 给指定提交打标签；省略则给当前 `HEAD` 打 |
| `cwd=<dir>` | — | 仓库目录 |

⚠️ **两个位置参数就是上限，且选项值不能含空格。** 解析按空格分词，所以
`message=first release` 会变成 `message=first` 加一个游离词 `release`。命令**不会**
把它当成推送目标——它会拒绝并说明原因（游离词若恰好是已配置的远端名，仍会被当作
推送目标，所以给 message 赋值时请勿留空格）：

```
/git-tag v1.0.0 message=first release        ❌ 报 Unknown remote: release
/git-tag v1.0.0 origin message=first release ❌ 报 Too many arguments
/git-tag v1.0.0 message=first-release        ✅
```

第二个位置参数会**对照 `git remote` 校验**：写成未配置的名字会直接报错并列出可用远端，
不会静默推到一个不存在的目标。`remote=<name>` 等价于第二个位置参数。

**版本名规则**（同时用内置正则与 `git check-ref-format` 双重校验）：

| 规则 | 例 |
|---|---|
| 不能含空格 | ❌ `v1 0` |
| 不能含 `~ ^ : ? * [ \ |` | ❌ `v1:0` |
| 不能含连续两个点 | ❌ `v1..0` |
| 不能以 `.` 或 `-` 开头 | ❌ `-v1` |
| 不能以 `.` 或 `.lock` 结尾 | ❌ `v1.0.0.lock` |
| 允许斜杠（可做分层命名） | ✅ `release/v1.0.0` |

**`/git-tag --push [version]`**（只推送，不创建）

| 参数 | 必填 | 说明 |
|---|---|---|
| `[version]` | — | **省略则推送全部本地标签**（`push --tags`） |
| `[<remote>]` | — | 推送目标，第二个位置参数，默认 `origin`（`remote=<name>` 等价） |
| `cwd=<dir>` | — | 仓库目录 |

⚠️ `--push` 之后的**第一个词永远是版本名**，所以 `/git-tag --push origin` 是在找名为
`origin` 的标签。想把全部标签推到某个远端，请写 `remote=`：

```
/git-tag --push origin              ❌ 报 "origin is a configured remote, not a tag"
/git-tag --push remote=origin       ✅ 全部标签推到 origin
/git-tag --push v1.0.0 origin       ✅ 只推 v1.0.0 到 origin
```

**执行顺序**：先创建（本地、快），再推送。两者各自报告结果；推送失败时标签**已经存在**
于本地，命令会明确告诉你这一点并给出重推命令，不会让你误以为版本没打成。

### 与 GitHub Releases 的关系

推送标签后，GitHub 会**自动生成** Tags 页：

```
https://github.com/<用户>/<仓库>/tags
```

而 **Releases 页**需要额外一步（在标签基础上附加发布说明、二进制包）：

```
https://github.com/<用户>/<仓库>/releases
```

两种做法：

1. **在 GitHub 网页上创建 Release**（推荐）——打开 Tags 页，点标签右侧的
   "Create release"，填标题和说明即可
2. **等本插件后续支持** —— 创建 Releases 需要调用 GitHub API，目前**未实现**；
   本插件的标签命令只负责 git 侧的标签，不涉及 GitHub Releases API

### 已知限制

- **没有删除标签的命令**。要删请用终端 `git tag -d <版本>`（本地）或
  `git push origin --delete <版本>`（远端）
- **不能检出/切换到某个版本**。查看用 `/git-tag-show <版本>`，真要切过去需要
  `git switch --detach <版本>`
- **不支持签名标签**（`git tag -s`）
- **没有"只创建不推送"的用法**：`/git-tag` 一律创建后推送。推送失败时标签留在本地，
  用 `/git-tag --push <版本>` 单独重推；不需要推送的标签请在终端用 `git tag` 手动创建
- **一次 `/git-tag --push` 不带版本会推送全部标签**，注意目标仓库是否需要这么多版本

## 提供的 agent 工具

与斜杠命令并列，模型也可以自主调用同名能力（`git_status`、`git_commit` 等）。
两者的区别只是触发者：命令由**人**输入 `/` 触发，工具由**模型**按需调用。

## 设计说明

- **不做 force push**：`git_push` 只使用 git 默认的非强制推送，没有提供 force 参数。
- **输出与语言环境无关**：使用 `--porcelain`、`-z`、显式 `--pretty=format`，
  不依赖 `LC_ALL`。
- **凭据**：`GIT_TERMINAL_PROMPT=0` 保证缺少凭据时快速失败而不是挂起。
  Windows 上 `credential.helper=manager` 会从凭据管理器取票，无需交互。
- **超时**：本地操作 120 秒，联网操作 300 秒。
- **`--no-color` 只用于接受它的子命令**：实测（git 2.55）`git diff` 与 `git log`
  **接受** `--no-color`，而 `git commit`、`git fetch`、`git pull`、`git push`
  **拒绝**它并直接以 `error: unknown option 'no-color'` 失败。切勿给后者添加该参数。
- **沙箱边界不变**：agent 自己的 shell 仍受 `workspace-write` 限制，
  本插件没有放宽它，只是把 git 放到了宿主侧执行。

## 安装

**本仓库根目录就是一个可安装的 DSH bundle**（根 `package.json` 声明了
`dsh.bundle.patch`，指向根 `cordis.patch.yml`），所以三种方式都可以：

### 方式 1：从 GitHub 地址安装

DSH GUI 侧边栏 →「插件」页 →「添加插件」，填入仓库地址：

```
https://github.com/Yangi-252410/dsh-import-repositories
```

### 方式 2：从本地目录安装

先把仓库克隆到本机，然后填入**该目录的绝对路径**：

```
D:\Githubrep\dsh-git-tools
```

⚠️ 用**正斜杠**更稳妥（GUI 输入框里反斜杠可能被转义吃掉）：

```
D:/Githubrep/dsh-git-tools
```

### 方式 3：由 agent 安装

由具备 `plugin_manager` 工具的会话执行 `install_bundle`，target 填本地绝对路径。

### 安装后

| 项目 | 说明 |
|---|---|
| 生效范围 | **该 `DSH_HOME` 的这个 profile**（同一根下的所有工作区；其他 `DSH_HOME` 不受影响） |
| 生效时机 | 重启宿主进程 + 新会话（命令集与工具集在会话创建时固定） |
| 出现内容 | 8 个 agent 工具（`git_status` 等） |
| 斜杠命令 | 输入 `/git` 列出全部 |
| `missing peer` 警告 | 可忽略，`@deepseek-ai/*` 由运行时注入 |

**版本对应**：`package.json` 的 `version` 字段（当前 `1.2.3`）是插件自身的版本，
与仓库的 git 标签（如 `v1.2.3`）是两套编号——习惯上让它们对齐，但升插件版本不会自动打标签，
反之打标签也不会自动改 `package.json`。查看已发布的版本请到仓库的 Releases 页。

## 多宿主与更新（重要）

**装在哪里由 `$DSH_HOME` 决定，不由本仓库的位置决定**：

```
$DSH_HOME/profiles/<profile>/          ← 插件的实际安装目录
```

`DSH_HOME` 的取值顺序（见 `@deepseek-ai/dsh-home-paths`）：显式配置 → 环境变量 `DSH_HOME`
→ 默认 `~/.dsh`。桌面应用会把自己的 harness 目录设为 `DSH_HOME`；自定义启动脚本
（例如 `start-dsh-web.cmd` 里的 `set DSH_HOME=...`）可以指向任意目录。

**因此：不同的 `DSH_HOME` 就是不同的安装，彼此完全独立。** 同一台机器上很容易同时存在多个：

| 宿主 | `DSH_HOME`（示意） | profile |
|---|---|---|
| 全局 CLI `dsh web`（环境里没设 `DSH_HOME`） | `~/.dsh` | 默认或 `--profile` 指定 |
| DSH 桌面应用 | `%APPDATA%\dsh-desktop\harness` | `web` |
| 自定义脚本启动的实例 | 脚本里 `set DSH_HOME=` 的目录 | `--profile` 指定 |

在某一端安装或更新，**其他端不会跟着变**；同一个根下的多个进程（例如两个 `dsh web`）
才共享同一份安装。想确认自己在哪一端，就在该端终端执行 `"$env:DSH_HOME"`，
或直接看界面里 `/git` 有没有命令。

### 两种安装形态：更新方式不同

| 形态 | 出现位置 | 由谁创建 | 如何更新 |
|---|---|---|---|
| **普通 pnpm 安装** | `profiles/<p>/node_modules/dsh-git-tools` | CLI `dsh plugin add` 或网页插件页 | `dsh plugin --profile <p> rm dsh-git-tools`，再 `add <spec>`，然后重启进程 |
| **generation 快照** | `profiles/.generations/live/<包名>+<版本>+<哈希>/`，并由 `profiles/<p>/package.json` 的 `pnpm.overrides` 指向它 | **只有桌面应用**（日志形如 `generation-install: … promoted to …`） | 在桌面插件页重新安装（源填本地路径最稳）。此时 `dsh plugin add` 只改依赖记录，**不会**重投影快照，代码不会变 |

### 更新步骤（通用）

1. 确认目标端的根：`"$env:DSH_HOME"`；
2. 更新：CLI/网页端用 `dsh plugin --profile <p> rm|add <spec>`；桌面端用插件页重装；
3. **重启该宿主进程**（`Ctrl+C` 后重新 `dsh web`，或重启桌面应用）；
4. **新开会话**——旧会话永远是旧命令表；
5. 自检（都在 `$DSH_HOME/profiles/<p>/` 内）：
   - `package.json` → `dependencies["dsh-git-tools"]` 的版本；
   - `pnpm-lock.yaml` → 该包后面的 commit（`git+…#<sha>`）；
   - `node_modules/dsh-git-tools/index.js` → 是否含新命令（例如 `git-tag-show`）；
   - 界面上 `/git` 列出的命令。

### 两个必须知道的坑

- **git 依赖被 lock 钉死**：`add github:<owner>/<repo>` 之后，`pnpm-lock.yaml` 记录的是
  当时解析到的 commit。**再 `add` 同一个 spec 不会换 pin**，必须 `rm` 之后再 `add`
  （或显式写 `#main` / `#<sha>`），否则会以为"更新了"其实还是旧代码。
- **填写过的 spec 不会被原样记录**：`package.json` 里存的是解析后的版本号（如 `1.2.3`），
  所以只看依赖版本**分不出**当初是从本地路径还是 GitHub 装的。要看去
  `profiles/<p>/.plugin-manager/logs/*/generation.log`（桌面端）或 `pnpm-lock.yaml`（CLI 端）。

## 已知限制

- 仅宿主插件，暂无 Web UI 面板（面板是下一步）。
- `git_push` 依赖已保存在 Windows 凭据管理器中的凭据；没有缓存凭据时会失败并给出 git 的诊断信息。
- 冲突的 `git_pull` 会报错并把冲突留给用户解决，不会自动处理。
