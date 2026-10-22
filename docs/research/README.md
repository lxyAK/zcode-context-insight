# 宿主与插件协议研究笔记

spec #1 实现前的探索产出（2026-10-22，宿主基线 ZCode 3.16.2 / Windows），自仓库外笔记目录原样迁入。这些是对**宿主事实**的一手采样（manifest 格式、面板 MCP Apps 协议、db.sqlite 与 rollout JSONL 的真实 schema、心跳原型结论），宿主升级前长期有效；与代码无重复。

| 文件 | 内容 |
|---|---|
| `00-index.md` | 索引与工单映射（映射对应已完成的 T1–T14，作历史参考） |
| `01-plugin-format.md` | `.zcode-plugin/plugin.json` 各字段真实格式、hooks/commands/i18n/图标、工具可见性 `_meta.ui.visibility` |
| `02-panel-protocol.md` | 面板 postMessage JSON-RPC 桥、握手协议、callServerTool、stateKey、资产内联约束（uPlot 打包方案） |
| `03-host-data.md` | db.sqlite 全部相关表 schema 与脱敏样例、rollout JSONL 行结构（full/delta/tail）、心跳原型验证结论 |
| `04-adr-decisions.md` | ADR 浓缩摘要——已被 `docs/adr/` 取代，保留作索引 |
| `05-dev-loop.md` | CLI 入口与 dev 回路——已被 README「本地安装与 dev 回路」吸收，保留作补充 |

注意：笔记含本机绝对路径（`C:\Users\...`）与机器相关结论（如心跳脚本的 Git Bash 路径、marketplace source 的原生反斜杠要求），跨机器使用时需按笔记内标注自行验证。
