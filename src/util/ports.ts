import net from "node:net";

/**
 * Asks the OS for a free TCP port on 127.0.0.1. There is an inherent race
 * between releasing the port and the server binding it; boot retries with a
 * fresh port on EADDRINUSE.
 */
export async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        if (port > 0) {
          resolve(port);
        } else {
          reject(new Error("could not allocate a port"));
        }
      });
    });
    server.on("error", reject);
  });
}
