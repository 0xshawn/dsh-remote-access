# dsh-remote-access

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green)](./package.json)

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 Web UI 可以通过**非 localhost 地址**访问 —— 反向代理、SSH 隧道或局域网地址均可 —— 无需修改已安装的 dsh 源码。

[English](./README.md)

## 解决的问题

上游 `dsh web` 是为"浏览器在同一台机器"设计的。换用其它权威（authority）访问时有四处缺失或失效：

| 问题 | 上游行为 | 本插件 |
|---|---|---|
| `/api` 的 Host/Origin 信任围栏 | 只接受 loopback、监听绑定的 IP 字面量和 `--trusted-host`；经代理的权威访问所有 RPC 返回 `403` | 把 `DSH_REMOTE_ACCESS_TRUSTED_HOSTS` 中的权威追加进同一列表（`--trusted-host` 继续有效） |
| 页面视图（`connection.isLoopback`） | 仅由 `location.hostname` 判定；经代理的页面被当作非回环，dsh 0.2.0 下设置只存在于进程内存（Models 页报 `settings are unavailable in this browser`），所有版本都会隐藏打开宿主机配置文件的操作 | 注入 `__DSH_TRANSPORT__ = { ownsHost: true }` —— dsh 桌面壳使用的宿主自有传输钩子 —— 已认证页面因此呈现回环视图 |
| 启动令牌 | 每个进程随机生成，重启后只能从服务日志里找登录 URL | 通过 `DSH_WEB_TOKEN`（或插件配置）固定令牌，重启后登录 URL 不变 |
| 首次登录 | 直接打开裸地址返回纯文本 `401`，必须使用打印出来的 `?token=` URL | 裸地址上提供 HTML 令牌输入框（`loginPage`，默认开启），提交后仍走上游的令牌交换 |
| 后台提醒 | 标签页在后台时，任务完成或等待批准/回答都不可见 | 用浏览器通知提醒任务完成和待处理输入（`notifications`，默认开启） |

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

两者都可以放在 systemd 的 `Environment=`/`EnvironmentFile=`、launchd 的 `EnvironmentVariables`、Docker 环境变量或 shell profile 中。习惯命令行参数时继续用 `--trusted-host` 即可；表达式会把这些环境权威追加到命令行列表之后。注意 patch 层会整体替换 `connection.config`：若另一个层（或更靠后的 profile patch）覆盖了 `connection`，需要在那里重新写上 `trustedHosts`（否则环境权威会丢失），并补齐仍需保留的键，例如 `cookieMaxAgeDays`、`recovery`。

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
    # 未带令牌或 Cookie 直接打开裸地址时，显示令牌输入框。
    # 设为 false 可恢复上游的纯文本 401。
    loginPage: true
    # 启用浏览器通知的客户端半边。
    notifications: true
```

### 首次登录：不用带 token 的 URL

未认证的浏览器直接打开裸部署地址时，会看到一个简单的登录表单，而不是纯文本 `401`。表单把令牌提交回相对的 index 路径（`GET ./?token=...`），因此上游的令牌交换、签名 Cookie、反代挂载前缀和跳转到干净 URL 的逻辑全部照旧。令牌错误时表单重新显示并给出错误提示；令牌正确则完成登录。

只有请求权威已经通过部署的 Host/Origin 围栏（loopback、监听绑定字面量，或 `DSH_REMOTE_ACCESS_TRUSTED_HOSTS`/`--trusted-host` 中的权威）时才会返回表单；不受信任的权威仍得到纯文本 `401`，因此 DNS rebinding 或外部主机无法借此收集令牌。令牌仍然出现在查询串里（与打印的 URL 相同），也仍然是唯一凭据；表单没有引入第二套密码存储，也没有绕过认证。若前置代理已有自己的登录页，可设 `loginPage: false` 恢复上游 `401`。

### 反向代理

`--public-url https://dsh.example.com/` 负责对外公布浏览器使用的地址（打印的 URL、`DSH_WEB_URL`、运行时上下文），本插件不改变这一点。代理仍需：

- 原样保留浏览器侧的 `Host`（围栏逐字比较）；
- 转发前剥掉挂载前缀；
- 带上 `Upgrade`/`Connection` 转发 WebSocket 升级；
- 把 Cookie 的 `Path` 重写到挂载点，并在 HTTPS 侧补 `Secure`。

完整清单见上游文档 [Publish the Web UI behind a reverse proxy](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/guide/public-deployments.md)。TLS 终结、网络隔离、谁能访问监听端口，仍由运维方负责。

### 浏览器通知

bundle 还带一个手写、无需构建的浏览器客户端：监听 Session 状态源，在以下情况发浏览器通知：

- 顶层会话从运行中变为空闲 —— `任务完成：<标题>`；
- 会话开始等待批准、计划确认或回答 —— `需要批准` / `需要确认计划` / `需要你的输入`。

只有页面不可见或窗口失去焦点时才通知，且必须先获得浏览器的通知权限。页面会在第一次点击/按键时请求一次权限（按来源授权）。点击通知会把 dsh 窗口切到前台。子代理会话和已移除会话会被跳过。插件配置 `notifications: false` 可关闭客户端半边。

限制：这里用的是页面级 Web Notification，不是 Web Push。dsh 页面必须保持打开（可以切到后台）；浏览器完全关闭后不会收到通知。通知权限需要安全上下文，因此使用 HTTPS 或 loopback，局域网纯 HTTP 不行。通知正文包含会话标题，锁屏预览可能暴露它。

## 工作原理

本包是一个 dsh **bundle**：`cordis.patch.yml` 是叠加在 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 之上的 patch 层，用到以下扩展点。

1. **信任权威 —— patch 层。** 在 `connection` 行的 `trustedHosts` 上把环境变量列表拼接到命令行列表之后。表达式优先读取 0.2.0 的 `ctx.get('webRuntime')`（其中已包含通配绑定推导出的 LAN 字面量与命令行附加项），再回退到 0.2.1 的 `ctx.get('webStartup')`；0.2.0 同时提供这两个服务，因此必须优先 runtime，否则会丢掉通配绑定的 LAN 权威。一份 patch 覆盖两种布局。Host/Origin 围栏与 `allowsRemoteAuthorities` 判定都交回上游实现。
2. **回环视图 —— index 注入。** 宿主插件监听 `webserver/index-inject`，向返回的 index 注入一段内联经典脚本：

   ```js
   if (globalThis.__DSH_TRANSPORT__ === void 0) globalThis.__DSH_TRANSPORT__ = { ownsHost: true };
   ```

   `ClientTransportHooks.ownsHost` 是上游"本页面拥有 Host"的标志，但文档将其保留给自行组装 transport 的 shell，并声明服务端返回的页面从不携带该全局变量。本 bundle 有意设置它来获得 owner 视图：`dsh-client-connection` 据此报告回环视图，但页面仍使用正常的 HTTP + WebSocket 传输。守卫语句不会覆盖真实 shell 提供的 transport，脚本在 shell 入口和全部客户端插件之前执行。
3. **启动令牌 —— 服务字段。** 插件等待 `ctx.connection` 就绪，在 Loader 结算前设置 `connection.browserAuth.launchToken`，打印的认证 URL 与令牌校验因此统一使用固定值。若未来 dsh 隐藏该字段，插件会显式报错，而不是悄悄退回随机 URL。
4. **登录表单 —— index 授权。** 插件包装 `connection.authorizeIndex`：`dsh-host-frontend-static` 在返回 index 前调用它。来自受信任权威、未认证的 GET index 请求得到令牌表单（内容为 HTML 的 `401`）；已认证、携带有效令牌、来自不受信任权威或非 GET 的请求都交回上游实现。插件卸载时恢复原方法。若未来 dsh 移除该方法，表单会静默禁用，裸地址恢复上游纯文本 `401`，其余功能不受影响。


5. **通知 —— 客户端插件。** `package.json` 声明 `dsh.client`（`platform: web`）并导出 `./client`；`dsh-client-modules` 把浏览器 bundle 发给页面。客户端通过 `sessions` 与 `uiSession` 服务订阅 `ctx.uiSession.sessionStatus`，在本地发 Web Notification；宿主侧只注入 `config.notifications` 对应的 `__DSH_REMOTE_ACCESS_NOTIFY__` 开关。
## 安全说明

- **启动令牌就是凭据。** 持有打印出来的 `?token=` URL 即可换取会话 Cookie 并获得完整 owner 权限。请谨慎分发；固定令牌是长期凭据，绝不能提交到仓库。修改 `DSH_WEB_TOKEN` 并重启只会让旧 URL 失效，**不会**吊销已经签发的 Cookie（默认有效期 `cookieMaxAgeDays` 为 30 天）；要真正吊销，请清除该站点的 Cookie，或删除 browser-session 凭据记录后重启。
- **信任权威不等于认证。** 它只让该权威通过 Host/Origin 围栏；签名会话 Cookie 仍把守每个 RPC。不要把监听端口暴露到不受信任的网络；需要时用 TLS 和自控代理。
- **回环视图是权限决定。** dsh 0.2.0 下它让已认证远程浏览器的设置改为写入宿主机；所有版本下它会暴露仅限本机的界面操作，例如 **Open configuration file** 会在**宿主机**的编辑器里打开设置文件。远程浏览器本来就持有 owner 凭据；希望保持上游最小权限视图的运维方可以设置 `loopback: false`。
- **回环视图超出了文档化的客户端契约。** 上游把 `ownsHost` 保留给自行组装 transport 的 shell，并声明服务端返回的页面从不携带该全局变量；本 bundle 有意设置它。当前 dsh 的所有消费方都只把它用于 `isLoopback`，但未来或第三方客户端插件可能把它当作宿主所有权的证明。设置 `loopback: false` 可消除该暴露面。
- **纯 HTTP 会泄露令牌。** 在代理侧或通过 `--tls-cert/--tls-key` 终结 TLS；Cookie 的 `Secure` 行为见上游文档。
- **通知会在系统通知/锁屏上显示会话标题。** 权限按浏览器来源授予；对共享屏幕或锁屏环境敏感时可用 `notifications: false` 关闭。
- **登录表单不做限流。** 它只是把同一个高熵启动令牌的输入入口暴露出来；对公网端点仍建议在代理层做限流。Host/Origin 围栏拒绝的权威永远不会看到表单。
- **不要新增会拦截内联脚本的 CSP。** 回环视图行是一段内联经典脚本；dsh 自身的启动全局变量已经要求内联脚本权限，但代理注入的不含 `'unsafe-inline'`（或未用 nonce 覆盖）的 CSP 会静默拦截该脚本，而页面仍能加载。

## 兼容性

- 已在 dsh `0.2.1-rc.2`、`0.2.1-rc.3` 与 `0.2.0-rc.2` 的 Web profile 上验证。
- 声明范围：`engines.dsh >=0.2.0-0 <0.3.0-0`。dsh 0.1.x 不受支持，也未测试。
- dsh 0.2.0 中 profile 级通配绑定（`webserver.host: 0.0.0.0`）会推导出 LAN 权威；本 patch 会保留它们，因此打印出的 LAN URL 无需额外 trusted-host 即可使用。
- 插件行仅适用于 Web profile；没有 `connection` 服务的 profile 中该行保持 inactive，安装也不会生效。
- `npm install -g @deepseek-ai/dsh@<version>` 升级 dsh 不会改动 profile，插件继续可用；升级后重启 `dsh web` 即加载新版本。
- 固定令牌依赖 `connection.browserAuth.launchToken` 字段。若 dsh 改变该结构，配置了令牌时插件会在启动阶段报错；取消令牌配置或升级插件即可。
- 登录表单包装 `connection.authorizeIndex` 并读取 `browserAuth.isAuthenticated`。若未来 dsh 移除二者，表单会被跳过，裸地址恢复上游纯文本 `401`，插件其余功能继续工作。
- 浏览器通知依赖客户端模块系统、`ctx.uiSession.sessionStatus` 与 `ctx.sessions`；若未来 dsh 移除其中任一项，客户端半边会静默失效，宿主半边继续工作。通知要求页面保持打开，没有 service worker 或 push 订阅。
- 固定动作只在启动时执行一次。宿主插件热重载（HMR）可能用 dsh 缓存的每进程令牌重建 Connection 服务，且不会重新打印启动 URL；更换令牌或升级 dsh 后请重启 `dsh web`。

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
