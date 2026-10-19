import { describe, expect, it, spyOn } from "bun:test";
import { parseElapsed, probeOutput, psOutput, processStartedAtAsync, processStartUpperBoundAsync } from "./process-start.ts";
import { saturatedProcessProbes } from "../scripts/test-process-probes.ts";

function observeSpawn(before: (command: string[]) => void, after: (child: Bun.Subprocess) => void = () => {}) {
  const spawn = Bun.spawn;
  return spyOn(Bun, "spawn").mockImplementation(function <
    const In extends Bun.SpawnOptions.Writable = "ignore",
    const Out extends Bun.SpawnOptions.Readable = "pipe",
    const Err extends Bun.SpawnOptions.Readable = "inherit",
  >(command: string[] | (Bun.SpawnOptions.SpawnOptions<In, Out, Err> & { cmd: string[] }), options?: Bun.SpawnOptions.SpawnOptions<In, Out, Err>) {
    before(Array.isArray(command) ? command : command.cmd);
    const child = Array.isArray(command) ? spawn(command, options) : spawn(command);
    after(child);
    return child;
  });
}

describe("process start time", () => {
  it("retains cancelled child slots until their exit promises settle", async () => {
    const killed = Promise.withResolvers<void>();
    let kills = 0;
    const children: { exited: Promise<number>; release: () => void; restore: () => void }[] = [];
    let started = 0;
    const spawning = observeSpawn(() => { started++; }, (child) => {
      const exited = child.exited;
      const gate = Promise.withResolvers<number>();
      Object.defineProperty(child, "exited", { value: gate.promise });
      const kill = spyOn(child, "kill").mockImplementation(() => { if (++kills === 8) killed.resolve(); });
      children.push({ exited, release: () => gate.resolve(0), restore: () => kill.mockRestore() });
    });
    const command = [process.execPath, "-e", "process.stdout.write('over cap')"];
    const probes = Array.from({ length: 8 }, () => probeOutput(command, 3000, 1));
    try {
      await killed.promise;
      await Promise.all(probes);
      expect(await probeOutput(command, 3000, 1)).toBeNull();
      expect(started).toBe(8);
    } finally {
      spawning.mockRestore();
      for (const entry of children) { entry.release(); entry.restore(); }
      await Promise.all(probes);
      await Promise.all(children.map((entry) => entry.exited));
    }
  });

  it.skipIf(process.platform === "win32")("bounds the production queue at 64 waiters and admits them in FIFO order", async () => {
    const saturation = await saturatedProcessProbes();
    const order: string[] = [];
    const spawning = observeSpawn((command) => { order.push(JSON.stringify(command)); });
    const waiters = Array.from({ length: 64 }, (_, index) => psOutput(["-p", String(process.pid), "-o", "pid=", "-p", String(index + 1)], 10_000));
    try {
      expect(await psOutput(["overflow"], 10_000)).toBeNull();
      expect(order).toEqual([]);
      saturation.release();
      await Promise.all(waiters);
      expect(order).toEqual(Array.from({ length: 64 }, (_, index) =>
        JSON.stringify(["/bin/ps", "-p", String(process.pid), "-o", "pid=", "-p", String(index + 1)])));
    } finally { spawning.mockRestore(); await saturation.close(); }
  }, 15_000);

  it.skipIf(process.platform === "win32")("expires a queued production request without spawning it later", async () => {
    const saturation = await saturatedProcessProbes();
    const spawning = observeSpawn(() => {});
    try {
      expect(await psOutput(["expired"], 10)).toBeNull();
      saturation.release();
      await saturation.close();
      expect(spawning).not.toHaveBeenCalled();
      expect(await psOutput(["-p", String(process.pid), "-o", "pid="])).not.toBeNull();
    } finally { spawning.mockRestore(); await saturation.close(); }
  });

  it.skipIf(process.platform === "win32")("releases a queued production slot after a spawn failure", async () => {
    const saturation = await saturatedProcessProbes();
    let calls = 0;
    const spawning = observeSpawn(() => {
      if (++calls === 1) throw new Error("fixture spawn failed");
    });
    try {
      const failed = psOutput(["-p", String(process.pid), "-o", "pid="]);
      const next = psOutput(["-p", String(process.pid), "-o", "pid="]);
      saturation.release();
      expect(await failed).toBeNull();
      expect(await next).not.toBeNull();
    } finally { spawning.mockRestore(); await saturation.close(); }
  });

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
