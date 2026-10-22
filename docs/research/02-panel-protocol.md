# 02 MCP Apps 面板协议（从 pdf/office-runtime 面板实测逆向）

调查对象：`C:\Users\86176\.zcode\cli\plugins\cache\zcode-plugins-official\pdf\0.2.1\dist\`（server.mjs 5.1MB 单文件 + ui/ 面板资产）。documents/presentations/spreadsheets 同构。

## 1. 总体架构

```
宿主(Electron) ──(stdio JSON-RPC/MCP)── 插件 MCP server (dist/server.mjs)
     │                                        │  registerResource("panel", "ui://pdf/panel.html")
     │                                        │  registerResource(assets 模板, "ui://pdf/assets/{+name}")
     ▼                                        ▼
<webview 加载 ui://pdf/panel.html>  ←内容经 resources/read 传输
     │  panel.html 内嵌自举 JS：
     │  1. new App() → connect(Transport(window.parent))
     │  2. request("ui/initialize") → 拿 hostCapabilities/hostContext
     │  3. notification("ui/notifications/initialized")
     │  4. readServerResource("ui://pdf/assets/assets.json") 取脚本清单
     │  5. 逐个 readServerResource 取 JS/CSS 文本 → 注入 <script>/<style>
     └─之后一切交互 = JSON-RPC over postMessage
```

## 2. 传输层（postMessage 桥）

面板 bundle 内嵌的 transport 类（pdf panel.html 偏移约 572600）：

```js
// 接收：window "message" 事件，数据必须是合法 JSON-RPC 2.0（zod 严格校验，非法消息打 console.error 后丢弃）
// 发送：window.parent.postMessage(jsonRpcMessage, "*")
//     eventTarget 默认 window.parent；源过滤：若指定 eventSource 则校验 o.source
class Transport {
  constructor(t = window.parent, n) { this.eventTarget = t; this.eventSource = n; ... }
  async start() { window.addEventListener("message", this.messageListener); }
  async send(t, n) { this.eventTarget.postMessage(t, "*"); }
  async close() { window.removeEventListener("message", this.messageListener); this.onclose?.(); }
}
```

- 无 MessageChannel、无自定义全局变量（`__zcode` 等均不存在）——**协议就是纯 JSON-RPC 2.0 over window.parent.postMessage**。
- 协议版本常量：`"2026-01-26"`（`ui/initialize` 请求的 protocolVersion 字段）。

## 3. 握手序列（App.connect，pdf bundle 原文还原）

```js
const app = new AppClient(
  { name: "pdf", version: "0.2.1" },                    // appInfo
  { tools: { listChanged: true }, availableDisplayModes: ["inline", "fullscreen"] }, // appCapabilities
  { autoResize: false }                                  // options；true 时自动上报尺寸(ui/*size 通知)
);
await app.connect(new Transport(window.parent, window.parent));
// connect 内部依次：
// 1. request { method: "ui/initialize",
//              params: { appCapabilities, appInfo, protocolVersion: "2026-01-26" } }
//    → result: { hostCapabilities, hostInfo, hostContext }
// 2. notification { method: "ui/notifications/initialized" }
// 3. this._initializedSent = true（此后才允许 callServerTool 等，否则 _assertInitialized 抛错）
```

- `hostCapabilities.experimental["zcode/surface"].stateKey`：**stateKey 用法**——宿主分配的面板状态键，面板用它做 `localStorage` 键持久化自身状态（打开的文件、最近列表）。pdf 的读写封装：`readWindow(){ return JSON.parse(localStorage.getItem(stateKey) ?? '{}') }`，写入时按 `windows:v1` 前缀 + 128 条上限环形清理。同一面板会话内 stateKey 稳定（配合 `crypto.randomUUID()` 兜底，pagehide 时把该 viewId 的服务端状态 release 掉）。
- `hostContext`：宿主上下文（含主题 light/dark、locale 等），变化时触发 `onhostcontextchanged` 事件。
- 主题：宿主注入 CSS 自定义属性（枚举见 bundle zod schema）：`--color-background-primary/secondary/tertiary/inverse/ghost/info/danger/success/warning/disabled`、`--color-text-*`、`--color-border-*`、`--color-ring-*`。**面板样式一律引用这些变量**，深浅色自动适配。
- 显示模式：`inline` / `fullscreen` / `pip`（zod 枚举）；appCapabilities 声明自己支持哪些。

## 4. 面板可用的宿主 API（AppClient 方法 → JSON-RPC method）

从 pdf bundle 的 AppClient 类逐个提取（均为 `request`/`notification` 封装，均需初始化后调用）：

| 方法 | JSON-RPC | 用途 |
|---|---|---|
| `callServerTool({name, arguments})` | `tools/call` | **调插件自己 MCP server 的工具**（注意第一参数是对象，传字符串会抛错并提示） |
| `readServerResource({uri})` | `resources/read` | 读 server 注册的资源（面板加载资产就靠它） |
| `listServerResources(params)` | `resources/list` | 列资源 |
| `createSamplingMessage(params)` | `sampling/createMessage` | 让宿主模型生成（需宿主支持 sampling） |
| `sendMessage(params)` | `ui/message` | 向对话/宿主发消息 |
| `sendLog(params)` | `notifications/message` | 日志通知 |
| `updateModelContext(params)` | `ui/update-model-context` | 更新模型上下文 |
| `openLink(params)` | `ui/open-link` | 打开链接（别名 sendOpenLink） |
| `downloadFile(params)` | `ui/download-file` | 触发下载 |
| `requestTeardown()` | `ui/notifications/request-teardown` | 请求关闭自己 |
| 面板注册工具（反向） | `oncalltool`/`onlisttools` 处理 `tools/call`/`tools/list` | **宿主/模型可以调用面板内实现的工具**（pdf 的 `capture_view` 就在面板里渲染后截图）；`registerTool(name,{title,description,inputSchema,...},handler)` + `sendToolListChanged()` 动态增删 |
| 事件 | `ontoolresult` / `onhostcontextchanged` / `onteardown` / `ontoolinput` 等 | 宿主→面板通知 |

**对本项目最有用的是反向工具 + ontoolresult**：server 端 `open_dashboard` 等模型可见工具只做数据准备，面板注册 `capture_state` 类工具；更简单的主路径是面板轮询/主动 `callServerTool({name:"get_dashboard_data", arguments:{...}})`。

## 5. CSP / 资产加载约束与打包方式（关键）

**面板不能直接用相对路径引本地文件，也不能访问网络**。资产全部经 MCP `resources/read` 以 `ui://` URI 传输，由自举 JS 注入 DOM：

pdf panel.html 尾部自举（原文还原，`$d()` 返回单例 host 对象）：

```js
async function loadAssetText(name) {           // zd()
  const host = getHost(); await host.ready();
  const res = (await host.app.readServerResource({ uri: `ui://pdf/assets/${name}` })).contents[0];
  if (typeof res.text !== "string") throw new Error(`Asset ${name} is not text`);
  return res.text;
}
(async () => {
  const host = getHost();                       // 构造 AppClient + 注册面板工具，不 connect
  const assets = JSON.parse(await loadAssetText("assets.json"));   // {"scripts":["bundle-0.txt"],"scriptBytes":1262573}
  const [css, ...scripts] = await Promise.all([
    loadAssetText("panel.css"), ...assets.scripts.map(loadAssetText)
  ]);
  const style = document.createElement("style"); style.textContent = css; document.head.append(style);
  const sc = document.createElement("script"); sc.textContent = scripts.join(""); document.body.append(sc);
})().catch(e => { /* root div 显示 "PDF failed to load: ..." */ });
```

- **JS 资产命名为 `.txt`**（`bundle-0.txt`）是有意为之：绕开任何外链脚本限制，取回文本后以 inline `<script>` 注入执行。
- 二进制资产（字体/pdfjs/wasm）经同一 resources/read 以 base64 `blob` 返回（server 端按扩展名分流：`.txt/.css/.json/.js` 走 `text`，其余走 base64 blob，见 server.mjs 偏移约 5095630 的 assets handler）。
- server 端 panel 资源声明（含 CSP 放行开关，server.mjs 原文）：

```js
const panelMeta = { "zcode/csp": { wasmUnsafeEval: true } };   // 需要 wasm/非安全 eval 时才加
server.registerResource("panel", "ui://pdf/panel.html",
  { mimeType: "text/html;profile=mcp-app", _meta: panelMeta },
  async () => ({ contents: [{ uri: "ui://pdf/panel.html",
    mimeType: "text/html;profile=mcp-app",
    text: await readFile(join(assetRoot, "panel.html"), "utf8"), _meta: panelMeta }] }));

server.registerResource("assets", new ResourceTemplate("ui://pdf/assets/{+name}", { list: undefined }),
  {}, async (uri) => { /* 路径安全校验 isAssetName 后按扩展名分流 text/blob */ });

// 大文件给面板传数据的第三通道：ui://pdf/file/{token}/{index} 4MB 分块 base64
```

- HTML MIME 是 `text/html;profile=mcp-app`——宿主据此按 MCP App 面板加载。
- 本项目无 wasm/eval 需求（uPlot 是纯 JS），不加 `zcode/csp`。

### uPlot 等第三方库如何进面板

两条路（推荐 A）：
- **A. 全量内联（最简）**：构建期用 esbuild 把 panel.ts + uPlot 打成**一个** JS 字符串，直接嵌进 panel.html 的 `<script>` 标签（模板注入），面板就无需 assets.json/readServerResource 自举，加载即运行；CSS 同理内联 `<style>`。文件大（uPlot min ~140KB）但无网络/无外链约束下最稳。
- **B. office-runtime 模式（按需加载）**：`dist/ui/` 放 `assets.json` + `vendor/uplot.min.js`（可改名 .txt 也可保持 .js——server 对 .js 也走 text），自举 JS `readServerResource` 取回后 inline 注入。多面板视图懒加载时才有必要。
- 字体/图片等二进制走 base64 blob 通道，能免则免（体积×4/3）。

## 6. 最小可运行 panel.html 骨架

以下骨架按 pdf 真实写法裁剪，**协议部分（Transport/connect/initialize/callServerTool）是逐字对照 bundle 还原的**；`AppClient` 实现建议直接用 `@modelcontextprotocol/client` 的 Apps/UI 扩展（pdf 打包进去的正是 `@modelcontextprotocol/client/dist/src-D_zzAWoS.mjs`），不要手写整套 JSON-RPC：

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Context Insight</title>
  <style>
    html, body, #root { margin: 0; height: 100%; font: 13px system-ui, sans-serif; }
    /* 颜色一律用宿主变量：var(--color-background-primary), var(--color-text-primary) ... */
    #root { color: var(--color-text-primary); background: var(--color-background-primary); }
  </style>
</head>
<body>
  <div id="root">Loading…</div>
  <script>
    "use strict";
    // === 构建期注入：esbuild 把 app.bundle.js 内容作为文本填入下述 IIFE ===
    (() => {
      // 1) Transport：JSON-RPC over postMessage
      class Transport {
        constructor(target = window.parent) { this.target = target; }
        async start() {
          this._listener = (ev) => { /* zod/手写校验 ev.data 是 JSON-RPC 2.0 后 */ this.onmessage?.(ev.data); };
          window.addEventListener("message", this._listener);
        }
        async send(msg) { this.target.postMessage(msg, "*"); }
        async close() { window.removeEventListener("message", this._listener); this.onclose?.(); }
      }
      // 2) AppClient 建议直接打包 @modelcontextprotocol/client（含 Apps 扩展）。
      //    语义（对照 pdf bundle）：
      const app = new AppClient(
        { name: "zcode-context-insight", version: "0.1.0" },
        { tools: { listChanged: true }, availableDisplayModes: ["inline", "fullscreen"] },
        {}
      );
      app.onhostcontextchanged = () => render(app.getHostContext());
      app.ready = () => app.connect(new Transport(window.parent, window.parent))
        .then(() => console.debug("surface ready"));
      // 3) 面板反向工具（可选）：app.onlisttools / app.oncalltool
      // 4) 取数：app.callServerTool({ name: "get_session_dashboard", arguments: { sessionId } })
      //    → { content: [{type:"text", text:JSON}], structured: {...} }
      // 5) stateKey 持久化：
      //    const sk = app.getHostCapabilities()?.experimental?.["zcode/surface"]?.stateKey;
      //    localStorage.setItem(sk, JSON.stringify(state));
      // 6) 卸载：window.addEventListener("pagehide", () => app.callServerTool(
      //        { name: "release_view", arguments: { viewId } }).catch(() => {}));
      window.__panel = { app, ready: app.ready() };
      app.ready().then(init);
    })();
  </script>
</body>
</html>
```

要点回顾：先 connect/initialize 完成才能 callServerTool；宿主没有 fetch/XHR 网络权限的假设按最保守处理（pdf 面板所有数据都走 MCP 资源/工具，不发任何 http）；调试可用 `console.debug/log`（宿主把 panel console 转发到 ZCode 日志，pdf 大量使用）。

## 7. server 侧必须实现的最小面（对照 office-runtime）

1. stdio MCP server，capabilities: `{ tools: {...}, resources: {} }`。
2. `registerResource("panel", "ui://<plugin-name>/panel.html", {mimeType: "text/html;profile=mcp-app"}, ...)` 返回 HTML 文本。
3. （若资产外置）`ResourceTemplate("ui://<plugin-name>/assets/{+name}")`。
4. 面板数据工具（`visibility: ["app"]` 或 `["model","app"]`，`_meta.ui` 见 01 笔记 §6）。
5. 面板打开入口工具：`_meta.ui = { resourceUri, surface, visibility: ["model","app"] }` + `_meta["openai/ui"]={preferredModelDisplayMode:"fullscreen"}`（模型说"打开仪表盘"时宿主自动开面板）。
6. resourceUri 常量与 plugin.json `ui.surfaces[].resourceUri` 必须完全一致（`ui://<name>/panel.html`）。

## 8. 待验证清单（面板相关）

- `availability` 除 `"session"` 外的取值（推测有 `global`，无实例）。
- `ui/initialize` 返回的 `hostContext` 完整字段（含 locale/theme 的确切键名）。
- 面板内 `console.*` 是否完整转发宿主日志（pdf 行为表明至少 debug/log 可用）。
- `@modelcontextprotocol/client` npm 包里 Apps/UI 扩展的公开 API 名（pdf bundle 是内嵌副本且已 minify，实现时以 npm 包 d.ts 为准；版本 2.0.0，见 browser-use package.json 依赖）。
- 同一插件多个 surfaces（本项目可能要 Insights / Dashboard / Fleet 多面板）：plugin.json surfaces 数组放多项即可，每个 surface 各自 resourceUri——无官方多面板实例，**待验证**。
