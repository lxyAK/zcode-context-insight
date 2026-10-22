/**
 * server e2e 冒烟：以真实 stdio JSON-RPC 驱动构建产物 dist/server.mjs。
 * 测试 seam：MCP stdio 协议（宿主与 server 之间的公共接口），不触及内部模块。
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

/** e2e 设置夹具目录：settings.json 读写往返的真值落点（测试隔离，绝不触碰真实数据目录） */
const e2eTmp = mkdtempSync(join(tmpdir(), "zci-e2e-"));
afterAll(() => rmSync(e2eTmp, { recursive: true, force: true }));

/** 起一个 MCP stdio 子进程，返回按 id 匹配响应的极简 JSON-RPC 客户端 */
async function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, ["dist/server.mjs"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    // 红线隔离：e2e 不读真实宿主库，默认注入不存在的 db/心跳路径（工具应走 available=false 降级）；
    // 设置注入临时文件、rollout 指向不存在目录（T12 watcher 容错降级，且绝不 watch 真实宿主目录）；
    // extraEnv 可注入仓库内合成夹具（绝不指向 ~/.zcode 真实数据），覆盖默认隔离路径
    env: {
      ...process.env,
      ZCI_DB_PATH: join(repoRoot, "test", "fixtures", "e2e-absent.sqlite"),
      ZCI_HEARTBEAT_PATH: join(repoRoot, "test", "fixtures", "e2e-absent.json"),
      ZCI_SETTINGS_PATH: join(e2eTmp, "settings.json"),
      ZCI_ROLLOUT_DIR: join(e2eTmp, "absent-rollout"),
      ...extraEnv,
    },
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => stderr.push(d));

  const pending = new Map(); // id -> {resolve, reject}
  let nextId = 1;
  const buffer = { text: "" };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer.text += chunk;
    let nl;
    while ((nl = buffer.text.indexOf("\n")) >= 0) {
      const line = buffer.text.slice(0, nl).trim();
      buffer.text = buffer.text.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 非 JSON-RPC 行（SDK 日志等）忽略
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  });

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const request = (method, params, timeoutMs = 15000) => {
    const id = nextId++;
    const p = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`请求超时: ${method}; stderr: ${stderr.join("")}`));
        }
      }, timeoutMs).unref?.();
    });
    send({ jsonrpc: "2.0", id, method, params });
    return p;
  };
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

  const close = () => {
    for (const { reject } of pending.values()) reject(new Error("server closed"));
    pending.clear();
    child.kill();
  };
  return { request, notify, close, stderr };
}

let server;
afterAll(() => server?.close());

describe("MCP server（stdio e2e）", () => {
  it("initialize 握手成功并声明 tools/resources 能力", async () => {
    server = await startServer();
    const result = await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "zci-e2e-test", version: "0.0.0" },
    });
    server.notify("notifications/initialized", {});
    expect(result.serverInfo.name).toBe("zcode-context-insight");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.capabilities.resources).toBeDefined();
  }, 30000);

  // 可见性分标（spec Implementation Decisions：面板专用工具标记 app 可见；
  // 供模型调用的工具标记 model 可见）。get_overview 是面板连通性探针 → 仅 app。
  it("tools/list 含示例工具 get_overview，且 _meta.ui.visibility 标记 app 可见", async () => {
    const result = await server.request("tools/list", {});
    const tool = result.tools.find((t) => t.name === "get_overview");
    expect(tool, `工具列表: ${JSON.stringify(result.tools.map((t) => t.name))}`).toBeTruthy();
    expect(tool.description).toBeTruthy();
    const visibility = tool._meta?.ui?.visibility;
    expect(Array.isArray(visibility)).toBe(true);
    expect(visibility).toContain("app");
  });

  it("tools/call get_overview 返回插件名与版本，版本与 package.json 一致", async () => {
    const result = await server.request("tools/call", {
      name: "get_overview",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe("text");
    const payload = JSON.parse(result.content[0].text);
    expect(payload.plugin).toBe("zcode-context-insight");
    expect(payload.version).toBe(pkg.version); // 独立真值来源：package.json
    expect(typeof payload.greeting).toBe("string");
    expect(payload.greeting.length).toBeGreaterThan(0);
  });

  // 面板专用工具可见性分标（spec：面板专用 → ["app"]）
  it("tools/list 含 get_current_session_usage，仅 app 可见（面板专用分标）", async () => {
    const result = await server.request("tools/list", {});
    const tool = result.tools.find((t) => t.name === "get_current_session_usage");
    expect(tool, `工具列表: ${JSON.stringify(result.tools.map((t) => t.name))}`).toBeTruthy();
    expect(tool._meta?.ui?.visibility).toEqual(["app"]);
  });

  it("tools/list 含 get_insights，仅 app 可见（面板专用分标）", async () => {
    const result = await server.request("tools/list", {});
    const tool = result.tools.find((t) => t.name === "get_insights");
    expect(tool, `工具列表: ${JSON.stringify(result.tools.map((t) => t.name))}`).toBeTruthy();
    expect(tool._meta?.ui?.visibility).toEqual(["app"]);
  });

  it("tools/list 含 get_activity_insights，仅 app 可见（面板专用分标）", async () => {
    const result = await server.request("tools/list", {});
    const tool = result.tools.find((t) => t.name === "get_activity_insights");
    expect(tool, `工具列表: ${JSON.stringify(result.tools.map((t) => t.name))}`).toBeTruthy();
    expect(tool._meta?.ui?.visibility).toEqual(["app"]);
  });

  it("tools/call get_insights（db 缺失时）降级 available=false，不报错", async () => {
    const result = await server.request("tools/call", {
      name: "get_insights",
      arguments: { sort: "tokens", limit: 10 },
    });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(payload.available).toBe(false);
    expect(payload.reason).toBe("db-not-found");
  });

  it("tools/call get_activity_insights（db 缺失时）降级 available=false，不报错", async () => {
    const result = await server.request("tools/call", {
      name: "get_activity_insights",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(payload.available).toBe(false);
    expect(payload.reason).toBe("db-not-found");
  });

  it("tools/call get_current_session_usage（db 缺失时）降级 available=false，不报错", async () => {
    const result = await server.request("tools/call", {
      name: "get_current_session_usage",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(payload.available).toBe(false);
    expect(payload.reason).toBe("db-not-found");
  });

  it("tools/list 含 get_session_timeline，仅 app 可见（面板专用分标）", async () => {
    const result = await server.request("tools/list", {});
    const tool = result.tools.find((t) => t.name === "get_session_timeline");
    expect(tool, `工具列表: ${JSON.stringify(result.tools.map((t) => t.name))}`).toBeTruthy();
    expect(tool._meta?.ui?.visibility).toEqual(["app"]);
  });

  it("tools/call get_session_timeline（db 缺失时）降级 available=false，不报错", async () => {
    const result = await server.request("tools/call", {
      name: "get_session_timeline",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(payload.available).toBe(false);
    expect(payload.reason).toBe("db-not-found");
    expect(payload.requests).toBeNull();
    expect(payload.compactions).toBeNull();
  });

  it("tools/list 含 get_session_stats，仅 app 可见（面板专用分标）", async () => {
    const result = await server.request("tools/list", {});
    const tool = result.tools.find((t) => t.name === "get_session_stats");
    expect(tool, `工具列表: ${JSON.stringify(result.tools.map((t) => t.name))}`).toBeTruthy();
    expect(tool._meta?.ui?.visibility).toEqual(["app"]);
  });

  it("tools/list 含 get_current_session_report（/context 后端），model+app 双可见（验收项 3 前置）", async () => {
    const result = await server.request("tools/list", {});
    const tool = result.tools.find((t) => t.name === "get_current_session_report");
    expect(tool, `工具列表: ${JSON.stringify(result.tools.map((t) => t.name))}`).toBeTruthy();
    expect(tool.description).toBeTruthy();
    // model 必须在可见列表（命令正文指示模型调用本工具）
    expect(tool._meta?.ui?.visibility).toContain("model");
    expect(tool._meta?.ui?.visibility).toContain("app");
  });

  it("可见性分标（spec：面板专用 app / 供模型调用 model）：面板专用工具仅 app，/context 后端保持 model+app", async () => {
    const result = await server.request("tools/list", {});
    const byName = Object.fromEntries(result.tools.map((t) => [t.name, t._meta?.ui?.visibility]));
    // 唯一供模型调用的工具：/context 命令正文指示模型调用（commands/context.md）
    expect(byName.get_current_session_report).toEqual(["model", "app"]);
    // 其余全部为面板专用：app 可见、不标 model
    for (const [name, visibility] of Object.entries(byName)) {
      if (name === "get_current_session_report") continue;
      expect(visibility, `${name} 应为面板专用分标`).toEqual(["app"]);
    }
  });

  it("tools/call get_session_stats（db 缺失时）降级 available=false，不报错", async () => {
    const result = await server.request("tools/call", {
      name: "get_session_stats",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(payload.available).toBe(false);
    expect(payload.reason).toBe("db-not-found");
  });

  it("tools/list 含 get_fleet_tree，仅 app 可见（面板专用分标）", async () => {
    const result = await server.request("tools/list", {});
    const tool = result.tools.find((t) => t.name === "get_fleet_tree");
    expect(tool, `工具列表: ${JSON.stringify(result.tools.map((t) => t.name))}`).toBeTruthy();
    expect(tool._meta?.ui?.visibility).toEqual(["app"]);
  });

  it("tools/call get_fleet_tree（db 缺失时）降级 available=false，不报错", async () => {
    const result = await server.request("tools/call", {
      name: "get_fleet_tree",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(payload.available).toBe(false);
    expect(payload.reason).toBe("db-not-found");
    expect(payload.root).toBeNull();
  });

  it("tools/list 含 T7 工具 get_session_events / get_session_file_activity，仅 app 可见（面板专用分标）", async () => {
    const result = await server.request("tools/list", {});
    for (const name of ["get_session_events", "get_session_file_activity"]) {
      const tool = result.tools.find((t) => t.name === name);
      expect(tool, `工具列表: ${JSON.stringify(result.tools.map((t) => t.name))}`).toBeTruthy();
      expect(tool._meta?.ui?.visibility).toEqual(["app"]);
    }
  });

  it("tools/call T7 工具（db 缺失时）降级 available=false，不报错", async () => {
    for (const name of ["get_session_events", "get_session_file_activity"]) {
      const result = await server.request("tools/call", { name, arguments: {} });
      expect(result.isError).toBeFalsy();
      const payload = result.structuredContent ?? JSON.parse(result.content[0].text);
      expect(payload.available).toBe(false);
      expect(payload.reason).toBe("db-not-found");
    }
  });

  it("resources/read 以 mcp-app MIME 返回自包含的 panel.html", async () => {
    const result = await server.request("resources/read", {
      uri: "ui://zcode-context-insight/panel.html",
    });
    const [content] = result.contents;
    expect(content.uri).toBe("ui://zcode-context-insight/panel.html");
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content.text).toContain('id="root"');
  });
});

describe("MCP server e2e：设置与数据版本工具（T12）", () => {
  it("tools/list 含 get_settings/set_settings/get_data_version；set_settings 标注 readOnlyHint=false", async () => {
    const result = await server.request("tools/list", {});
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("get_settings");
    expect(names).toContain("set_settings");
    expect(names).toContain("get_data_version");

    const setTool = result.tools.find((t) => t.name === "set_settings");
    expect(setTool.annotations?.readOnlyHint).toBe(false); // 写操作工具不得宣称只读
    const getTool = result.tools.find((t) => t.name === "get_settings");
    expect(getTool.annotations?.readOnlyHint).toBe(true);
  });

  it("设置读写往返：set → get 读回一致；非法枚举回退默认并提示", async () => {
    const set = await server.request("tools/call", {
      name: "set_settings",
      arguments: { defaultView: "fleet", trendGranularity: "weekly" },
    });
    expect(set.isError).toBeFalsy();
    const setPayload = set.structuredContent;
    expect(setPayload.available).toBe(true);
    expect(setPayload.settings.defaultView).toBe("fleet"); // 合法值生效
    expect(setPayload.settings.trendGranularity).toBe("request"); // 未知枚举回退默认
    expect(setPayload.warnings.some((w) => w.includes("trendGranularity"))).toBe(true);

    const get = await server.request("tools/call", { name: "get_settings", arguments: {} });
    const getPayload = get.structuredContent;
    expect(getPayload.available).toBe(true);
    expect(getPayload.settings).toEqual(setPayload.settings); // 持久化后读回一致
    // 独立真值来源：落盘文件内容
    const onDisk = JSON.parse(readFileSync(join(e2eTmp, "settings.json"), "utf8"));
    expect(onDisk).toEqual(setPayload.settings);
  });

  it("get_data_version 返回整数版本与监听状态（rollout 目录缺失 → 该源 watching=false 容错）", async () => {
    const result = await server.request("tools/call", {
      name: "get_data_version",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent;
    expect(Number.isInteger(payload.dataVersion)).toBe(true);
    expect(payload.dataVersion).toBeGreaterThanOrEqual(1);
    // db 源监听 fixtures 目录（存在 → true，监听建立即可，文件缺失不妨碍将来感知）；
    // rollout 源注入不存在目录 → 如实降级 false
    expect(payload.watching).toEqual({ db: true, rollout: false });
  });
});

describe("MCP server e2e：get_current_session_composition（T3）", () => {
  it("tools/list 含 get_current_session_composition，仅 app 可见（面板专用分标）", async () => {
    const result = await server.request("tools/list", {});
    const tool = result.tools.find((t) => t.name === "get_current_session_composition");
    expect(tool, `工具列表: ${JSON.stringify(result.tools.map((t) => t.name))}`).toBeTruthy();
    expect(tool._meta?.ui?.visibility).toEqual(["app"]);
  });

  it("无会话识别来源（无心跳且 db 缺失）时降级 available=false，不报错", async () => {
    const result = await server.request("tools/call", {
      name: "get_current_session_composition",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(payload.available).toBe(false);
    expect(payload.reason).toBe("no-session");
  });

  it("夹具 env 注入（ZCI_DB_PATH/ZCI_HEARTBEAT_PATH/ZCI_ROLLOUT_DIR）全链路返回组成估算", async () => {
    // 独立 server 实例：env 缝注入仓库内合成夹具（期望值同 test/composition.test.mjs 手算常量）
    const fixtureServer = await startServer({
      ZCI_DB_PATH: join(repoRoot, "test", "fixtures", "db.sqlite"),
      ZCI_HEARTBEAT_PATH: join(repoRoot, "test", "fixtures", "heartbeat.json"),
      ZCI_ROLLOUT_DIR: join(repoRoot, "test", "fixtures", "rollout"),
    });
    try {
      await fixtureServer.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "zci-e2e-test", version: "0.0.0" },
      });
      fixtureServer.notify("notifications/initialized", {});
      const result = await fixtureServer.request("tools/call", {
        name: "get_current_session_composition",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const payload = result.structuredContent ?? JSON.parse(result.content[0].text);
      expect(payload.available).toBe(true);
      expect(payload.session.id).toBe("session_00000000000000000000000000000001");
      expect(payload.session.source).toBe("heartbeat");
      expect(payload.rollout.requests).toEqual({ total: 5, full: 2, delta: 2, tail: 1, other: 0 });
      expect(payload.anchor.requestId).toBe("req-main-3");
      expect(payload.exactTotalTokens).toBe(625);
      expect(payload.composition.estimated).toBe(true);
      expect(payload.composition.calibrated).toEqual({ system: 100, tools: 137, history: 236, currentTurn: 152 });
      // 锚点校准不变量：Σcalibrated === 精确锚点
      const sum = Object.values(payload.composition.calibrated).reduce((a, b) => a + b, 0);
      expect(sum).toBe(payload.exactTotalTokens);
    } finally {
      fixtureServer.close();
    }
  }, 30000);
});
