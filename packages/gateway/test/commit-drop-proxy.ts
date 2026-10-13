import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";

/** Disposable PostgreSQL wire fault: drop the server's COMMIT acknowledgement only
 * after PostgreSQL has committed. No SQL/credentials are logged or retained.
 */
export async function commitDropProxy(target: URL) {
  const sockets = new Set<Socket>();
  let dropped = 0;
  const server = createServer((downstream) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    sockets.add(downstream);
    sockets.add(upstream);
    downstream.on("error", () => undefined);
    upstream.on("error", () => downstream.destroy());
    downstream.once("close", () => {
      upstream.destroy();
      sockets.delete(downstream);
    });
    upstream.once("close", () => {
      downstream.destroy();
      sockets.delete(upstream);
    });
    downstream.pipe(upstream);
    let buffered = Buffer.alloc(0);
    upstream.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 5) {
        const size = buffered.readInt32BE(1) + 1;
        if (size < 5 || size > 16 * 1024 * 1024) {
          downstream.destroy();
          upstream.destroy();
          return;
        }
        if (buffered.length < size) return;
        const message = buffered.subarray(0, size);
        buffered = buffered.subarray(size);
        if (message[0] === 67 && message.toString("utf8", 5).startsWith("COMMIT\0")) {
          dropped++;
          downstream.destroy();
          upstream.destroy();
          return;
        }
        downstream.write(message);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy address");
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);
  return {
    url: url.href,
    dropped: () => dropped,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
