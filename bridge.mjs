import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { once } from "node:events";

export function parseEndpoint(text) {
  const [port, pathname] = text.trim().split(/\r?\n/);
  if (!/^\d+$/.test(port ?? "") || +port < 1 || +port > 65535 ||
      !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(pathname ?? "")) {
    throw new Error("Invalid DevToolsActivePort file");
  }
  return { port: +port, pathname };
}

function websocketAccept(key) {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

async function approvedSocket(target, signal) {
  const key = randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1", port: target.port, path: target.pathname,
      headers: {
        Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key,
      },
    });
    const abort = () => request.destroy(new Error("Debugging connection cancelled"));
    request.setTimeout(120_000, () => request.destroy(new Error("Timed out waiting for Chromium's debugging approval")));
    request.on("error", reject);
    request.on("response", response => {
      response.resume();
      request.destroy(new Error(`Chromium refused debugging (HTTP ${response.statusCode})`));
    });
    request.on("upgrade", (response, socket, head) => {
      request.setTimeout(0);
      if (response.headers["sec-websocket-accept"] !== websocketAccept(key)) {
        socket.destroy();
        reject(new Error("Invalid Chromium WebSocket handshake"));
        return;
      }
      socket.pause();
      resolve({ socket, head });
    });
    request.on("close", () => signal?.removeEventListener("abort", abort));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else request.end();
  });
}

export async function startBridge(file, chromiumPort, log = console.error, signal) {
  const endpoint = async () => {
    const target = parseEndpoint(await readFile(file, "utf8"));
    if (target.port !== chromiumPort) {
      throw new Error("Chromium's port changed; update port in launch.json");
    }
    return target;
  };
  const target = await endpoint();
  // Approve before VS Code starts its two-second WebSocket handshake timer.
  const { socket: upstream, head: upstreamHead } = await approvedSocket(target, signal);
  let port;
  let attached = false;
  let disposed = false;
  const sockets = new Set();
  const trusted = (req) => !req.headers.origin &&
    ["localhost", `localhost:${port}`, `127.0.0.1:${port}`, "127.0.0.1"]
      .includes(req.headers.host);

  const server = http.createServer(async (req, res) => {
    if (!trusted(req)) {
      res.writeHead(403).end("Local debugger clients only");
      return;
    }
    if (req.method !== "GET" || req.url !== "/json/version") {
      res.writeHead(404).end("Use /json/version");
      return;
    }
    try {
      const current = await endpoint();
      if (current.pathname !== target.pathname) throw new Error("Chromium's endpoint changed; restart debugging");
      res.writeHead(200, {
        "Content-Type": "application/json", "Cache-Control": "no-store",
      }).end(JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}${target.pathname}`,
      }));
    } catch (error) {
      log(error.message);
      res.writeHead(503).end("Cannot read Chromium endpoint; enable remote debugging");
    }
  });

  // VS Code rewrites the discovered WebSocket's port to the discovery port.
  server.on("upgrade", async (req, socket, head) => {
    socket.on("error", (error) => log(`Debugger socket: ${error.message}`));
    try {
      if (!trusted(req)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const key = req.headers["sec-websocket-key"];
      if (req.method !== "GET" || req.url !== target.pathname ||
          req.headers.upgrade?.toLowerCase() !== "websocket" ||
          req.headers["sec-websocket-version"] !== "13" ||
          typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      if (attached || disposed || upstream.destroyed) {
        socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
        return;
      }
      if (socket.destroyed) return;
      attached = true;
      socket.on("close", dispose);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    } catch (error) {
      log(error.message);
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  function dispose() {
    if (disposed) return;
    disposed = true;
    upstream.destroy();
    for (const socket of sockets) socket.destroy();
    server.close();
  }
  upstream.on("error", error => log(`Chromium socket: ${error.message}`));
  upstream.on("close", () => {
    if (!disposed) log("Chromium debugging connection closed");
    dispose();
  });
  if (signal?.aborted || upstream.destroyed) {
    dispose();
    throw new Error("Debugging connection cancelled or closed");
  }
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
  } catch (error) {
    dispose();
    throw error;
  }
  port = server.address().port;
  return {
    port,
    dispose,
  };
}
