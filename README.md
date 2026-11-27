# dsh-voice-fish 🐟

> 让 DSH（DeepSeek Harness）里的 AI **开口说话** —— 而且嗓子由你自己挑。

一个 Windows 本地小插件：每轮开始时说一句、收尾时把这一轮的结果概括念出来，出错和等人审批也会出声。

## 它什么时候说话

| 时机 | 说什么 |
| --- | --- |
| 每轮开始思考 | 「让我思考一下~」 |
| 每轮完成 | 这一轮的**结果概括**（代码、表格、文件路径自动跳过，默认最多 80 字） |
| 工具出错 | 「出岔子了，来看看」 |
| 等你批准操作 | 「有个操作等你点一下」 |
| DSH 启动 | 「鱼鱼上线啦」 |

都能在设置页里单独开关。

## 声音从哪来

| 引擎 | 说明 | 依赖 |
| --- | --- | --- |
| `edge`（默认） | 微软 **Edge 神经音色**，插件内直接合成 | 只要网络 |
| `bridge` | 朗读桥（把话交给 DeepSeek 网页端去念） | 浏览器 + 扩展 |
| `sapi` | Windows 自带语音（Huihui） | 无 |
| `auto` | 桥 → edge → sapi 挨个试 | — |

`edge` 是**零依赖**实现：WebSocket 帧、微软的 `Sec-MS-GEC` v2 令牌都在插件里自己算，不装 python 包、不加 npm 依赖，合成完用 Windows MediaPlayer 放出来。

可选 14 个中文音色：晓晓、晓伊、云希、云扬、东北话晓北、陕西话晓妮、粤语、台湾腔……

## 安装

需要 **DSH**（带 Web 界面的版本）和 **Windows 10/11**。

```bash
# 方式一：直接从 GitHub 装
dsh plugin --profile desktop add github:luojuee/dsh-voice-fish

# 方式二：克隆下来再 link（改代码方便）
git clone https://github.com/luojuee/dsh-voice-fish.git
dsh plugin --profile desktop add link:<克隆下来的目录>
```

装完**重启一次 DSH**，设置里会出现「大肥鱼的声音」那一页。

## 用

DSH 设置 →「大肥鱼的声音」：

- 挑音色 → 点「▶ 试听」→ 满意再「保存」（立即生效，不用重启）
- 调语速（-50% ~ +50%）、音调（-50 ~ +50Hz，往上更嫩、往下更御）、音量
- 勾什么时候出声、概括最多多少字、它怎么称呼你

不想开界面也行，配置就在：

- `cordis.patch.yml`：插件默认值
- `%LOCALAPPDATA%\dsh-voice-fish\state.json`：即时覆盖，优先于上面
- `%LOCALAPPDATA%\dsh-voice-fish\voice.log`：每条播报走的是哪个引擎、念了什么

```json
{ "engine": "edge", "edgeVoice": "zh-CN-XiaoxiaoNeural", "edgePitch": 30, "ownerName": "小鱼" }
```

## 原理

- 监听 DSH 的 `session/event`（`turn/start`、`assistant/message`、`turn/end`、`tool/result`、`approval/asked`）
- 收尾时把这一轮最后几条回复里的**纯文字**抓出来，去掉代码块 / 表格 / 链接 / 文件路径 / 驼峰标识符，按句截断成能念的摘要
- 合成：连 `wss://speech.platform.bing.com`，发 SSML，收 mp3；令牌按 edge-tts 的算法在本地复刻
- 播放：`powershell.exe` + `System.Windows.Media.MediaPlayer`
- 设置页是 DSH 客户端插件（`slots` 里的 `settings.section`），走宿主注册的 `/dsh-voice-fish/*` 路由

## 常见问题

| 现象 | 怎么办 |
| --- | --- |
| 设置页显示「读不到配置」 | 插件宿主半边没起来，重启 DSH；看 `voice.log` 里有没有 `activate failed` |
| 没声音 | 看 `voice.log`：`speak(edge)` 是神经音色，`speak(sapi)` 是系统语音，`speak(none)` 表示都没成功 |
| 音色下拉是空的 | 拉微软音色列表失败，会用内置那份；断网也能用基础音色 |
| 念得太长/太短 | 设置页调「概括最多 X 字」 |
| 每轮都要重启才生效？ | 只有改**插件代码**才要；改配置是即时生效的 |

## 说明

- 这是个 Windows 专属插件（播放依赖 PowerShell + WPF）。
- `edge` 引擎用的是微软网页朗读服务的公开端点，请按微软的服务条款合理使用，别拿来批量跑长文本。
- 和 DeepSeek 官方无关，也没用到 DeepSeek 的私有接口。

## 许可

[MIT](./LICENSE)
