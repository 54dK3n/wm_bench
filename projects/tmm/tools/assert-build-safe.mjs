import http from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

export function requestProbe({ host, port, path, timeoutMs = 800 }) {
  return new Promise((resolve) => {
    const request = http.get(
      { host, port, path, timeout: timeoutMs, agent: false },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (body.length < 65_536) body += chunk.slice(0, 65_536 - body.length);
        });
        response.on("end", () => resolve({
          statusCode: response.statusCode ?? 0,
          contentType: String(response.headers["content-type"] ?? ""),
          body,
        }));
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(null));
  });
}

export async function isWorkshopDevRunning({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  timeoutMs = 800,
  probe = requestProbe,
} = {}) {
  const [page, viteClient] = await Promise.all([
    probe({ host, port, path: "/competition", timeoutMs }),
    probe({ host, port, path: "/@vite/client", timeoutMs }),
  ]);
  const isWorkshop = page?.statusCode === 200 && /识物工坊/.test(page.body);
  const isViteClient = viteClient?.statusCode === 200
    && /javascript/i.test(viteClient.contentType)
    && /createHotContext|vite\/dist\/client/i.test(viteClient.body);
  return Boolean(isWorkshop && isViteClient);
}

export async function assertBuildSafe(options) {
  if (await isWorkshopDevRunning(options)) {
    throw new Error(
      "识物工坊开发服务正在 127.0.0.1:3000 运行。为避免页面模块失效，请先停止统一平台或识物工坊，再执行构建或测试。",
    );
  }
}

async function main() {
  try {
    await assertBuildSafe();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
