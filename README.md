# Kimi Work BYOK for Magpie

让普通 **Kimi 桌面应用的 Work** 在原生模型选择器里使用 Magpie 的第三方模型。不是 Kimi Code，也不是把 Kimi 会员额度提供给其他 Agent 的 Provider。

**按实际结构与运行契约检查兼容性，不用版本号或来源哈希白名单放行。** 模型目录、原生配置同步和旧副本接入分别检查；某一路径不支持时明确报告。BYOK 核心已有 macOS Kimi 3.2.21、3.2.22 实测记录，原生池有未修改内核和适配器经本地模拟网关的调用证据。Windows 有分支测试和 CI，真实 UAC、真实 hosts 与登录后的完整 Work 流程仍未联合验收，Linux 未适配。`source-compatible` 和目录 `compat` 都不是正式应用全功能验收承诺。

原生 BYOK 接入不修改 Magpie 或 Kimi 的安装目录、`app.asar`、可执行文件或签名，不开调试端口、不注入模型菜单。HTTP 转发和单域名 DNS 都运行在 Magpie 的 Bun 插件宿主里。

固定子代理模型优先使用 **Magpie Agent 卡片的原生模型选择器**，并自动迁移已有固定目标到 Kimi 的原生配置。多模型池、各模型用途和默认项在「Kimi Work 模型设置」中编辑，保存到用户状态目录，跨插件重载保留。该路径不依赖 `DAIMON_BUNDLE_DIR` 或运行时副本。模型、凭证、路由和用量继续由 Magpie 管理。**思考翻译**也在同一设置页配置，复用插件已嵌入的核心翻译宿主与监督器，无需另开独立网关。

## 与通用核心的关系

本插件的接入能力来自独立仓库 [`kimi-work-gateway`](https://github.com/wssz527/kimi-work-gateway)，该仓库同时提供可直接运行的独立 CLI。Magpie 版把核心的固定版本复制到 `vendor/kimi-work-gateway/`，**用户不需要另装或另开网关**。当前嵌入核心为 **0.9.0**，来源提交 `934438a457c46b0249b6d317a01db86431ed7aa4`；逐文件 SHA-256 见 `vendor/VENDOR.json`。

| 位置 | 作用 |
| --- | --- |
| `vendor/kimi-work-gateway/` | 核心库的固定副本：监听、鉴权、目录、转发、DNS、准备流程、子代理策略 |
| `vendor/VENDOR.json` | 核心版本、来源提交与每个文件的 SHA-256；`bun run vendor:verify` 与 CI 都会校验 |
| `magpie-backend.mjs` | 把 Magpie 的模型目录翻译成核心模型，并把请求发回 Magpie 网关 |
| `native-byok.mjs` | 兼容包装器，保留原有调用方式（`configure({url, key, port})`、`nativeCatalog`） |

插件嵌入实际运行的核心模块，包括维护原生导入通道的私有管道宿主与监督器；不复制独立 CLI 或 Web 控制面板。`vendor/kimi-work-gateway/index.mjs` 是导出投影，`VENDOR.json` 记录逐文件摘要和被排除的模块。思考翻译在「Kimi Work 模型设置」页配置，读写的是核心自己的 `translation-settings.json`：本状态目录里已有的独立版设置原样保留，插件不会因为读取而改写它，也不会另存一份。

升级核心时执行 `bun run vendor:sync ../kimi-work-gateway`，将相邻的核心仓库路径作为参数，再运行测试与哈希校验。其他目录布局请传入对应的核心仓库路径。插件不联网拉取核心，也不在安装时构建。

模型走哪个接口由 **模型 ID 的最后一段**决定：以 `kimi-` 开头走 Chat Completions，其余走 Responses。这与 Kimi 自己的判断一致；名字和协议对不上时模型会在导入阶段被静默丢弃，核心会直接拒绝这种配置。

> 0.7.0 启用接入后自动准备 Kimi 原生入口、网关连接与 `dev.msh.team` 单域名解析。首次管理员授权在系统窗口完成，取消后等待主动重试。macOS 写单域名 resolver，Windows 只改 hosts 两行；不会改全局 DNS、代理、证书或防火墙。

## 跨版本

插件按结构读取已安装 Kimi 的解析器，并将**当前可见模型的完整目录**交给它检查。`status.json` 中 `compat.scope` 为 `active-models`，`modelCount` 是本次检查的模型数；目录或安装包变化会使缓存失效。

| `compat.state` | 含义 |
| --- | --- |
| `verified` | 解析器接受本次检查的全部可见模型 |
| `incompatible` | 有模型会被丢弃，`skipped` 列出对应项 |
| `unverified` | 无法识别或执行解析器，兼容性未知 |
| `unavailable` | 没找到安装包或平台不支持检查 |

未知状态不阻止运行，也不保证可以成功导入或调用。请核对 Kimi 的导入结果；`native_byok_ready` 表示前置条件和配置已就绪。核心 CLI 支持 `compat --config gateway.json` 检查指定配置；省略 `--config` 只检查内置样例。

## 安装

如果已启用 `@magpie-community/agent-kimi-desktop`、`kupakupar/magpie-agent-kimi` 或本插件的本地副本，先在 Magpie 停用旧版，再安装本版。它们共用 `kimi-desktop` Agent ID 与状态目录，不能同时运行。切换后正常重启一次 Magpie，确保旧适配器已退出。

在 Magpie「插件」中添加：

```text
github:wssz527/magpie-agent-kimi-work-byok
```

仓库已设置 `magpie-plugin` Topic，按 Magpie 的发现规则列入「非官方插件 · GitHub」候选；这不表示社区推荐或官方审核。发现页提示 GitHub 限流、只显示旧缓存时，可以直接添加上述仓库地址，无需等待列表刷新。

或使用终端中的 Magpie 命令：

```sh
magpie plugin add github:wssz527/magpie-agent-kimi-work-byok
```

没有把 `magpie` 加入 PATH 时，按平台使用安装位置：

```sh
# macOS
/Applications/magpie.app/Contents/MacOS/magpie plugin add github:wssz527/magpie-agent-kimi-work-byok
```

```powershell
# Windows
& "$env:LOCALAPPDATA\Programs\magpie\magpie.exe" plugin add github:wssz527/magpie-agent-kimi-work-byok
```

### 更新到新版本

用上面的 `github:` 地址安装时，Magpie 会跟踪该仓库默认分支的提交，但不会自动装上：仓库有新提交时，侧栏「插件 → 已安装」会显示「1 个更新」，进入「已安装」后点本插件这一行的 **更新**，只重新解析并安装这一个插件，选项和启用状态保持不变，其他插件不会被更新（宿主仍会重启，见下文）。

单插件更新目前只有 Magpie 图形界面里的这个「更新」按钮，终端没有对应命令：

```sh
magpie plugin update      # 更新全部已安装插件
magpie plugin update X    # 同样更新全部插件，X 会被忽略
```

`plugin update`（`upgrade` 与它同义）不接受插件名，命令行里带的名字不会缩小更新范围。也不要改用重新添加来绕过：对已安装的同一个 `github:` 地址再次执行 `magpie plugin add`，Bun 会沿用 `bun.lock` 里已有的提交，仓库有新提交也装不到；先 `plugin rm` 再 `add` 虽然会重新解析，却会丢掉这个插件的选项（例如 `workPanelPort`），不建议这样做。

固定到某个标签或提交的写法（例如 `github:wssz527/magpie-agent-kimi-work-byok#v0.6.3`）不会自动产生更新提示，需要手动改成新版本。从本地文件夹添加的副本只会按文件夹当前内容加载，不会从 GitHub 更新；想持续接收更新，请改用 `github:` 来源（同一时间只保留一个来源，避免两个副本争用 `kimi-desktop` Agent ID）。

插件更新会重启 Magpie 的插件宿主，正在流式返回的回答会先完成。接入意图、模型池、用途和默认项保存在用户状态目录，Kimi 正常更新或重建生成配置时，根据已确认的当前账户原生 profile 自动恢复 provider 和模型表，不按版本号重新导入。首次和后续目录同步由插件调用 Kimi 原生导入接口完成。账户身份已确认且已有接入授权时，可恢复丢失的原生目录；检测到明确断开、身份无法确认或手动配置冲突时暂停并报告，不猜账户或还原旧凭据。插件的 GitHub 更新来源与检查机制保持不变。

打开并登录普通 Kimi 桌面应用，在 Magpie「Agent」中打开 **Kimi Work BYOK · 子代理模型** 的接入开关。完成 Kimi 导入后，使用卡片上的 Magpie 通用模型选择器设置固定子代理；多模型池在卡片菜单的 **编辑子代理模型池** 中编辑。主模型可继续在 Work 菜单选择。模型可见范围、账号凭证、路由与用量仍由 Magpie 管理。

当前 Magpie 插件 API 只提供一个通用 `model` 字段；插件将它映射到 `subagents.model`。内置 Agent 的专用子代理模型、思考档位组件没有对插件开放，因此这里的通用选择器不等同于内置专用子代理组件。子代理策略与模型池设置页采用 Magpie 主题，但仍是插件页面。

已有固定子代理设置会迁移到原生配置；没有子代理字段时继续继承，旧版顶层 `model` 不用于选择子代理。持久保存、配置应用和实际请求采用分别显示。

## 首次接入与日常使用

1. 在 Magpie 中配置自己的上游与可见模型，打开并登录普通 Kimi 桌面 Work。
2. 启用 **Kimi Work BYOK · 子代理模型**。插件复用 Magpie 网关凭据和目录，自动准备原生入口及单域名解析；首次系统授权在本机完成。
3. 等待「Kimi Work 模型设置」显示原生目录已接入，在 Work 自带模型菜单选择主模型。固定子代理使用 Agent 卡片上的原生通用模型选择器，模型池在设置页编辑。

不需要另开独立网关、复制 Token 或手动填写 Kimi 的网关连接。取消系统授权后不会反复弹框，在设置页点击“重试接入”继续。Kimi 有任务时等待空闲；无法确认账户或发现外来配置冲突时会明确报告。

模型目录变化会触发自动原生同步。Kimi 重启或安装文件更新时，插件按结构复核接入通道，在实时确认空闲后恢复；接入意图、模型池、用途和默认项保存在用户目录，不随版本号变化。用户主动退出 Kimi 时不会立即重新拉起；下次打开后继续检查。插件停用时停止监督；重新启用后恢复。

macOS 的原生接入只控制官方 Kimi 桌面应用，不启动远程 companion、凭据 helper，也不接管 `safeStorage`。它不会把第三方模型或登录态同步到 Kimi 手机端；桌面目录接入、选模和真实上游调用分别以实际结果验收。Windows 真机仍需单独验收。

## 手动准备与导入（高级）

以下保留给诊断或手动接入；正常安装不需要执行。先让 Kimi Work 任务结束。命令提交五分钟内有效的一次性请求，由 Magpie 宿主准备并把网关 Token 复制到本机剪贴板。系统管理员授权在自己的电脑上完成。

macOS：

```sh
MAGPIE=/Applications/magpie.app/Contents/MacOS/magpie
SETUP_AT=$(($(date +%s) * 1000))
"$MAGPIE" plugin options magpie-agent-kimi-work-byok \
  "{\"setupRequest\":{\"action\":\"prepare\",\"id\":\"prepare-$SETUP_AT\",\"at\":$SETUP_AT},\"copyTokenRequest\":{\"id\":\"copy-token-$SETUP_AT\",\"at\":$SETUP_AT}}"
```

Windows（需要 PowerShell 7.3+；系统自带的 Windows PowerShell 5.1 会剥掉 JSON 内嵌引号，命令看似成功但请求会被记为 `invalid-request`）：

```powershell
$MAGPIE = "$env:LOCALAPPDATA\Programs\magpie\magpie.exe"
$SETUP_AT = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
& $MAGPIE plugin options magpie-agent-kimi-work-byok "{`"setupRequest`":{`"action`":`"prepare`",`"id`":`"prepare-$SETUP_AT`",`"at`":$SETUP_AT},`"copyTokenRequest`":{`"id`":`"copy-token-$SETUP_AT`",`"at`":$SETUP_AT}}"
```

命令显示“options set”只表示请求已保存。准备结果在 `~/.config/magpie-kimi/native-setup-receipt.json`（Windows 为 `%USERPROFILE%\.config\magpie-kimi\native-setup-receipt.json`）：`result.state` 应为 `done`。管理员取消、文件冲突或中断都会明确记录，且不会循环弹框；重试时重新运行上面的命令生成新请求 ID。

准备会做两件事：

1. 让 `dev.msh.team` 解析到插件的私有地址 `10.255.255.254`。macOS 安装单域名 resolver 指向 `127.0.0.1:53535`；Windows 只在 hosts 写入两行，不需要 DNS 服务。两者都只影响这一个域名，不接管其他解析，也不代表接入了真实公司内网。
2. 在 Kimi 用户数据目录的 `kimi-agent/byok-availability.json` 合并 `revealed: true`，保留已有字段。这个标记只显示 Kimi 原有的 BYOK 设置，不修改应用代码。

已有 resolver 的内容不同、路径是符号链接，或 hosts 中该域名已被别的程序占用时，插件拒绝覆盖并保留现状。需要自定义端口时先配置 `nativeByok.dns.port`，再准备；不要手动覆盖其他网络软件的解析文件。

## 在 Kimi 原生设置导入

准备成功后，在空闲时正常重启 Kimi，让它刷新隐藏入口和 DNS 缓存。

打开 Kimi「设置 → Kimi Work → 模型来源」，找到「第三方模型网关」（旧版位于「其他」），填入：

- **Base URL**：`http://127.0.0.1:3426/v1`
- **Token**：粘贴上一步由插件复制的 Agent 网关凭证。

点击 **测试连接并导入模型**，看到导入成功后回到 Work，点击输入框旁的模型名称即可切换。不要以 Magpie Agent 卡片的“已接入”代替 Kimi 的导入成功提示。

完成后清除一次性操作选项（Windows 用 `& $MAGPIE plugin options ... off`）：

```sh
/Applications/magpie.app/Contents/MacOS/magpie plugin options magpie-agent-kimi-work-byok off
```

需要重新复制 Token 时，可以重新执行首次准备命令；已经匹配的解析设置不会被覆盖。也可只提交新的 `copyTokenRequest`。

Kimi 菜单保存导入目录。插件检测到 Magpie 可见模型、能力或本地连接变化后自动同步，不必等待每日刷新；手动导入仍可用于诊断。实际推理前继续校验可见目录，已撤销模型明确报错，不退回默认模型。

## 在 Agent 页面设置主模型和子代理池

完成 BYOK 导入后，在 **Kimi Work BYOK 卡片的原生模型选择器**中选择固定子代理模型。卡片的新选择优先于旧插件选项；已有固定目标自动迁移到原生配置。

需要多个候选时，使用卡片菜单中的 **Kimi Work 模型设置**：

1. **新会话默认模型**：选择后设置 Work 的默认模型。已有会话在 Work 原生菜单切换；这里不会改写指定会话的模型绑定。
2. **模型池**：选择 1–32 个支持工具的可见模型，填写用途并选择池内默认模型。池使用各模型自己的默认思考档位。
3. **新建子代理**：普通 Agent 按其实际工具定义选择池内别名；需要使用主模型时，可把主模型加入池并选择其别名。`primary` 仅适用于 Kimi 原生提供该能力的工具，例如当前 TowerSpawn；fork 跟随父会话，恢复的子代理保留旧模型。用途说明不构成按类型强制绑定。

高级设置通过插件本地控制服务保存到 `~/.config/magpie-kimi/work-settings.json`，不重载共享插件宿主。模型池、用途、默认项跨插件重载保留；再次改变原生卡片选择会替换现有池。旧 `workModels.subagents` 仅用于首次迁移。独立网关使用相同模型池合同，见[原生子代理模型池](https://github.com/wssz527/kimi-work-gateway#原生子代理模型池)。

原生同步只管理私有 TOML 中带归属标记的子代理区块；原有未受管区块、用户修改或路径冲突均保留并报告。`file-applied` 只证明配置写入；`observed-schema` 表示 Work 工具定义包含预期池和默认模型，二者均不代替真实调用验证。新版内核的单成员池可能不暴露选择参数，按其能力处理。

高级页使用 Magpie 官方页面入口与主题桥，脱敏状态由本机服务提供，不再向插件安装目录写运行状态。控制 API 单独鉴权，并检查 Host、Origin、JSON 类型与设置 revision。页面不包含网关凭证或对话。本机服务中断时会停用保存和主模型切换，并保留页面草稿；连接恢复后重新核对状态。宿主重启使页面会话失效时，会明确提示重新打开设置页。关闭前切回继承并确认撤销，再停用或卸载插件。

### 思考翻译

同一设置页的「思考翻译」区块控制 Chat 和 Work 里**已展开的可见思考**如何显示，默认关闭。它复用插件已嵌入的核心翻译运行时、私有管道宿主和监督器，不新增密钥存储，也不自动选择收费服务。

| 设置项 | 作用 |
| --- | --- |
| 启用思考翻译 | 只表达"希望翻译"；真正接入仍以运行时状态为准 |
| 翻译服务 | Bing、Google，或自定义 Chat Completions 服务 |
| 目标语言 | 中文、英语、日语、韩语、西班牙语、法语、德语、俄语 |
| 默认展示 | 每段思考默认展开译文还是原文，仍可在段内切换 |
| 自定义地址 / 模型 | 选择自定义服务时出现；地址需 HTTPS，本机回环可用 HTTP |
| 密钥环境变量名 | 只接受变量名，插件进程从环境读取凭证；页面既不保存也不显示密钥值 |

保存写入核心自己的 `translation-settings.json`（`~/.config/magpie-kimi/`），并对整份设置文档做真正的比较并交换：读取返回的 `revision` 是核心对**整份文件现内容**推导的摘要令牌（公开字段名不变），文件不存在时为 `null`。保存把这个令牌作为期望值交给嵌入核心的运行时，写入在原子重命名前一刻重新推导磁盘上的当前令牌并比对：独立网关或另一个面板先改过文件时，本次保存以 `translation_settings_conflict` 失败，而不是悄悄覆盖对方的修改；首次保存期望 `null` 时，若别的进程已抢先创建文件，同样被拒绝。冲突后页面保留草稿并按最新 revision 重新读取，重试即可把改动写回。设置文档内部的 `revision` 字段只是设置内容的摘要，不作为并发令牌使用。读取在文件不存在时返回核心默认（关闭）且**不写文件**，因此独立版此前保存的设置不会被覆盖。嵌入核心对应的最终公开提交以 `vendor/VENDOR.json` 为准，随核心仓库发布同步更新。翻译失败时保留原文，不影响对话；状态区显示的是翻译运行时自己的状态，与 BYOK 接入状态无关。宿主只在设置真正应用后才算生效，保存成功不等于已注入；若只确认了共享宿主连接、无法确认翻译注入，页面会如实显示「翻译是否已接入尚未确认」，而不会显示为已接入。

核心 0.9.0 起，状态区把 Chat 与 Work 当作两个页面分别报告：每面会显示页面上看到多少个思考块、其中多少个仍符合翻译引擎期望的结构。`none` 表示页面还没有思考块（空会话不是结构验证成功），`partial` 表示选择器与该界面版本已不一致，`matched` 表示结构对得上；结构状态旁会给出「已匹配/共 段」的计数。**结构匹配只说明选择器仍有对上，不等于译文已经产出**，页面不会把结构识别写成已翻译；引擎在运行但没有任何页面回执时只显示「翻译引擎已接入，页面尚未确认」。已保存为关闭时优先显示关闭，旧的 `active` 回执不会把翻译显示成开启。旧版核心没有逐面字段时，页面退回原来的单行状态，不伪造分面数据。

插件不会为了翻译强制结束正在工作的 Kimi：若 Kimi 已由用户或更新启动，状态会显示等待正常退出后再接入，而不是重启它。

主会话、压缩、图片理解和子代理的推理可以走第三方模型；标题、记忆、搜索、生图和语音有各自的服务或鉴权，详见[功能来源清单](https://github.com/wssz527/kimi-work-gateway#work-各功能的模型来源)。标题没有独立的模型路由，请求是否经过 BYOK 由全局默认模型决定，本插件不提供单独的标题模型设置；移动端（含安卓）不在本插件范围内。本插件不解锁会员功能、开启隐藏的 Tower 入口或将聊天 API 冒充专用媒体服务。Magpie 自带的生图、搜索与图片理解 MCP 可以经本机资源库作为额外工具接入，见下文「复用现有 MCP 能力」。

## 复用现有 MCP 能力（可选）

插件的定位是接管原生模型接入与翻译，**不另造记忆、搜索或生图服务**。已经成熟的能力优先沿用原有来源，默认仍由官方 Work 提供；下表只说明可选的复用入口，不新增依赖，也不会自动启用任何 MCP 或改动生产配置。

| 能力 | 复用入口 | 默认与边界 |
| --- | --- | --- |
| 生图 / 视频、搜索、读图 | Magpie 内置 MCP（固定源码 [`yetone/magpie@838d12d`](https://github.com/yetone/magpie/commit/838d12d6f876cfca67d6127950311a9647b1f2e2)）：`/mcp/magpie/image`、`/mcp/magpie/web-search`、`/mcp/magpie/vision` | 经本机 Magpie 资源库（`library.mcp`）接入为额外工具；Work 自带搜索等工具仍由 Kimi 执行 |
| 记忆 | 官方 [`@modelcontextprotocol/server-memory@2.0.1`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)（Node ≥ 24） | 默认保留官方 Work 的记忆；只作为可选 MCP 条目接入，不替换、不迁移既有记忆 |

验证层级需要分清：Magpie 三个 MCP 服务在本机 3425 端口的 `tools/list` 与官方内核的全局 MCP 连接探针均已通过，`web_fetch` 对 example.com 的真实抓取也成功；但**尚未在真实 Work 会话里验证工具调用或图片展示**，因此不能据此声称已接管官方生图。记忆 server 的官方内核连接、独立 MCP 创建、搜索、重启后持久与删除已实测通过（临时目录，未改生产配置），同样不代表真实会话中的记忆替换。以上都不构成本插件自带的能力，插件也不会替你开启；记忆 server 与 Magpie 的 MCP 服务都是外部组件，**不随本插件分发**，其许可证以各自对应版本的上游仓库为准（`server-memory` 的授权随该包版本变化，使用前请核对该版本的 `LICENSE`）。

## 旧副本子代理接入（高级诊断）

以下命令仅保留给允许 `DAIMON_BUNDLE_DIR` 的兼容构建显式诊断使用。当前正式版 Kimi 禁用该副本入口，普通接入使用上文的原生配置同步；Magpie 卡片选择器不再指向旧副本。

首次使用需要显式准备本地运行时副本。macOS：

```sh
MAGPIE=/Applications/magpie.app/Contents/MacOS/magpie
REQUEST_AT=$(($(date +%s) * 1000))
"$MAGPIE" plugin options magpie-agent-kimi-work-byok \
  "{\"subagentRequest\":{\"action\":\"prepare\",\"id\":\"subagents-prepare-$REQUEST_AT\",\"at\":$REQUEST_AT}}"
```

Windows（需要 PowerShell 7.3+；说明同上一节）：

```powershell
$MAGPIE = "$env:LOCALAPPDATA\Programs\magpie\magpie.exe"
$REQUEST_AT = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
& $MAGPIE plugin options magpie-agent-kimi-work-byok "{`"subagentRequest`":{`"action`":`"prepare`",`"id`":`"subagents-prepare-$REQUEST_AT`",`"at`":$REQUEST_AT}}"
```

若启动能力检查通过，`subagents.operation.state` 会显示 `prepared`；启动时也可由当前结构自动准备。当前正式版 Kimi 3.2.21、3.2.22 会返回 `failed / subagent_launch_unsupported`，此时应跳过本节的准备与启动步骤，保留主模型 BYOK 或继承模式，不要继续等待 `prepared`。准备只复制本机运行时到 `~/.config/magpie-kimi/native-runtime/`，不启动或结束 Kimi，不需要修改安装目录。副本不随插件分发。

让 Work 任务结束，**正常退出 Kimi**，再提交新启动请求。macOS：

```sh
MAGPIE=/Applications/magpie.app/Contents/MacOS/magpie
REQUEST_AT=$(($(date +%s) * 1000))
"$MAGPIE" plugin options magpie-agent-kimi-work-byok \
  "{\"subagentRequest\":{\"action\":\"launch\",\"id\":\"subagents-launch-$REQUEST_AT\",\"at\":$REQUEST_AT}}"
```

Windows：

```powershell
$MAGPIE = "$env:LOCALAPPDATA\Programs\magpie\magpie.exe"
$REQUEST_AT = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
& $MAGPIE plugin options magpie-agent-kimi-work-byok "{`"subagentRequest`":{`"action`":`"launch`",`"id`":`"subagents-launch-$REQUEST_AT`",`"at`":$REQUEST_AT}}"
```

启动仅为本次 Kimi 进程设置 `DAIMON_BUNDLE_DIR`。如果 Kimi 仍运行，返回 `waiting-kimi-exit`，不会强杀，也不会退出后自动重试；退出后重新提交新 ID 的请求。`starting` 只表示启动请求已发出。每个请求五分钟内有效，跨插件重载也只执行一次；可以用 `magpie plugin options magpie-agent-kimi-work-byok off` 清除操作选项。

检查 `status.json` 的 `subagents`，不要用顶层 `native_byok_ready` 判断子代理接管：

| 字段 / 状态 | 含义 |
| --- | --- |
| `policy.mode: force` | 已保存目标，`policy.model` 是 Magpie 模型 ID |
| `policy.mode: inherit` | 使用 Kimi 原有子代理绑定 |
| `policy.mode: blocked` | 目标撤销、能力不符或策略文件有问题；错误原因在 `reason`，不沿用旧强制目标 |
| `runtime.state: not-prepared` | 尚未生成副本 |
| `runtime.state: waiting-launch` | 尚未观察到匹配副本的有效回执；从适配入口启动并在 Work 中加载会话 |
| `runtime.state: pending-policy` | 已观察到副本运行，新策略等待下一次原生子代理配置读取 |
| `runtime.state: loaded` | 匹配运行时的进程、心跳和当前策略版本均已确认；`runtime.mode` 为观察到的策略，强制模式下 `runtime.modelAlias` 为目标 |
| `runtime.state: policy-unavailable` | 副本仍运行，但策略丢失或无法读取；主会话保持可用，子代理被阻止 |
| `runtime.state: heartbeat-stale` | 匹配进程仍在，心跳尚未更新；先观察运行状态，不代表需要重新启动 |
| `runtime.state: unavailable` | 找不到原安装或运行时来源，`reason` 给出原因 |
| `runtime.state: unsupported` | 正式应用不允许加载适配副本；当前正式版 Kimi 的 `reason` 为 `packaged_bundle_override_disabled`，跳过准备与启动 |
| `runtime.state: scope-conflict` | 实际内核作用域与策略不匹配，拒绝沿用该策略 |
| `runtime.state: outdated` / `conflict` | 来源已变化、更新版本正在准备或副本/状态文件冲突；先检查原因。从适配入口启动时会尝试按当前结构重新准备，失败则明确报告 |

切换目标后，对后续新建的普通原生子代理生效；已经运行的子代理不会被换模型。`fork` 必须继承父模型，强制模式下会明确拒绝，改用普通新建子代理。恢复旧子代理时，保存的模型与强制目标不一致也会拒绝，避免改写旧上下文；一致时允许恢复。关闭接入或插件正常退出会按文件归属恢复 `inherit`，旧宿主不会覆盖新宿主的策略。下次从 Kimi 普通入口启动即可不使用副本。

当前适配按**实际结构接点与启动契约**判断：配置读取、依赖注入、子代理创建/恢复、运行入口和模型档案服务都要唯一匹配，并通过行为探针与生成代码语法检查。版本号和内核摘要只用于展示与副本完整性校验，不再作为许可门槛；Kimi 升级后若这些接点仍然存在，且正式应用允许加载副本，重新准备即可继续使用，无需等待插件发版。接点缺失或有多个候选时会拒绝准备并给出原因，不会猜测或强行改写。它不是 Kimi 或 Magpie 的官方稳定子代理 API。

`runtime.state: unsupported` 的 `reason` 给出启动能力缺失原因；当前正式版 Kimi 3.2.21、3.2.22 为 `packaged_bundle_override_disabled` 或明确的不兼容原因，严格强制模式无法从该入口生效。`scope-conflict` 表示实际内核作用域与策略不匹配。不会自动改写用户 TOML 来放松 fork/resume 约束。主模型 BYOK 不受此限制。**Windows 真机的完整调用链仍未验收**。

`compat` 的 `runtime source markers` 是源码文本观察结果：标记为 `not-observed` 可能是因为混淆隐藏了字符串，不等于该能力在运行时缺失，因此不会单独把状态判成 `incompatible`。

## 状态与排查

状态文件：`~/.config/magpie-kimi/status.json`。它不保存 Token 或对话内容。

| 状态 | 含义与操作 |
| --- | --- |
| `native_byok_waiting_intranet` | 系统 DNS 检查未通过；核对准备结果和单域名解析设置（macOS resolver / Windows hosts），再重启 Kimi |
| `native_byok_waiting_setup` | 隐藏入口未显示；完成准备，也可在 Kimi 设置页连续点击版本号五次 |
| `native_byok_waiting_import` | 网关已启动，等待原生导入、登录或冲突处理；设置页提供原因和重试 |
| `native_byok_syncing` | 目录变更已进入自动同步，等待 Kimi 接受 |
| `native_byok_ready` | 前置条件和导入配置就绪；实际模型调用还取决于 Magpie 上游账号与额度 |
| `waiting_kimi` / `waiting_kimi_idle` | Kimi 未运行或有任务在执行，插件等待 |
| `native_byok_port_unavailable` / `native_byok_dns_unavailable` | HTTP / DNS 本地端口被占用，停用重复适配器或使用明确配置的其他端口 |
| `catalog_unavailable` | Magpie 模型目录不可用；检查 Magpie 自己的网关与模型设置 |

一次性准备回执中的 `resolver-conflict` 表示现有解析文件由别的设置占用，`cancelled` 表示管理员取消，`interrupted` 表示上次在完成前退出，`failed` 的 `stage` 指明失败阶段。请保留文件现状再排查。

HTTP 默认监听 `127.0.0.1:3426`；`nativeByok.port` 可改变端口，修改后需把新的地址导入 Kimi。目录与推理均需 Agent 凭证。Electron 原生请求的 `Sec-Fetch-Site: none` 允许通过，网页 Origin 或网页来源标记被拒绝。

### 撤销本机 DNS（设置页，日常路径）

不再使用时，先在 **Kimi 自带的第三方模型网关设置中断开连接**，让 Kimi 自己清理原生 profile。然后打开「Kimi Work 模型设置」页的 **Kimi 接入** 区，点击 **撤销本机 DNS 解析** 并确认：页面提交一次带新回执 ID 的撤销请求，走与首次准备相同的撤销流程，需要时在系统授权框完成认证（Windows 弹出 UAC）。状态行如实显示 `running / done / cancelled / failed / resolver-conflict` 等；`done` 表示只移除了本插件写入的单域名解析，不删除 Kimi 账号、profile 或隐藏入口，也不会停用插件。重新接入时会在系统授权后重新写入。

回执为 `done` 后，关闭 Magpie 的 Kimi Work BYOK 接入开关；需要时从插件页移除本包。

## 断开（高级诊断）

以下命令行路径保留给诊断或无法打开设置页时使用；日常撤销请用上面的设置页按钮。只删除内容仍与本插件配置匹配的 `/etc/resolver/dev.msh.team`（macOS），或 hosts 中带本插件标记的那两行（Windows），不删除别人的解析文件或条目。隐藏入口标记保留；它本身不会产生网络请求。停止 Magpie 后，插件内 HTTP 监听（以及 macOS 的 DNS 监听）也停止，不会安装 LaunchAgent、计划任务或其他常驻服务。

```sh
MAGPIE=/Applications/magpie.app/Contents/MacOS/magpie
SETUP_AT=$(($(date +%s) * 1000))
"$MAGPIE" plugin options magpie-agent-kimi-work-byok \
  "{\"setupRequest\":{\"action\":\"remove-dns\",\"id\":\"remove-dns-$SETUP_AT\",\"at\":$SETUP_AT}}"
```

## 资源库与本地数据

沿用上游 Agent 的资源库接口：共享指令在推理时合并；MCP 和技能使用普通 Kimi 的本地资源目录。已有文件和冲突项按 Magpie 的资源库规则处理，不会自动启用全部资源。Kimi 自带的搜索、文件等工具仍由 Kimi 执行。

插件状态在 `~/.config/magpie-kimi/`。`connection.json` 含 Agent 网关凭证，不要上传。Kimi 的账号、原生 profile、运行状态以及 Magpie 的账号配置均不属于分发包。升级前如果使用过旧版配置备份，备份可能含凭证，同样不要上传。移除插件不会自动删除该状态目录或其中的 `native-runtime/` 适配副本；确认不再需要后手动删除，Kimi 普通入口不使用该副本。

## 验证范围

- 历史核心接入记录：macOS、Kimi 3.2.21、Magpie 0.1.1659、Bun 1.4.4 下，6 个模型导入且真实推理 HTTP 200。该记录不替代当前源码和分发包的回归验证。
- 当前测试检查生成的目录、两种协议转发、目录变更、兼容缓存、实际插件入口加载、子代理选择保存、目标撤销、一次性操作去重及断开恢复。入口用例在隔离数据和模拟 Magpie 上游上运行；macOS 安装了 Kimi 时额外调用其真实解析器。
- 核心内核验收用 Node 24 **直接导入**本地适配副本中的真实 adapter 与内核，经本地模拟上游验证 12 个绑定、跨协议、effort、配置重建和 fork/resume 场景。夹具显式绕过桌面启动探针，因此只能证明内核适配，不能证明正式 App 加载副本；未调用付费推理。
- 早期本机记录曾确认模型目录、GLM 目标保存和副本生成。本轮进一步确认正式版 Kimi 3.2.21 忽略副本环境变量；旧 `waiting-launch` 不能解释成接管。新版按实际能力报告不支持，主模型导入继续独立工作。
- **Windows 未做真机端到端验收。** 核心仓库新增了临时 hosts 文件上的 PowerShell 执行用例，当前 macOS 环境会跳过。真实 UAC、Kimi 导入和 `clip.exe` 仍需 Windows 验证；不能以旧版 CI 或脚本字符串断言代替。
- 核心通过 `vendor/VENDOR.json` 固定文件集合与哈希，换行归一化后校验，避免 Windows CRLF 检出误报。该文件同时记录 `index.mjs` 是 allowlist 投影、其原始来源 SHA-256、核心版本与来源提交。
- **v0.6.2 验证**：新增原生子代理模型池（多候选、用途、默认项）与 Magpie Agents 内嵌设置面板；不依赖 `DAIMON_BUNDLE_DIR`，旧副本路径保持独立。隔离的真实 Magpie 宿主已加载面板并显示主模型、子模型与池设置；最终测试数量、分发包和 CI 结果以本次 Release 说明为准，不沿用旧版结果；不包含 Windows 真机，也没有调用付费模型。
- **v0.6.3 验证**：同步核心 0.7.2 的两处修复。`compat` 对 Kimi 3.2.22 由误报 `table_not_found` 变为 `verified`（5 个样例模型全部接受），修法只作用于字符串表函数，未改其余函数的切分方式。超限请求体在客户端仍在写入时不再丢状态码，且停滞客户端只等待一次 drain 窗口。新增两条回归用例，均已验证在旧实现上失败。本机 macOS 上核心 389 项、插件 70 项测试通过；Windows 真机仍未验收。
- **v0.7.0 验证**：核心 0.8.0 固定为公共提交 `baca5d0babd551ed1eea93031910e8a9f09bb98d`，该提交在 GitHub CI（Ubuntu Bun 1.4.2 / 1.4.4 与 Windows Bun 1.4.4）全部通过。官方 Kimi 3.2.23 经真实 Magpie Agents 开关接入后，宿主与应用同一 PID 连续运行超过 10 分钟，保留 Savitr 账号与历史任务，无 companion、凭据 helper 或额外 Kimi 应用；6 个模型进入原生菜单，滚动显示后已实际选中 GLM-5.3 Flash。核心最终分发包 `kimi-work-gateway-0.8.0.tgz` 解包验收为 751 项通过、2 项环境跳过、0 失败，58 个文件语法检查通过，包内 132 个文件与核心源码逐字节一致。上述接入记录来自固定该公共提交之前的插件候选包（97 项通过、0 失败，74 个文件语法检查及 vendor 校验通过）；本轮只把嵌入核心的来源提交与文件哈希同步到该公共提交，未重跑插件测试，插件分发包、CI 与 Release 结果以本次 Release 说明为准。未发送任务或调用付费上游，不承诺手机端同步；Windows 真机仍未验收。
- **v0.8.0 验证**（历史记录，描述当时固定的提交 `5cbb00d7c3d3fdc94a805bf43a050534e60e8f28`；当前候选已固定到更新的公开提交，以 `vendor/VENDOR.json` 为准）：嵌入核心升级到 0.9.0，当时固定为公共提交 `5cbb00d7c3d3fdc94a805bf43a050534e60e8f28`（已推送至核心仓库 `main`，核心版本号仍为 0.9.0），`vendor/VENDOR.json` 记录逐文件 SHA-256 与 `index.mjs` 投影来源。设置页把 Chat 与 Work 的思考翻译状态分开显示，并透出每面的思考块计数与结构状态。相对此前固定的 `4c4d7f7`，本次只同步 `translation-host.mjs` 的首请求握手：首个注入请求要等宿主确认本次注入的回执与主 world 后才处理，注入失败或页面被替换时直接丢弃，不调用翻译服务、也不迟到回包。
- **v0.8.0 本轮验证**（历史记录，只描述当时固定的核心 `5cbb00d`，不代表当前候选）：核心 `5cbb00d` 的源码与最终 `kimi-work-gateway-0.9.0.tgz` 均为 793 项通过、2 项环境跳过、0 失败，58 个文件语法检查通过；该提交的 GitHub CI（run 41429560224，Ubuntu Bun 1.4.2、Ubuntu Bun 1.4.4 与 Windows Bun 1.4.4 三矩阵）全部 success。从该最终包解包后，在官方 Kimi 3.2.23 的隔离 profile 里用合成中性思考块连续跑完 Work 与 Chat：Work 面由 Bing 产出真实译文并保留 `const power = 1;`，热保存、应用内 SPA 切换、关闭再开启与页面重载后译文均自动恢复；Chat 面首个请求无需手动 configure 即完成自动翻译，代码保留，折叠后恢复原文。探针未使用生产登录，未走故障恢复路径，临时 profile 在结束后删除，未改动生产配置。**仍待验收**：真实登录 UI 下的显示、Windows 真机，以及合并后的最终插件全量测试、CI 与 Release。
- **v0.8.0 候选包记录**（历史记录，只描述当时固定旧提交 `4c4d7f789887bd3987908909533d03006cdca23e` 的候选）：本机 macOS 插件 `bun test` 为 119 项通过、0 失败，`npm run check` 检查 76 个文件通过，`vendor:verify` 与包内检查同样通过。
- Kimi 后续版本的格式与检查条件可能变化，`compat` 的未知状态不代表验证成功。

开发验证：

```sh
bun test
bun run check
bun run vendor:verify
bun scripts/verify-package.mjs  # 打包、解包并重跑包内测试、语法和哈希检查
```

要求 Bun 1.4.2+，由 Magpie 管理和运行，无需单独常驻 Bun。CI 配置在 Ubuntu 上覆盖 Bun 1.4.2 / 1.4.4，另在 Windows 上检查同一包和 vendor；v0.6.2 的提交已在 Linux 与 Windows 全部通过；v0.6.3 的 CI 结果以本次 Release 为准。包内保留测试文件，测试使用临时目录与合成凭证。

开发时可用隔离的 `XDG_CONFIG_HOME`、`XDG_CACHE_HOME` 测试安装与元数据加载，并把 `MAGPIE_KIMI_DATA_HOME` 指向绝对路径。Windows 还必须将 `APPDATA` 指向隔离目录。Agent 定义仍声明正常的用户目录，因此测试实例不要在真实 Magpie 中打开接入开关、同步资源库或执行首次准备；完整界面测试使用独立系统用户。日常使用不要设置这些测试变量。

## 来源与许可证

基于 MIT 项目 [`@magpie-community/agent-kimi-desktop` 0.1.3](https://github.com/magpie-community/plugins/tree/main/packages/kimi-desktop)，保留上游适配器、资源库实现及版权。此仓库新增原生 BYOK 目录/转发、单域名 DNS、原生请求兼容、一次性准备及相关验证；未把上游已有功能宣称为本仓库原创。接入核心现由独立仓库 [`kimi-work-gateway`](https://github.com/wssz527/kimi-work-gateway) 提供，`vendor/` 内为固定副本。许可证见 [LICENSE](LICENSE)。

本项目是独立社区插件，与 Magpie 和 Kimi 官方无隶属关系。[Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins) 说明 GitHub Topic `magpie-plugin` 的发现规则；设置 Topic 不代表官方审核或推荐。

插件图标 `assets/kimi.png` 取自开发者本机安装的官方 Kimi 桌面应用（3.2.21）的应用图标，仅用于标识所接入的应用；它不表示 Kimi 或 Moonshot AI 对本插件的认可、赞助或背书。
