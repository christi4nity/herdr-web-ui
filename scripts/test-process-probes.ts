import { probeOutput } from "../server/process-start.ts";

/** Occupy the real child ceiling until the test explicitly releases all eight probes. */
export async function saturatedProcessProbes() {
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let arrived = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch() {
      if (++arrived === 8) ready.resolve();
      await release.promise;
      return new Response("done");
    },
  });
  const probes = Array.from({ length: 8 }, () => probeOutput([
    process.execPath, "-e", `process.stdout.write(await (await fetch("http://127.0.0.1:${server.port}")).text())`,
  ], 15_000));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ready.promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Probe children did not reach the gate")), 10_000);
    })]);
  } catch (error) {
    release.resolve();
    await Promise.all(probes);
    server.stop(true);
    throw error;
  } finally { clearTimeout(timer); }
  return {
    release: () => release.resolve(),
    async close() {
      release.resolve();
      await Promise.all(probes);
      server.stop(true);
    },
  };
}
