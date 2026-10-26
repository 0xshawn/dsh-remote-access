# dsh-remote-access

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green)](./package.json)

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 Web UI 可以通过**非 localhost 地址**访问 —— 反向代理、SSH 隧道或局域网地址均可 —— 无需修改已安装的 dsh 源码。

[English](./README.md)

## 解决的问题

上游 `dsh web` 是为"浏览器在同一台机器"设计的。换用其它权威（authority）访问时有三处会失效：

| 问题 | 上游行为 | 本插件 |
|---|---|---|
| `/api` 的 Host/Origin 信任围栏 | 只接受 loopback、监听绑定的 IP 字面量和 `--trusted-host`；经代理的权威访问所有 RPC 返回 `403` | 把 `DSH_REMOTE_ACCESS_TRUSTED_HOSTS` 中的权威追加进同一列表（`--trusted-host` 继续有效） |
| 页面视图（`connection.isLoopback`） | 仅由 `location.hostname` 判定；经代理的页面被当作非回环，dsh 0.2.0 下设置只存在于进程内存（Models 页报 `settings are unavailable in this browser`），所有版本都会隐藏打开宿主机配置文件的操作 | 注入 `__DSH_TRANSPORT__ = { ownsHost: true }` —— dsh 桌面壳使用的宿主自有传输钩子 —— 已认证页面因此呈现回环视图 |
| 启动令牌 | 每个进程随机生成，重启后只能从服务日志里找登录 URL | 通过 `DSH_WEB_TOKEN`（或插件配置）固定令牌，重启后登录 URL 不变 |

认证机制不变：浏览器仍需用启动令牌换取与权威绑定的签名会话 Cookie，每次 `/api` 请求仍先经过 Host/Origin 围栏。本插件只消除部署摩擦，不新增也不绕过访问控制。

## 安装

```sh
# 从 GitHub 安装（公开仓库，无需构建）
dsh plugin --profile web add git+https://github.com/0xshawn/dsh-remote-access.git

# 或从本地源码安装
dsh plugin --profile web add /path/to/dsh-remote-access
```

之后重启 `dsh web`（dsh 在启动时加载 bundle）。确认插件行已生效：

```sh
dsh --profile web --dump-config | grep -A6 'dsh-remote-access'
```

卸载：`dsh plugin --profile web remove dsh-remote-access`，下次重启即恢复上游默认行为。

### 从源码 patch 迁移

如果现有部署是通过 patch 已安装的 dsh bundle 实现（固定启动令牌 + 强制回环判定），迁移步骤：

1. 安装脚本里不再执行 patch；`npm install -g @deepseek-ai/dsh@<version>` 之后不需要补 patch 步骤。
2. 按上面的方式把本 bundle 装进 `web` profile，重启 `dsh web`。
3. 保留部署原有的 `DSH_WEB_TOKEN`（变量名相同，直接沿用）；`--trusted-host` 可继续使用，也可改配 `DSH_REMOTE_ACCESS_TRUSTED_HOSTS`。
4. 确认启动日志仍打印固定令牌：`dsh web: ...?token=<同一个令牌>`。

## 配置

### 环境变量

| 变量 | 取值 | 作用 |
|---|---|---|
| `DSH_REMOTE_ACCESS_TRUSTED_HOSTS` | 逗号分隔的裸权威，如 `dsh.example.com,dsh.example.com:8443` | 追加到 `--trusted-host`；不带端口的条目匹配任意端口 |
| `DSH_WEB_TOKEN` | 非空启动令牌 | 固定登录令牌；为空或未设置时保持上游的每进程随机令牌 |

两者都可以放在 systemd 的 `Environment=`/`EnvironmentFile=`、launchd 的 `EnvironmentVariables`、Docker 环境变量或 shell profile 中。习惯命令行参数时继续用 `--trusted-host` 即可，patch 层做的是拼接而非替换：

```sh
DSH_WEB_TOKEN="$(cat /etc/dsh/web-token)" \
DSH_REMOTE_ACCESS_TRUSTED_HOSTS="dsh.example.com" \
dsh web --host 127.0.0.1 --port 3080 --no-open
```

非法权威（带 scheme、路径、userinfo 或补零端口）会在启动时以上游的校验错误中止，而不是被静默忽略。

### 插件配置

需要按 profile 覆盖时，编辑 `$DSH_HOME/profiles/web/cordis.patch.yml` 中的 `dsh-remote-access` 行：

```yaml
- id: dsh-remote-access
  config:
    # false 表示保持上游按权威判定的页面视图。
    loopback: true
    # 固定令牌；留空则回退到 DSH_WEB_TOKEN，再回退到随机令牌。
    # 推荐使用 DSH_WEB_TOKEN：profile 配置以明文保存。
    launchToken: ''
```

### 反向代理

`--public-url https://dsh.example.com/` 负责对外公布浏览器使用的地址（打印的 URL、`DSH_WEB_URL`、运行时上下文），本插件不改变这一点。代理仍需：

- 原样保留浏览器侧的 `Host`（围栏逐字比较）；
- 转发前剥掉挂载前缀；
- 带上 `Upgrade`/`Connection` 转发 WebSocket 升级；
- 把 Cookie 的 `Path` 重写到挂载点，并在 HTTPS 侧补 `Secure`。

完整清单见上游文档 [Publish the Web UI behind a reverse proxy](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/guide/public-deployments.md)。TLS 终结、网络隔离、谁能访问监听端口，仍由运维方负责。

## 工作原理

本包是一个 dsh **bundle**：`cordis.patch.yml` 是叠加在 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 之上的 patch 层，用到两个扩展点。

1. **信任权威 —— patch 层。** 在 `connection` 行的 `trustedHosts` 上把环境变量列表拼接到命令行列表之后。表达式读取 0.2.1 的 `ctx.get('webStartup')` 或 0.2.0 的 `ctx.get('webRuntime')`，一份 patch 覆盖两种布局。Host/Origin 围栏与 `allowsRemoteAuthorities` 判定都交回上游实现。
2. **回环视图 —— index 注入。** 宿主插件监听 `webserver/index-inject`，向返回的 index 注入一段内联经典脚本：

   ```js
   if (globalThis.__DSH_TRANSPORT__ === void 0) globalThis.__DSH_TRANSPORT__ = { ownsHost: true };
   ```

   `ClientTransportHooks.ownsHost` 是上游"本页面拥有 Host"的公开标志；`dsh-client-connection` 据此报告回环视图，但页面仍使用正常的 HTTP + WebSocket 传输。守卫语句不会覆盖真实 shell 提供的 transport，脚本在 shell 入口和全部客户端插件之前执行。
3. **启动令牌 —— 服务字段。** 插件等待 `ctx.connection` 就绪，在 Loader 结算前设置 `connection.browserAuth.launchToken`，打印的认证 URL 与令牌校验因此统一使用固定值。若未来 dsh 隐藏该字段，插件会显式报错，而不是悄悄退回随机 URL。

## 安全说明

- **启动令牌就是凭据。** 持有打印出来的 `?token=` URL 即可换取会话 Cookie 并获得完整 owner 权限。请谨慎分发；固定令牌是长期凭据，绝不能提交到仓库。修改 `DSH_WEB_TOKEN` 并重启只会让旧 URL 失效，**不会**吊销已经签发的 Cookie（默认有效期 `cookieMaxAgeDays` 为 30 天）；要真正吊销，请清除该站点的 Cookie，或删除 browser-session 凭据记录后重启。
- **信任权威不等于认证。** 它只让该权威通过 Host/Origin 围栏；签名会话 Cookie 仍把守每个 RPC。不要把监听端口暴露到不受信任的网络；需要时用 TLS 和自控代理。
- **回环视图是权限决定。** dsh 0.2.0 下它让已认证远程浏览器的设置改为写入宿主机；所有版本下它会暴露仅限本机的界面操作，例如 **Open configuration file** 会在**宿主机**的编辑器里打开设置文件。远程浏览器本来就持有 owner 凭据；希望保持上游最小权限视图的运维方可以设置 `loopback: false`。
- **纯 HTTP 会泄露令牌。** 在代理侧或通过 `--tls-cert/--tls-key` 终结 TLS；Cookie 的 `Secure` 行为见上游文档。

## 兼容性

- 已在 dsh `0.2.1-rc.2`、`0.2.1-rc.3` 与 `0.2.0-rc.2` 的 Web profile 上验证。
- 声明范围：`engines.dsh >=0.2.0-0 <0.3.0`。dsh 0.1.x 不受支持，也未测试。
- 插件行仅适用于 Web profile；headless/SDK profile 没有 `connection` 服务，会拒绝该行。
- `npm install -g @deepseek-ai/dsh@<version>` 升级 dsh 不会改动 profile，插件继续可用；升级后重启 `dsh web` 即加载新版本。
- 固定令牌依赖 `connection.browserAuth.launchToken` 字段。若 dsh 改变该结构，配置了令牌时插件会在启动阶段报错；取消令牌配置或升级插件即可。

## 开发

```sh
npm install
npm test        # node:test：配置、令牌解析、index 注入的单元测试
```

隔离 home 的端到端验证（不影响真实 profile）：

```sh
export DSH_HOME=$(mktemp -d)
dsh plugin --profile web add "$PWD"
DSH_WEB_TOKEN=dev-token DSH_REMOTE_ACCESS_TRUSTED_HOSTS=dsh.test \
  dsh --profile web --host 127.0.0.1 --port 3199 --no-open
# 再通过你的代理打开 http://<非 localhost 地址>:3199/?token=dev-token
```

## 许可证

[MIT](./LICENSE) © 2026 shawn
