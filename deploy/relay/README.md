# Focus Island 自动连接中继

电脑端只需填写 HTTPS 服务地址与连接密钥，程序每 2 秒自动接收服务器上的通知；不需要电脑安装 SSH、配置入站端口或保持隧道进程。以下配置部署在你自己的 Linux 服务器。

```text
外部系统 → HTTPS 专属投递 URL → Caddy → Node 中继内存队列
电脑程序 → HTTPS + 连接密钥 → 拉取消息 → 当前通知岛接收后确认
```

## 服务器部署

准备域名、Linux 服务器和 Docker Engine / Compose。域名 A/AAAA 指向服务器，TCP 80/443 可达。先运行 `sudo ss -ltnp '( sport = :80 or sport = :443 )'`；若端口已由其他网站占用，采用后面的已有网关方式，不停止现有网站。

将本目录全部文件放到服务器，例如 `/opt/focus-island-relay`，进入该目录。初始化会用操作系统随机源生成两把不同的 256 位密钥，写入权限 0600 的 `.env`；已有文件不会被覆盖。不要从 `.env.example` 复制空密钥后启动。

```bash
cd /opt/focus-island-relay
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work \
  node:24-alpine node init.cjs init notify.example.com
# 上一行的域名换成自己的域名；不是 HTTPS URL。
docker compose config --quiet
docker compose build --pull
docker compose run --rm --no-deps gateway caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose up -d
docker compose ps
```

已有 Node.js 24 的服务器也可用 `node init.cjs init 你的域名` 初始化。初始化不打印密钥；需要复制连接密钥时，在可信终端执行：

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work:ro" -w /work \
  node:24-alpine node init.cjs show-connection
```

把输出的连接密钥填入电脑端。日常使用不需要再次运行这些命令。`.env` 不应提交到 Git 或发送给通知调用方。

Caddy 终止 TLS，自动申请/续期证书。Node 只在 Docker 内网的 `relay:17893` 提供 HTTP，Compose 没有发布该端口；公网只开放 80/443。Caddy 明文 HTTP 入口返回 400，其他未匹配路由返回 404。[Docker 网络](https://docs.docker.com/compose/how-tos/networking/)、[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)

## 电脑端设置与外部投递

在电脑端 Webhook 的服务器连接设置中填写 `https://你的域名` 和上面读取的连接密钥，保存并开启；保持“通知框”开启。连接成功后，程序读取专属投递 URL。把这个 URL 填入外部系统的 Webhook 地址，选择 POST 和 `Content-Type: application/json`。

支持飞书文本消息结构：

```json
{"msg_type":"text","content":{"text":"构建成功"}}
```

也支持原生通知、按同一通知 id 更新和撤回：

```json
{"id":"build-123","app":"CI","title":"构建成功","body":"可以开始验收"}
```

```json
{"type":"removed","id":"build-123"}
```

成功状态是 HTTP 202，正文包含 `{"ok":true,"code":0,"msg":"success","id":"..."}`；它表示进入服务器队列，尚不表示电脑已展示。仅兼容飞书文本结构，不支持卡片、飞书签名、任务执行或远程命令。

连接密钥用于电脑拉取、确认消息和读取投递 URL；投递 URL 内的另一把令牌只能发送通知。两者互不授权，不能把连接密钥提供给第三方调用方。

## 容量、确认与隐私

- 该版本服务单个电脑。同一个连接密钥被多台电脑使用时会竞争消费，不提供广播语义。
- 消息仅保存在内存，最多 200 条；满后新投递返回 429，不挤掉已有消息。进程持续运行时，消息保留最多 24 小时。
- 服务器重启或升级会清空队列。电脑收到确认后，服务器删除对应事件；确认表示送入当前界面，不承诺应用崩溃后的恢复或严格仅投递一次。
- 拉取不删除消息，确认可安全重试。每次更新都有独立的 `deliveryId`；确认旧事件不会删掉同一通知 id 的后续更新。
- 请求体最多 16 KiB；每分钟最多 60 个通过身份验证的投递请求。单条正文最多 2048 个 Unicode 字符，标题 256、来源名 80，通知 id 最多 256 UTF-8 字节。
- 服务不记录 URL、密钥、消息正文和标题。Caddy 禁止访问日志与包含请求地址的 HTTP 错误日志；如果前面还有 CDN/WAF，需要同样关闭或脱敏专属 URL 日志。

## 已有 HTTPS 网关

如果服务器已有 Caddy/Nginx，在其已有域名配置中代理下列路径到中继容器即可：

| 方法 | 路径 |
| --- | --- |
| POST | `/api/webhook/*` |
| GET | `/api/relay/info`、`/api/relay/messages` |
| POST | `/api/relay/ack` |

不要再启动本目录的 `gateway`。可额外创建 `compose.host.yml`：

```yaml
services:
  relay:
    ports:
      - "127.0.0.1:17893:17893"
```

然后运行 `docker compose -f compose.yml -f compose.host.yml up -d --build relay`。现有宿主机网关代理到 `127.0.0.1:17893`；不要绑定公网 `0.0.0.0`。若现有网关本身也是 Docker 容器，需要把它加入同一 Docker 网络，再代理到 `relay:17893`。

现有 Caddy 可参考本目录 Caddyfile 的路由、16 KiB 请求限制与固定错误响应。合入既有配置时保留其他网站、现有唯一全局块，并处理专属 URL 的日志隐私。Nginx 需使用 `proxy_pass http://127.0.0.1:17893;` 保留完整路径，开启请求缓冲并配置 `client_max_body_size 16k`、有限超时；为独立通知站点设置 `access_log off;`、`error_log /dev/null;`，拒绝其他路由及错误方法。部署前验证现有网关配置，再按已有流程重载。[Caddy 反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[Nginx 代理](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)

## API 契约与测试

`GET /api/relay/info` 带 `Authorization: Bearer 连接密钥`，返回 `{protocol:1,webhookToken:"..."}`。桌面据此拼出 `https://域名/api/webhook/投递令牌`。

`GET /api/relay/messages` 使用相同认证，返回 `{messages:[{deliveryId,notification}]}`，每次最多 20 条，按入队顺序排列。`deliveryId` 是 64 位小写十六进制随机字符串。`notification` 字段为 `type/source/id/app/title/body/time`，其中 source 固定为 `webhook`。

`POST /api/relay/ack` 使用相同认证和 JSON `{"ids":["deliveryId"]}`，返回 `{ok:true,acked:数量}`。重复确认有效；未知事件不会影响其他消息。

中继用 Node.js 内置 HTTP、crypto 和 node:test，无 npm 依赖。运行测试：

```bash
docker run --rm -v "$PWD:/work:ro" -w /work node:24-alpine node --test server.test.cjs
```

检查运行：`docker compose ps` 与 `docker compose logs --tail 50`。401 表示密钥错误；429 表示限流或队列满；502/503 检查中继健康与网关连接。需要换密钥时在可信终端修改 `.env` 后运行 `docker compose up -d --force-recreate relay`，并更新电脑设置或第三方投递 URL；该操作重启服务并清空内存队列。

旧的 [SSH 反向隧道部署](../webhook/README.md) 仍保留为高级可选方式；本中继方案不需要它。
