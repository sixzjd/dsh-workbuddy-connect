# DSH WorkBuddy Connect

[English](./README.en.md) | **简体中文**

把 **WorkBuddy**（国际版 / 国内版）的模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的社区插件。一个插件同时服务两条 WorkBuddy 产品线：**一张设置卡片**（卡片内用页签切国际版 / 国内版，和 Qoder 卡片同一套交互），各有一个 provider、一套凭证与模型目录，互不混用：

| 变体 | provider id | 卡片页签 | 上游站点 |
|---|---|---|---|
| 国际版 | `workbuddy-global` | 国际版 | www.workbuddy.ai |
| 国内版 | `workbuddy` | 国内版 | copilot.tencent.com / www.codebuddy.cn |

> **国际版当前限时免费**：实测目录里有三个模型倍率是 `x0.00`——`deepseek-v4.1-flash`（DeepSeek-V4.1-Flash，300K/128K）、`hy3`（192K/64K）、`step-5-preview`（300K/64K）；另有 `deepseek-v4.1-flash-sg` 是 `x0.03`。免费是上游的活动，插件读取的是**实时**倍率——活动结束后卡片会自己把「免费」标记去掉，而不是继续挂着一个过期的承诺。

## 为什么需要插件，而不是直接配一个 provider

WorkBuddy 的网关是一套**只认官方客户端**的封闭接口，DSH 的原生适配器够不着它：

1. **User-Agent 门闸**：网关按 UA 分流，`deepseek-harness/*` 直接被拒（业务码 `11128`）。DSH 自己的适配器写死了这个 UA。
2. **首条消息必须是 system**：国际版缺了就 `400 / 11128`。
3. **字段方言**：`developer` 角色、`store` 字段、对象形态的 `tool_choice`、`max_completion_tokens` 别名、裸字符串的 `stop`、非字符串的 tool-call `arguments`——每一个都会被上游拒。
4. **一整套归属头**：`X-Product`、`X-Domain`、`X-User-Id`、`X-Enterprise-Id`/`X-Tenant-Id`、`X-IDE-*`，以及**三个会一起校验的会话头**（`X-Conversation-ID`、`X-Conversation-Request-ID`、`X-Conversation-Message-ID`）——只给一个仍然 `11128`。

所以插件在宿主与上游之间插一层**回环 shim**：pi-ai 用标准 OpenAI-completions 跟 shim 说话，shim 用 WorkBuddy 的方言跟网关说话。

```
DSH (pi-ai)  ──OpenAI 协议──▶  127.0.0.1 shim  ──WorkBuddy 协议──▶  网关
                 共享密钥         方言改写              真实 accessToken
```

**真实令牌从不离开这台机器**，也从不交给 pi-ai：shim 自己从凭据库里取。

## 功能

- **两种登录方式**：
  - **设备授权**（主路径）：卡片上点「登录 WorkBuddy」→ 打开 WorkBuddy 授权页 → 回到卡片即完成，全程不需要 API Key。accessToken 到期前 5 分钟自动续期，续期失败时仍用未过期的旧令牌，不打断正在进行的对话。
  - **从桌面 App 导入**（便捷路径）：本机装了 WorkBuddy 桌面版且已经登录时，卡片上会多一个「从桌面 App 导入」——插件直接采用桌面版自己的登录态，免去浏览器往返。桌面版把令牌加密存盘（WorkBuddy 5.6.0 起），插件**调用桌面版自己的原生模块**取密钥来解密，不内置任何与构建相关的常量；桌面版没装、没登录或取不到密钥时，这一项不会出现。**已登录状态下这一项也一直可用**——桌面版会自己重新登录并轮换会话，插件手里那份副本会随之作废，这时再点一次「从桌面 App 导入」就能接上新的会话，不必先退出登录。
- **会话失效会自己说**：上游拒收这份凭据时（例如桌面版换过会话），卡片会直接提示「上游拒绝了这份凭据」，而不是继续挂着「已登录」的假象。
- **账号被限制会和会话失效分开说**：「上游拒收凭据」和「上游限制了这个账号」是两种病，只有前者能靠重新登录或重新导入治好。后者（业务码 `11140`）会单独提示「只有申诉才能解除」——实测重新导入、重新登录、用刚刷新出的新令牌都无效，官方桌面版同样被拒，见下文 2026-11-08 补记。
- **插件页上的「更新」按钮是本插件自己补的**：DSH 的插件页只给**官方按需插件**算 `installTarget`（`updateAvailable()` 要求它存在，而它只由 `OFFICIAL_ON_DEMAND_CATALOG` 生成），所以从 `github:` 装的社区插件的页面**永远不显示「更新」**——不是没新版，是那条判断在第一行就 `return false` 了。文档也写明「其他插件通过卸载后重新安装升级」。
  本插件的卡片因此往插件页的 `plugins.detail.actions` 插槽（页面为这种情况专门声明的）里放了一个自己的按钮：读 profile 的 `package.json` + `pnpm-lock.yaml` 得知**当前锁在哪个 commit**，再用 `git ls-remote` 问上游 `main` 现在指向哪个 commit，落后就显示「有新版本 ⟨按钮：更新到此版本⟩」。
  安装动作**交给插件管理器**（`ctx.remote.pluginManager` 的 `removeBundle` + `installBundle`），因为它持有 profile 锁、pnpm 调用和重载生命周期；插件自己只读不写。更新成功后需要重启 App。
  只读判断为 `local-copy` 的安装（`file:` / `link:`）不会出现按钮——没有远程可比较，硬更新等于用远端覆盖你的工作目录。

- **两个 realm 各自独立**：两版各有自己的凭据文件、路由、已保存目录与额度。`workbuddy.ai` 的令牌在 `codebuddy.cn` 上无效，反之亦然，两套永不互串。
- **模型目录三级降级（live → saved → fallback）**：卡片明示当前列表来自哪里——「实时列表（更新于 …）」、「上次保存的模型列表」、「内置模型列表（尚未从 WorkBuddy 更新）」；最近一次拉取失败时附带原因，并可手动「刷新目录」。
- **模型自由开关**：按名称/ID 即时搜索，单个开关，或「全部开启 / 全部关闭」；关闭的模型从 DSH 的模型选择器里消失。
- **价格倍率与免费标记**：模型名后直接拼上游倍率（`Deepseek-V4.1-Flash · x0.00`），免费模型额外挂一个「免费」角标。活动过期的倍率不会被继续显示为当前价格——插件会把它标成「价格暂不可用」。
- **额度明细**：按资源包逐行给出「剩余 / 总量 + 进度条」，标注到期时间与下一轮刷新时间。读的是**周期额度**而不是池额度——池额度在月度资源用完之后仍会报「一点没动、全部还在」。
- **上下文窗口开关**：可选择按上游声明的默认窗口（300K）或最大窗口（1M）发请求，两版各自独立保存。
- **推理档位**：上游声明了可用档位的模型才有档位可选；上游用单数形态声明的档位会被折算成完整阶梯，而不是整个丢掉。

## 安装

前置条件：DSH 核心 `0.2.0-rc.2` 及以上；Node.js `^22.19.0 || >=24.0.0`。

```sh
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:sixzjd/dsh-workbuddy-connect

# 从本地目录安装（开发用）
dsh plugin --profile web add "file:/绝对路径/接入workbuddy"
```

> **别用 `add dsh-workbuddy-connect`。** npm 上这个名字**已被另一个插件占用**——`dsh-workbuddy-connect@0.7.9`（作者 `corrinehu`，2026-10-20 发布），那是另一套实现，装到的是它而不是本仓库。本插件只在 GitHub 上分发，安装请写全 `github:sixzjd/`。

按你使用的 profile 换 `--profile` 的值（`web` / `desktop` / `tui`）。装到哪个 profile，数据就落在哪个 profile 目录里，web / desktop / tui 各自独立。

> **装完要重启 DSH。** 插件是启动时按 `package.json → dsh.profile.bundles` 装载的，热重载只覆盖 client 侧的模块，不覆盖 bundle 本身。

## 使用

1. DSH → 设置 → 插件设置 → 展开 **WorkBuddy** 卡片。
2. 卡片顶部有「国际版 / 国内版」两个页签，页签前的小圆点就是这个版本的登录状态（绿=已登录，灰=未登录）。默认停在国际版。
3. 点「登录 WorkBuddy」，在新标签页里完成 WorkBuddy 授权；本机装了桌面版的话还有「从桌面 App 导入」一键接入。
4. 回到卡片，状态变成「已登录」，模型目录自动刷新。
5. 在会话里用模型选择器挑一个模型——国际版当前有免费模型可用。

切到「国内版」页签管理国内线路，站点换成 `codebuddy.cn`，两边的凭证、目录、额度、开关互不影响。

## 数据与隐私

插件的全部自有文件收在数据目录一处：`<profile>/.dsh-workbuddy-connect/`

```text
<profile>/.dsh-workbuddy-connect/
├── .workbuddy-auth.json          # 国内版凭据（{version, region, auth{…}, account{…}}）
├── .workbuddy-ai-auth.json       # 国际版凭据
├── .workbuddy-settings.json      # 国内版设置（模型开关、上下文窗口）
├── .workbuddy-ai-settings.json   # 国际版设置
└── state/
    ├── .workbuddy-catalog.json          # 国内版按账号保存的模型目录
    ├── .workbuddy-ai-catalog.json       # 国际版
    ├── .workbuddy-app-version.json      # 国内版 App 版本缓存
    └── .workbuddy-ai-version.json       # 国际版 App 版本缓存
```

凭据文件权限 `0600`，目录 `0700`，写入用「临时文件 + rename」保证不会读到半截文件。

数据目录按 profile 归属（在 `$DSH_HOME/profiles/` 下找声明本插件的 profile），无法确定时回落到 Harness home；环境变量 `DSH_WORKBUDDY_DATA_DIR` 可显式覆盖。

**凭据的来源只有两种**：插件自己的设备授权登录（主路径），或用户主动点的「从桌面 App 导入」。后者读的是桌面版自己的加密登录态——密钥由桌面版的原生模块现取，插件不内置任何与构建相关的常量，也**从不写入磁盘**。桌面版没装时，插件照常工作。

## 实现要点

| 环节 | 做法 |
|---|---|
| 登录 | `POST {base}/v2/plugin/auth/state?platform=CLI` → 轮询 `GET {base}/v2/plugin/auth/token?state=`；业务码 `11217` = 等待中。每次尝试一个独立 cookie jar——两版同时登录不会互相应答。 |
| 刷新 | `POST {base}/v2/plugin/auth/token/refresh`，`X-Refresh-Token` + `X-Auth-Refresh-Source: workbuddy` |
| 对话 | `POST {base}/v2/chat/completions`，SSE；`choices[0].delta.reasoning_content` 是思考内容 |
| 目录 | `GET {base}/v3/config`（**优先**）；旧的 `/v2/enterprises/personal/models` 与 `/console/enterprises/personal/models` 只作兜底——旧文档给的是 CLI 渠道的名单，会把同样叫「Hy4 preview」的免费 `hy4-preview-f`（x0.00）换成付费的 `hy4-preview`（x0.29） |
| 额度 | `POST {base}/v2/billing/meter/get-user-resource`，读 `CycleCapacity*` + `*Precise` |
| 错误码 | `14018` 额度耗尽（终态，不是限流）· `14003` 模型级限流 · `6004` 账号级限流 · `12153` 会话失效 · `11140` **账号被上游限制**（不是凭据问题，申诉才能解）· `11128` 渠道被拒 · `11133` 参数被拒 · `11101` 非流式 |
| 回环安全 | 只绑 `127.0.0.1`；校验 Host / Origin；每次进程一个随机 bearer 密钥；只收 `application/json`；请求体上限 32 MiB |
| 桌面登录态 | `AES-256-GCM`，12 字节 nonce、16 字节 tag，AAD 是「方案 / 套件 / keyId / 分帧」的长度前缀转写；密钥 = `sha256(桌面版原生模块给出的 base64 字符串)`，只存在内存里 |

**模型身份**是一个容易被忽略的坑：两个区域的模型都声明同一个身份 `workbuddy`，而**路由**分别是 `workbuddy` 和 `workbuddy-global`。pi-ai 只在「provider + api + 模型 id」三者全同的时候才保留历史思考块，所以跨区域续聊时身份必须一致；但身份同时又必须是每个区域注册表里的一个键，否则国际版每个请求都会以 `Unknown provider: workbuddy` 收场。两件事一起做才成立。

**上游没有服务端会话**：每一轮都要把完整历史发回去，插件不会替它压缩。

**模型身份之外还有一处容易漏的**：`supportsImages` 是**平台标记**而不是能力标记——上游几乎给每一行都标 `true`，包括根本收不了图片的模型。所以图片能力另有一张逐 id 复核的表；否则会两头出错：对纯文本模型发图（上游在消息已经落库之后才拒），或者对真能看图的模型收掉图（用户白白少一个能力）。

**还有一处是国内版专属的坑**：上游的渠道校验会读消息的**行首**，凡是「自报家门成别的客户端」的行首一律拒（`400 / 11128`「Illegal API invocation from an unapproved channel」）——**DSH 系统提示词的第一行恰好就是 "You are an AI agent powered by DeepSeek Harness."**，所以国内版每一条消息都会被拦，而国际版不查这一行、毫发无损。

这里有三层，少修一层都会复发：

1. **system 消息**：首行是该标记就拒（前面多一行、或多一个空格就放行，是字面前缀）。
2. **assistant 消息**：同样按行首查。这一层最阴——**模型只要把自己的指令复述进回复，下一轮起这整条对话就一直失败**，而代码一个字没改。你遇到的就是这个：第 1 轮正常，切到国内版后的第 2 轮就 11128。
3. **content 形状**：`content` 既可能是字符串，也可能是 `[{type:'text',text:…}]` 这样的数组块，**两种形态都会查**。只处理字符串的消毒器在数组形态下等于没生效。

插件因此把这句话改写成 "You are an AI coding assistant."：system 消息整条替换，assistant 消息只改行首、**不动句中**（实测句中不拦），**user / tool 一律不碰**（那是你的原话，改了就是篡改对话），数组块只改 `text` 部分、保留图片等结构。国际版那条路径同样受益。

**2026-10-24：这条校验升级成了指纹匹配**，同一份消毒只管首行不够了。国内网关（错误外壳同日新增了 `displayMsg`/`displayTips`「请求被拦截，请重新发送」）开始对**拼装后的整条 system 提示词做指纹比对**，而 0.2.1-rc.2 时代的系统提示词在首行之外又新增了两句自报家门的话——「The runtime context names the **DeepSeek Harness** implementation checkout.」和「You are interacting with the user through the **DeepSeek Harness** Web GUI…」。实测的边界（逐条测过，hy3 免费模型）：

- 每一句**单独**发都放行（连 3 次出现也放行）；首行那句照旧被拒；
- 完整提示词**确定性** 11128（重试三次全拦），把其中 "DeepSeek Harness" 改写掉就 200 放行；
- 同样的句子放进 **user** 消息（1 条 3 次、2 条共 6 次）都放行——指纹只看 system；
- 失败片段二分到 1.7KB 连续原文才中、对半拆开各自都过——匹配的是提示词的**原文片段**，不是单个短语。

所以消毒表加了一条兜底：**system 消息里残留的 "DeepSeek Harness" 一律改写成 "DSH"**（排在首行那条之后，首行仍优先用更自然的整句替换），assistant 行首同样覆盖。user / tool 依旧一字不动（实测 6 处 user 提及不触发）。

**2026-10-25 补记：只改 system 不够——扫描覆盖了全部消息**。次日重启后同一会话仍被拦（requestId 换了新的），而系统提示词已被消毒、进程确认加载了新代码。差异在**历史**：那是个五天的插件调试会话，最后一次成功压缩停在 turn 2，此后 1166 条消息（约 0.95 MB）整个在窗口里，其中 **assistant 消息含 91 处、"tool" 结果含 75 处 "DeepSeek Harness"**（模型读过并复述了本插件的源码和探针脚本）。结论：指纹扫描现在到达全转录本，于是这条兜底标记为 `"deep"`——在 **assistant 句中与 tool 结果里也改写**（assistant 记录的 `tool_calls[].function.arguments` 一并覆盖，模型用编辑工具写文件时参数里同样带这个词）；**user 消息仍然一字不动**（10-24 实测 user 侧多处提及、system 干净时放行，且那是人的原话）。代价是诚实说明的：assistant/tool 里的改动只是把同一实体的名字换掉，不碰语义，但历史与模型当初看到的文本不再逐字一致——这是「整条国内线路拒绝」与「历史里换个名字」之间的取舍。

**2026-10-25 再补记：deep 改写生效后仍被拦——第二堵墙是上下文窗口虚报**。用重建的真实历史复现：真实系统提示词单独发**通过**（消毒有效），加上真实历史后失败——但错误码变成了 **11115**（新码），而且把 assistant/tool/user 全部改写后**依然失败**，说明这一层与指纹无关。按规模二分（免费模型 hy3）：最后 100 条（约 80KB）2.8 秒通过、300 条（约 250KB）8.3 秒通过、600 条（约 470KB）连接直接挂起、全量（约 0.95MB）快速回 11115——**过了模型真实窗口，上游要么挂起要么拒绝**。根因在目录解析：两个部署对容量的描述不同——国际版 `/v3/config` 产品文档带 `contextWindow` 对象（deepseek-v4.1-flash **默认 300000**、最大 1000000），而国内 CLI 文档只有 `maxInputTokens`，且 deepseek 行给的是**最大值** 1000000。解析器对国内行直接拿 `maxInputTokens` 当窗口报给宿主——报大了 3-5 倍；宿主的压缩引擎阈值是声明窗口的 0.8，声明 1M 就永远不压缩，五天历史原样发。修复：国内行对有官方默认声明的 id 取默认值（`DEFAULT_CONTEXT_WINDOWS` 表，值来自 2026-10-25 实测的国际版文档；表外 id 维持原行为——hy3 的 192000 本来就两边一致）。修复后 deepseek 报 300k，压缩引擎在约 10 万 token 就主动压缩，请求始终在可投递范围内；那个卡死的会话在重启后第一条消息就会触发压缩自愈。

**2026-10-31 补记：上面两处的结论都被后续实测部分推翻**。用超大 body 直接问网关（免费模型，请求被拒时不产生输出），网关自己在 `11115` 里报出「测得多少 token / 执行的上限是多少」，于是三件事第一次有了准数：

- **「285KB 以上会挂起」是误判**。同一条线路实测：512KB 8.5 秒、819KB 19 秒、**1.2MB 23 秒、2MB 4.5 秒**全部正常应答，唯一的拒绝理由是 **token 超限**，且报错精确到个位（`prompt is too long: 1200515 tokens > 1048576 maximum`）。当年那个「卡死」其实是撞上了模型的 token 上限。于是 `MAX_DELIVERABLE_BODY_BYTES` 从 350KB 改为 **16MiB**（可用 `DSH_WORKBUDDY_MAX_BODY_BYTES` 覆盖）——它从此只是传输保护，窗口由上游按 token 执行，而 `11115` 本来就已经被改写成宿主能压缩的那种错误。350KB 的旧值危害是具体的：它在约 9 万 token 处**本地伪造 400**（2ms 返回、`inputTokens: 0`，根本没出门），而压缩请求自身同样超限，于是会话既发不出去也压不了。
- **窗口两个方向都报错了**。`deepseek-v4.1-flash` 与 `kimi-k3.1-pro` 网关实际执行 **1048576**（目录只报 300000，白扔 3.5 倍容量）；而 `hy3`（192000）与 `minimax-m3.1-flash`（300000）实际只给 **100000**——**多报**更糟：宿主压缩阈值是声明窗口的 0.8，声明 192000 就要到 153600 才压，而墙在 100000，于是永远撞墙在压缩之前，压缩请求本身又被同样拒绝，这就是「压缩也压缩不了」的机制。修复在 `catalog.all()` 里加 `MEASURED_CONTEXT_WINDOWS` 覆盖（必须在这一层：磁盘上已保存的目录里，错数字已经烤进 `contextWindow` 字段）。
- **网关不把 `max_tokens` 算进窗口**。CN hy3 实测 `prompt≈70000 + max_tokens=64000`（合计 134000 > 100000）**仍然通过**，所以 128000 的输出预留不会吃掉窗口，按 1048576 声明是安全的。
- **新的 11128 指纹：这条必须标 `deep`**。国内网关还会按内容指纹拦 harness 的**路径解析段落**（`Tokens prefixed with @ … Relative paths resolve from the workspace root;`），它不含任何产品名，所以 `DeepSeek Harness → DSH` 那条兜底碰不到它。逐句二分：两句**单独**发都放行，只有**紧邻**才被拦。作用域实测与上面那条产品名的规则**不同**——system 与 assistant（**句中同样拦**，不只是行首）会被拦，而 **tool 结果不拦**；非 `deep` 只改写 assistant 行首，句中漏网就等于「模型转述一次，后续每一轮都被拒」，所以这一行标成 `deep`。user 消息照旧不碰（实测多处提及均放行）。

**2026-11-08 补记：`11140` 是账号限制，不是会话失效——这个误判从 10-24 拖到今天**（该码首次出现在 2026-10-24 15:46 的 `workbuddy-global` 请求上，当时被读成会话失效）。国际版账号 `szn2685959182@gmail.com` 的所有模型（`hy4free` / `deepseek-v4.1-flash-sg` / `gpt-6-astra`）统一回 **403 / `11140`**「账号存在异常行为，已被限制使用」，面板显示「桌面 App 换过会话了，点『从桌面 App 导入』重新接入」，于是用户反复重新导入、重新登录，全部无效。三次对照实测确认根因不在凭据：

- **刷新接口正常**：`/v2/plugin/auth/token/refresh` → 200，当场签发新 accessToken（1409 字符）。凭据链本身是通的。
- **新令牌同样被拒**：用刚刷出来的令牌发 chat → **403 / 11140**，与存盘旧令牌一字不差。所以不是过期、不是轮换、不是本地副本陈旧。
- **官方桌面版同样被拒**：同一个账号在 WorkBuddy 官方 App（v5.8.4）里直接回「账号存在异常行为，已被限制使用 / 11140」。**这是账号级的限制，反代的形状无关**——换客户端、换请求头都绕不过去。

旧代码的问题在分类器的兜底：`classifyUpstreamError()` 把「403 且不含额度/限流关键词」一律归为 `session_dead`，而 `11140` 既不在业务码表里，也没有任何文本标记能命中，于是落进这条兜底，被当成「令牌被轮换掉了」。修复有三处：

1. **新增 `account_restricted` 类**（`lib/upstream.js`）：业务码 `11140` 和文本标记（`account has been restricted` / `账号存在异常行为` / 繁体两种写法）都归到它；**排在 403 兜底之前**判定，所以同一含义换个 HTTP 状态也照样识别。`describeAccountRestriction()` 把网关自己的中文 `displayMsg` + `displayTips`（申诉指引）原样取出，因为这句话才是用户能对上号的。
2. **Shim 用 409 而不是 401/403**（`lib/shim.js`）：宿主适配器的 `classifyPiAiError()` 只要在消息里看到裸的 `401`/`403` 就改写为 `AUTH`，界面上就变成「API 密钥无效」——正好是要避免的误诊。因此这一类的响应体连状态码字样都不带，文案直接说明「限制未解除前任何模型都不会应答，只有申诉能解」。
3. **卡片提示分开**（`client.js` / `lib/index.js`）：`sessionStale` 与 `accountRestricted` 是两个独立标记，受限时只显示后者，不再劝用户「重新导入」。顺带修掉一个真实存在的坑：`import-desktop` 与登录成功**都不清 stale 标记**，标记只在上游成功接受一次请求后才清——所以账号被限时，用户照提示导入完，红条依然挂着。现在换凭据即清 stale（限制标记保留：它属于账号，不属于凭据）。

回归：`test/smoke.mjs` 92 → 98 项，覆盖 11140 识别、跨状态码识别、中文取自网关、裸文本识别、以及「没有限制标记的 403 仍然算会话失效」（这条保证轮换提示不被误伤）。

国际版另有一类与体积无关的拒绝：`kimi-k3.1-pro` / `kimi-k3.1-pro-highspeed` 回 **11158**（`not allowed for user type [personal]`），是账号类型授权，声明窗口改不动它。

**渠道身份会自己过期**：客户端身份里的版本号来自本机桌面版，而桌面版会自己升级（实测当晚 5.7.6 → 5.8.4、CLI 2.156.0 → 2.161.0）。所以身份每 10 分钟重新解析一次，而不是进程启动时定死——否则 App 升了级，宿主还在拿旧版本号冒充客户端。

## 开发

```sh
node test/smoke.mjs     # 纯逻辑的回归用例（目录解析、请求改写、额度归一、错误分类、加密信封）
```

插件本身是**纯 ESM JavaScript，无构建步骤**。

**开发时把依赖写成 `link:` 而不是 `file:`**：

```json
"dsh-workbuddy-connect": "link:/绝对路径/接入workbuddy"
```

`file:` 走的是「把文件硬链接进 `node_modules`」——编辑器替换文件会换 inode，硬链接随之断开，改动不会生效；`link:` 是一条真符号链接，改完刷新页面即可。两种写法安装出来的包都能用，区别只在这条。

bundle 层（`package.json` / `cordis.patch.yml`）的改动需要重启 DSH：插件是启动时按 `dsh.profile.bundles` 装载的，热重载只覆盖 client 侧的模块。

## 出处与许可

上游行为来自对真实部署的实测，以及这几个开源实现的交叉验证：

- [masknull/dsh-workbuddy-connect](https://github.com/masknull/dsh-workbuddy-connect)（MIT）——国内版 / 国际版双变体的连接器骨架
- [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT）——模型身份与注册表键的处理
- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）——请求头的取值
- [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub)——上游请求形态与模型目录

本项目按 [MIT](./LICENSE) 许可发布。本仓库与 WorkBuddy、腾讯、DeepSeek 官方均无关联，是社区适配器——非官方实现。

## 免责声明

- WorkBuddy 的接口来自上游：上游随时可能改动、限流或封禁调用方，导致本插件部分或全部功能失效。
- 本工具仅供个人学习研究，用于驱动**使用者自己的** WorkBuddy 账号；请勿用于商业转售或任何超出个人合理使用的场景。使用即表示你自行承担账号被限制、额度损失、服务中断等一切后果，并遵守 WorkBuddy 的服务条款。
- 作者不对因使用或滥用本插件产生的任何直接或间接损失负责。文中出现的 WorkBuddy、DeepSeek 等名称与商标归各自权利人所有，仅作兼容性描述之用。
