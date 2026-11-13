# Focus Island Android 伴侣

原生 Java 单 Activity 应用，包名 `com.focusisland.companion`，最低 Android 8.0（API 26），compile/target SDK 36。通过 BLE 把新通知发送到 Windows Focus Island；无需账号、服务器或网络权限。该版本提供通知展示，不提供回复、点击手机通知或历史同步。

## 使用

1. 安装 debug APK，在手机打开“允许通知访问”，手动授权 Focus Island 通知共享。
2. 允许“附近设备”；Android 13+ 建议同时允许状态通知，便于随时停止共享。拒绝状态通知不阻止 Android 前台服务，但通知栏可能不显示停止入口。
3. 手机点击“让手机可被发现 / 首次配对”。在 Windows 系统设置的“蓝牙 → 添加设备”找到手机，两端核对并手动确认配对码。本应用不会创建绑定、代输 PIN 或自动同意配对。
4. 返回伴侣 App，刷新已配对设备，明确选择允许接收通知的那台电脑。其他历史配对设备没有订阅权限。
5. 按需设置隐私与应用过滤，然后“开始共享”。在 Windows Focus Island 中扫描并连接手机。
6. 手机可锁屏，前台共享服务继续运行。点击手机“停止共享”或状态通知中的停止按钮可立即结束。修改授权电脑、应用过滤或隐私设置前先停止共享，已有连接和待发送队列会清空。

默认仅共享应用名，标题与正文为空。关闭“仅显示应用名”后，转发系统通知监听实际提供的标题和正文。普通新通知默认允许；自身通知、常驻通知、分组摘要被排除。开启应用白名单但未选应用时，不共享任何应用。选择器显示当前可见、带启动入口的应用；工作资料、无启动入口的应用可能不在列表中。

应用不主动修改锁屏策略，也不绕过系统脱敏。Android 的敏感通知保护、工作资料策略、厂商后台限制、用户强行停止或关闭蓝牙均可能影响共享。Android 8+ 是 API 基线，不代表所有品牌/ROM均已验证。某些国产 ROM 需要用户在系统设置允许后台运行。撤销通知访问、附近设备权限或移除电脑配对会停止共享；不会开机自启、进程被终止后自动重启，需再次明确“开始共享”。暂时蓝牙断开后手机重新广播，电脑端需重新连接；初连/重连只发 status，不补发旧通知。

## 构建

要求 JDK 17、Android SDK 平台 36 / Build Tools 35.0.0。Gradle 8.13 / AGP 8.13.2 已固定，标准 wrapper 包含官方发行包 SHA-256 校验。没有 Android SDK 的 Windows 环境可使用项目局部引导脚本：

```powershell
.\build-local.ps1 -JdkPath 'C:\path\to\jdk-17' -AcceptSdkLicense
```

`-AcceptSdkLicense` 明确允许 SDK 安装时接受开发工具许可；省略时由官方 SDK 管理器交互确认。脚本只在本目录 `.tools/`、`.android-sdk/`、`.android-user-home/`、`.gradle-user-home/` 下载/安装缓存，结束恢复进程环境变量，不修改全局 SDK、PATH 或用户配置。目录均已忽略。

已有 Android SDK 的 Windows / Linux / macOS 或 CI 可设置 `JAVA_HOME` 和 `ANDROID_HOME`，运行：

```sh
# 在 android/ 内；Windows 使用 gradlew.bat
bash ./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
```

输出：

- `app/build/outputs/apk/debug/app-debug.apk`：可侧载的测试 APK（自动 debug 签名，仅供测试）。
- `app/build/reports/tests/testDebugUnitTest/index.html`：协议、过滤、授权、队列测试。
- `app/build/reports/lint-results-debug.html`：静态检查。

release 构建未配置生产签名；不把签名密钥或本机配置提交到仓库。Gradle wrapper 校验官方发行包，项目局部引导额外校验官方 SDK 命令行工具 zip。使用 Android Studio 可直接打开此目录，并选择本机 SDK。

## BLE 协议 v1

手机是 BLE peripheral / GATT server；电脑是 central / GATT client。广播为 connectable，主广播包含 128-bit service UUID，scan response 包含系统设备名。不修改系统蓝牙名称；名称过长导致广播超长时会显示可操作错误。

- Service：`7b5e0001-6b7d-4a8f-9c10-6a2d3f4b5c60`
- Notify characteristic：`7b5e0002-6b7d-4a8f-9c10-6a2d3f4b5c60`
- CCCD：`00002902-0000-1000-8000-00805f9b34fb`

CCCD 读写要求链路加密，并额外检查 `BOND_BONDED` 与用户选择的唯一电脑地址。收到 `01 00` 才订阅；不支持 indication、长写或外部写入通知内容。只有系统配对并不代表用户授权共享；未选中的设备会被拒绝连接/订阅。

每条 JSON 为 UTF-8，最大 8192 字节。所有根对象都有数字字段 `version: 1`：

```json
{"version":1,"type":"posted","id":"64位小写SHA256十六进制","app":"聊天","package":"com.example.chat","title":"新消息","body":"你好","time":1794441600000}
{"version":1,"type":"removed","id":"同一通知的64位SHA256十六进制"}
{"version":1,"type":"status","notificationAccess":true,"name":"Manufacturer Model"}
```

`id = SHA-256(StatusBarNotification.getKey())`，不发送原始通知 key，posted/removed 使用同一散列；无截断碰撞。`time` 是非负 Unix 毫秒。应用名最多 128 个 Unicode code point，包名 255，标题 160，正文 500；裁剪保留代理对，移除控制字符与双向文字覆盖符。隐私模式始终发送空 title/body，系统返回的隐私脱敏内容照实保留。

每次 GATT notification：

| 偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 1 | version = 1 |
| 1 | 1 | reserved = 0 |
| 2 | 2 | messageId，u16 little-endian |
| 4 | 2 | fragment index，从 0 开始，u16 LE |
| 6 | 2 | fragment count，u16 LE |
| 8 | 可变 | UTF-8 JSON 的部分字节 |

分片载荷容量是 `min(MTU - 3, 512) - 8`（默认 MTU 23 时为 12 字节）。JSON 必须完整重组后才解码 UTF-8。每次只发送一个分片，等 `onNotificationSent` 成功才继续。队列最多 32 条 / 64 KiB；超过限制、发送失败或 10 秒未收到发送回调会清理连接重新广播，绝不发送半条消息后静默丢弃其余分片。断线关闭旧 GATT server，使旧回调失效；消息序列在进程内继续递增。

初次订阅发送 status，只有通知监听真正已连接时 `notificationAccess` 才为 true。不会枚举当前通知。已转发 id 集合上限 512，移除事件仅对本次连接已转发的通知发送。内容仅存在内存，不保存或打印到日志。偏好仅保存授权电脑地址、白名单包名与隐私开关，应用备份和设备迁移已禁用。

## 验证范围

纯 Java 测试覆盖默认/最大 MTU 分片重组、多字节跨片、8192 字节边界、单分片 ACK 顺序、队列溢出与断线清空、稳定通知 ID、Unicode 裁剪、隐私内容清空、唯一授权电脑及白名单规则。

真实手机的系统配对、CCCD 加密协商、OEM 锁屏后台存活、Android 权限撤销与 Windows 端收发仍需硬件验收，不能由编译或单元测试代替。建议至少验证：通知新增/更新/移除；仅应用名及白名单；两台已配对电脑只有所选一台能订阅；默认 MTU 23 长中文通知；锁屏收发；蓝牙断开重连不重放旧通知；停止共享与撤销权限后没有后续内容。

官方参考：

- [Android 蓝牙权限与附近设备授权](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions)
- [connectedDevice 前台服务权限与类型](https://developer.android.com/about/versions/14/changes/fgs-types-required#connected-device)
- [Android 13 通知运行时权限](https://developer.android.com/develop/ui/views/notifications/notification-permission)
- [NotificationListenerService 生命周期](https://developer.android.com/reference/android/service/notification/NotificationListenerService)
- [GATT server 与通知发送 API](https://developer.android.com/reference/android/bluetooth/BluetoothGattServer)
- [AGP 8.13 构建工具兼容性](https://developer.android.com/build/releases/agp-8-13-0-release-notes)
