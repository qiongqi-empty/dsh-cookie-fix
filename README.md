# dsh-cookie-fix

**DeepSeek Harness 桌面端专用：把随机的 `dsh-auth-*` 会话 cookie 限制在 3 条以内，避免随机端口累积到 Node.js 16 KiB 请求头上限后，启动时返回 `HTTP 431 Request Header Fields Too Large` / `desktop welcome: Web authentication failed`。**

这是一个 Host-only 的 DSH bundle（不依赖 pnpm 包、没有构建步骤、没有客户端资源），通过官方插件管理器安装和卸载。

---

## 安装（官方 Plugins 页面）

1. 打开 DeepSeek Harness 的 **插件 / Plugins** 页面。
2. 点 **添加插件**。
3. 粘贴（**不要带末尾斜杠**）：

   ```
   https://github.com/qiongqi-empty/dsh-cookie-fix
   ```

4. 点 **安装**。装完后列表里会出现 **Cookie 清理器 / Cookie Fix**（包名 `dsh-cookie-fix`），确认它是启用状态。
5. 如果页面提示需要重启才能加载新插件，重启一次 DeepSeek Harness 即可。

之后每次启动都会自动把旧的 `dsh-auth-*` cookie 清理到最多 3 条，不需要任何手动操作。

> 如果从 GitHub 安装超时，可在对话框里切换 **安装源 → 中国大陆镜像**，或改用下面的 CLI 方式。

### 命令行安装（等价）

```bash
dsh plugin --profile desktop add https://github.com/qiongqi-empty/dsh-cookie-fix
```

## 卸载

- **图形界面**：插件页面 → 已安装 → `dsh-cookie-fix` / Cookie 清理器 → 卸载（移除 bundle）。
- **命令行**：

  ```bash
  dsh plugin --profile desktop remove dsh-cookie-fix
  ```

卸载后插件的请求监听器随 plugin fiber 一起释放，桌面端恢复官方原样；已经剩下的少量 `dsh-auth-*` cookie 无害，会在 30 天内自然过期。

---

## 它做什么

桌面宿主每次启动都用新的随机回环端口，并写入一条名字含 `host:port` 哈希、有效期 30 天的 `dsh-auth-*` cookie。Cookie 只看主机、不看端口，所以它们会全部堆在 `127.0.0.1` 的同一个 jar 里。桌面端启动时的欢迎握手是：

```js
net.fetch(authenticatedUrl, { credentials: "include" })
```

这条请求会带上整个 cookie jar；累计约 70 次启动后，Cookie 请求头超过 Node 默认的 16 KiB 上限，服务器直接返回 431，桌面端就报错无法启动。

插件在 DSH Host 的 webserver 上挂一个请求监听器，只处理 `GET /`（每次启动的启动令牌交换）：

1. 解析请求中的 `dsh-auth-*`；
2. 保留「当前 authority 的 cookie（本次响应会重新签发）+ 最新 2 条旧 cookie」；
3. 在同一响应里追加 `Set-Cookie: dsh-auth-…=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`。

Electron 的 session fetch 和浏览器都会执行这些删除指令，于是每次启动后最多只剩 3 条，永远不会再顶到 16 KiB。新签发的 auth cookie 始终保持为第一个 `Set-Cookie`，不影响桌面端读取 cookie 的既有逻辑。

## 安全性与可逆性

- **不改 `app.asar`、不改端口、不加客户端脚本、不注册后台进程。**
- **不联网**，不读取、不上报 cookie 的值；只根据 cookie 名字和签名 payload 里的 `issuedAt` 排序，删除已发送的旧 cookie。
- 只在 `GET /` 且请求确实带有 3 条以上 `dsh-auth-*` 时才修改响应头；平时完全不改动任何响应。
- 删除 bundle 即恢复官方行为，其余插件和 profile 配置不受影响。
- 代码只有一个文件（`index.mjs`），可自行审计。

## 如果已经 431 到完全打不开

插件必须在应用能跑起来时才能安装。若当前已经卡在 431：

1. **完全退出** DeepSeek Harness（包括托盘图标）。
2. 删除 Chromium 的 cookie 数据库（Chromium 会重建；只重置本地网页 cookie，不影响 `~/.dsh` 里的账号凭据）：

   ```
   %APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies
   ```

3. 重新启动 DeepSeek Harness，按上面的步骤安装插件。

## 兼容性

- 在 DeepSeek Harness Desktop **0.2.1-rc.5**（nightly，Electron 44）上开发并验证。
- 不声明 `engines.dsh` 硬性版本限制，以便后续版本继续安装；插件只使用 `webServer` 服务和 Node 标准库，若未来 `webServer` 服务不存在，插件会安全地不生效，不会阻止 Harness 启动。
- 自测（不启动 DSH）：

  ```bash
  node test.mjs
  ```

  验证：10 条 cookie 时恰好追加 7 条删除、新 auth cookie 仍排第一、cookie 少时不改动响应、其它路径不受影响。

## License

MIT © 2026 qiongqi-empty

---

## English summary

`dsh-cookie-fix` is a Host-only DSH bundle that keeps the desktop app's random-port `dsh-auth-*` cookies bounded. On every launch the desktop exchanges its launch token at `GET /`; the plugin appends `Max-Age=0` `Set-Cookie` deletions for all but the current and the two newest stale cookies. The jar therefore never reaches Node's 16 KiB request-header limit, so the HTTP 431 startup failure cannot occur. Install it from the official Plugins page with `https://github.com/qiongqi-empty/dsh-cookie-fix`, and remove the bundle to return to stock behavior. No `app.asar` edits, no network access, no stored data.
