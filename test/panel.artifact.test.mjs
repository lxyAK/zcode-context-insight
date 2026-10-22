// @vitest-environment happy-dom
/**
 * 产物缝回归：构建后的 dist/ui/panel.html 必须真正可执行并发起 ui/initialize 握手。
 *
 * 缘起（0.1.1–0.1.4 全部中招）：build.mjs 用字符串 replace 把 JS 拼进模板，替换串里的
 * $& 是 replace 特殊模式（= 被匹配原文）；uPlot 压缩产物里变量 $ 的 && 连写恰好构成 $&，
 * 4 处被替换成占位符 <!--ZCI_JS--> 注入产物。<!-- 在经典脚本中开启 HTML 注释、吞掉单行
 * 压缩脚本的其余部分 → 面板静默语法死亡 → 宿主 ui/initialize 握手超时。
 * 源码缝测试（mountPanel + mock 桥）对拼接损坏不可见，必须打到产物本体。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ARTIFACT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "ui", "panel.html");

/** 装载产物：先放无脚本的 DOM，再逐块执行脚本（复现宿主 iframe 解析执行路径） */
async function bootArtifact() {
  const html = readFileSync(ARTIFACT_PATH, "utf8");
  const { Browser } = await import("happy-dom");
  const browser = new Browser({ settings: { disableCSSFileLoading: true } });
  const page = browser.newPage();
  const win = page.mainFrame.window;
  page.url = "https://zcode-sandbox.invalid/instance/test/";

  const posted = [];
  const errors = [];
  win.console.error = (...a) => errors.push(a.map(String).join(" "));
  win.addEventListener("error", (e) => errors.push(e.error?.stack || e.message));
  // happy-dom 中 window.parent === window：postMessage(msg,"*") 异步回派发 message 事件
  win.addEventListener("message", (e) => {
    const msg = e.data;
    if (!msg?.jsonrpc) return;
    posted.push(msg);
    // mock 宿主应答握手，让挂载流程继续（工具调用悬置即可）
    if (msg.method === "ui/initialize") {
      queueMicrotask(() => {
        win.dispatchEvent(
          new MessageEvent("message", {
            data: { jsonrpc: "2.0", id: msg.id, result: { hostInfo: { name: "mock-host", version: "0" } } },
          }),
        );
      });
    }
  });

  page.content = html.replace(/<script[\s\S]*?<\/script>/g, "");
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const evalErrors = [];
  for (const s of scripts) {
    try {
      win.eval(s);
    } catch (err) {
      evalErrors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { browser, posted, errors: [...errors, ...evalErrors] };
}

describe("面板产物 panel.html（拼接后缝）", () => {
  it("脚本块不含 HTML 注释起始符（占位符泄漏/<!-- 吞码类损坏）", () => {
    const html = readFileSync(ARTIFACT_PATH, "utf8");
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) {
      expect(s).not.toContain("<!--");
    }
  });

  it("产物可执行并发起 ui/initialize 握手（JSON-RPC over postMessage）", async () => {
    const { browser, posted, errors } = await bootArtifact();
    await new Promise((r) => setTimeout(r, 600));
    await browser.close();

    expect(errors, `产物执行错误: ${errors.join(" | ")}`).toEqual([]);
    const init = posted.find((m) => m.method === "ui/initialize");
    expect(init, "未发出 ui/initialize——产物脚本未执行或语法损坏").toBeTruthy();
    expect(init.params?.protocolVersion, "协议版本缺失").toBeTruthy();
    expect(init.params?.appInfo?.name).toBe("zcode-context-insight");
  });
});
