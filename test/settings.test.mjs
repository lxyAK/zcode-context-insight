/**
 * 设置工具功能缝基线（T12，工单预先约定的缝：in-process 直调工具 execute）。
 *
 * 设置形状（本票定义，对照 GLOSSARY 三视图与 T4/T3 口径）：
 *  - defaultView: "insights" | "context" | "fleet"（默认 insights）
 *  - trendGranularity: "request" | "turn" | "day"（默认 request，T4 逐请求趋势为基准口径）
 *  - estimationDensity: "coarse" | "balanced" | "detailed"（默认 balanced，组成估算密度）
 *
 * 红线对照：设置文件属插件自身数据目录（ZCODE_PLUGIN_DATA），可写；
 * 测试一律用临时目录夹具，绝不触碰 ~/.zcode 真实目录。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 期望的默认设置（独立手写常量，非经被测代码反推） */
const DEFAULTS = {
  defaultView: "insights",
  trendGranularity: "request",
  estimationDensity: "balanced",
};

function tempDir() {
  return mkdtempSync(join(tmpdir(), "zci-settings-"));
}

import { createGetSettingsTool } from "../src/server/tools/get_settings.ts";

async function callTool(deps, args = {}) {
  const tool = createGetSettingsTool(deps);
  const result = await tool.execute(args);
  return result.structuredContent;
}

describe("get_settings（读设置）", () => {
  it("settings.json 不存在：返回全部默认值，available=true", async () => {
    const dir = tempDir();
    try {
      const payload = await callTool({ settingsPath: join(dir, "settings.json") });

      expect(payload.available).toBe(true);
      expect(payload.settings).toEqual(DEFAULTS);
      expect(payload.defaults).toEqual(DEFAULTS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settings.json 存在合法值：原样读回（跨会话持久）", async () => {
    const dir = tempDir();
    try {
      const path = join(dir, "settings.json");
      // 手写合法设置文件（夹具真值：三个字段均取非默认枚举，验证读回不经默认值混淆）
      writeFileSync(path, JSON.stringify({
        defaultView: "fleet",
        trendGranularity: "day",
        estimationDensity: "coarse",
      }), "utf8");

      const payload = await callTool({ settingsPath: path });
      expect(payload.available).toBe(true);
      expect(payload.settings).toEqual({
        defaultView: "fleet",
        trendGranularity: "day",
        estimationDensity: "coarse",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settings.json 损坏（非法 JSON）：容错回退默认值，不抛错", async () => {
    const dir = tempDir();
    try {
      const path = join(dir, "settings.json");
      writeFileSync(path, '{"defaultView": "fle', "utf8"); // 半截 JSON

      const payload = await callTool({ settingsPath: path });
      expect(payload.available).toBe(true);
      expect(payload.settings).toEqual(DEFAULTS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settings.json 含未知枚举：该字段回退默认值", async () => {
    const dir = tempDir();
    try {
      const path = join(dir, "settings.json");
      // 只有 defaultView 合法，其余两字段是未来版本/手改产生的未知枚举
      writeFileSync(path, JSON.stringify({
        defaultView: "context",
        trendGranularity: "weekly",
        estimationDensity: 42,
      }), "utf8");

      const payload = await callTool({ settingsPath: path });
      expect(payload.settings).toEqual({
        defaultView: "context",
        trendGranularity: DEFAULTS.trendGranularity,
        estimationDensity: DEFAULTS.estimationDensity,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settingsPath 为空（宿主未注入插件数据目录）：available=false 降级，不抛错", async () => {
    const payload = await callTool({ settingsPath: "" });
    expect(payload.available).toBe(false);
    expect(typeof payload.reason).toBe("string");
    expect(payload.reason.length).toBeGreaterThan(0);
  });
});

describe("set_settings（写设置）", () => {
  it("合法全量更新：持久化到 settings.json，跨工具实例读回一致（跨会话持久）", async () => {
    const { createSetSettingsTool } = await import("../src/server/tools/set_settings.ts");
    const dir = tempDir();
    try {
      const path = join(dir, "settings.json");
      const write = (await createSetSettingsTool({ settingsPath: path }).execute({
        defaultView: "fleet",
        trendGranularity: "day",
        estimationDensity: "coarse",
      })).structuredContent;

      expect(write.available).toBe(true);
      expect(write.settings).toEqual({
        defaultView: "fleet",
        trendGranularity: "day",
        estimationDensity: "coarse",
      });

      // 独立真值来源：直接读文件内容（原子写后应为合法 JSON 且无 .tmp 残留）
      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      expect(onDisk).toEqual(write.settings);

      // 新工具实例（等价重启/重开面板）读回一致
      const read = await callTool({ settingsPath: path });
      expect(read.settings).toEqual(write.settings);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("部分更新：未提交字段保持原值（增量合并，非整体替换）", async () => {
    const { createSetSettingsTool } = await import("../src/server/tools/set_settings.ts");
    const dir = tempDir();
    try {
      const path = join(dir, "settings.json");
      await createSetSettingsTool({ settingsPath: path }).execute({ defaultView: "context" });
      const payload = (await createSetSettingsTool({ settingsPath: path }).execute({
        trendGranularity: "turn",
      })).structuredContent;

      expect(payload.settings).toEqual({
        defaultView: "context", // 上次写入保持
        trendGranularity: "turn", // 本次更新
        estimationDensity: DEFAULTS.estimationDensity, // 未动过 → 默认
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("非法枚举：该字段回退默认并提示（warnings），不抛错，合法字段正常生效", async () => {
    const { createSetSettingsTool } = await import("../src/server/tools/set_settings.ts");
    const dir = tempDir();
    try {
      const path = join(dir, "settings.json");
      const payload = (await createSetSettingsTool({ settingsPath: path }).execute({
        defaultView: "bogus-view",
        estimationDensity: "detailed",
      })).structuredContent;

      expect(payload.available).toBe(true);
      expect(payload.settings.defaultView).toBe("insights"); // 未知枚举回退默认
      expect(payload.settings.estimationDensity).toBe("detailed"); // 合法字段照常生效
      expect(payload.warnings.some((w) => w.includes("defaultView"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("空参数/全未知参数：settings 保持（默认）值，不误清空", async () => {
    const { createSetSettingsTool } = await import("../src/server/tools/set_settings.ts");
    const dir = tempDir();
    try {
      const path = join(dir, "settings.json");
      const payload = (await createSetSettingsTool({ settingsPath: path }).execute({})).structuredContent;
      expect(payload.available).toBe(true);
      expect(payload.settings).toEqual(DEFAULTS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settingsPath 为空或不可写目录：available=false 降级，不抛错", async () => {
    const { createSetSettingsTool } = await import("../src/server/tools/set_settings.ts");
    const empty = (await createSetSettingsTool({ settingsPath: "" }).execute({ defaultView: "fleet" })).structuredContent;
    expect(empty.available).toBe(false);
    expect(typeof empty.reason).toBe("string");

    // 目录不存在 → 写失败降级（而非半截 tmp 残留导致误判成功）
    const bad = (await createSetSettingsTool({
      settingsPath: join(tmpdir(), "zci-no-such-dir-xyz", "settings.json"),
    }).execute({ defaultView: "fleet" })).structuredContent;
    expect(bad.available).toBe(false);
  });
});
