import { describe, expect, it } from "bun:test";
import { parseElapsed, probeOutput, processStartedAtAsync, processStartUpperBoundAsync } from "./process-start.ts";

describe("process start time", () => {
  it("reads every form of ps's elapsed time", () => {
    expect(parseElapsed("   00:07\n")).toBe(7);
    expect(parseElapsed("12:34")).toBe(12 * 60 + 34);
    expect(parseElapsed("01:02:03")).toBe(3723);
    expect(parseElapsed("2-01:02:03")).toBe(2 * 86400 + 3723);
    expect(parseElapsed("")).toBeNull();
  });

  it("tells when a running process started, to the second", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    try {
      const started = await processStartedAtAsync(child.pid);
      expect(started).not.toBeNull();
      expect(Math.abs(started! - Date.now())).toBeLessThan(2500);
    } finally { child.kill(); }
  });

  it("keeps timers and unrelated HTTP requests responsive during a controlled slow probe", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    let ticked = false;
    let finished = false;
    const tick = Promise.withResolvers<void>();
    const timer = setTimeout(() => { ticked = true; tick.resolve(); }, 15);
    const probe = probeOutput([process.execPath, "-e", "await Bun.sleep(350); process.stdout.write('done')"], 2000).finally(() => { finished = true; });
    try {
      await tick.promise;
      expect(ticked).toBeTrue();
      expect(finished).toBeFalse();
      expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text()).toBe("ok");
      expect(finished).toBeFalse();
      expect(await probe).toBe("done");
      expect(ticked).toBeTrue();
    } finally { clearTimeout(timer); server.stop(true); }
  });

  it("enforces the deadline even when the owned probe ignores TERM", async () => {
    const start = Date.now();
    expect(await probeOutput([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], 100)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it("kills an owned child at the streaming cap without waiting for EOF", async () => {
    const start = Date.now();
    const output = await probeOutput([process.execPath, "-e", "process.stdout.write('x'.repeat(5000)); setInterval(() => {}, 1000)"], 3000, 4096);
    expect(output).toBeNull();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("refuses excess concurrent probes instead of queueing more children", async () => {
    const probes = Array.from({ length: 8 }, () => probeOutput([process.execPath, "-e", "await Bun.sleep(5000)"], 150));
    try { expect(await probeOutput([process.execPath, "-e", "process.stdout.write('extra')"])).toBeNull(); }
    finally { await Promise.all(probes); }
  });

  it.skipIf(process.platform !== "linux")("bounds a new Linux process closely enough to identify its first thread", async () => {
    const before = Date.now();
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    try {
      const upper = await processStartUpperBoundAsync(child.pid);
      expect(upper).not.toBeNull();
      expect(upper!).toBeGreaterThanOrEqual(before);
      expect(upper!).toBeLessThanOrEqual(Date.now() + 25);
      expect(await processStartUpperBoundAsync(2147483647)).toBeNull();
    } finally { child.kill(); }
  });
});
