# SillyTavern Resumable Generation

[English](#english)

让 SillyTavern（酒馆）的 AI 生成请求在服务器上持续运行，浏览器连接断了也能续上。

主要解决的问题：**iOS / 手机浏览器切到后台后连接被断开，生成直接失败。** 装上之后：

- 切出去再切回来，流式输出会从断开的位置接着往下走，酒馆这边感知不到中断。
- 如果页面被系统彻底杀掉并重新加载了，回到同一个聊天时会弹窗，让你把后台已经完成的结果插入为新消息或新滑动（swipe）。
- 点"停止"按钮会同时取消服务器上的请求，不会白白消耗 API 额度。

支持的接口：Chat Completion、Text Completion、KoboldAI、NovelAI。

## 原理

酒馆的生成接口在浏览器断开连接时会主动中止上游请求，所以单靠前端扩展解决不了。本项目包含两部分，**放在同一个仓库里，两部分都要装**：

| 部分 | 作用 | 安装方式 |
| --- | --- | --- |
| 服务端插件（`server/`） | 在服务器上创建"生成任务"，通过本机回环连接调用酒馆原有的生成接口，并缓存输出，支持按偏移续传 | 克隆到酒馆的 `plugins` 目录 |
| 前端扩展（`client/`） | 接管生成请求，断线后自动续传；页面重载后提供恢复 | 在酒馆界面中用 git URL 安装 |

不修改酒馆的任何核心文件。

> **安全提示：** 服务端插件运行在酒馆的服务器进程里，拥有和酒馆一样的权限。这也是酒馆默认禁用服务端插件的原因。安装前请自行检查代码（只有 `server/index.cjs` 一个文件）。

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
- **恢复弹窗的范围**：只对当前打开的聊天弹出，不包括后台静默生成（例如总结）。
- **"继续"或"代拟"的恢复**：恢复弹窗只提供"新消息"和"新滑动"两种插入方式。如果被中断的是"继续"或"代拟"，请手动复制需要的内容。
- **跨设备**：在另一台设备上打开同一个聊天，也能看到恢复弹窗。但如果原设备的页面其实没被杀（只是被冻结），它回来后也会写入，可能产生重复消息，删掉一条即可。

## 许可证

[AGPL-3.0](LICENSE)，与 SillyTavern 相同。

---

## English

Keeps SillyTavern generation requests running on the server so the browser can reconnect after its connection drops — most notably when iOS suspends a backgrounded tab.

- A dropped stream resumes transparently from the last received byte.
- If the page was killed and reloaded, finished results can be recovered into the chat as a new message or swipe.
- Pressing Stop also cancels the request on the server.

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
