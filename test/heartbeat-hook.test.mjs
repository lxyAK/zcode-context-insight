/**
 * 心跳 hook 测试（T2）：
 *  - 契约缝：hooks/hooks.json 是宿主装载插件 hook 的真实输入，形状必须严格符合
 *    宿主 schema（研究笔记 01 §5.2：process 型字段严格不混用，混用即被丢弃）。
 *  - 行为缝：heartbeat.sh 以真实 bash 子进程执行（替代不可行的宿主内实测——
 *    hook 配置不热加载，宿主内验证标注"待宿主重启验证"）。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hookJsonPath = join(repoRoot, "hooks", "hooks.json");
const heartbeatShPath = join(repoRoot, "hooks", "heartbeat.sh");

/** bash 可用性探测（本机 Git Bash；不可用则跳过行为测试） */
function bashAvailable() {
  const probe = spawnSync("bash", ["-c", "exit 0"], { timeout: 5000 });
  return probe.error === undefined && probe.status === 0;
}

describe("hooks/hooks.json 契约（宿主装载的真实输入）", () => {
  it("声明 UserPromptSubmit 事件", () => {
    const manifest = JSON.parse(readFileSync(hookJsonPath, "utf8"));
    const events = manifest.hooks?.UserPromptSubmit;
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });

  it("hook 为 process 型且字段不混用（args 数组 + timeoutMs 毫秒，无 shell/timeout 秒字段）", () => {
    const manifest = JSON.parse(readFileSync(hookJsonPath, "utf8"));
    const hook = manifest.hooks.UserPromptSubmit[0].hooks[0];
    expect(hook.type).toBe("process");
    expect(Array.isArray(hook.args)).toBe(true);
    expect(hook.args.length).toBeGreaterThan(0);
    expect(typeof hook.timeoutMs).toBe("number");
    expect(hook.timeoutMs).toBeGreaterThan(0);
    // 混用检测：command 型独有字段出现即被宿主丢弃
    expect(hook.shell).toBeUndefined();
    expect(hook.timeout).toBeUndefined();
  });

  it("args 引用插件根模板变量定位心跳脚本，脚本文件存在", () => {
    const manifest = JSON.parse(readFileSync(hookJsonPath, "utf8"));
    const hook = manifest.hooks.UserPromptSubmit[0].hooks[0];
    const scriptArg = hook.args.find((a) => a.includes("heartbeat"));
    expect(scriptArg, `args 应含心跳脚本: ${JSON.stringify(hook.args)}`).toMatch(
      /^\$\{ZCODE_PLUGIN_ROOT\}\/hooks\/heartbeat\.sh$/,
    );
    expect(existsSync(heartbeatShPath)).toBe(true);
  });

  it("无 matcher（心跳对一切用户提交生效）", () => {
    const manifest = JSON.parse(readFileSync(hookJsonPath, "utf8"));
    const entry = manifest.hooks.UserPromptSubmit[0];
    expect(entry.matcher).toBeUndefined();
  });
});

describe("heartbeat.sh 行为（真实 bash 子进程执行）", () => {
  it.skipIf(!bashAvailable())(
    "注入 ZCODE_SESSION_ID + ZCODE_PLUGIN_DATA 时写入 heartbeat.json（会话 ID 正确、time 为毫秒时间戳）",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "zci-hb-"));
      try {
        const res = spawnSync("bash", [heartbeatShPath], {
          env: {
            ...process.env,
            ZCODE_SESSION_ID: "session_abcdefabcdefabcdefabcdefabcdef01",
            ZCODE_PLUGIN_DATA: dir,
          },
          timeout: 10000,
        });
        expect(res.status, `stderr: ${res.stderr}`).toBe(0);
        expect(res.stdout?.toString().trim()).toBe(""); // 空 stdout 合法且必需（严格 schema 解析）

        const heartbeat = JSON.parse(readFileSync(join(dir, "heartbeat.json"), "utf8"));
        expect(heartbeat.sessionId).toBe("session_abcdefabcdefabcdefabcdefabcdef01");
        expect(heartbeat.time).toBeGreaterThan(1790000000000); // Unix 毫秒量级
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!bashAvailable())("三别名兜底：仅有 CLAUDE_SESSION_ID 时也能识别", () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-hb-"));
    try {
      const env = { ...process.env, CLAUDE_SESSION_ID: "session_aliasfallback00000000000000002", ZCODE_PLUGIN_DATA: dir };
      delete env.ZCODE_SESSION_ID;
      delete env.CLAUDE_CODE_SESSION_ID;
      const res = spawnSync("bash", [heartbeatShPath], { env, timeout: 10000 });
      expect(res.status).toBe(0);
      const heartbeat = JSON.parse(readFileSync(join(dir, "heartbeat.json"), "utf8"));
      expect(heartbeat.sessionId).toBe("session_aliasfallback00000000000000002");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!bashAvailable())("缺 ZCODE_PLUGIN_DATA 时静默成功且不写文件（server 侧走推断兜底）", () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-hb-"));
    try {
      const env = { ...process.env, ZCODE_SESSION_ID: "session_x" };
      delete env.ZCODE_PLUGIN_DATA;
      delete env.CLAUDE_PLUGIN_DATA;
      const res = spawnSync("bash", [heartbeatShPath], { env, cwd: dir, timeout: 10000 });
      expect(res.status).toBe(0);
      expect(existsSync(join(dir, "heartbeat.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
