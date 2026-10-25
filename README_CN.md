# ClashTUNWithDSH

[English](README.md) | 中文

一个 DSH（DeepSeek Harness）**bundle 插件**：**通过解除 `resolves to a non-public IP address` 的限制，使 DSH 可以在 Clash TUN 的情况下工作**。

## 许可证

本项目以 [GNU AGPL-3.0-or-later](./LICENSE) 发布：你可以自由使用、修改和再分发；再分发（包括作为服务提供）时须以相同许可证开放源码。详见仓库根目录的 `LICENSE` 文件。

## 这是什么

DSH 内置的 `web_fetch` 网页抓取工具带有一层 SSRF 防护：抓取前会把域名解析成 IP，只要解析结果中存在**非公网 IP**（回环、私网、保留网段等），就直接报错拒绝请求：

```
URL hostname "example.com" resolves to a non-public IP address   (WEB_BLOCKED_URL)
```

而在 **Clash TUN（fake-ip 模式）** 下，系统 DNS 会被 Clash 接管：任何域名都会解析成 `198.18.0.0/15`（或 `fdfe:dcba:9876::/48`）这类 **fake-ip 保留网段地址**，真实连接由 TUN 虚拟网卡截获后转交给 Clash 按规则代理。这套机制对普通应用完全透明，却恰好命中 DSH 的“非公网 IP”拦截——导致开启 Clash TUN 后 `web_fetch` 几乎所有请求都被拒。

本插件移除这一限制：**解析到什么 IP 都允许访问**，连接仍然直接发起，由 TUN 网卡按原样接管，从而使 DSH 在 Clash TUN 环境下正常工作。

## 作为 DSH 插件安装

本仓库**就是**一个 DSH bundle 包：`package.json` 声明 `dsh.bundle.patch`，[`cordis.patch.yml`](./cordis.patch.yml) 负责插入宿主插件行。下面三种官方安装方式都可以直接从本仓库或 npm 拉取，无需手工复制文件、也无需手改补丁文件。

### 包信息

| 项 | 值 |
| --- | --- |
| 包名 | `clash-tun-with-dsh` |
| bundle 补丁 | `cordis.patch.yml` → 行 `clash-tun-web-fetch-unlock` |
| 宿主入口 | [`index.js`](./index.js)（ESM，零依赖） |
| 展示元数据 | `locale/en.json`、`locale/zh.json`、`icon.svg` |
| 插件行 id | `clash-tun-web-fetch-unlock` |

`engines.dsh` 为 `>=0.2.0 <1.0.0`；DSH 在不兼容的运行时上会拒绝安装/启用该 bundle，除非显式授予版本豁免。

### 1. Web 界面（插件页）——推荐

把本仓库的市场索引加为「发现（Discover）」来源，然后在发现页直接安装：

```text
https://raw.githubusercontent.com/ffdnm/ClashTUNWithDSH/main/market.json
```

或者跳过索引，直接在插件页的安装/URL 输入框里填包 spec（DSH 会交给 `plugin_manager`）：

```text
git+https://github.com/ffdnm/ClashTUNWithDSH.git
```

安装后本 bundle 会加入 `dsh.profile.bundles` 并挂载其插件行：开启 HMR（补丁热重载）时立即生效，否则下次启动 DSH 生效。

### 2. Agent 工具 `plugin_manager`

在启用 `plugin_manager` 的会话（Creator 预设默认启用）中：

```jsonc
// install_bundle
{ "action": "install_bundle", "target": "git+https://github.com/ffdnm/ClashTUNWithDSH.git" }
```

```jsonc
// 安装后可查看结果
{ "action": "list_bundles" }
```

若返回 `restart-required`，说明当前 profile 未开启 HMR，重启 DSH 后生效。

### 3. 命令行

```bash
# Git（可用 #<ref> 固定到某个 commit 或 tag）
dsh plugin --profile web add git+https://github.com/ffdnm/ClashTUNWithDSH.git

# 发布到 npm 之后
dsh plugin --profile web add clash-tun-with-dsh
```

`--profile <名字>` 指定要改的 profile（Electron 桌面版是 `desktop`，`dsh --profile web` 是 `web`）。安装后的 bundle 会被追加到 `dsh.profile.bundles`，其补丁层在每次启动时参与组合。

### 卸载

Web 界面用 **插件 → 移除**，`plugin_manager` 用 `{ "action": "remove_bundle", "target": "clash-tun-with-dsh" }`，或：

```bash
dsh plugin --profile web remove clash-tun-with-dsh
```

补丁随插件一起撤销，原始解析方法自动恢复；重启 DSH（或让 HMR 重新组合）即回到原版行为。

### 4. 市场索引（仓库自带）

`market.json` 是一份 DSH 插件市场索引（format 1），把本包列出来并将 Git 来源固定到某个 commit；因此「发现」来源只需要上面那个 raw 文件 URL。它由脚本从仓库生成、不手写——在包含本次改动的 commit 之后运行脚本，保证被固定的 commit 里已经有插件文件：

```bash
node scripts/make-market-index.mjs           # 按当前 HEAD 重写 market.json
node scripts/make-market-index.mjs --check   # 仅校验
```

脚本读取 `origin` 远端，要求被固定的 commit 里已经包含插件文件；如果当前环境能解析到 `@deepseek-ai/dsh-plugin-market-index`，就用官方校验器验证产物，否则在本地做等价的结构校验。因此 `market.json` 是在“包含插件代码的那个 commit”之后才提交的；在它生成并推送之前，请直接用 Git spec 安装，而不是「发现」来源。生成的安装 spec 形如：

```text
git+https://github.com/ffdnm/ClashTUNWithDSH.git#<40 位 commit>
```

### 配置（可选）

所有字段均可选，且在 [`cordis.patch.yml`](./cordis.patch.yml) 中默认注释掉；按需取消注释即可：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `providerId` | `http` | 要打补丁的 fetch provider id；内置本地 HTTP provider 注册为 `http`。 |
| `cacheTtlMs` | `60000` | 放行结果的缓存时长；`0` 关闭缓存。 |
| `cacheMaxEntries` | `400` | 缓存条目上限，超过后整体清空。 |

## 工作原理

DSH 的网页抓取链路为：`web_fetch` 工具 → `ctx.web`（WebRuntime 服务）→ 本地 HTTP fetch provider（`web-fetch-http`，id 为 `http`）。IP 校验只发生在 provider 实例的 `resolveAddresses` 方法（DNS 解析后逐一检查是否公网 unicast）。

本插件在运行期对该方法做**就地替换**：

1. **公网目的地零改动**：先照常调用原始解析逻辑，解析结果全为公网 IP 时行为与原版完全一致（含 NAT64 检查、地址钉扎、重定向、大小/超时上限）。
2. **仅拦截“非公网”这一种情况**：当且仅当原始逻辑抛出 `WEB_BLOCKED_URL` 且消息含 `non-public` 时，改用**系统解析器**重新解析（`dns.lookup(..., { all: true, order: 'verbatim' })`，在 Clash TUN 下即得到 fake-ip），**将返回的全部地址放行**，交给原有的地址钉扎传输层直接连接——TUN 按原样截获并交给 Clash 代理。
3. IP 字面量（如 `127.0.0.1`、`[::1]`）同样放行；解析结果默认按 60 秒缓存在进程内。
4. **晚注册也覆盖**：插件同时包住 `web.registerFetchProvider`，因此在其之后挂载的 provider（或热重载后的新 provider 实例）一注册就被打上补丁。
5. **停止/更新插件时自动恢复原始方法**；带引用计数，多次挂载/重挂载互不干扰。

不修改 DSH 源码、不改部署配置、不注册第二个 provider（因此不影响 provider 选择策略），补丁随插件生命周期生效与撤销。

每次放行都会通过 Cordis logger 输出 `[clash-tun-web] allowed non-public destination: <host> -> <ip,...>`，可在 DSH 日志流中观察。

## 验证

安装前后各执行一次（DSH Web GUI 默认监听 `127.0.0.1:3080`）：

| 请求 | 安装前 | 安装后 |
| --- | --- | --- |
| `web_fetch http://127.0.0.1:3080/` | `URL hostname "127.0.0.1" resolves to a non-public IP address` | HTTP 401（GUI 认证响应，连接真实发生） |
| `web_fetch http://localhost:3080/` | 同上被拦 | HTTP 401 |
| `web_fetch https://example.com/` | HTTP 200 | HTTP 200（公网路径无回归） |

仓库还自带零依赖的单元测试：

```bash
node --test          # 用最小假 Cordis 上下文驱动 index.js
```

## 注意事项

- **这层校验本是 SSRF 防护**。解除后，`web_fetch` 可以访问本机与内网地址。请仅在个人设备、Clash TUN 等可信网络环境下使用，不要让不可信的模型指令引导抓取内网敏感服务。
- 解除的**只有 IP 解析校验**：URL 协议白名单、凭据拒绝、重定向限制、字节/字符/超时上限、地址钉扎等传输卫生策略全部保留。
- 插件挂在宿主平面，对所选 profile 的所有会话生效；其它 profile 需同样把该 bundle 加入。
- 在 DSH Windows 桌面版中，`desktop` profile 由应用自身管理，请用应用内的插件页安装，而不是命令行。

## 仓库内容

| 文件 | 说明 |
| --- | --- |
| `package.json` | bundle 清单：`dsh.bundle.patch`、`engines.dsh`、展示资源 |
| `cordis.patch.yml` | bundle 补丁层，插入 `clash-tun-web-fetch-unlock` 行 |
| `index.js` | 宿主插件本体（ESM，零依赖） |
| `locale/en.json`、`locale/zh.json` | 插件管理器 / 设置页的标题与描述 |
| `icon.svg` | 插件图标 |
| `test/index.test.js` | 零依赖单元测试（`node --test`） |
| `test/integration.test.js` | 真实运行时集成测试（`dsh-web`/`dsh-web-fetch-http`），解析不到时自动跳过 |
| `scripts/make-market-index.mjs` | 生成 `market.json`（插件市场索引 format 1） |
| `market.json` | 由脚本生成的插件市场索引（发布时一并提交） |
| `README.md` | 英文说明 |
| `README_CN.md` | 本说明（中文） |
| `LICENSE` | GNU AGPL-3.0 许可证全文 |
