import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { assertBuildSafe, isWorkshopDevRunning } from "../tools/assert-build-safe.mjs";

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    await run(address.port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function workshopHandler(request, response) {
  if (request.url === "/competition") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<h1>识物工坊</h1>");
    return;
  }
  if (request.url === "/@vite/client") {
    response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    response.end("export function createHotContext() {}");
    return;
  }
  response.writeHead(404).end();
}

test("build guard recognizes the running workshop Vinext development server", async () => {
  await withServer(workshopHandler, async (port) => {
    assert.equal(await isWorkshopDevRunning({ port }), true);
    await assert.rejects(() => assertBuildSafe({ port }), /请先停止统一平台或识物工坊/);
  });
});

test("build guard ignores unrelated HTTP services", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("ordinary service");
  }, async (port) => {
    assert.equal(await isWorkshopDevRunning({ port }), false);
  });
});

test("build guard allows a closed port", async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.equal(await isWorkshopDevRunning({ port, timeoutMs: 100 }), false);
  await assert.doesNotReject(() => assertBuildSafe({ port, timeoutMs: 100 }));
});
