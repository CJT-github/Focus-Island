# Focus Island 公网 Webhook 部署

这套配置把自有 Linux 服务器上的 HTTPS 请求，通过 SSH 反向隧道交给运行中的桌面灵动岛。服务器只运行 HTTPS 网关；消息、访问令牌和任务仍由桌面应用管理。

```text
外部 POST → https://你的域名/api/webhook/专属令牌
         → 服务器 Caddy → 服务器 127.0.0.1:17892
         → SSH 隧道 → 电脑 127.0.0.1:17891 → 通知岛
```

## 1. 准备服务器与域名

需要自有域名、可 SSH 登录的 Linux 服务器、Docker Engine 与 Compose 插件。域名 A 记录指向服务器公网 IPv4；若配置 AAAA，也必须指向可达的 IPv6。开放服务器 TCP 80、443，以及原有 SSH 端口。不要对公网开放 17891、17892。

先检查服务器端口：

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 or sport = :17892 )'
```

如果 80 或 443 已由 Nginx、Caddy 或其他网关使用，直接使用本文后面的“已有网关”配置。不要停止现有网站、也不要同时启动本 Compose 网关。17892 应留给本项目 SSH 隧道。

本 Compose 面向 **Linux 服务器**，使用 `network_mode: host`，让容器能连接服务器回环地址上的 SSH 隧道。普通 bridge 网络中的 `127.0.0.1` 指向容器自身；改用 Docker 网桥 IP 也无法连接只绑定主机回环的隧道。host 模式不配置 `ports:`。[Docker 官方说明](https://docs.docker.com/engine/network/drivers/host/)

## 2. 启动电脑端与隧道

在桌面应用打开“Webhook”，访问范围选择“本机”，端口保留 `17891`，开启并保存；同时开启“通知框”。使用本方案不需要开启局域网监听。

先用正常 SSH 登录完成服务器身份核对与密钥登录设置。项目的 [Windows 隧道脚本](../../tools/webhook-tunnel.ps1) 使用已确认的主机密钥和密钥认证，不会交互索要密码。工程根目录执行：

```powershell
.\tools\webhook-tunnel.ps1 -Server your-server -User your-user -Reconnect
```

可传 `-SshPort 22 -LocalPort 17891 -RemotePort 17892 -IdentityFile 'C:\Users\you\.ssh\id_ed25519'`，或直接把 `-Server` 设为 SSH 配置中的主机别名。脚本运行期间保持窗口/进程存活；关闭它即停止隧道。

macOS/Linux 可直接运行：

```bash
ssh -N -T -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:17892:127.0.0.1:17891 your-user@your-server
```

服务器 SSH 配置需允许该用户使用远程端口转发，并保持 `GatewayPorts no`。如为专用用户设置限制，可使用 `AllowTcpForwarding remote` 与 `PermitListen 127.0.0.1:17892`；修改 SSH 配置前需保留现有管理连接并验证配置。远程转发语义见 [OpenSSH 手册](https://man.openbsd.org/ssh.1) 和 [sshd 配置](https://man.openbsd.org/sshd_config.5)。

在服务器再次运行 `sudo ss -ltnp 'sport = :17892'`，应仅看到 `127.0.0.1:17892`，不能是 `0.0.0.0:17892` 或 `[::]:17892`。

## 3. 部署独立 HTTPS 网关

将本目录复制到服务器，例如 `/opt/focus-island-webhook`，在该目录执行：

```bash
cp .env.example .env
# 编辑 .env，把 notify.example.com 换成自己的域名。
# WEBHOOK_DOMAIN 只填域名，不填 https://、端口、路径或令牌。
nano .env
docker compose --env-file .env config --quiet
docker compose pull
docker compose run --rm --no-deps gateway caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose up -d gateway
docker compose ps
docker compose logs --tail 50 gateway
```

镜像固定为官方 `caddy:2.11.9-alpine`。Caddy 自动申请和续期域名证书，`caddy_data` 卷保存证书资料；域名解析和 80/443 可达性必须正确。[官方镜像](https://hub.docker.com/_/caddy)、[自动 HTTPS](https://caddyserver.com/docs/automatic-https)

本配置只代理两个 POST 路由：`/api/webhook` 和 `/api/webhook/*`。其他 HTTPS 请求返回 404，明文 HTTP 返回 400，不重定向携带令牌的地址。请求体上限 16 KiB；网关缓冲请求后以 HTTP/1.1 转发。外部请求必须携带正确的 `Content-Length`，没有长度的请求在网关直接返回 411；不支持 HTTP/1.1 chunked 或省略长度的 HTTP/2 流式发送。常规 JSON 客户端及下方 `curl --data` 示例会自动计算长度。缓冲设为 17 KiB，配合 16 KiB 上限，让合法最大请求也能读到结束。桌面应用继续检查令牌、消息格式、大小和速率。没有任务执行或远程命令接口。[Caddy 路由匹配](https://caddyserver.com/docs/caddyfile/matchers)、[请求缓冲](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

访问日志与包含请求地址的 HTTP 错误日志均关闭；连接失败返回固定错误正文。证书与启动日志仍保留。若前面另有 CDN、负载均衡器或 WAF，也应关闭或脱敏专属 URL 的记录。不要开启 Caddy 的 `debug` 或 `trace` 请求日志。[日志配置](https://caddyserver.com/docs/caddyfile/options)

## 4. 填入公网地址并发送通知

在电脑端 Webhook 设置中填入 `https://你的域名`，保存后复制应用显示的专属 URL。只填公网基地址不会自动部署服务器；必须先完成网关与隧道。专属 URL 内的令牌等同访问密码，不能放入公开仓库。

外部系统选择 POST、`Content-Type: application/json`，并发送 JSON UTF-8 字节数对应的 `Content-Length`（一般由 HTTP 客户端自动设置）。如果 SDK 使用流式 body，请先编码为完整 JSON 字节数组，再发送。消息体可使用飞书文本消息格式：

```json
{"msg_type":"text","content":{"text":"构建成功，可以开始验收"}}
```

也可以使用本应用原生格式：

```json
{"id":"build-123","app":"CI","title":"构建成功","body":"版本已准备完成"}
```

在 Bash 中可这样测试，让专属 URL 通过标准输入传给 curl，避免写入命令历史与进程参数：

```bash
read -r -s -p '专属 HTTPS URL: ' WEBHOOK_URL
printf '\n'
printf 'url = "%s"\n' "$WEBHOOK_URL" |
  curl --config - --silent --show-error --fail-with-body \
    --header 'Content-Type: application/json' \
    --data '{"msg_type":"text","content":{"text":"公网 Webhook 测试"}}'
unset WEBHOOK_URL
```

成功返回 HTTP 202，JSON 中 `ok: true`、`code: 0`，桌面通知岛显示消息。上面的格式兼容飞书文本消息结构，不代表支持飞书卡片、签名协议或所有第三方机器人扩展。若外部系统只接受 HTTP 200，应调整其成功状态判断；本接口成功状态为 202。

直接访问 `https://你的域名/` 得到 404，可用于确认域名与 TLS 网关可达，但不能证明隧道和桌面应用可用。带令牌的通知地址只接收 POST，不应在浏览器地址栏打开。

## 5. 已有网关

### 已有 Caddy

在现有 Caddyfile 中加入本目录 Caddyfile 的两个站点块，替换 `{$WEBHOOK_DOMAIN}` 为实际独立域名；不要额外启动 Compose。保留现有其他站点与唯一的全局配置块。

该通知站点需要 `log_skip`、固定的 `handle_errors` 响应、POST 路由、16 KiB 请求体限制、缺少 Content-Length 时返回 411 及 `request_buffers 17KiB`。如当前有额外的默认 HTTP 错误日志输出，在原有全局 `log` 配置合并 `exclude http.log.access http.log.error`，或对通知站点提供等效脱敏；此排除影响整个 Caddy 实例，应与已有站点日志需求协调。不要直接覆盖现有全局配置或启用 debug/trace。若无法隔离日志，请使用独立网关实例和可用的独立 IP/入口。

确认相同域名没有另一个 HTTP 跳转站点，以免将专属 URL 写入重定向响应。独立文件的 `auto_https disable_redirects` 已避免自动重定向；合入已有实例时显式 HTTP 站点处理该域名。

按服务器既有方式设置环境变量，或在站点块写入真实域名后验证并重载：

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

这些命令针对已有 systemd 服务。独立 Compose 关闭了管理 API，更新后使用 `docker compose restart gateway`。

### 已有 Nginx

在已有 Nginx 加入一个独立域名的 server 配置，使用该域名已有的有效证书。下面的域名与证书路径必须替换；不要覆盖现有网站。Nginx 应安装在服务器宿主机或使用能访问宿主机回环的网络配置。

```nginx
server {
    listen 80;
    server_name notify.example.com;
    access_log off;
    error_log /dev/null;
    return 400 "HTTPS required";
}

server {
    listen 443 ssl;
    server_name notify.example.com;
    ssl_certificate /etc/ssl/your-domain/fullchain.pem;
    ssl_certificate_key /etc/ssl/your-domain/privkey.pem;

    access_log off;
    error_log /dev/null;
    client_max_body_size 16k;
    client_body_buffer_size 16k;
    client_body_timeout 10s;
    add_header Cache-Control "no-store" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Content-Type-Options "nosniff" always;

    location ~ ^/api/webhook(?:/.*)?$ {
        if ($request_method != POST) { return 404; }
        if ($http_content_length = "") { return 411; }
        proxy_http_version 1.1;
        proxy_set_header Connection "close";
        proxy_request_buffering on;
        proxy_buffering off;
        proxy_cache off;
        proxy_connect_timeout 2s;
        proxy_send_timeout 5s;
        proxy_read_timeout 5s;
        proxy_pass http://127.0.0.1:17892;
    }
    location / { return 404; }
}
```

这里 `proxy_pass` 不附加 URI，以保留认证路径；请求缓冲保持开启。禁用该独立站点的 access/error 日志，防止连接失败时令牌出现在请求地址中。外层网关也需要采用相同策略。[Nginx 代理文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)、[访问日志](https://nginx.org/en/docs/http/ngx_http_log_module.html)、[错误日志](https://nginx.org/en/docs/ngx_core_module.html#error_log)

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Nginx 不会通过以上配置自动申请或续期证书；沿用服务器已有的证书管理方式。

## 6. 运行与排查

| 现象 | 处理 |
| --- | --- |
| 域名无法建立 HTTPS | 检查 A/AAAA、80/443 防火墙、端口冲突与证书日志 |
| 502/503 | 检查桌面应用、通知框、Webhook 开关和 SSH 隧道；503 也可能是接收队列繁忙 |
| 401 | 专属 URL 已过期或令牌错误；重新复制，重置令牌会使旧地址立即失效 |
| 411 | 发送完整 JSON，并让客户端提供 Content-Length；不支持 chunked/未知长度流式请求 |
| 413 | 消息体超过 16 KiB |
| 429 | 超过每分钟 60 条认证请求；等待后重试 |
| 400/415 | 检查 UTF-8 JSON、字段和 Content-Type；不支持浏览器跨域直连 |
| SSH 报远程转发失败 | 检查服务器 17892 占用及 SSH 用户转发权限 |

电脑、应用和隧道必须持续运行。此方案没有离线消息存储；关闭电脑期间第三方请求会失败，调用方可自行设置有限重试。

更新 Caddyfile 后先运行上面的 validate，再 `docker compose restart gateway`。停止独立网关用 `docker compose down`；不要加 `-v`，以保留证书卷。
