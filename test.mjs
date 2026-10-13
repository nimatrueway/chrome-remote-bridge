import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseEndpoint, startBridge } from "./bridge.mjs";

test("manifest declares source-map configuration", async () => {
  const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
  const properties = manifest.contributes.debuggers[0].configurationAttributes.attach.properties;
  assert.equal(properties.sourceMaps.type, "boolean");
  assert.equal(properties.sourceMapPathOverrides.type, "object");
  assert.equal(properties.sourceMapPathOverrides.additionalProperties.type, "string");
});

test("parse endpoint", () => {
  assert.deepEqual(parseEndpoint("62883\r\n/devtools/browser/abc-123\r\n"), {
    port: 62883, pathname: "/devtools/browser/abc-123",
  });
  for (const text of ["", "0\n/devtools/browser/a", "65536\n/devtools/browser/a",
    "9222x\n/devtools/browser/a", "9222\n//example.com"]) {
    assert.throws(() => parseEndpoint(text));
  }
});

test("discovery, forwarding, access controls, refresh, and disposal", { timeout: 5000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chrome-bridge-test-"));
  const file = path.join(dir, "DevToolsActivePort");
  const upstream = http.createServer();
  const sockets = new Set();
  let bridge, client, seenHost;
  let approvals = 0;
  const logs = [];
  upstream.on("upgrade", (req, socket, head) => {
    sockets.add(socket);
    approvals++;
    seenHost = req.headers.host;
    const accept = createHash("sha1").update(
      `${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
    ).digest("base64");
    setTimeout(() => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      if (head.length) socket.write(head);
      socket.on("data", data => socket.write(data));
    }, 2100);
  });
  try {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const port = upstream.address().port;
    await writeFile(file, `${port}\n/devtools/browser/test-123\n`);
    const beforeApproval = Date.now();
    bridge = await startBridge(file, port, message => logs.push(message));
    assert.ok(Date.now() - beforeApproval >= 2000);
    const base = `http://127.0.0.1:${bridge.port}`;
    assert.equal((await (await fetch(`${base}/json/version`)).json()).webSocketDebuggerUrl,
      `ws://127.0.0.1:${bridge.port}/devtools/browser/test-123`);
    assert.equal((await fetch(`${base}/json/list`)).status, 404);
    assert.equal((await fetch(`${base}/json/version`, {
      headers: { Origin: "https://example.com" },
    })).status, 403);
    assert.equal(await new Promise((resolve, reject) => {
      http.get(`${base}/json/version`, { headers: { Host: "example.com" } }, res => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject);
    }), 403);
    client = net.connect(bridge.port, "127.0.0.1");
    await once(client, "connect");
    const received = new Promise((resolve, reject) => {
      let data = "";
      client.on("data", chunk => {
        data += chunk;
        if (data.includes("round-trip-check")) resolve(data);
      });
      client.on("error", reject);
    });
    client.write(`GET /devtools/browser/test-123 HTTP/1.1\r\nHost: localhost:${bridge.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\nround-trip-check`);
    assert.match(await received, /101 Switching Protocols/);
    assert.match(await received, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
    assert.equal(seenHost, `127.0.0.1:${port}`);
    assert.equal(approvals, 1);
    await writeFile(file, `${port}\n/devtools/browser/changed-456\n`);
    assert.equal((await fetch(`${base}/json/version`)).status, 503);
    await writeFile(file, "invalid endpoint");
    assert.equal((await fetch(`${base}/json/version`)).status, 503);
    assert.ok(logs.some(message => message.includes("Invalid")));
    await assert.rejects(startBridge(file, port));
    await writeFile(file, `${port === 65535 ? 1 : port + 1}\n/devtools/browser/test-123\n`);
    assert.equal((await fetch(`${base}/json/version`)).status, 503);
    assert.ok(logs.some(message => message.includes("port changed")));
    await assert.rejects(startBridge(file, port));
  } finally {
    client?.destroy();
    bridge?.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
    await unlink(file);
    await rmdir(dir);
  }
});

test("extension preserves configuration and delegates to built-in debugger", { timeout: 5000 }, async () => {
  let provider, terminate;
  const disposables = [];
  const vscode = {
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
    debug: {
      onDidTerminateDebugSession(callback) {
        terminate = callback;
        return { dispose() {} };
      },
      registerDebugConfigurationProvider(type, value) {
        assert.equal(type, "chrome-remote-bridge");
        provider = value;
        return { dispose() {} };
      },
    },
  };
  const load = Module._load;
  let extension;
  try {
    Module._load = function (id, ...args) {
      return id === "vscode" ? vscode : load.call(this, id, ...args);
    };
    extension = createRequire(import.meta.url)("./extension.cjs");
  } finally {
    Module._load = load;
  }
  extension.activate({ subscriptions: disposables });
  const dir = await mkdtemp(path.join(os.tmpdir(), "chrome-bridge-extension-test-"));
  const file = path.join(dir, "DevToolsActivePort");
  const upstream = http.createServer();
  const sockets = new Set();
  upstream.on("upgrade", (req, socket) => {
    sockets.add(socket);
    const accept = createHash("sha1").update(
      `${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
    ).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  try {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const port = upstream.address().port;
    await writeFile(file, `${port}\n/devtools/browser/test-123\n`);
    const config = {
      name: "Attach to Chrome", type: "chrome-remote-bridge", request: "attach",
      address: "127.0.0.1", port, webRoot: "${workspaceFolder}",
      devToolsActivePort: file, sourceMaps: false,
      sourceMapPathOverrides: { "../packages/*": "${workspaceFolder}/client/packages/*" },
    };
    const resolved = await provider.resolveDebugConfiguration(undefined, config);
    assert.equal(resolved.type, "pwa-chrome");
    assert.equal(resolved.webRoot, config.webRoot);
    assert.equal(resolved.sourceMaps, false);
    assert.deepEqual(resolved.sourceMapPathOverrides, config.sourceMapPathOverrides);
    assert.equal(resolved.targetSelection, "pick");
    assert.notEqual(resolved.port, port);
    assert.equal(config.type, "chrome-remote-bridge");
    const again = await provider.resolveDebugConfiguration(undefined, config);
    assert.notEqual(again.port, resolved.port);
    assert.equal((await fetch(`http://127.0.0.1:${resolved.port}/json/version`)).status, 200);
    await assert.rejects(provider.resolveDebugConfiguration(undefined, { ...config, address: "example.com" }));
    await assert.rejects(provider.resolveDebugConfiguration(undefined, { ...config, port: 0 }));
    await assert.rejects(provider.resolveDebugConfiguration(undefined, { ...config, request: "launch" }));
    await assert.rejects(provider.resolveDebugConfiguration(undefined, { ...config, port: 1234 }));
    await assert.rejects(provider.resolveDebugConfiguration(undefined, { ...config, devToolsActivePort: "relative" }));
    terminate({ configuration: resolved });
    await assert.rejects(fetch(`http://127.0.0.1:${resolved.port}/json/version`));
  } finally {
    for (const disposable of disposables.reverse()) disposable.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
    await unlink(file);
    await rmdir(dir);
  }
});

test("approval can be cancelled without starting a retry loop", { timeout: 5000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chrome-bridge-cancel-test-"));
  const file = path.join(dir, "DevToolsActivePort");
  const server = http.createServer();
  const sockets = new Set();
  let approvals = 0;
  server.on("upgrade", (req, socket) => {
    approvals++;
    sockets.add(socket);
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await writeFile(file, `${server.address().port}\n/devtools/browser/test-123\n`);
    const controller = new AbortController();
    const pending = startBridge(file, server.address().port, () => {}, controller.signal);
    const rejection = assert.rejects(pending, /cancelled/);
    await once(server, "upgrade");
    controller.abort();
    await rejection;
    assert.equal(approvals, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await unlink(file);
    await rmdir(dir);
  }
});
