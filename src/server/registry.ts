/**
 * 工具注册表：后续工单的新工具只需在 tools/ 下新增文件并加入 tools 数组，
 * 不改动 main.ts 的装配逻辑（扩展缝）。
 */
import type { z } from "zod";

/** 工具执行结果（MCP tools/call 结果的子集；用 type 而非 interface 以满足 SDK 结果类型的索引签名） */
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/** 可见性：model=模型可调用；app=面板可经 callServerTool 调用 */
export type Visibility = Array<"model" | "app">;

/** 工具定义（注册表的公共形状） */
export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  /** 输入 schema（zod 对象）；无参工具用 z.object({}) */
  inputSchema: z.ZodObject;
  visibility: Visibility;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}
