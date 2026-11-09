# dsh-skill-manager · DeepSeek Harness (DSH) Skill 技能管理

中文 | [English](README.en.md)

<p align="center">
  <img src="https://img.shields.io/npm/v/@moruoxing/dsh-skill-manager?style=flat-square" alt="Version">
  &nbsp;
  <img src="https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.2-4c6ef5?style=flat-square&amp;labelColor=454a54" alt="DSH">
  &nbsp;
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
</p>

<p align="center">
  <strong>DeepSeek Harness（DSH）官方 Web GUI 与桌面客户端专属技能中心与 Skill 管理面板</strong><br>
  <em>按来源层级浏览 · 一键启闭模型调用 · 技能广场与 Git 仓库安装 · 更新检查 · 可视化新建/编辑 SKILL.md · 安全回收站与 git 备份 · 零侵入管理</em>
</p>

DSH Web GUI 与官方桌面客户端的**技能中心**：按来源分级浏览已加载的全部 skill，启用/禁用模型调用，集成 SkillHub 广场与 Git 仓库安装并自动纳管到 skills-manager 中央库，支持远端版本检查与一键更新、技能预设与批量管理、创建与原地编辑技能、安全删除（移入可恢复的回收站），以及把技能库备份到 git 仓库。

## 界面预览

### 技能列表

<img src="docs/images/skills-tab.png" alt="技能中心技能列表：按来源分级展示，顶部搜索、来源筛选与批量管理" width="100%">

按来源分级展示技能，顶部提供搜索框、来源筛选与批量管理入口。

### 技能详情弹窗

<img src="docs/images/skill-detail-modal.png" alt="技能详情弹窗：大图标、来源事实、编辑与复制路径、可展开描述、概述区搜索与正文预览" width="100%">

点击技能卡片弹出居中详情卡片：顶部是图标、名称与来源事实，右侧为启停开关与关闭；主操作「编辑」、次操作「复制路径」与「更多」菜单；描述可展开；概述区搜索框按行过滤并高亮命中。

### SkillHub 技能广场

<img src="docs/images/skillhub-plaza.png" alt="SkillHub 技能广场：分类胶囊标签、四种排序模式与一键安装按钮" width="100%">

分类胶囊标签、综合/下载量/最新/收藏四种排序，卡片右侧提供快捷一键安装按钮。

## 功能

- 侧边栏「技能中心」入口（位于 shell 自身的面板列表，与插件、定时、任务看板并列）打开原生中栏页面，带页签栏。该入口负责打开面板，打开任意会话或新建对话即让中栏回到会话正文，与官方插件页、定时任务页行为一致；页面自身不设返回会话控件。
- **技能 tab**：按来源分级展示（系统内置、项目 `.dsh/skills`、项目 `.agents/skills`、自定义目录、skills-manager 中央技能库、用户 `~/.dsh/skills`、用户 `~/.agents/skills`、运行时注册）。顶部搜索框按技能名或描述即时过滤（名称命中优先，Esc 清空），支持与工作区选择叠加。工具栏提供「检查全部」与「全部更新 (N)」入口，卡片和详情弹窗展示更新状态（可更新/最新/检查失败）徽章与一键更新按钮；每行显示描述、适用场景、调用支持标记、启用/禁用开关（改写 SKILL.md frontmatter 的 `disable-model-invocation`，模型目录热刷新；插件提供的文件开关由面板本地存储持久化）、复制路径、复制为模板入口、编辑入口、固定/取消固定操作以及删除按钮（整个技能目录移入 `.trash` 并以技能名命名、可恢复；中央技能库管理的技能会同时清理数据库记录与已部署副本）。
- **技能详情弹窗（Detail Modal）**：点击技能卡片弹出居中的详情卡片，顶部为大图标、技能名与来源事实行（工作区、来源、软链接、调用支持、可更新），其后是启用/禁用开关与关闭按钮，以及主操作（编辑）、次操作（复制路径）与「更多」菜单（复制为模板、检查更新、更新此技能、删除）。概述区展示可展开的描述与适用场景，右侧搜索框按行实时过滤正文并高亮命中，正文按标题、列表、围栏代码与表格渲染（只读预览，不做完整 Markdown）。
- **预设管理与批量操作**：预设是一组命名技能集合；激活时把成员部署到选定的四个技能根（用户/项目 × `~/.dsh`/`~/.agents`），并把上一个预设部署的副本收回。归属按记录判断而非按名字猜测：只有仍与部署记录一致的目标才会被移除或替换，他人创建的目录一律拒绝并汇报。支持随时切换、应用或删除；批量管理模式下勾选多个技能一键移入回收站，并逐项汇报成功与失败。
- **备份 tab**：把中央技能库（`~/.agents/skills-manager/skills`）当作一个普通 git 仓库备份：创建仓库、提交并打快照标签、配置远端并推送、从快照恢复（恢复前先把当前状态提交为安全快照，随时可回退）。本地与远端都前进时只报告 `diverged` 而绝不自动合并，避免三方合并静默丢掉一边的改动。
- **命令面板**：`Ctrl+K` / `⌘K` 打开，可搜索技能、预设与操作（检查全部更新、更新全部）。
- **工作区感知与隔离标记**：自动识别会话当前工作区；当项目技能属于非当前会话工作区时，清晰展示工作区隔离标记与提示；工具栏支持按全部工作区、当前工作区、用户全局技能、系统内置技能进行精准筛选。
- **筛选与来源折叠**：搜索框与三个筛选维度叠加（要显示的来源分组、启用/禁用状态、行的标记：由插件提供/无本地文件/软链接），由工具栏统一展开，展示当前收窄维度的计数徽章。每个来源分组支持折叠与展开，首次使用时默认仅展开项目与用户根；折叠决定与筛选维度持久化在浏览器 `localStorage` 中，预设保存在中央库数据库里。
- **市场 tab（集成 SkillHub 技能广场与 Git 仓库安装）**：在技能中心无缝浏览、检索与安装优质 AI 技能，支持两种视界：
  - **SkillHub 技能广场**：提供综合评分、下载量、最新发布、收藏量 4 种排序模式；横向滚动 14 大分类胶囊标签（开发编程、办公提效、内容创作、AI Agent 等）；5 列响应式卡片展示图标、名称、官方认证徽章、简介、热度指标与快捷一键安装按钮；点击卡片滑出 TRACE 评测详情抽屉，展示完整 Markdown 说明、TRACE 五维质量得分（可信度、可靠性、适用性、规范性、有效性）雷达分项及版本记录；支持安装到全局用户目录（`~/.agents/skills`）或当前项目工作区。
  - **从 Git 仓库安装（Git Install）**：输入公共或私有 Git 仓库地址（支持 SSH/HTTPS/本地目录），浅克隆拉取后自动递归扫描发现有效 `SKILL.md`，支持多选、自定义安装别名与目标位置（全局 `~/.agents/skills` 或当前项目工作区），一键落盘并自动纳管至 `~/.agents/skills-manager` 中央数据库。表单下方常驻「已导入的仓库」清单，按归一化后的仓库地址聚合已纳管的技能，标出技能数、最近安装时间与更新可用状态；安装预览中若所选技能与来自其他仓库的同名技能冲突，会提前提示将被覆盖。每个上游仓库在本机保留一份检出缓存（`~/.agents/skills-manager/cache/repos/`），预检、安装与更新都从该缓存生成临时检出，重复操作只拉取增量而非重新下载整个仓库；缓存总量上限 1 GB，超出时按最近使用时间淘汰；远端不可达时报错而不是回退到陈旧的缓存内容。
- **创建 tab**：表单可视化新建技能，可选择写入用户全局根（`~/.agents/skills`）或当前项目根（`.dsh/skills`），生成标准规范的 SKILL.md，即写即生效（无需重启）。
- **编辑 tab**：从技能列表或详情弹窗进入，经宿主安全读取技能内容，原地改写描述、适用场景与正文；技能名、文件路径与启用状态保持不变。
- **导入 tab**：从宿主机目录或浏览器读取的 `.zip` 压缩包批量导入技能。每个候选按官方规则严格校验，并按来源 rank 裁决同名冲突；导入仅新建文件，绝不覆盖已有技能。
- 数据来自按官方 dsh-skill-filesystem 根约定的文件系统扫描，并与 `ctx.skills` 注册表（内置与运行时条目）合并。扫描同时读取本插件配置的 `customSkillDirs` 以及各 loader 行上的同名配置。插件不改变 skill 的加载与注入语义，是纯 GUI 管理层。
- 写路由无法操作的技能按其实际本地形态打标：插件 provider 报告了真实指令文件的技能标记为**「由插件提供」**，支持本地启闭开关；无本地指令文件的运行时技能标记为**「无本地文件」**。两者均不提供编辑或删除按钮，避免无效调用。
- 只有官方 provider 会加载的技能才被列出：SKILL.md 必须声明非空名称与描述，且名称符合官方 kebab-case 文法。
- 同名技能严格按官方来源 rank 裁决（项目 `.dsh/skills` 100、项目 `.agents/skills` 200、运行时 250、自定义目录 300、用户 `~/.dsh/skills` 400、用户 `~/.agents/skills` 500、内置 600），确保面板展示与模型实际调用一致。

## 安装

### 从 npm（推荐）

```sh
dsh plugin --profile web add @moruoxing/dsh-skill-manager@latest
```

### 从仓库（开发）

```sh
git clone https://github.com/ruoxhub/dsh-skill-manager.git
cd dsh-skill-manager
pnpm install
pnpm build
dsh plugin --profile web add link:$(pwd)
```

安装后重启 `dsh web`，侧边栏出现「技能中心」入口。

## 路由

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/dsh-skill-explorer/list` | GET | 分级技能列表与工作区信息 |
| `/api/dsh-skill-explorer/read` | GET | 单个技能的可编辑字段与正文（`?name=&path=`） |
| `/api/dsh-skill-explorer/set-enabled` | POST | 启用/禁用技能（改写 frontmatter） |
| `/api/dsh-skill-explorer/set-provider-enabled` | POST | 启用/禁用插件随附技能（记入面板专属存储） |
| `/api/dsh-skill-explorer/create` | POST | 创建技能（user/project 根） |
| `/api/dsh-skill-explorer/import` | POST | 从目录或 .zip 压缩包批量导入技能 |
| `/api/dsh-skill-explorer/update` | POST | 原地修改已有技能（名称与位置不变） |
| `/api/dsh-skill-explorer/delete` | POST | 删除技能（整个目录安全移入 .trash，并清理中央库记录与已部署副本） |
| `/api/dsh-skill-explorer/check-all` | POST | 检查中央技能库全部技能的远端最新版本 |
| `/api/dsh-skill-explorer/check-one` | POST | 检查指定技能的远端最新版本 |
| `/api/dsh-skill-explorer/update-all` | POST | 批量拉取并更新所有有可用更新的技能 |
| `/api/dsh-skill-explorer/update-one` | POST | 拉取并更新指定技能至最新版本 |
| `/api/dsh-skill-explorer/health` | GET | 健康探测 |
| `/api/dsh-skill-explorer/market/search` | GET | 搜索与筛选 SkillHub 技能广场 |
| `/api/dsh-skill-explorer/market/detail` | GET | 获取 SkillHub 技能详情与 TRACE 评测数据 |
| `/api/dsh-skill-explorer/market/install` | POST | 下载并安装 SkillHub 技能到指定根目录或工作区 |
| `/api/dsh-skill-explorer/git/preview` | POST | 克隆 Git 仓库并扫描预览其中的全部 Skills |
| `/api/dsh-skill-explorer/git/confirm` | POST | 确认安装所选 Skills 到中央库与指定 Agent 目录 |
| `/api/dsh-skill-explorer/git/cancel` | POST | 取消 Git 预览并清理临时克隆目录 |
| `/api/dsh-skill-explorer/presets` | GET | 预设列表与部署记录 |
| `/api/dsh-skill-explorer/presets/save` | POST | 新建或更新预设 |
| `/api/dsh-skill-explorer/presets/apply` | POST | 激活预设（部署成员并收回上个预设的副本） |
| `/api/dsh-skill-explorer/presets/delete` | POST | 删除预设 |
| `/api/dsh-skill-explorer/backup/status` | GET | 技能库备份仓库状态与远端健康度 |
| `/api/dsh-skill-explorer/backup/init` | POST | 创建技能库 git 仓库 |
| `/api/dsh-skill-explorer/backup/commit` | POST | 提交当前状态，可选打快照标签与推送 |
| `/api/dsh-skill-explorer/backup/snapshots` | GET | 列出可恢复快照 |
| `/api/dsh-skill-explorer/backup/restore` | POST | 恢复快照（先提交安全快照） |
| `/api/dsh-skill-explorer/backup/remote` | POST | 设置备份远端 |
| `/api/dsh-skill-explorer/tags` | GET | 按技能读取标签 |
| `/api/dsh-skill-explorer/tags/set` | POST | 设置技能标签 |
| `/api/dsh-skill-explorer/tags/rename` | POST | 重命名标签 |
| `/api/dsh-skill-explorer/tags/delete` | POST | 删除标签 |
| `/api/dsh-skill-explorer/trash` | GET | 列出回收站条目 |
| `/api/dsh-skill-explorer/trash/restore` | POST | 从回收站恢复技能 |
| `/api/dsh-skill-explorer/audit` | GET | 最近的技能库操作审计记录 |

## 安全模型

- 全部 `/api/dsh-skill-explorer/*` 路由默认仅限 loopback 访问（插件家族共享围栏：loopback 套接字 + Host 请求头 + 浏览器同源标记）：未配对的局域网客户端在任何技能文件访问前即收到 `403 forbidden: loopback-only`。当同时加载 `dsh-remote-web-ui` 时，有效的已配对设备 cookie 作为额外放行路径；未配对与已撤销设备保持 403。技能中心不硬依赖远程插件。
- 写路由仅将面板展示的路径作为身份声明；执行修改前，最新文件系统扫描必须解析到同名且路径完全一致的技能。任意未知路径与过期的同名回退均会被拒绝，防止项目技能变动引发误操作。
- read 路由采用相同的安全校验：已安装技能必须匹配最新扫描路径；对于市场技能预览，规范路径必须严格限制在 `agentsHome` 或 `dshHome` 目录内，严防越权任意文件读取。
- update 路由原地改写已有 SKILL.md，不更改技能名与存储路径，并原样保留当前的 `disable-model-invocation` 设置，防止编辑操作意外覆盖启用状态。与删除同理，软链接技能在该路由上直接拒绝。
- 插件技能开关路由将每条记录以 `(provider, 技能名)` 组合写入 `$DSH_HOME/dsh-skill-explorer/provider-toggles.json`（采用临时文件 + fsync + rename 原子落盘；损坏或异常文档安全降级）。客户端仅发送身份标识而不涉及文件路径；停用与启用操作均具备幂等性。
- 导入路由具有严格的读取与写入边界：宿主机目录仅扫描一层 `<名称>/SKILL.md` 或 `<名称>.md`，跳过符号链接与隐藏点目录；上传的压缩包由浏览器读取后提交；写入严格限制在用户或项目技能根目录下创建新文件，绝不覆盖已有文件；请求设有严格上限（压缩包 4MB、条目 512、单个 SKILL.md 64KB、展开文本 4MB）；异常或越界压缩包（zip64、加密条目、Zip Slip 路径穿越）一律 400 拒绝并返回详细原因。
- 技能内容限制为用户编写的 Markdown 格式；新建、编辑与导入路由均严格执行 64KB 大小上限。
- 面板渲染技能描述与文本时均采用纯文本节点，严禁 HTML 注入。
- 扫描支持符号链接：skill 根目录中的符号链接目录及单文件链接会被识别为普通技能并展示。但为了防止通过符号链接移出目录破坏原文件或造成路径逃逸，**软链接技能严格禁止删除和原地编辑**（界面隐藏相应操作按钮，并在 delete 与 update 路由上返回 400 拒绝）；软链接技能的启用/禁用操作正常可用（改写链接目标自身的 frontmatter）。

## 已知限制

- 项目技能遵循面板所选工作区：list 路由支持显式 `?cwd=` 覆盖，创建与安装操作均使用当前选定工作区；项目根目录解析为该工作区最近的 `.git` 祖先。写路由解析相同的工作区，确保进程工作目录位于其他路径时仍可正常管理。
- 工作区清单以 DSH 工作区注册表为准：删除工作区只移除注册记录，其目录与会话日志会被保留（对应会话归入「未分组」），因此被删工作区保留会话的 `cwd` 不会被重新当作工作区列出；只有宿主没有注册表服务时（无头运行、旧版宿主），才回退为按活动会话的 `cwd` 推断工作区。
- frontmatter 解析采用零依赖轻量实现（支持块标量、布尔值与嵌套输入块）；若包含不支持的复杂 YAML 高级语法，将以官方 dsh-skill-filesystem 提供方为准。
- 面板覆盖范围包含所扫描的文件系统根目录以及 `ctx.skills` 注册表的全局层。配置在 host 平面 `skill-filesystem` 上的 `customSkillDirs` 会被完整扫描；仅通过特定 agent preset 自身作用域生效的技能不在此全局覆盖范围内。
- 「由插件提供」技能的开关属于面板本地状态：它改变的是面板中呈现的可调用状态标记，宿主注册表仍会照常加载该技能。若需彻底移除此类技能，需在提供该技能的对应插件中进行配置或卸载。
- 软链接技能不可删除、不可编辑（详见安全模型）；启用/禁用功能对软链接技能有效；单文件软链接在原子改写时会被替换为普通独立文件，目标源文件保持不变。
- 本地目录导入仅扫描单层结构，不支持递归扫描嵌套目录；`.zip` 压缩包导入支持读取任意层级内的 `SKILL.md`，但包内的非 Markdown 附加资源文件会被忽略，不会一并复制。
- 导入同名技能时，若同级或更高优先级的来源已存在同名技能，将直接报告为跳过（`exists` 或 `shadowed`），避免覆盖。如需导入需先将技能重命名。
- 分组折叠状态与筛选维度偏好按浏览器环境保存在本地存储中，支持跨页面刷新与重新挂载，但不跨浏览器或无痕模式；技能预设保存在中央库数据库中，因此跨浏览器一致。

## 数据遥测

浏览器半区每个 UTC 日向 dsh-market.com 发送一次匿名安装心跳：仅含一个 localStorage 随机 ID 与本包名，无其他数据。服务端只存储该 ID 的加盐哈希，不存 IP，且只暴露聚合计数。完整契约见。

## 协议

MIT。
