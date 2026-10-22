# zcode-context-insight

ZCode 的上下文与 token 可视化插件：跨会话总览（Insights）、会话内 Context 仪表盘、代理网络（Fleet）与 /context 命令。inspired by bowenliang123/dsh-context (Apache-2.0)，界面与实现独立重写。领域术语见 `GLOSSARY.md`。

## Agent skills

### Issue tracker

工单与 spec 以 GitHub Issues 跟踪（仓库 lxyAK/zcode-context-insight），操作走 `gh` CLI。See `docs/agents/issue-tracker.md`.

### Triage labels

使用五个默认三审标签（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix），未重命名。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文布局：根目录一个 `GLOSSARY.md`，决策记录在 `docs/adr/`。See `docs/agents/domain.md`.
