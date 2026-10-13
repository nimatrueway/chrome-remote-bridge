const vscode = require("vscode");
const { readFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

exports.activate = function (context) {
  const output = vscode.window.createOutputChannel("Chrome Remote Bridge");
  const bridges = new Map();
  context.subscriptions.push(output, {
    dispose() {
      for (const bridge of bridges.values()) bridge.dispose();
    },
  });
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
    if (session.parentSession) return;
    bridges.get(session.configuration.__chromeRemoteBridgePort)?.dispose();
  }));
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(
    "chrome-remote-bridge",
    {
      async resolveDebugConfiguration(folder, config, token) {
        if (config.request !== "attach" ||
            !["127.0.0.1", "localhost"].includes(config.address ?? "127.0.0.1") ||
            !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
          throw new Error("Chrome Remote Bridge requires attach, a local address, and a port between 1 and 65535.");
        }
        const { parseEndpoint, startBridge } = await import("./bridge.mjs");
        const roots = process.platform === "darwin"
          ? ["Chromium", "Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "BraveSoftware/Brave-Browser", "Microsoft Edge"]
            .map(name => path.join(os.homedir(), "Library/Application Support", name))
          : [];
        if (config.devToolsActivePort && !path.isAbsolute(config.devToolsActivePort)) {
          throw new Error("devToolsActivePort must be an absolute path.");
        }
        const files = config.devToolsActivePort
          ? [config.devToolsActivePort]
          : roots.map(root => path.join(root, "DevToolsActivePort"));
        let file;
        for (const candidate of files) {
          let text;
          try {
            text = await readFile(candidate, "utf8");
          } catch (error) {
            if (!config.devToolsActivePort && error.code === "ENOENT") continue;
            throw error;
          }
          if (parseEndpoint(text).port === config.port) {
            file = candidate;
            break;
          }
        }
        if (!file) {
          throw new Error(`No DevToolsActivePort file matches port ${config.port}. Enable chrome://inspect/#remote-debugging and check its current port, or set devToolsActivePort to the file's absolute path.`);
        }
        const controller = new AbortController();
        let bridge;
        const cancellation = token?.onCancellationRequested(() => {
          controller.abort();
          bridge?.dispose();
        });
        if (token?.isCancellationRequested) controller.abort();
        try {
          output.appendLine("Waiting for Chromium's debugging approval...");
          bridge = await startBridge(file, config.port, message => output.appendLine(message), controller.signal);
        } catch (error) {
          cancellation?.dispose();
          throw error;
        }
        const originalDispose = bridge.dispose;
        bridge.dispose = () => {
          cancellation?.dispose();
          bridges.delete(bridge.port);
          originalDispose();
        };
        bridges.set(bridge.port, bridge);
        output.appendLine(`Forwarding localhost:${bridge.port} to Chromium:${config.port}`);
        const { devToolsActivePort, ...rest } = config;
        return {
          ...rest,
          type: "pwa-chrome",
          address: "127.0.0.1",
          port: bridge.port,
          __chromeRemoteBridgePort: bridge.port,
          targetSelection: config.targetSelection ?? "pick",
        };
      },
    },
  ));
};
