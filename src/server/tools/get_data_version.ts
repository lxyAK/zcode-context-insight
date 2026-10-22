/**
 * 工具 get_data_version（T12，app+model 双可见）：数据版本查询（自动刷新缝）。
 *
 * MCP Apps 面板协议无服务端推送：面板轻量轮询本工具比对 dataVersion，
 * 版本变化即重新拉取数据视图（秒级自动刷新）；手动刷新按钮兜底。
 * 其他数据视图（T4/T8 等）接入时同样经此缝感知数据变更。
 */
import { z } from "zod";
import type { ToolDefinition } from "../registry.ts";
import type { DataVersionWatcher } from "../watcher.ts";

/** 工具依赖（装配注入；测试注入 mock watcher） */
export interface GetDataVersionDeps {
  watcher: Pick<DataVersionWatcher, "getDataVersion" | "getWatching">;
}

export function createGetDataVersionTool(deps: GetDataVersionDeps): ToolDefinition {
  return {
    name: "get_data_version",
    title: "数据版本",
    description:
      "返回当前数据版本 dataVersion（初始 1，任一数据源 db.sqlite/rollout 变更后递增）" +
      "与各源监听状态 watching。面板轮询比对版本即可在数据变更后秒级自动刷新；" +
      "监听不可用时 watching 如实标注，消费方应回退手动刷新。",
    inputSchema: z.object({}),
    visibility: ["model", "app"],
    execute: async () => {
      const payload = {
        dataVersion: deps.watcher.getDataVersion(),
        watching: deps.watcher.getWatching(),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };
}
