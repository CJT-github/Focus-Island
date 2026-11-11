# Focus Island · 桌面灵动岛倒计时

透明无边框专注计时器，使用 Rust + tao + wry。Windows 使用 WebView2，已有本机验证的便携包；macOS 使用 WKWebView，平台适配源码和云端打包流程已加入，尚待 macOS 构建与实机验收。界面、脚本、托盘图标均内置。

## 运行

双击 **dist/FocusIsland.exe**。系统需已有 Microsoft Edge WebView2 Runtime；发布包不包含该系统运行时。

- 收起态为屏幕水平居中、距离顶部约 20px 的 132×38 药丸，有选中任务或已开始计时时优先显示倒计时和进度环。无任务待机可显示时分秒或恶魔之眼；两项都开启时每 10 秒轮换，只开启一项时持续显示该项。
- 点击展开为 340×340 圆盘：真实时钟、金色倒计时环、数字电子窗、播放/暂停和重置。
- 右键打开右下角的独立设置浮窗，按住顶部标题区可拖动，关闭再打开保留本次位置；支持预设、时/分/秒输入、任务增删切换、显示、待机与提醒偏好。任务列表旁的「新增任务」进入独立页面，可一次填写名称、时长和结束动作；返回保留完整草稿，创建成功后返回并选中新任务。
- 倒计时归零时左右半盘沿互补锯齿分离，伴随白光、光束、金色火花与冲击波；约 1.5 秒后显示绿色完成态。
- 药丸通过原生窗口区域接收点击，透明角落和画布留白可直接穿透。展开态保持可交互。
- 托盘菜单提供设置、显示/隐藏、退出。关闭设置浮窗只隐藏它。
- 有选中任务时显示任务倒计时，即使尚未开始；开始后的自由计时也优先于待机，暂停和完成保留结果。重置保留选中任务的设定时长，没有选中任务时返回待机。「待机时间」只控制待机数字时钟，不影响任务倒计时和独立的指针开关。
- 空格开始/暂停；Esc 收起圆盘。设置中 Esc 优先收起执行类型菜单，新增任务页或任务设置页按 Esc 返回设置主页，主页按 Esc 关闭浮窗。

任务、当前设定时长和偏好保存在 **%APPDATA%\FocusIsland\state.json**。时长精确到整秒，上限 99:59:59。运行中修改显示偏好不会重置倒计时；应用新时长或切换任务会停止并重置。重启恢复配置，计时器处于待开始状态。


## 倒计时结束动作

新增任务页可直接配置「结束后执行」，与任务一起保存。新建草稿独立于当前任务，默认关闭；创建成功后下一份草稿恢复默认关闭。已有任务通过任务行的设置按钮进入专属页面修改结束动作，设置主页没有独立的动作配置。结束动作只属于任务，无任务的自由计时不执行动作。动作默认关闭，可选择 PowerShell 自定义命令、锁屏、睡眠、关机或重启，各任务独立保存。自定义时长仍属于当前任务。

执行类型使用玻璃风格下拉菜单，带选中标记，可用方向键选择、Enter 确认、Esc 收起。启用后选择动作、填写命令与延迟并保存。执行延迟默认 10 秒，可设 0–300 秒。圆盘和对应任务的设置页显示本次动作，尚未执行时可取消。保存修改会撤销该任务本次待执行动作，新设置下次开始计时生效。

自定义命令使用 Windows PowerShell，例如 `Start-Process notepad.exe`；工作目录为程序所在文件夹，任务名不会拼入脚本。后台执行不阻塞界面，反馈执行状态或失败结果。取消不会强行终止已经启动的外部程序；关机、重启不强制关闭应用。

暂停续用本次动作；重置、切换任务、修改时长、新计时和退出取消待执行动作。每轮最多执行一次，重启只恢复配置，不补执行上次动作。

## 构建

标准环境需要 Rust MSVC 工具链、Visual Studio C++ Build Tools 和 Windows SDK。本机脚本会自动使用项目上一级已有的 .rustup-home / .cargo-home 配置。

~~~powershell
powershell -ExecutionPolicy Bypass -File .\tools\build.ps1
powershell -ExecutionPolicy Bypass -File .\tools\build.ps1 -Action test
~~~

发布构建使用 target/verified，避免覆盖仍在运行的旧版 target/release/focus-island.exe，最终复制到 dist/FocusIsland.exe。运行中的发布 exe 必须退出后才能覆盖。

## 平台打包

Windows x64 便携包由 `tools/package-windows.ps1` 生成，输出 `dist/FocusIsland-1.0.0-windows-x64.zip`，包含程序、中文使用说明和校验文件。解压后运行 `FocusIsland.exe`；电脑需要 Microsoft Edge WebView2 Runtime。打包使用独立暂存目录，不覆盖正在运行的 `dist/FocusIsland.exe`。

~~~powershell
powershell -ExecutionPolicy Bypass -File .\tools\package-windows.ps1
# 复用已经验证的 target/verified/release 构建
powershell -ExecutionPolicy Bypass -File .\tools\package-windows.ps1 -SkipBuild
~~~

macOS 的窗口、菜单、通知、数据目录和命令类型已按平台适配。`.github/workflows/package.yml` 分别使用 Apple Silicon 和 Intel macOS runner 构建 ZIP/DMG，构建失败或 GUI 自检失败不会输出 Mac 包；本次尚未在 macOS 上构建或实机验收。Mac 包默认采用 ad-hoc 签名，未公证。完整上传、打包及平台差异说明见 [PACKAGING.txt](PACKAGING.txt)。

工程包由 `tools/package-source.ps1` 生成，只包含源码、锁定依赖清单、测试/构建脚本和说明，不包含编译缓存、测试数据、用户配置或登录凭据。

## 自检与回归

~~~powershell
Start-Process .\dist\FocusIsland.exe -ArgumentList '--selftest','--log-file',"$PWD\tools\verify\selftest.log" -Wait
Get-Content .\tools\verify\selftest.log
~~~

--selftest 使用独立临时数据目录，页面就绪后执行 SetShape → TogglePanel → 3 秒计时 → TimerDone → AnimationDone，校验三针基座到圆心距离为 0。成功自动退出（退出码 0），错误或 25 秒超时退出码为 1，不修改日常任务配置。

其他诊断参数：

~~~powershell
.\dist\FocusIsland.exe --verbose
.\dist\FocusIsland.exe --data-dir .\tools\verify\manual-profile --log-file .\tools\verify\manual.log
~~~

普通运行的诊断日志位于 %APPDATA%\FocusIsland\diagnostic.log。WebView2 用户数据也写入应用数据目录，exe 所在目录无需写入权限。

浏览器和真实 Windows 集成回归脚本：

~~~powershell
node .\tools\verify-frontend.cjs
node .\tools\verify-native.cjs
node .\tools\verify-flicker.cjs after .\dist\FocusIsland.exe
node .\tools\verify-completion-actions.cjs
node .\tools\verify-completion-actions.cjs --native .\dist\FocusIsland.exe
node .\tools\verify-idle-eyes.cjs
node .\tools\verify-idle-eyes.cjs --native .\dist\FocusIsland.exe
~~~

这些脚本需要 Playwright；本机默认复用上一级 verify-tools/node_modules/playwright，也可通过 PLAYWRIGHT_MODULE 指向已安装模块。前端测试可用 BROWSER_EXE 指定 Chromium/Edge。原生测试在独立 profile 中启动发布版，通过 --debug-port 9457 临时启用本地 CDP（普通运行不开放端口），检查窗口居中、真实鼠标穿透、双窗口控制、秒级计时、归零动效、任务清空和重启恢复；测试结束退出测试实例并恢复鼠标位置。

## 实现说明

| 文件 | 职责 |
|---|---|
| src/main.rs | IPC 路由、双窗口生命周期、托盘菜单、自检、统一诊断日志 |
| src/window.rs | 多显示器原点与 DPI、顶部 20px 锚定与水平居中、设置面板工作区限制、原生点击区域、提示音与通知 |
| src/state.rs | 状态验证、兼容旧偏好字段、唯一任务 ID、动作配置与原子保存 |
| src/actions.rs | 每轮动作快照、延迟取消、一次执行校验与后台命令执行 |
| ui/app.js | 唯一计时器、真实时钟、可配置待机与鼠标注视、设置交互、裂开特效 |
| ui/styles.css | 深色玻璃、金色强调、电子窗与动画 |
| tools/verify-*.cjs | 前端与实际 WebView2 的回归检查 |

前端桥接使用 window.ipc.postMessage。设置面板把操作交给主岛，通过 timerState 同步显示；不会另起计时器。原生窗口与 WebView 始终保留 580×580 透明画布，药丸、圆盘和特效共用固定屏幕原点，避免缩放时旧合成帧错位。原生窗口区域随形态限定可见和点击范围；裂开时放开完整画布，避免裁掉碎片与冲击波；原始盘面在碎片之后衔接回归，期间没有空白帧。减弱动态效果（含系统偏好）直接显示完成态。

桌面通知复用已有托盘图标，通过 Windows Shell 发出；系统专注助手或通知策略可能抑制提示。提示音与桌面通知独立控制。

## 验收记录

验证证据保存在 tools/verify：selftest.log、frontend-report.json、native-report.json 和 native-*.png。资源占用记录以实际测量为准，区分 Rust 主进程与 WebView2 运行时子进程；不能将单独主进程读数当作整个应用内存。

### 本机实测（2026-11-11）

- Rust 单元测试：54 / 54 通过；前端回归及真实 Windows 双窗口回归通过。
- 自检退出码 0，SetShape / TogglePanel / TimerDone 完整往返，三针基座距离在浮点误差 1e-6 像素内为 0。
- 本轮 Windows 便携 ZIP 内的 FocusIsland.exe：872960 字节（约 852.5 KiB）。
- 无 CDP 的收起待机：主进程工作集约 21.7 MiB；整个进程树私有内存合计约 220.2 MiB，工作集合计约 459.9 MiB（工作集包含共享页，不等同于独占物理内存）。详见 tools/verify/idle-memory.json。
- **未达标项：若“运行内存 30MB 以内”指包含 WebView2 的完整应用，则此项未满足。当前保留指定的 wry/WebView2 架构，不能用单独 Rust 进程读数声称整体达标。**

### 顶部玻璃样式更新

药丸和展开圆盘均保持水平居中，距屏幕顶部 20 个逻辑像素（随 DPI 缩放）。向下展开和收起时保持顶部锚点；特效窗口用透明留白补偿，圆盘位置不跳动。岛体取消白色描边与硬边高光，改为透色深玻璃和柔和反光；Windows 11 的系统边框也显式禁用。

透明窗口使用 `WS_EX_NOREDIRECTIONBITMAP`，避免圆角外出现 Windows 白色底图；桌面实拍验证见 `tools/verify/native-pill-desktop.png` 和 `native-dial-desktop.png`。

### 动画流畅度更新

表盘使用固定 340×340 画布，玻璃轮廓通过圆角裁剪形变，避免宽高动画反复布局整个表盘。数字仅变化时写入；可见指针跟随屏幕刷新，收起后停止指针更新。宿主窗口和 WebView 的尺寸、位置在形态切换中保持不变，只有 CSS 轮廓与原生窗口区域改变；展开等待区域回执，收起等待过渡结束后收紧点击范围。

本机 WebView2 同场景 8 次展开/收起的采样结果（见 `tools/verify/animation-before.json` 与 `animation-after.json`）：

| 指标 | 优化前 | 优化后 |
|---|---:|---:|
| 累计布局耗时 | 79.3 ms | 8.4 ms |
| 累计主线程任务耗时 | 519.8 ms | 319.6 ms |
| 最大 RAF 帧间隔 | 130.1 ms | 60.0 ms |

展开时秒针从约 10 次/秒更新改为随屏幕刷新（本机约 100 次/秒）。收起待机采样中不再更新隐藏指针，布局次数由 12 降为 0。帧间隔统计包含原生窗口切换，不等同于屏幕呈现帧率。快速反复切换、延迟回执、取消特效、设置拖动和原生自检均已验证。

### 展开 / 收起闪烁修复

宿主窗口与 WebView 统一保持 580×580，正常切换不再改变位置、尺寸和透明样式。Win32 窗口区域限定胶囊或圆盘的交互范围，透明留白直接穿透；展开等待匹配的区域回执，收起后再缩小区域。

桌面连续采样测试用真实鼠标开合 10 次，并在后方放置高亮背景检测闪帧。旧版 838 个采样帧中有 7 帧露出背景；修复版 840 帧均未出现该现象，窗口与 WebView 几何保持稳定。原生命中检查同时验证药丸可点击、外部透明画布可穿透。报告与截图位于 `tools/verify/flicker-before.json`、`flicker-after.json` 和同名 `*-frames` 目录。采样结果只代表该轮本机测试。

### 统一玻璃主题

药丸、圆盘和设置面板采用冷灰色透光渐变，轮廓内侧以顶部柔光、底部暗部表现厚度，不增加白色外框或占用大片透明画布。按钮采用凸起渐变，输入框采用内凹阴影，次级文字提高对比度。电子读数窗保持不透明的深色渐变，指针不会穿透文字。模糊仅保留在主玻璃和面板表面；固定画布与区域握手保持不变。主题效果见 `tools/verify/native-pill-desktop.png`、`native-dial-desktop.png` 和 `native-panel.png`。

主题版前端与 Windows 回归通过；真实鼠标开合 10 次、833 帧桌面采样未检测到闪帧，透明区命中与固定视口检查通过，见 `tools/verify/flicker-glass.json`。

### 圆角抗锯齿与轻微柔影

修正 Windows 胶囊区域裁切过紧的问题：区域按 6 个逻辑像素的柔影范围加 3 个物理像素的抗锯齿保护扩展，保持圆角和固定画布。真实 GDI 检查覆盖 100%、125%、150%、175%、200% 缩放，确认胶囊及阴影范围没有有效像素被裁掉。

玻璃独立合成层在轮廓裁切后施加 0.4px 柔化与轻微向下阴影；装饰高光仅做 0.2px 柔化，文字、数字、时钟指针不经过滤镜。展开、收起和归零的同层显隐已同步。前端、20 项 Rust 测试及原生回归通过；10 次真实开合的 835 帧桌面采样未检测到闪帧，见 `tools/verify/flicker-edge.json`。像素放大对比见 `edge-native-before-4x.png` 与 `edge-native-after-4x.png`，DPI 裁切验证见 `region-shadow-audit.json`。

### 任务与待机优先级

选中任务或已开始计时优先级最高，始终显示对应倒计时；没有选中任务且未开始计时才进入待机。添加、选择任务会立即显示该任务设定时长，重置仍保留其倒计时。清空任务后按两个待机开关显示内容。

### 可配置待机

设置中的「待机时间」默认开启，「待机眼睛」默认关闭，两个开关独立保存并在重启后恢复。两项都关闭时，收起态用小圆点表示待机；待机时间关闭时，展开数字窗显示「等待开始」。选中任务和实际开始计时均优先显示倒计时。

只开启眼睛时，收起待机立即持续显示红色发光、竖瞳的恶魔之眼；只开启时间时持续显示时分秒。两项都开启时，先显示时间 10 秒，再显示眼睛 10 秒，循环轮换；两项都关闭时显示小圆点。眼睛保持眨眼、张望，偶尔短暂盯着屏幕上的鼠标；仅注视阶段采样鼠标位置。关闭眼睛、出现选中任务、开始计时、展开、隐藏或启用减弱动态效果会停止眼睛和采样，取消过期回调。

当前待机实现已通过 17 组待机专项检查（单眼睛 120 秒模拟持续显示、双开关多轮 10 秒轮播、选中任务抢占、多轮短暂注视、两个开关组合、开始/暂停/完成、鼠标注视的取消及迟到回调、隐藏和减弱动态效果），另有完整前端回归和 27 项 Rust 测试。报告见 `tools/verify/idle-eyes-report.json`。

10 项真实 Windows 功能验证通过：双开关约 10 秒轮播、仅眼睛持续显示、眼睛中新增选中任务立即抢占、开关保存与重启恢复，原配置保持不变。报告见 `tools/verify/idle-eyes-native-report.json`。本轮桌面会话不可捕获，真实屏幕截图和鼠标移动检查明确跳过；新增规则以原生 WebView 状态和 CDP 图像验证。鼠标跟随在上一版已通过真实坐标验证，本次调度边界另由专项测试覆盖。

### 倒计时结束动作验证

38 项 Rust 测试、7 组动作前端专项、7 组普通前端回归及 17 组待机专项通过。11 组原生动作检查使用隔离配置，只实际运行写入测试文件的 PowerShell 和 `exit 7`，验证每轮仅执行一次、提前与重复完成事件拒绝、延迟期间取消、重置与切换任务撤销、失败反馈及重启不补执行。锁屏、睡眠、关机、重启未在本机实际触发，其调用参数和配置路径由单元测试及保存检查覆盖。真实用户配置保持不变，测试实例与临时目录已清理。报告见 `tools/verify/completion-actions-report.json` 与 `completion-actions-native-report.json`，界面截图见 `completion-native-pending.png`、`completion-native-error.png` 和 `completion-native-settings.png`。

### 独立新增任务页与玻璃菜单

新增任务改为设置浮窗内的独立页面，支持返回、取消与 Escape，未提交内容在返回后保留。创建时禁用重复提交，收到匹配的新任务后清空名称、返回列表并选中任务。设置页滚动位置与输入焦点在页面切换中保留。

执行类型改为自定义玻璃菜单，提供图标与选中标记；方向键、Home/End、Enter、Escape 和 Tab 均可操作。菜单根据窗口空间选择展开方向，滚动、失焦或切页时收起。普通前端 8 组、完成动作前端 8 组及原生 13 组检查通过，真实用户配置未修改。

### 新增任务时配置结束动作

新增任务页可同时填写动作开关、执行类型、命令和延迟，任务与动作一次校验并保存。返回保留整份草稿，错误反馈保留输入并允许重试；成功按匹配的创建请求返回列表，并将下一份新建动作恢复默认关闭。各任务的编辑草稿彼此独立，新建任务也有独立草稿。

42 项 Rust 测试、8 组普通前端、12 组动作前端及 15 组原生回归通过。检查覆盖创建失败无半成品、配置重启恢复但不自动执行、真实倒计时结束仅执行一次，以及原有取消和失败反馈。原生仅执行隔离目录中的测试命令，没有实际执行系统预设；用户配置保持不变，测试实例与临时目录已清理。

### 任务专属结束动作

结束动作配置仅位于新增任务页和对应任务的设置页，设置主页无独立入口。编辑非当前任务不会切换任务、重置计时或取消当前任务的动作；草稿、保存回执与状态卡均按任务隔离。旧版自由计时动作被忽略，后续保存不再写入该字段，自由计时仍可正常结束提醒。

44 项 Rust 测试、8 组普通前端、13 组动作前端和 18 组原生检查通过。覆盖任务归属、旧配置迁移、空任务 ID 拒绝、跨任务保存隔离以及完整创建与执行回归。用户配置字节保持不变，原生测试只执行隔离目录中的测试命令，测试实例与临时目录已清理。

### Windows / macOS 工程与自动打包

Windows 与 macOS 共用任务、计时、玻璃界面和完成动作状态机。平台层分别处理窗口透明、点击穿透、托盘/菜单栏、通知和数据目录。新建 Mac 任务默认使用 Shell（zsh），旧 PowerShell 配置保持解释器身份并拒绝在 Mac 上重解释；Mac 菜单提供 Shell、睡眠、关机、重启，现代 macOS 暂不提供锁屏动作。

Windows 本轮 54 项 Rust 测试通过；普通前端 8 组、包含 Mac 平台选择的动作前端 14 组、原生动作 18 组通过，独立配置 GUI 自检通过。Apple Silicon 和 Intel 均通过 Windows 主机上的 Rust 类型检查（含 tests）；检查使用依赖支持的 `DOCS_RS=1` 跳过仅供链接的 Objective-C exception helper，未进行 Mac 原生链接或运行。Mac 打包布局、plist、工作流和超时处理已做静态/模拟验证，仍须在 macOS runner 实际构建和执行 GUI 自检。

GitHub 工作流提供 Windows x64、macOS arm64 和 macOS x86_64 三个独立构建任务，只上传打包产物，不发布 Release。Mac 使用 ad-hoc 签名，未做 Apple 公证。源码工程 ZIP 采用明确文件清单并逐项对比哈希；上传步骤见 PACKAGING.txt。
