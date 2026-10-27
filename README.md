# Kimi Work BYOK for Magpie

让普通 **Kimi 桌面应用的 Work** 在原生模型选择器里使用 Magpie 的第三方模型。不是 Kimi Code，也不是把 Kimi 会员额度提供给其他 Agent 的 Provider。

**v0.3.1 支持 macOS 与 Windows。** 核心接入已在 macOS 上以 Kimi 3.2.21、Magpie 0.1.1659、Magpie Bun 1.4.4 实测；Windows 分支已实现并有单元测试与 CI 覆盖，但尚未在真实 Windows + Kimi + UAC 上做端到端验收。Linux 未适配。

不修改 Magpie 或 Kimi 的安装包、`app.asar`、可执行文件或签名，不开调试端口、不注入模型菜单。HTTP 转发和单域名 DNS 都运行在 Magpie 的 Bun 插件宿主里；日常只需打开 Magpie 和 Kimi。

## 与通用核心的关系

本插件的接入能力来自独立仓库 [`kimi-work-gateway`](https://github.com/wssz527/kimi-work-gateway)，该仓库同时提供可直接运行的独立 CLI。Magpie 版把核心的固定版本复制到 `vendor/kimi-work-gateway/`，**用户不需要另装或另开网关**。

| 位置 | 作用 |
| --- | --- |
| `vendor/kimi-work-gateway/` | 核心库的固定副本：监听、鉴权、目录、转发、DNS、准备流程 |
| `vendor/VENDOR.json` | 核心版本与每个文件的 SHA-256；`bun run vendor:verify` 与 CI 都会校验 |
| `magpie-backend.mjs` | 把 Magpie 的模型目录翻译成核心模型，并把请求发回 Magpie 网关 |
| `native-byok.mjs` | 兼容包装器，保留原有调用方式（`configure({url, key, port})`、`nativeCatalog`） |

升级核心时执行 `bun run vendor:sync`（脚本在 `scripts/vendor-core.mjs`），再让测试与校验通过。插件不联网拉取核心，也不在安装时构建。

模型走哪个接口由 **模型 ID 的最后一段**决定：以 `kimi-` 开头走 Chat Completions，其余走 Responses。这与 Kimi 自己的判断一致；名字和协议对不上时模型会在导入阶段被静默丢弃，核心会直接拒绝这种配置。

> 首次接入涉及本机配置：Kimi 的隐藏 BYOK 入口、Kimi 原生网关设置，以及 `dev.msh.team` 的单域名解析。它不是普通“开发者模式”，也不是零配置接入。准备操作必须显式触发，并由系统管理员授权（macOS 写 `/etc/resolver`，Windows 只改 hosts 的两行）；不会修改全局 DNS、代理、证书或防火墙。

## 跨版本

Kimi 每次发版都会重新混淆主进程代码，因此本插件不按符号名读取安装包。`status.json` 里的 `compat` 字段给出当前判断：

| `compat.state` | 含义 |
| --- | --- |
| `verified` | 已安装的 Kimi 接受本插件生成的每一个模型 |
| `incompatible` | 有模型会被丢弃，需要处理 |
| `unverified` | 这次认不出混淆结构；集成照常工作，只是无法预先验证 |
| `unavailable` | 没找到安装包或不在支持平台 |

`unverified` 不是故障：插件只输出公开的 `api.json` 结构，从不修改 Kimi。想手动检查，可在核心仓库运行 `kimi-work-gateway compat`。

## 安装

如果已启用 `@magpie-community/agent-kimi-desktop`、`kupakupar/magpie-agent-kimi` 或本插件的本地副本，先在 Magpie 停用旧版，再安装本版。它们共用 `kimi-desktop` Agent ID 与状态目录，不能同时运行。切换后正常重启一次 Magpie，确保旧适配器已退出。

在 Magpie「插件」中添加：

```text
github:wssz527/magpie-agent-kimi-work-byok
```

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

打开并登录普通 Kimi 桌面应用，在 Magpie「Agent」中打开 **Kimi Work BYOK** 的接入开关。模型由 Kimi Work 自己选择，因此本版不在 Magpie Agent 卡片提供默认模型选择器。模型的可见范围仍由 Magpie 控制。

## 首次准备

先让 Kimi Work 当前任务结束。下面的命令向插件提交一个五分钟内有效的一次性请求；由 Magpie 宿主运行准备步骤，并把该 Agent 的网关 Token 复制到系统剪贴板。请在自己的系统管理员授权框中完成认证，不要把密码或 Token 发给别人。

macOS：

```sh
MAGPIE=/Applications/magpie.app/Contents/MacOS/magpie
SETUP_AT=$(($(date +%s) * 1000))
"$MAGPIE" plugin options magpie-agent-kimi-work-byok \
  "{\"setupRequest\":{\"action\":\"prepare\",\"id\":\"prepare-$SETUP_AT\",\"at\":$SETUP_AT},\"copyTokenRequest\":{\"id\":\"copy-token-$SETUP_AT\",\"at\":$SETUP_AT}}"
```

Windows（PowerShell）：

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

- 核心接入在 macOS 上以原版 Kimi 3.2.21 / Magpie 0.1.1659 / Bun 1.4.4 复测：6 个模型全部导入，真实推理 HTTP 200。
- Kimi 3.2.21 升级后，本插件生成的目录仍被其解析器全部接受（0 丢弃）；测试改为按结构定位解析器，并要求在**安装包全部符号随机改名**后依然通过。
- **Windows 未做真机端到端验收。** 已实现并有测试覆盖：hosts 编辑（保留 BOM/换行/其他行、幂等、采纳手写条目、冲突拒绝）、UAC 取消映射、平台分派、`clip.exe` 剪贴板；CI 在 `windows-latest` 上跑全量测试。真实 Windows + Kimi + UAC 的完整流程需要另行验证。
- 0.3.1 的核心副本同步到 0.1.2，`vendor/VENDOR.json` 哈希由 CI 校验；哈希在计算前统一换行，因此 Windows 上 CRLF 检出不会误报。
- Kimi 后续版本的 BYOK 格式、隐藏入口和可用性检查可能变化；`status.json` 的 `compat` 字段会给出当前判断。

开发验证：

```sh
bun test
bun run check
bun run vendor:verify
bun pm pack
```

要求 Bun 1.4.2+，由 Magpie 管理和运行，无需单独常驻 Bun。发布包的 43 项测试在 Bun 1.4.2、1.4.4 均通过；CI 覆盖这两个版本，另在 `windows-latest` 上跑同一套测试并校验 vendor 哈希。macOS 上会额外用已安装的 Kimi 校验模型目录契约（按结构定位，符号改名不影响）；未安装或非 macOS 自动跳过。测试使用临时目录与合成凭证。

开发时可用隔离的 `XDG_CONFIG_HOME`、`XDG_CACHE_HOME` 测试 Magpie 插件安装与元数据加载，并把 `MAGPIE_KIMI_DATA_HOME` 指向绝对路径，隔离 Bun 适配器的状态和 Kimi 数据查找。Agent 定义仍声明正常的用户目录，所以这种测试实例**不要打开 Agent 接入开关、同步资源库或执行首次准备**。需要完整隔离接入测试时使用独立系统用户。日常使用不要设置该变量。

## 来源与许可证

基于 MIT 项目 [`@magpie-community/agent-kimi-desktop` 0.1.3](https://github.com/magpie-community/plugins/tree/main/packages/kimi-desktop)，保留上游适配器、资源库实现及版权。此仓库新增原生 BYOK 目录/转发、单域名 DNS、原生请求兼容、一次性准备及相关验证；未把上游已有功能宣称为本仓库原创。接入核心现由独立仓库 [`kimi-work-gateway`](https://github.com/wssz527/kimi-work-gateway) 提供，`vendor/` 内为固定副本。许可证见 [LICENSE](LICENSE)。

本项目是独立社区插件，与 Magpie 和 Kimi 官方无隶属关系。[Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins) 说明 GitHub Topic `magpie-plugin` 的发现规则；设置 Topic 不代表官方审核或推荐。
