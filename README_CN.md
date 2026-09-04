# ClashTUNWithDSH

[English](README.md) | 中文

一个 DSH（DeepSeek Harness）插件：**通过解除 `resolves to a non-public IP address` 的限制，使 DSH 可以在 Clash TUN 的情况下工作**。

## 许可证

本项目以 [GNU AGPL-3.0-or-later](./LICENSE) 发布：你可以自由使用、修改和再分发；再分发（包括作为服务提供）时须以相同许可证开放源码。详见仓库根目录的 `LICENSE` 文件。

## 这是什么

DSH 内置的 `web_fetch` 网页抓取工具带有一层 SSRF 防护：抓取前会把域名解析成 IP，只要解析结果中存在**非公网 IP**（回环、私网、保留网段等），就直接报错拒绝请求：

```
URL hostname "example.com" resolves to a non-public IP address   (WEB_BLOCKED_URL)
```

而在 **Clash TUN（fake-ip 模式）** 下，系统 DNS 会被 Clash 接管：任何域名都会解析成 `198.18.0.0/15`（或 `fdfe:dcba:9876::/48`）这类 **fake-ip 保留网段地址**，真实连接由 TUN 虚拟网卡截获后转交给 Clash 按规则代理。这套机制对普通应用完全透明，却恰好命中 DSH 的"非公网 IP"拦截——导致开启 Clash TUN 后 `web_fetch` 几乎所有请求都被拒。

本插件移除这一限制：**解析到什么 IP 都允许访问**，连接仍然直接发起，由 TUN 网卡按原样接管，从而使 DSH 在 Clash TUN 环境下正常工作。

## 工作原理

DSH 的网页抓取链路为：`web_fetch` 工具 → `ctx.web`（WebRuntime 服务）→ 本地 HTTP fetch provider（`web-fetch-http`，id 为 `http`）。IP 校验只发生在 provider 实例的 `resolveAddresses` 方法（DNS 解析后逐一检查是否公网 unicast）。

本插件（Cordis 动态插件，Host 侧）在运行期对该方法做**就地替换**：

1. **公网目的地零改动**：先照常调用原始解析逻辑，解析结果全为公网 IP 时行为与原版完全一致（含 NAT64 检查、地址钉扎、重定向、大小/超时上限）。
2. **仅拦截"非公网"这一种情况**：当且仅当原始逻辑抛出 `WEB_BLOCKED_URL` 且消息含 `non-public` 时，通过 DSH 的 `subprocess` 服务拉起一个一次性 Node 子进程，用 `dns.lookup(..., { all: true, order: 'verbatim' })` 走**系统解析器**重新解析（在 Clash TUN 下即得到 fake-ip），**将返回的全部地址放行**，交给原有的地址钉扎传输层直接连接——TUN 按原样截获并交给 Clash 代理。
3. IP 字面量（如 `127.0.0.1`、`[::1]`）同样放行；解析结果带 60 秒进程内缓存，避免重复拉起子进程。
4. **停止/更新插件时自动恢复原始方法**，不留任何残留副作用。

不修改 DSH 源码、不改部署配置、不注册第二个 provider（因此不影响 provider 选择策略），补丁随插件生命周期生效与撤销。

## 一键安装

仓库提供 `install.ps1`（Windows PowerShell）与 `install.sh`（macOS/Linux/Git Bash），一条命令完成安装：

```powershell
# Windows（PowerShell 5.1+）
.\install.ps1              # 安装
.\install.ps1 -Uninstall   # 卸载
```

```bash
# macOS / Linux / Git Bash
./install.sh               # 安装
./install.sh uninstall     # 卸载
```

**安装内容**（写入 `$DSH_HOME`，即 `$env:DSH_HOME` 或 `~/.dsh`）：

| 文件 | 说明 |
| --- | --- |
| `clash-tun-web-fetch-unlock.cjs` | 宿主平面插件模块（`payload/` 内同一文件的副本） |
| `cordis.patch.yml` | DSH 官方家目录用户补丁层；脚本以标记块（`# >>> classtunwithdsh`）幂等追加一行 `insert`，把插件挂载进宿主组合 |

**特点**：

- **对所有 profile 的所有会话生效**（宿主平面挂载），无需改动任何预设或 DSH 源码；
- 若当前 profile 开启了补丁热重载（live），**保存即生效，无需重启 DSH**；否则 DSH 下次启动生效；
- 幂等：重复运行安全；卸载按标记块精确移除，不触碰文件中的其他内容；
- 脚本自带卸载入口，随时恢复 DSH 原始行为。

## 使用方法（会话内动态插件，可选）

除一键安装外，也可以在会话内把 [`clash-tun-web-fetch-unlock.host.js`](./clash-tun-web-fetch-unlock.host.js) 的函数体作为 `cordis_define` 的 `code.host` 定义动态插件（`idPrefix: "clash"`），再 `cordis_run` 激活——效果相同，但仅存活于当前 DSH 进程，重启后需重新加载。两种方式择一即可；同时启用时互不冲突（补丁带引用计数与恢复保护）。

## 验证

安装前后各执行一次（DSH Web GUI 默认监听 `127.0.0.1:3080`）：

| 请求 | 安装前 | 安装后 |
| --- | --- | --- |
| `web_fetch http://127.0.0.1:3080/` | `URL hostname "127.0.0.1" resolves to a non-public IP address` | HTTP 401（GUI 认证响应，连接真实发生） |
| `web_fetch http://localhost:3080/` | 同上被拦 | HTTP 401 |
| `web_fetch https://example.com/` | HTTP 200 | HTTP 200（公网路径无回归） |

## 注意事项

- **这层校验本是 SSRF 防护**。解除后，`web_fetch` 可以访问本机与内网地址。请仅在个人设备、Clash TUN 等可信网络环境下使用，不要让不可信的模型指令引导抓取内网敏感服务。
- 解除的**只有 IP 解析校验**：URL 协议白名单、凭据拒绝、重定向限制、字节/字符/超时上限、地址钉扎等传输卫生策略全部保留。
- 一键安装随 DSH 进程常驻（宿主平面），重启后依旧生效；卸载脚本或补丁行后，重启 DSH（或保存触发热重载）即恢复原行为。
- 日志中每次放行会输出 `[clash-tun-web] allowed non-public destination: <host> -> <ip,...>`，便于观察。

## 仓库内容

| 文件 | 说明 |
| --- | --- |
| `README.md` | 英文说明（默认） |
| `README_CN.md` | 本说明（中文） |
| `LICENSE` | GNU AGPL-3.0 许可证全文 |
| `install.ps1` / `install.sh` | 一键安装 / 卸载（Windows PowerShell / POSIX shell） |
| `payload/clash-tun-web-fetch-unlock.cjs` | 安装载荷：宿主平面插件模块（CJS，`module.exports = { apply }`） |
| `clash-tun-web-fetch-unlock.host.js` | 会话内动态插件源码（`cordis_define` 的 `code.host` 函数体，与载荷同一逻辑） |
