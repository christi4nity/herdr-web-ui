import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { HerdrError } from "./herdr/client.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

it("logs local roster failures and one recovery without copying the UI error into the log", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-machine-diagnostic-"));
  let failing = false;
  const snapshot = { protocol: 22, version: "fixture", panes: [], workspaces: [], tabs: [], layouts: [], agents: [] } as SessionSnapshot;
  const lines: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((line) => { lines.push(String(line)); });
  const push = { seed() {}, async onStatus() {}, async onEnded() {} } as unknown as PushService;
  const manager = new MachineManager(root, push, new CompletionTracker(null), async () => {
    if (failing) throw new HerdrError("timeout", "private-host/private-socket private-token");
    return snapshot;
  });
  cleanups.push(() => { manager.stop(); warn.mockRestore(); rmSync(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 1000;
  while (manager.list()[0]?.state !== "connected") {
    if (Date.now() > deadline) throw new Error("initial local snapshot did not finish");
    await Bun.sleep(5);
  }
  expect(lines).toHaveLength(0);
  failing = true;
  await manager.refreshLocal();
  await manager.refreshLocal();
  expect(manager.list()[0]).toMatchObject({ state: "error", error: "private-host/private-socket private-token" });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ event: "machine.local.failed", operation: "snapshot", code: "timeout" });
  failing = false;
  await manager.refreshLocal();
  await manager.refreshLocal();
  expect(manager.list()[0]).toMatchObject({ state: "connected", error: null });
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[1]!)).toMatchObject({ event: "machine.local.recovered", failures: 2, suppressed: 1, episode_id: JSON.parse(lines[0]!).episode_id });
  expect(lines.join("\n")).not.toContain("private-");
  expect(lines.join("\n")).not.toContain(root);
});
