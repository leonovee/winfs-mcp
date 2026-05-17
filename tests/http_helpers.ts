import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface MiniServer {
  port: number;
  host: string;
  url(path?: string): string;
  close(): Promise<void>;
}

export interface RouteSpec {
  status?: number;
  body?: string | Buffer;
  headers?: Record<string, string>;
  /** If set, server delays response by N ms before sending headers. */
  delayMs?: number;
}

/** Spin up a one-off HTTP server bound to 127.0.0.1 on a random port. The
 *  caller wires routes via the `routes` map keyed by exact pathname. */
export async function startTestServer(
  routes: Record<string, RouteSpec | ((req: http.IncomingMessage, res: http.ServerResponse) => void)>,
): Promise<MiniServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = routes[url.pathname];
    if (route === undefined) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    if (typeof route === "function") {
      route(req, res);
      return;
    }
    const send = (): void => {
      res.statusCode = route.status ?? 200;
      if (route.headers) {
        for (const [k, v] of Object.entries(route.headers)) {
          res.setHeader(k, v);
        }
      }
      if (route.body !== undefined) {
        const buf = Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body, "utf8");
        res.setHeader("Content-Length", String(buf.length));
        res.end(buf);
      } else {
        res.end();
      }
    };
    if (route.delayMs && route.delayMs > 0) {
      setTimeout(send, route.delayMs);
    } else {
      send();
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    host: "127.0.0.1",
    url(path: string = "/"): string {
      return `http://127.0.0.1:${addr.port}${path}`;
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
