# Kimi Work BYOK for Magpie

让普通 **Kimi 桌面应用的 Work** 在原生模型选择器里使用 Magpie 的第三方模型。不是 Kimi Code，也不是把 Kimi 会员额度提供给其他 Agent 的 Provider。

**v0.5.2 优先按实际结构兼容 Kimi，不再用版本号或来源哈希白名单拦截。** 子代理适配会检查实际配置、创建、运行和档案接点；结构保持兼容时，Kimi 升级后可重新准备本地副本，无需跟着升级插件。BYOK 核心接入已有 macOS Kimi 3.2.21 的实测记录，Windows 有分支测试和 CI；真实 UAC、真实 hosts 修改与登录后的完整 Work 流程仍未联合验收，Linux 未适配。`compat` 的源码标记只是文本观察，未观察到时不代表运行时能力缺失。

原生 BYOK 接入不修改 Magpie 或 Kimi 的安装目录、`app.asar`、可执行文件或签名，不开调试端口、不注入模型菜单。HTTP 转发和单域名 DNS 都运行在 Magpie 的 Bun 插件宿主里。

新增的**可选原生子代理模型控制**会从本机 Kimi 生成一份运行时副本，在副本中适配策略读取，并通过 `DAIMON_BUNDLE_DIR` 启动 Kimi。适配以实际结构接点为准，不再要求固定的 Kimi 版本号或来源哈希；结构不匹配时只禁用这条适配路径，并明确报告原因。主模型仍由 Work 菜单选择。本插件复用 Magpie 原生 Agent 选择器、模型目录、凭证、路由和用量。独立网关从 v0.3.0 起提供 `panel --config gateway.json` 本机 Web 控制面板；Magpie 用户直接在本插件中切换，不需要另开网关或面板。

## 与通用核心的关系

本插件的接入能力来自独立仓库 [`kimi-work-gateway`](https://github.com/wssz527/kimi-work-gateway)，该仓库同时提供可直接运行的独立 CLI。Magpie 版把核心的固定版本复制到 `vendor/kimi-work-gateway/`，**用户不需要另装或另开网关**。当前嵌入核心为 **0.6.0**（`be9e0024740d513a5e8ee1556435472e55828a52`）。

| 位置 | 作用 |
| --- | --- |
| `vendor/kimi-work-gateway/` | 核心库的固定副本：监听、鉴权、目录、转发、DNS、准备流程、子代理策略 |
| `vendor/VENDOR.json` | 核心版本、来源提交与每个文件的 SHA-256；`bun run vendor:verify` 与 CI 都会校验 |
| `magpie-backend.mjs` | 把 Magpie 的模型目录翻译成核心模型，并把请求发回 Magpie 网关 |
| `native-byok.mjs` | 兼容包装器，保留原有调用方式（`configure({url, key, port})`、`nativeCatalog`） |

插件只嵌入它实际运行的核心模块，不复制独立 CLI、Web 面板和翻译宿主。`vendor/kimi-work-gateway/index.mjs` 因此是**投影**而非原文：只保留导出目标都在嵌入清单里的 `export … from` 语句，`VENDOR.json` 的 `projection` 字段记录其原始 `src/index.mjs` 的 SHA-256 与被去掉的模块。翻译设置页与翻译运行时属于独立网关，不在本插件中，插件界面也没有新增翻译入口。

升级核心时执行 `bun run vendor:sync ../kimi-work-gateway`，将相邻的核心仓库路径作为参数，再运行测试与哈希校验。其他目录布局请传入对应的核心仓库路径。插件不联网拉取核心，也不在安装时构建。

模型走哪个接口由 **模型 ID 的最后一段**决定：以 `kimi-` 开头走 Chat Completions，其余走 Responses。这与 Kimi 自己的判断一致；名字和协议对不上时模型会在导入阶段被静默丢弃，核心会直接拒绝这种配置。

> 首次接入涉及本机配置：Kimi 的隐藏 BYOK 入口、Kimi 原生网关设置，以及 `dev.msh.team` 的单域名解析。它不是普通“开发者模式”，也不是零配置接入。准备操作必须显式触发，并由系统管理员授权（macOS 写 `/etc/resolver`，Windows 只改 hosts 的两行）；不会修改全局 DNS、代理、证书或防火墙。

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

用上面的 `github:` 地址安装时，Magpie 会跟踪该仓库默认分支的提交：插件有新版本时，「已安装」里会出现更新提示，侧栏显示「1 个更新」，点一下即可更新；也可在终端单独更新这个插件：

```sh
magpie plugin update magpie-agent-kimi-work-byok
```

`magpie plugin update` 不带参数会更新全部插件，只想更新本插件时请带上名字。固定到某个标签或提交的写法（例如 `github:wssz527/magpie-agent-kimi-work-byok#v0.4.2`）不会自动产生更新提示，需要手动改成新版本。从本地文件夹添加的副本只会按文件夹当前内容加载，不会从 GitHub 更新；想持续接收更新，请改用 `github:` 来源（同一时间只保留一个来源，避免两个副本争用 `kimi-desktop` Agent ID）。

插件更新会重启 Magpie 的插件宿主，正在流式返回的回答会先完成。更新不会改动 Kimi 的安装目录、原有接入设置或 `~/.config/magpie-kimi/` 里的状态；更新后仍需在 Kimi 的「第三方模型网关」里确认导入结果。

打开并登录普通 Kimi 桌面应用，在 Magpie「Agent」中打开 **Kimi Work BYOK** 的接入开关。**卡片上的模型选择器指定原生子代理的强制模型，主模型继续在 Kimi Work 菜单中选择**。模型可见范围、账号凭证、路由与用量仍由 Magpie 管理。

已有 native-byok 配置如果没有 `subagents` 字段，继续使用 Kimi 原来的子代理绑定方式；旧版顶层 `model` 字段不会自动迁移成子代理目标。选择子代理模型后，还要完成下文的运行时准备与启动，保存选择本身不表示已生效。

## 首次准备

先让 Kimi Work 当前任务结束。下面的命令向插件提交一个五分钟内有效的一次性请求；由 Magpie 宿主运行准备步骤，并把该 Agent 的网关 Token 复制到系统剪贴板。请在自己的系统管理员授权框中完成认证，不要把密码或 Token 发给别人。

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

打开 Kimi「设置 → 其他」，找到「第三方模型网关」，填入：

- **Base URL**：`http://127.0.0.1:3426/v1`
- **Token**：粘贴上一步由插件复制的 Agent 网关凭证。

点击 **测试连接并导入模型**，看到导入成功后回到 Work，点击输入框旁的模型名称即可切换。不要以 Magpie Agent 卡片的“已接入”代替 Kimi 的导入成功提示。

完成后清除一次性操作选项（Windows 用 `& $MAGPIE plugin options ... off`）：

```sh
/Applications/magpie.app/Contents/MacOS/magpie plugin options magpie-agent-kimi-work-byok off
```

需要重新复制 Token 时，可以重新执行首次准备命令；已经匹配的解析设置不会被覆盖。也可只提交新的 `copyTokenRequest`。

Kimi 菜单保存的是导入时的模型清单。**Kimi 自己每 24 小时重新拉取一次**目录，所以在 Magpie 增删可见模型后，最长一天内会自动更新；想立刻生效，再点一次“测试连接并导入模型”。每次实际推理前，插件都会重新校验当前可见目录；已撤销模型明确报错，不退回默认模型。

## 强制原生子代理模型

先完成上面的 BYOK 导入，再在 Magpie 的 **Kimi Work BYOK** 卡片选择子代理目标。它使用 Magpie 已有模型目录和 Agent 凭证，不复制 Magpie 的账号或新增推理服务。目标必须可见且支持工具调用；协议、上下文、输出限制和默认推理档位沿用该模型的真实能力。

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

在 `status.json` 中确认 `subagents.operation.state` 为 `prepared`，或启动时由当前结构自动准备。准备只复制本机运行时到 `~/.config/magpie-kimi/native-runtime/`，不启动或结束 Kimi，不需要修改安装目录。副本不随插件分发。

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
| `runtime.state: outdated` / `conflict` | 来源已变化、更新版本正在准备或副本/状态文件冲突；先检查原因。从适配入口启动时会尝试按当前结构重新准备，失败则明确报告 |

切换目标后，对后续新建的普通原生子代理生效；已经运行的子代理不会被换模型。`fork` 必须继承父模型，强制模式下会明确拒绝，改用普通新建子代理。恢复旧子代理时，保存的模型与强制目标不一致也会拒绝，避免改写旧上下文；一致时允许恢复。关闭接入或插件正常退出会按文件归属恢复 `inherit`，旧宿主不会覆盖新宿主的策略。下次从 Kimi 普通入口启动即可不使用副本。

当前适配按**实际结构接点**判断：配置读取、子代理创建、运行入口和模型档案服务都要唯一匹配。版本号和内核摘要只用于展示与副本完整性校验，不再作为许可门槛；Kimi 升级后若这些接点仍然存在，重新准备即可继续使用，无需等待插件发版。接点缺失或有多个候选时会拒绝准备并给出原因，不会猜测或强行改写。它不是 Kimi 或 Magpie 的官方稳定子代理 API。**Windows 真机的完整调用链仍未验收**。

`compat` 的 `runtime source markers` 是源码文本观察结果：标记为 `not-observed` 可能是因为混淆隐藏了字符串，不等于该能力在运行时缺失，因此不会单独把状态判成 `incompatible`。

## 状态与排查

状态文件：`~/.config/magpie-kimi/status.json`。它不保存 Token 或对话内容。

| 状态 | 含义与操作 |
| --- | --- |
| `native_byok_waiting_intranet` | 系统 DNS 检查未通过；核对准备结果和单域名解析设置（macOS resolver / Windows hosts），再重启 Kimi |
| `native_byok_waiting_setup` | 隐藏入口未显示；完成准备，也可在 Kimi 设置页连续点击版本号五次 |
| `native_byok_waiting_import` | 本地网关已启动，尚未从 Kimi 原生设置导入 |
| `native_byok_ready` | 前置条件和导入配置就绪；实际模型调用还取决于 Magpie 上游账号与额度 |
| `waiting_kimi` / `waiting_kimi_idle` | Kimi 未运行或有任务在执行，插件等待 |
| `native_byok_port_unavailable` / `native_byok_dns_unavailable` | HTTP / DNS 本地端口被占用，停用重复适配器或使用明确配置的其他端口 |
| `catalog_unavailable` | Magpie 模型目录不可用；检查 Magpie 自己的网关与模型设置 |

一次性准备回执中的 `resolver-conflict` 表示现有解析文件由别的设置占用，`cancelled` 表示管理员取消，`interrupted` 表示上次在完成前退出，`failed` 的 `stage` 指明失败阶段。请保留文件现状再排查。

HTTP 默认监听 `127.0.0.1:3426`；`nativeByok.port` 可改变端口，修改后需把新的地址导入 Kimi。目录与推理均需 Agent 凭证。Electron 原生请求的 `Sec-Fetch-Site: none` 允许通过，网页 Origin 或网页来源标记被拒绝。

## 断开与撤销 DNS

1. 先在 **Kimi 自带的第三方模型网关设置中断开连接**，让 Kimi 自己清理原生 profile。插件不会替其他账号删除 profile。
2. 保持 Magpie 和本插件接入开启，提交下列撤销请求，并在系统授权框完成认证（Windows 会弹出 UAC）。
3. 回执为 `done` 后，关闭 Magpie 的 Kimi Work BYOK 接入开关；需要时从插件页移除本包。

```sh
MAGPIE=/Applications/magpie.app/Contents/MacOS/magpie
SETUP_AT=$(($(date +%s) * 1000))
"$MAGPIE" plugin options magpie-agent-kimi-work-byok \
  "{\"setupRequest\":{\"action\":\"remove-dns\",\"id\":\"remove-dns-$SETUP_AT\",\"at\":$SETUP_AT}}"
```

只删除内容仍与本插件配置匹配的 `/etc/resolver/dev.msh.team`（macOS），或 hosts 中带本插件标记的那两行（Windows），不删除别人的解析文件或条目。隐藏入口标记保留；它本身不会产生网络请求。停止 Magpie 后，插件内 HTTP 监听（以及 macOS 的 DNS 监听）也停止，不会安装 LaunchAgent、计划任务或其他常驻服务。

## 资源库与本地数据

沿用上游 Agent 的资源库接口：共享指令在推理时合并；MCP 和技能使用普通 Kimi 的本地资源目录。已有文件和冲突项按 Magpie 的资源库规则处理，不会自动启用全部资源。Kimi 自带的搜索、文件等工具仍由 Kimi 执行。

插件状态在 `~/.config/magpie-kimi/`。`connection.json` 含 Agent 网关凭证，不要上传。Kimi 的账号、原生 profile、运行状态以及 Magpie 的账号配置均不属于分发包。升级前如果使用过旧版配置备份，备份可能含凭证，同样不要上传。

## 验证范围

- 历史核心接入记录：macOS、Kimi 3.2.21、Magpie 0.1.1659、Bun 1.4.4 下，6 个模型导入且真实推理 HTTP 200。该记录不替代当前源码和分发包的回归验证。
- 当前测试检查生成的目录、两种协议转发、目录变更、兼容缓存、实际插件入口加载、子代理选择保存、目标撤销、一次性操作去重及断开恢复。入口用例在隔离数据和模拟 Magpie 上游上运行；macOS 安装了 Kimi 时额外调用其真实解析器。
- 核心的原生验收用 Node 24 加载本地生成副本中的真实 Work adapter 与内核，经网关访问本地模拟上游，验证父 A → 子 B → 父 A、跨协议、推理档位、配置重建、关闭以及 fork/resume 冲突。未调用付费模型。没有安装受支持 Kimi 或 Node 24 的环境会跳过此项；普通 CI 不代替真实内核验收。
- 已在本机 Magpie 0.1.1692 停用旧本地插件并启用本版，宿主报告 6 个模型兼容检查通过、GLM-5.3 Flash/high 子代理目标已保存。已通过本插件准备真实 Kimi 3.2.21 的运行时副本；Kimi 运行时的启动检查返回 `waiting-kimi-exit`，未结束用户进程。真实桌面从适配入口启动后的完整调用链仍需单独验收；保存目标和准备成功本身不表示已接管。
- **Windows 未做真机端到端验收。** 核心仓库新增了临时 hosts 文件上的 PowerShell 执行用例，当前 macOS 环境会跳过。真实 UAC、Kimi 导入和 `clip.exe` 仍需 Windows 验证；不能以旧版 CI 或脚本字符串断言代替。
- 核心通过 `vendor/VENDOR.json` 固定文件集合与哈希，换行归一化后校验，避免 Windows CRLF 检出误报。该文件同时记录 `index.mjs` 是 allowlist 投影、其原始来源 SHA-256、核心版本与来源提交。
- **v0.5.2 本地验证**：以核心 `ecf5e2d2…`（网关 0.6.2）执行 `vendor:sync` 后，`vendor:verify`、`bun run check` 与双 Bun 的 `bun test` 通过；核心分发包含结构适配器（版本与摘要只作完整性校验）和更新管理器，更新检查依次尝试本机 git、仓库静态发行 feed、最后才是 GitHub API，前两条都不消耗任何人的配额。这些验证不包含 Windows 真机，也没有调用付费模型。
- Kimi 后续版本的格式与检查条件可能变化，`compat` 的未知状态不代表验证成功。

开发验证：

```sh
bun test
bun run check
bun run vendor:verify
bun scripts/verify-package.mjs  # 打包、解包并重跑包内测试、语法和哈希检查
```

要求 Bun 1.4.2+，由 Magpie 管理和运行，无需单独常驻 Bun。CI 配置在 Ubuntu 上覆盖 Bun 1.4.2 / 1.4.4，另在 Windows 上检查同一包和 vendor；本次修改仍需实际运行 CI 才能取得 Windows 结果。包内保留测试文件，测试使用临时目录与合成凭证。

开发时可用隔离的 `XDG_CONFIG_HOME`、`XDG_CACHE_HOME` 测试安装与元数据加载，并把 `MAGPIE_KIMI_DATA_HOME` 指向绝对路径。Windows 还必须将 `APPDATA` 指向隔离目录。Agent 定义仍声明正常的用户目录，因此测试实例不要在真实 Magpie 中打开接入开关、同步资源库或执行首次准备；完整界面测试使用独立系统用户。日常使用不要设置这些测试变量。

## 来源与许可证

基于 MIT 项目 [`@magpie-community/agent-kimi-desktop` 0.1.3](https://github.com/magpie-community/plugins/tree/main/packages/kimi-desktop)，保留上游适配器、资源库实现及版权。此仓库新增原生 BYOK 目录/转发、单域名 DNS、原生请求兼容、一次性准备及相关验证；未把上游已有功能宣称为本仓库原创。接入核心现由独立仓库 [`kimi-work-gateway`](https://github.com/wssz527/kimi-work-gateway) 提供，`vendor/` 内为固定副本。许可证见 [LICENSE](LICENSE)。

本项目是独立社区插件，与 Magpie 和 Kimi 官方无隶属关系。[Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins) 说明 GitHub Topic `magpie-plugin` 的发现规则；设置 Topic 不代表官方审核或推荐。

插件图标 `assets/kimi.png` 取自开发者本机安装的官方 Kimi 桌面应用（3.2.21）的应用图标，仅用于标识所接入的应用；它不表示 Kimi 或 Moonshot AI 对本插件的认可、赞助或背书。
