# Kimi Work BYOK for Magpie

让普通 **Kimi 桌面应用的 Work** 在原生模型选择器里使用 Magpie 的第三方模型。不是 Kimi Code，也不是把 Kimi 会员额度提供给其他 Agent 的 Provider。

**v0.2.0 支持 macOS。** 核心接入已在 Kimi 3.2.20、Magpie 0.1.1587、Magpie Bun 1.4.4 上验证。Windows / Linux 的原生模式尚未适配，不承诺跨平台可用。

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

> 首次接入涉及本机配置：Kimi 的隐藏 BYOK 入口、Kimi 原生网关设置，以及 `/etc/resolver/dev.msh.team` 单域名解析。它不是普通“开发者模式”，也不是零配置接入。准备操作必须显式触发，并由 macOS 管理员授权；不会修改全局 DNS、hosts、代理、证书或防火墙。

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

没有把 `magpie` 加入 PATH 时，macOS 安装位置可使用：

```sh
/Applications/magpie.app/Contents/MacOS/magpie plugin add github:wssz527/magpie-agent-kimi-work-byok
```

打开并登录普通 Kimi 桌面应用，在 Magpie「Agent」中打开 **Kimi Work BYOK** 的接入开关。模型由 Kimi Work 自己选择，因此本版不在 Magpie Agent 卡片提供默认模型选择器。模型的可见范围仍由 Magpie 控制。

## 首次准备

先让 Kimi Work 当前任务结束。下面的命令向插件提交一个五分钟内有效的一次性请求；由 Magpie 宿主运行准备步骤，并把该 Agent 的网关 Token 复制到系统剪贴板。请在 macOS 自己的管理员授权框中完成认证，不要把密码或 Token 发给别人。

```sh
MAGPIE=/Applications/magpie.app/Contents/MacOS/magpie
SETUP_AT=$(($(date +%s) * 1000))
"$MAGPIE" plugin options magpie-agent-kimi-work-byok \
  "{\"setupRequest\":{\"action\":\"prepare\",\"id\":\"prepare-$SETUP_AT\",\"at\":$SETUP_AT},\"copyTokenRequest\":{\"id\":\"copy-token-$SETUP_AT\",\"at\":$SETUP_AT}}"
```

命令显示“options set”只表示请求已保存。准备结果在 `~/.config/magpie-kimi/native-setup-receipt.json`：`result.state` 应为 `done`。管理员取消、文件冲突或中断都会明确记录，且不会循环弹框；重试时重新运行上面的命令生成新请求 ID。

准备会做两件事：

1. 为 `dev.msh.team` 安装精确单域名 resolver，指向插件的 `127.0.0.1:53535`。插件只回答这个域名，A 记录为合成内网地址 `10.255.255.254`，其他域名不转发。这让 Kimi 的本地可用性检查通过，不代表接入了真实公司内网。
2. 在 Kimi 用户数据目录的 `kimi-agent/byok-availability.json` 合并 `revealed: true`，保留已有字段。这个标记只显示 Kimi 原有的 BYOK 设置，不修改应用代码。

已有 resolver 的内容不同或路径是符号链接时，插件拒绝覆盖。需要自定义端口时先配置 `nativeByok.dns.port`，再准备；不要手动覆盖其他网络软件的解析文件。

## 在 Kimi 原生设置导入

准备成功后，在空闲时正常重启 Kimi，让它刷新隐藏入口和 DNS 缓存。

打开 Kimi「设置 → 其他」，找到「第三方模型网关」，填入：

- **Base URL**：`http://127.0.0.1:3426/v1`
- **Token**：粘贴上一步由插件复制的 Agent 网关凭证。

点击 **测试连接并导入模型**，看到导入成功后回到 Work，点击输入框旁的模型名称即可切换。不要以 Magpie Agent 卡片的“已接入”代替 Kimi 的导入成功提示。

完成后清除一次性操作选项：

```sh
/Applications/magpie.app/Contents/MacOS/magpie plugin options magpie-agent-kimi-work-byok off
```

需要重新复制 Token 时，可以重新执行首次准备命令；匹配的 resolver 可重复准备，不会覆盖其他文件。也可只提交新的 `copyTokenRequest`。

Kimi 菜单保存的是导入时的模型清单。在 Magpie 增删可见模型后，再点一次“测试连接并导入模型”刷新。每次实际推理前，插件都会重新校验当前可见目录；已撤销模型明确报错，不退回默认模型。

## 状态与排查

状态文件：`~/.config/magpie-kimi/status.json`。它不保存 Token 或对话内容。

| 状态 | 含义与操作 |
| --- | --- |
| `native_byok_waiting_intranet` | 系统 DNS 检查未通过；核对准备结果和单域名 resolver，再重启 Kimi |
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
2. 保持 Magpie 和本插件接入开启，提交下列撤销请求，并在 macOS 授权框完成认证。
3. 回执为 `done` 后，关闭 Magpie 的 Kimi Work BYOK 接入开关；需要时从插件页移除本包。

```sh
MAGPIE=/Applications/magpie.app/Contents/MacOS/magpie
SETUP_AT=$(($(date +%s) * 1000))
"$MAGPIE" plugin options magpie-agent-kimi-work-byok \
  "{\"setupRequest\":{\"action\":\"remove-dns\",\"id\":\"remove-dns-$SETUP_AT\",\"at\":$SETUP_AT}}"
```

只删除内容仍与本插件配置匹配的 `/etc/resolver/dev.msh.team`，不删除别人的解析文件。隐藏入口标记保留；它本身不会产生网络请求。停止 Magpie 后，插件内 HTTP 和 DNS 监听也停止，不会安装 LaunchAgent 或其他常驻服务。

## 资源库与本地数据

沿用上游 Agent 的资源库接口：共享指令在推理时合并；MCP 和技能使用普通 Kimi 的本地资源目录。已有文件和冲突项按 Magpie 的资源库规则处理，不会自动启用全部资源。Kimi 自带的搜索、文件等工具仍由 Kimi 执行。

插件状态在 `~/.config/magpie-kimi/`。`connection.json` 含 Agent 网关凭证，不要上传。Kimi 的账号、原生 profile、运行状态以及 Magpie 的账号配置均不属于分发包。升级前如果使用过旧版配置备份，备份可能含凭证，同样不要上传。

## 验证范围

- 核心接入在原版 Kimi 3.2.20 / Magpie 0.1.1587 / Bun 1.4.4 的 macOS 环境验证。
- Work 原生设置成功导入多类模型，正常重启后菜单仍保留。GLM-5.3 Flash 从 Work 界面发送测试并收到完整回复，Magpie 记录确认请求模型与实际供应商，HTTP 200。
- DeepSeek 经同一插件网关完成真实流式调用，HTTP 200；这项是 HTTP 客户端验证，不等同于第二次 Work 界面发送。
- Kimi `app.asar`、`Info.plist` 哈希与接入前一致，`codesign --verify --deep --strict` 通过。
- 分享版一次性准备模块通过隔离目录与模拟管理员调用验证；既有单域名 DNS 实际配置验证来自本机接入。CI 不会弹出管理员窗口或连接真实模型。
- 0.2.0 把接入逻辑换成本仓库 `vendor/kimi-work-gateway/` 内的固定核心副本。升级前所在机器的真实接入状态、Kimi 菜单与 resolver 未改动；兼容包装器与原接口一致，原有 15 项原生行为测试全部保留并通过。
- Kimi 后续版本的 BYOK 格式、隐藏入口和可用性检查可能变化；本版只声明上述已验证版本。

开发验证：

```sh
bun test
bun run check
bun run vendor:verify
bun pm pack
```

要求 Bun 1.4.2+，由 Magpie 管理和运行，无需单独常驻 Bun。发布包的 41 项测试、315 个断言在 Bun 1.4.2、1.4.4 均通过，CI 覆盖两个版本并校验 vendor 哈希。安装了对应 Kimi 的 macOS 会额外验证其纯模型目录解析契约；其他环境自动跳过该项。测试使用临时目录与合成凭证。

开发时可用隔离的 `XDG_CONFIG_HOME`、`XDG_CACHE_HOME` 测试 Magpie 插件安装与元数据加载，并把 `MAGPIE_KIMI_DATA_HOME` 指向绝对路径，隔离 Bun 适配器的状态和 Kimi 数据查找。Agent 定义仍声明正常的用户目录，所以这种测试实例**不要打开 Agent 接入开关、同步资源库或执行首次准备**。需要完整隔离接入测试时使用独立系统用户。日常使用不要设置该变量。

## 来源与许可证

基于 MIT 项目 [`@magpie-community/agent-kimi-desktop` 0.1.3](https://github.com/magpie-community/plugins/tree/main/packages/kimi-desktop)，保留上游适配器、资源库实现及版权。此仓库新增原生 BYOK 目录/转发、单域名 DNS、原生请求兼容、一次性准备及相关验证；未把上游已有功能宣称为本仓库原创。接入核心现由独立仓库 [`kimi-work-gateway`](https://github.com/wssz527/kimi-work-gateway) 提供，`vendor/` 内为固定副本。许可证见 [LICENSE](LICENSE)。

本项目是独立社区插件，与 Magpie 和 Kimi 官方无隶属关系。[Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins) 说明 GitHub Topic `magpie-plugin` 的发现规则；设置 Topic 不代表官方审核或推荐。
