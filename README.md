# SillyTavern Resumable Generation

[English](#english)

让 SillyTavern（酒馆）的 AI 生成请求在服务器上持续运行，浏览器连接断了也能续上。

主要解决的问题：**iOS / 手机浏览器切到后台后连接被断开，生成直接失败。** 装上之后：

- 切出去再切回来，流式输出会从断开的位置接着往下走，酒馆这边感知不到中断。
- 如果页面被系统彻底杀掉并重新加载了，回到同一个聊天时会弹窗，点"恢复"就会把后台已经完成的结果放回它该在的位置。
- 关闭或刷新页面不会停止生成，可以换一台设备打开同一个聊天接着看。
- 点"停止"按钮会同时取消服务器上的请求，不会白白消耗 API 额度。
- 切到后台期间的时间不会算进消息的生成计时器。
- 可选：回复为空（例如被审查过滤）时自动重试，重试进度显示在消息左侧的 token 数下面。

支持的接口：Chat Completion、Text Completion、KoboldAI、NovelAI。

## 原理

酒馆的生成接口在浏览器断开连接时会主动中止上游请求，所以单靠前端扩展解决不了。本项目包含两部分，**放在同一个仓库里，两部分都要装**：

| 部分 | 作用 | 安装方式 |
| --- | --- | --- |
| 服务端插件（`server/`） | 在服务器上创建"生成任务"，通过本机回环连接调用酒馆原有的生成接口，并缓存输出，支持按偏移续传 | 克隆到酒馆的 `plugins` 目录 |
| 前端扩展（`client/`） | 接管生成请求，断线后自动续传；页面重载后提供恢复 | 在酒馆界面中用 git URL 安装 |

不修改酒馆的任何核心文件。

> **安全提示：** 服务端插件运行在酒馆的服务器进程里，拥有和酒馆一样的权限。这也是酒馆默认禁用服务端插件的原因。安装前请自行检查代码（`server/` 目录下的两个文件）。

## 安装

仓库地址：

```
https://github.com/Sakura-Byte/SillyTavern-ResumableGen
```

### 第 1 步：安装服务端插件

把仓库克隆到**酒馆根目录**（有 `server.js` 的目录）下的 `plugins` 文件夹里。

**Windows（命令提示符或 PowerShell）**，把路径换成你自己的酒馆目录：

```bash
cd C:\path\to\SillyTavern\plugins
git clone https://github.com/Sakura-Byte/SillyTavern-ResumableGen
```

**macOS / Linux / Termux（安卓）**：

```bash
cd ~/SillyTavern/plugins
git clone https://github.com/Sakura-Byte/SillyTavern-ResumableGen
```

用 [SillyTavern-Launcher](https://github.com/SillyTavern/SillyTavern-Launcher) 安装的，酒馆目录一般在 `SillyTavern-Launcher/SillyTavern`。

**Docker（官方 docker-compose）**：官方的 `docker-compose.yml` 把宿主机的 `./plugins` 挂载到了容器里，在 `docker-compose.yml` 所在目录执行：

```bash
cd plugins
git clone https://github.com/Sakura-Byte/SillyTavern-ResumableGen
```

### 第 2 步：开启服务端插件

编辑酒馆根目录下的 `config.yaml`（Docker 是 `./config/config.yaml`），找到这一行并改成 `true`：

```yaml
enableServerPlugins: true
```

Docker 也可以不改文件，在 `docker-compose.yml` 的 `environment` 里加一行 `- SILLYTAVERN_ENABLESERVERPLUGINS=true`。

然后**重启酒馆**。启动日志里出现下面这行就说明装好了：

```
[resumable-gen] Resumable generation plugin v1.0.0 loaded
```

### 第 3 步：安装前端扩展

打开酒馆网页 → 顶部"扩展"图标（三个方块）→ "安装扩展"，填入仓库地址：

```
https://github.com/Sakura-Byte/SillyTavern-ResumableGen
```

安装完成后刷新页面。可以选择"仅为我安装"或"为所有用户安装"。

### 验证

如果服务端插件没装好，或者没开启 `enableServerPlugins`，刷新页面后右上角会弹出黄色提示。没有提示就说明一切正常。

也可以用手机试一下：发一条消息，生成到一半时切到别的 App，十几秒后切回来，文字应该会接着往下出。

## 恢复弹窗

弹窗只有三个按钮：**恢复**、**稍后再说**、**丢弃**。点"恢复"时，插件会根据这次生成的类型和当时的聊天状态，自动决定放在哪里，弹窗里会用一行小字提前说明：

| 生成类型 | 恢复到 |
| --- | --- |
| 普通 / 重新生成 | 新消息；如果原页面中断时留下了一条（空的或只写了一半的）回复，就替换它 |
| 滑动（swipe） | 最后一条消息的新滑动 |
| 继续（continue） | 接在最后一条消息的正文后面（原页面写了一半的部分会被替换掉） |
| 代拟（impersonate） | 输入框 |

如果生成期间聊天发生了变化（比如在另一台设备上又发了消息），会退回"作为新消息插入"，并在弹窗里注明。

"稍后再说"只在当前页面不再提示，刷新或换设备打开时会再次弹出。

恢复的消息会像正常生成的消息一样触发酒馆的事件，所以酒馆助手（JS-Slash-Runner）等扩展会照常渲染其中的 HTML。

## 关闭页面时会怎样

默认情况下，**关闭或刷新页面不会停止生成**，只有点"停止"按钮才会取消。原因是从页面这边分辨不出"不玩了"和"换设备"，而 iOS 在后台杀掉页面，看起来和用户自己关闭几乎一样。生成会在服务器上跑完，结果保留 1 小时，下次在任意设备打开这个聊天时弹窗恢复。如果你确实不想要，在弹窗里点"丢弃"即可。

如果更希望"关掉页面就停"，可以在"扩展"面板里展开 **Resumable Generation**，勾选"关闭页面时停止生成"。注意，iOS 在后台杀掉页面时可能来不及通知服务器，所以这个开关只能尽量做到。

## 空回复自动重试

默认关闭。在"扩展"面板里展开 **Resumable Generation** 开启，可以设置：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| 空回复时自动重试 | 关 | 总开关 |
| 最大重试次数 | 3 | 1 到 10 次 |
| 重试间隔（秒） | 1 | 每次重试前等待的时间 |
| 只有思考、没有正文也算空回复 | 开 | 关闭后思考内容会实时显示，但"思考完后正文被拦截"就无法重试 |
| 上游报错时也重试 | 关 | HTTP 错误、连接失败时也重试 |

工作方式：

- 判断和重试都在服务器上进行，手机切到后台时也照常重试。
- 开启后，服务器会先扣住回复，直到出现真正的正文才开始发给页面。这对"假流式"接口（先发一串空的心跳块，最后一次性给出全部内容）同样有效。
- 重试过程中，消息左侧的 token 数下面会实时显示"自动重试 1/3"。生成完后保留在消息上，刷新页面、切换滑动后仍然可见。如果重试次数用完仍为空，会以警告色显示，并弹出提示。
- 重试会重新发送完整请求，可能产生额外的 API 费用。
- 已经开始输出正文的回复不会被重试。

## 更新

- **服务端插件**：`enableServerPluginsAutoUpdate` 默认开启，每次启动酒馆时会自动 `git pull`。也可以手动在插件目录执行 `git pull`，然后重启酒馆。
- **前端扩展**：在"管理扩展"里点更新。

两部分的版本需要配套。如果前端检测到服务端版本不兼容，会弹出提示，并暂时关闭续传功能。

## 卸载

1. 在"管理扩展"里删除 Resumable Generation。
2. 删除 `plugins/SillyTavern-ResumableGen` 文件夹，然后重启酒馆。如果没有其他服务端插件，可以把 `enableServerPlugins` 改回 `false`。

## 注意事项

- **白名单**：插件通过 `127.0.0.1` / `::1` 访问酒馆自己。如果你改过 `config.yaml` 里的 `whitelist`，请确保保留这两个地址（默认就有）。
- **任务保存在内存里**：酒馆重启后，所有任务都会丢失。已完成但没有被收取的结果保留 1 小时，单个任务最多运行 30 分钟。
- **多用户模式下**，每个用户只能看到自己的任务。
- **非流式请求的重试进度**：生成完成前页面上还没有对应的消息，所以要等生成完成后才会显示。
- **恢复弹窗的范围**：只对当前打开的聊天弹出，不包括后台静默生成（例如总结）。
- **跨设备**：在另一台设备上打开同一个聊天时：
  - 如果生成还在进行，会显示一个提示（含自动重试进度），完成后自动弹出恢复窗口。
  - 如果原页面还开着，它会自己保存回复，这边只提示"点此刷新聊天"，不会重复弹恢复窗口。
  - 如果原设备的页面没被杀、只是被冻结（例如 iOS 切后台），它回来后也会写入，可能产生重复消息，删掉一条即可。

## 许可证

[AGPL-3.0](LICENSE)，与 SillyTavern 相同。

---

## English

Keeps SillyTavern generation requests running on the server so the browser can reconnect after its connection drops — most notably when iOS suspends a backgrounded tab.

- A dropped stream resumes transparently from the last received byte.
- If the page was killed and reloaded, finished results can be recovered into the chat as a new message or swipe.
- Closing or reloading the page does not stop the generation (so you can switch devices); only the Stop button cancels it. An option to stop on close is available in the extension settings.
- Pressing Stop also cancels the request on the server.
- Time spent suspended in the background doesn't count toward the message's generation timer.
- Optional: retry empty replies (e.g. blocked by a content filter) on the server, with progress shown under the message's token counter. Enable it under Extensions → Resumable Generation.

The project has **two parts in one repository, and both are required**:

1. **Server plugin** — clone this repository into `SillyTavern/plugins`, set `enableServerPlugins: true` in `config.yaml` (or `SILLYTAVERN_ENABLESERVERPLUGINS=true` for Docker), and restart SillyTavern.

   ```bash
   cd SillyTavern/plugins
   git clone https://github.com/Sakura-Byte/SillyTavern-ResumableGen
   ```

2. **UI extension** — in SillyTavern, open Extensions → Install extension and paste `https://github.com/Sakura-Byte/SillyTavern-ResumableGen`.

If the server plugin is missing or incompatible, the extension shows a warning and falls back to normal (non-resumable) requests.

> Server plugins run with full server privileges. Review `server/index.cjs` before installing.

The plugin calls SillyTavern's own generate endpoints over loopback (`127.0.0.1` / `::1`), so keep those in your `whitelist` if you customised it. Jobs are kept in memory only and are lost on restart.

License: AGPL-3.0.
