/**
 * 面板入口：真实 webview 环境下挂载（构建打包为 IIFE 内联进 panel.html）。
 */
import "./panel.css";
import { mountPanel } from "./panel.ts";
import { t } from "./i18n.ts";

mountPanel({ win: window }).catch((err: unknown) => {
  const root = document.getElementById("root");
  if (root)
    root.textContent = t("panelLoadFailed", {
      message: err instanceof Error ? err.message : String(err),
    });
  console.error("[zci-panel] 挂载失败:", err);
});
