import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

/** `ps -o etime=`: `[[dd-]hh:]mm:ss` since the process started. */
export function parseElapsed(text: string): number | null {
  const match = /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(text);
  if (!match) return null;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes!)) * 60 + Number(seconds!);
}

const PROBE_TIMEOUT_MS = 1500;
const PROBE_OUTPUT_BYTES = 4096;

// Refuse excess work rather than retaining a growing queue on status/request bursts.
const MAX_PROBES = 8;
let activeProbes = 0;

/** A hard deadline and streaming cap apply even if a descendant keeps stdout open. */
export async function probeOutput(command: string[], timeoutMs = PROBE_TIMEOUT_MS, maxBytes = PROBE_OUTPUT_BYTES, env?: Record<string, string | undefined>): Promise<string | null> {
  if (activeProbes >= MAX_PROBES) return null;
  activeProbes++;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore", ...(env ? { env } : {}) });
    child = probe;
    reader = probe.stdout.getReader();
    const stream = reader;
    const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const reading = (async (): Promise<string | null> => {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await stream.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) return null;
        chunks.push(value);
      }
      return await probe.exited === 0 ? Buffer.concat(chunks).toString() : null;
    })();
    return await Promise.race([reading, deadline]);
  } catch { return null; }
  finally {
    clearTimeout(timer);
    // Probe children own no state to flush. Kill directly, including children ignoring TERM;
    // never signal the inspected PID or a process group. Do not wait on inherited pipes.
    try { child?.kill("SIGKILL"); } catch { /* already exited */ }
    void reader?.cancel().catch(() => {});
    activeProbes--;
  }
}

/** A bounded, awaited `ps` read; a slow process table must not hold the event loop. */
export function psOutput(args: string[], timeoutMs = PROBE_TIMEOUT_MS, env?: Record<string, string | undefined>): Promise<string | null> {
  return probeOutput(["/bin/ps", ...args], timeoutMs, PROBE_OUTPUT_BYTES, env);
}

/**
 * Legacy synchronous process reading for synchronous fixture helpers only. Runtime paths use
 * processStartedAtAsync so macOS process-table stalls cannot block Bun's event loop.
 */
export function processStartedAt(pid: number): number | null {
  if (process.platform === "darwin") {
    try {
      const ps = Bun.spawnSync(["/bin/ps", "-o", "etime=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
      const elapsed = ps.exitCode === 0 ? parseElapsed(ps.stdout.toString()) : null;
      return elapsed === null ? null : Date.now() - elapsed * 1000;
    } catch { return null; }
  }
  try {
    const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]);
    const boot = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
    return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + ticks * 10 : null;
  } catch { return null; }
}

/** Runtime process birth probe. */
export async function processStartedAtAsync(pid: number): Promise<number | null> {
  if (process.platform === "darwin") {
    const output = await psOutput(["-o", "etime=", "-p", String(pid)]);
    const elapsed = output === null ? null : parseElapsed(output);
    return elapsed === null ? null : Date.now() - elapsed * 1000;
  }
  try {
    const [stat, procStat] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/stat", "utf8")]);
    const ticks = Number(stat.split(") ").pop()!.split(" ")[19]);
    const boot = Number(procStat.match(/^btime (\d+)$/m)?.[1]);
    return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + ticks * 10 : null;
  } catch { return null; }
}

/** An upper bound for comparing a new thread's timestamp, without btime's whole-second loss. */
export function processStartUpperBound(pid: number): number | null {
  if (process.platform !== "linux") {
    const started = processStartedAt(pid);
    return started === null ? null : started + 1000;
  }
  try {
    const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]);
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    return Number.isFinite(ticks) && Number.isFinite(uptime) ? Date.now() - uptime * 1000 + ticks * 10 + 10 : null;
  } catch { return null; }
}

/** Async upper bound for runtime paths. */
export async function processStartUpperBoundAsync(pid: number): Promise<number | null> {
  if (process.platform !== "linux") {
    const started = await processStartedAtAsync(pid);
    return started === null ? null : started + 1000;
  }
  try {
    const [stat, uptimeText] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/uptime", "utf8")]);
    const ticks = Number(stat.split(") ").pop()!.split(" ")[19]);
    const uptime = Number(uptimeText.split(" ")[0]);
    return Number.isFinite(ticks) && Number.isFinite(uptime) ? Date.now() - uptime * 1000 + ticks * 10 + 10 : null;
  } catch { return null; }
}
