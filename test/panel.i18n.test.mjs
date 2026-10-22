/**
 * 面板文案中心（i18n 骨架）单测：
 * 锁定骨架契约——zh-CN 为默认且唯一语言、占位符替换、未知 locale 回落默认。
 * 后续工单迁移文案时，此处的骨架行为不应变化。
 */
import { describe, it, expect } from "vitest";
import { t, setLocale, getLocale, DEFAULT_LOCALE } from "../src/panel/i18n.ts";

describe("src/panel/i18n.ts（i18n 骨架）", () => {
  it("默认语言为 zh-CN（默认且当前唯一语言）", () => {
    expect(DEFAULT_LOCALE).toBe("zh-CN");
    expect(getLocale()).toBe("zh-CN");
  });

  it("t() 返回 zh-CN 文案", () => {
    expect(t("usageTitle")).toBe("当前会话精确用量");
    expect(t("badgeHeartbeat")).toBe("心跳精确");
    // 全部键值均为非空字符串（zh-CN 走查兜底）
    for (const key of [
      "brandName",
      "connectedHost",
      "footerSkeleton",
      "usageUnavailable",
      "loading",
      "toolCallFailed",
    ]) {
      expect(t(key).length).toBeGreaterThan(0);
    }
  });

  it("占位符 {name} 替换", () => {
    expect(t("connectedHost", { host: "zcode-host" })).toBe("已连接 zcode-host");
    expect(t("toolCallFailed", { message: "boom" })).toBe("工具调用失败: boom");
  });

  it("未知 locale 回落默认 zh-CN，注册 locale 可切换", () => {
    setLocale("fr-FR"); // 未注册语言：忽略
    expect(getLocale()).toBe("zh-CN");
    expect(t("usageTitle")).toBe("当前会话精确用量");
    setLocale("zh-CN"); // 已注册：正常（幂等）
    expect(getLocale()).toBe("zh-CN");
  });
});
