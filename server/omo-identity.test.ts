import { expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { heldRuntime, omoProcessIdentity, omoSessionFolder, omoTranscriptsOfCwd, selectOmoTranscript } from "./omo.ts";
import { processStartedAt } from "./process-start.ts";
import * as processStart from "./process-start.ts";
import { saturatedProcessProbes } from "../scripts/test-process-probes.ts";

const holdRecord = (dir: string, id: string, pid: number, record: object): void => {
  const holders = join(dir, "session-holders", encodeURIComponent(id));
  mkdirSync(holders, { recursive: true });
  writeFileSync(join(holders, `${pid}.json`), JSON.stringify(record));
};
const writeSession = (dir: string, id: string, cwd: string): string => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-10-02T16-47-10-905Z_${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session", id, cwd, timestamp: "2026-10-02T16:47:10.905Z" }) + "\n");
  return path;
};
const info = (processes: { pid: number; argv?: string[]; cwd?: string }[]) => ({ process_info: { foreground_processes: processes } });
const NEUTRAL = ["/opt/team-ai/bin/run"];

it("rejects stale argv holders when the real process probe ceiling is occupied", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-saturated-")));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const pid = 2_000_001;
  holdRecord(join(agentDir, "sessions", omoSessionFolder(cwd)), "stale", pid, { pid, processStartedAtMs: 100_000, cwd });
  const saturation = await saturatedProcessProbes();
  const reached = Promise.withResolvers<void>();
  const probe = spyOn(processStart, "processStartedAtAsync").mockImplementation(async () => {
    reached.resolve();
    return await processStart.psOutput(["-o", "pid=", "-p", String(process.pid)]) === null ? null : 110_000;
  });
  try {
    const identity = omoProcessIdentity({ pid, argv: ["omo"], cwd }, cwd, root, () => [`OMO_CODING_AGENT_DIR=${agentDir}`]);
    await reached.promise;
    saturation.release();
    expect((await identity)?.heldIds).toEqual([]);
  } finally { probe.mockRestore(); await saturation.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const births of [[null, 110_000], [100_000, 110_000]] as const) it(`rejects stale holders across birth probes ${births}`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-birth-")));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const dir = join(agentDir, "sessions", omoSessionFolder(cwd));
  const pid = 2_000_001;
  holdRecord(dir, "stale", pid, { pid, processStartedAtMs: 100_000, cwd });
  const stale = writeSession(dir, "stale", cwd);
  writeFileSync(stale, JSON.stringify({ type: "session", id: "stale", cwd, timestamp: new Date(50_000).toISOString() }) + "\n");
  let calls = 0;
  const probe = spyOn(processStart, "processStartedAtAsync").mockImplementation(async () => births[Math.min(calls++, 1)]!);
  try {
    const pane = { pane_id: "w:p1", cwd } as HerdrPane;
    const out = await omoTranscriptsOfCwd(cwd, [pane], new Map([[pane.pane_id, info([{ pid, argv: ["omo"], cwd }])]]), home,
      () => [`OMO_CODING_AGENT_DIR=${agentDir}`]);
    expect(out.get(pane.pane_id)?.path).toBeNull();
    expect(out.get(pane.pane_id)?.pending).toBeNull();
  } finally { probe.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

it("never validates a holder when the process birth stays unknown", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-unknown-")));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const pid = 2_000_001;
  holdRecord(join(agentDir, "sessions", omoSessionFolder(cwd)), "stale", pid, { pid, processStartedAtMs: 100_000, cwd });
  const probe = spyOn(processStart, "processStartedAtAsync").mockResolvedValue(null);
  try {
    expect((await omoProcessIdentity({ pid, argv: ["omo"], cwd }, cwd, root, () => [`OMO_CODING_AGENT_DIR=${agentDir}`]))?.heldIds).toEqual([]);
  } finally { probe.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

it("discovers custom holders beyond eight concurrent birth probes on every refresh", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-cap-")));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const dir = join(agentDir, "sessions", omoSessionFolder(cwd));
  const panes = Array.from({ length: 10 }, (_, index) => ({ pane_id: `w:p${index}`, cwd } as HerdrPane));
  const infos = new Map(panes.map((pane, index) => {
    const pid = 2_000_001 + index;
    holdRecord(dir, `held-${index}`, pid, { pid, processStartedAtMs: 100_000, cwd });
    writeSession(dir, `held-${index}`, cwd);
    return [pane.pane_id, info([{ pid, argv: NEUTRAL, cwd }])] as const;
  }));
  let active = 0;
  // Hold each admitted slot until the next microtask; simultaneous ninth probes are refused,
  // exactly as the bounded macOS subprocess adapter does.
  const probe = spyOn(processStart, "processStartedAtAsync").mockImplementation(async () => {
    if (active >= 8) return null;
    active++;
    try { await Promise.resolve(); return 100_000; } finally { active--; }
  });
  try {
    for (let refresh = 0; refresh < 2; refresh++) {
      const out = await omoTranscriptsOfCwd(cwd, panes, infos, home, () => [`OMO_CODING_AGENT_DIR=${agentDir}`]);
      expect(out.get("w:p9")?.path).toBe(realpathSync(join(dir, "2026-10-02T16-47-10-905Z_held-9.jsonl")));
    }
  } finally { probe.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "linux")("prefers the OS cwd over stale pane directories for a held custom session", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-proc-cwd-")));
  try {
    const home = join(root, "home");
    const pid = process.pid;
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    const agentDir = join(root, "agent");
    const dir = join(agentDir, "sessions", omoSessionFolder(cwd));
    holdRecord(dir, "held", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    const written = writeSession(dir, "held", cwd);
    writeSession(dir, "unheld", cwd);
    const pane = { pane_id: "w:p1", cwd: join(root, "stale-pane"), foreground_cwd: join(root, "stale-foreground") } as HerdrPane;
    const infos = new Map([[pane.pane_id, info([{ pid, argv: NEUTRAL }])]]);
    const resolved = (await omoTranscriptsOfCwd(cwd, [pane], infos, home, () => [`OMO_CODING_AGENT_DIR=${agentDir}`])).get(pane.pane_id);
    expect(resolved?.path).toBe(realpathSync(written));
    expect(resolved?.pending).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps a held claim's store when its own file cannot be read as a candidate", async () => {
  // A custom holder in store A names sess-x; the pane's other, legacy process resolves
  // the default store B, where another pane's session happens to share the id.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-scope-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const storeA = join(root, "a", "agent");
    const dirA = join(storeA, "sessions", omoSessionFolder(cwd));
    const dirB = join(home, ".omo", "agent", "sessions", omoSessionFolder(cwd));
    const pid = process.pid;
    holdRecord(dirA, "sess-x", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    // the held session's own file is present in A but unreadable as a candidate
    writeFileSync(join(dirA, "2026-10-02T16-47-10-905Z_sess-x.jsonl"), "{");
    writeSession(dirB, "sess-x", cwd);
    const pane = { pane_id: "w:p1", cwd } as HerdrPane;
    const infos = new Map([[pane.pane_id, info([{ pid, argv: NEUTRAL, cwd }, { pid: process.ppid, argv: ["node", "/opt/omo/bin/omo.js"], cwd }])]]);
    const envOf = (pid: number) => pid === process.pid ? [`OMO_CODING_AGENT_DIR=${storeA}`] : ["PATH=/bin"];
    const out = (await omoTranscriptsOfCwd(cwd, [pane], infos, home, envOf)).get(pane.pane_id);
    // the claim still binds store A: B's same-id file is another session, and the pane
    // reports nothing — not the other store's transcript
    expect(out?.path).toBeNull();
    expect(out?.pending).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps a truly pending held id pending while another store has the id written", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-pending-scope-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const storeA = join(root, "a", "agent");
    const dirA = join(storeA, "sessions", omoSessionFolder(cwd));
    const dirB = join(home, ".omo", "agent", "sessions", omoSessionFolder(cwd));
    const pid = process.pid;
    holdRecord(dirA, "sess-x", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    writeSession(dirB, "sess-x", cwd);
    const pane = { pane_id: "w:p1", cwd } as HerdrPane;
    const infos = new Map([[pane.pane_id, info([{ pid, argv: NEUTRAL, cwd }, { pid: process.ppid, argv: ["node", "/opt/omo/bin/omo.js"], cwd }])]]);
    const envOf = (pid: number) => pid === process.pid ? [`OMO_CODING_AGENT_DIR=${storeA}`] : ["PATH=/bin"];
    const out = (await omoTranscriptsOfCwd(cwd, [pane], infos, home, envOf)).get(pane.pane_id);
    expect(out?.path).toBeNull();
    expect(out?.pending).toBe("sess-x");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("binds a structured claim to its store and a legacy string claim to none", () => {
  const a = { path: "/a/s.jsonl", id: "same", createdAt: 100, store: "/store-a" };
  const b = { path: "/b/s.jsonl", id: "same", createdAt: 100, store: "/store-b" };
  const runtime = { paneId: "p", startedAt: 10, paths: [] as string[], ids: [] as string[] };
  // a scoped claim selects its own store's file, and still selects it when the pane
  // owns both stores: the other store's same-id file never counts
  const scoped = heldRuntime(runtime, [{ id: "same", store: "/store-b" }], [a, b]);
  expect(selectOmoTranscript("p", [a, b], [scoped])).toBe("/b/s.jsonl");
  expect(selectOmoTranscript("p", [a], [heldRuntime(runtime, [{ id: "same", store: "/store-b" }], [a])])).toBeNull();
  // a claim whose file is gone still binds: it never resolves to another store's file
  expect(selectOmoTranscript("p", [a], [heldRuntime(runtime, [{ id: "same", store: "/store-b" }], [a, b])])).toBeNull();
  // legacy callers that know no store keep matching by id alone
  const unscoped = heldRuntime(runtime, ["same"], [a]);
  expect(selectOmoTranscript("p", [a], [unscoped])).toBe("/a/s.jsonl");
});

it("fails closed when one pane holds two different sessions", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-ambiguous-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const storeA = join(root, "a", "agent");
    const dirA = join(storeA, "sessions", omoSessionFolder(cwd));
    const pid = process.pid;
    holdRecord(dirA, "sess-1", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    holdRecord(dirA, "sess-2", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    writeSession(dirA, "sess-1", cwd);
    writeSession(dirA, "sess-2", cwd);
    const pane = { pane_id: "w:p1", cwd } as HerdrPane;
    const infos = new Map([[pane.pane_id, info([{ pid, argv: NEUTRAL, cwd }])]]);
    const out = (await omoTranscriptsOfCwd(cwd, [pane], infos, home, () => [`OMO_CODING_AGENT_DIR=${storeA}`])).get(pane.pane_id);
    expect(out?.path).toBeNull();
    expect(out?.pending).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("lets an ambiguous peer's claims still block a pane claiming a known file", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-peer-block-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const storeA = join(root, "a", "agent");
    const dirA = join(storeA, "sessions", omoSessionFolder(cwd));
    const pidA = process.pid;
    const pidB = process.ppid;
    holdRecord(dirA, "shared", pidA, { pid: pidA, processStartedAtMs: processStartedAt(pidA), cwd });
    holdRecord(dirA, "shared", pidB, { pid: pidB, processStartedAtMs: processStartedAt(pidB), cwd });
    holdRecord(dirA, "other", pidB, { pid: pidB, processStartedAtMs: processStartedAt(pidB), cwd });
    writeSession(dirA, "shared", cwd);
    writeSession(dirA, "other", cwd);
    const panes = [{ pane_id: "w:p1", cwd } as HerdrPane, { pane_id: "w:p2", cwd } as HerdrPane];
    const infos = new Map([
      ["w:p1", info([{ pid: pidA, argv: NEUTRAL, cwd }])],
      ["w:p2", info([{ pid: pidB, argv: NEUTRAL, cwd }])],
    ]);
    const out = (await omoTranscriptsOfCwd(cwd, panes, infos, home, () => [`OMO_CODING_AGENT_DIR=${storeA}`]));
    // p2 is ambiguous and selects nothing; its claims still block p1's known file
    expect(out.get("w:p1")?.path).toBeNull();
    expect(out.get("w:p2")?.path).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("rejects a holder the pane's cwd names when the process runs elsewhere", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-cwd-win-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const other = join(root, "other");
    const storeA = join(root, "a", "agent");
    const dirA = join(storeA, "sessions", omoSessionFolder(cwd));
    const pid = process.pid;
    const env = [`OMO_CODING_AGENT_DIR=${storeA}`];
    // a stale record under the pane's cwd names this pid, but the process runs in
    // /other: the process's own cwd wins and the pane-scoped holder is not its
    holdRecord(dirA, "stale", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    expect((await omoProcessIdentity({ pid, argv: NEUTRAL, cwd: other }, cwd, home, () => env))).toBeNull();
    // once the record names where the process actually runs, it is recognized
    holdRecord(join(storeA, "sessions", omoSessionFolder(other)), "moved", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd: other });
    expect((await omoProcessIdentity({ pid, argv: NEUTRAL, cwd: other }, cwd, home, () => env)))
      .toEqual({ agentDir: storeA, heldIds: ["moved"], custom: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("binds the folder a moved process runs in and resolves the session it holds there", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-moved-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const other = join(root, "other");
    const storeA = join(root, "a", "agent");
    const dirOther = join(storeA, "sessions", omoSessionFolder(other));
    const pid = process.pid;
    holdRecord(dirOther, "moved", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd: other });
    const file = writeSession(dirOther, "moved", other);
    const env = () => [`OMO_CODING_AGENT_DIR=${storeA}`];
    // the pane's cwd is stale; herdr reports the process's own cwd
    const pane = { pane_id: "w:p1", cwd } as HerdrPane;
    const infos = new Map([[pane.pane_id, info([{ pid, argv: NEUTRAL, cwd: other }])]]);
    expect((await omoTranscriptsOfCwd(other, [pane], infos, home, env)).get(pane.pane_id)?.path).toBe(realpathSync(file));
    // the folder the pane left behind claims nothing of it
    expect((await omoTranscriptsOfCwd(cwd, [pane], infos, home, env)).has(pane.pane_id)).toBeFalse();
    // a foreground cwd herdr reports for the pane reaches the same answer
    const moved = { pane_id: "w:p1", cwd, foreground_cwd: other } as HerdrPane;
    const processCwd = new Map([[moved.pane_id, info([{ pid, argv: NEUTRAL, cwd: other }])]]);
    expect((await omoTranscriptsOfCwd(other, [moved], processCwd, home, env)).get(moved.pane_id)?.path).toBe(realpathSync(file));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("still rejects conflicting claims among peers that moved to one cwd", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-moved-peers-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const other = join(root, "other");
    const storeA = join(root, "a", "agent");
    const dirOther = join(storeA, "sessions", omoSessionFolder(other));
    const pidA = process.pid;
    const pidB = process.ppid;
    holdRecord(dirOther, "shared", pidA, { pid: pidA, processStartedAtMs: processStartedAt(pidA), cwd: other });
    holdRecord(dirOther, "shared", pidB, { pid: pidB, processStartedAtMs: processStartedAt(pidB), cwd: other });
    writeSession(dirOther, "shared", other);
    // one pane kept its old pane cwd; its process runs in the other's folder
    const panes = [{ pane_id: "w:p1", cwd } as HerdrPane, { pane_id: "w:p2", cwd: other } as HerdrPane];
    const infos = new Map([
      ["w:p1", info([{ pid: pidA, argv: NEUTRAL, cwd: other }])],
      ["w:p2", info([{ pid: pidB, argv: NEUTRAL, cwd: other }])],
    ]);
    const out = (await omoTranscriptsOfCwd(other, panes, infos, home, () => [`OMO_CODING_AGENT_DIR=${storeA}`]));
    expect(out.get("w:p1")?.path).toBeNull();
    expect(out.get("w:p2")?.path).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
