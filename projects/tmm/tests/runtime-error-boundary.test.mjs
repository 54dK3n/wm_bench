import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/global-error.tsx", import.meta.url), "utf8");

test("global runtime failures offer a Chinese reload and platform recovery path", () => {
  assert.match(source, /页面暂时没有加载完成/);
  assert.match(source, /window\.location\.reload\(\)/);
  assert.match(source, /window\.location\.assign\("\/portal\.html"\)/);
  assert.doesNotMatch(source, /This page couldn.t load/);
});
