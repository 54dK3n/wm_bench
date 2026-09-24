const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function functionSource(name) {
  const start = app.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\(`));
  assert.notEqual(start, -1, `${name} should exist`);
  const remaining = app.slice(start + 1);
  const next = /\n(?:async\s+)?function\s+/.exec(remaining);
  return app.slice(start, next ? start + 1 + next.index : app.length);
}

test("real-car address accepts only an HTTP(S) origin", () => {
  const source = functionSource("getValidatedRobotBaseUrl");
  const validate = new Function(`${source}; return getValidatedRobotBaseUrl;`)();

  assert.equal(validate("http://192.168.4.1"), "http://192.168.4.1");
  assert.equal(validate("https://robot.local:8443/"), "https://robot.local:8443");
  for (const value of [
    "ftp://192.168.4.1",
    "http://user:pass@192.168.4.1",
    "http://192.168.4.1/wrong",
    "http://192.168.4.1/?mode=drive",
    "http://192.168.4.1/#control"
  ]) {
    assert.throws(() => validate(value));
  }
});

test("concurrent real-car stop requests share one hardware request", async () => {
  const source = functionSource("sendRealRobotStop");
  let resolveFetch;
  const requestedUrls = [];
  const fetch = url => {
    requestedUrls.push(String(url));
    return new Promise(resolve => { resolveFetch = resolve; });
  };
  const factory = new Function("fetch", `
    let realStopPromise = null;
    let realStopPending = false;
    let realRobotActionController = null;
    const hazards = [];
    function setRealStopHazard(value) { hazards.push(Boolean(value)); }
    function updateRealRobotControls() {}
    function getValidatedRobotBaseUrl() { throw new Error("unexpected fallback"); }
    function addLog() {}
    ${source}
    return {
      sendRealRobotStop,
      state: () => ({ realStopPromise, realStopPending, hazards: [...hazards] })
    };
  `);
  const control = factory(fetch);
  const first = control.sendRealRobotStop("http://192.168.4.1");
  const second = control.sendRealRobotStop("http://192.168.4.1");

  assert.equal(requestedUrls.length, 1);
  const request = new URL(requestedUrls[0]);
  assert.equal(request.pathname, "/api/control");
  assert.equal(request.searchParams.get("action"), "stop");
  assert.equal(request.searchParams.get("time"), "0");
  resolveFetch({});
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(control.state().realStopPending, false);
  assert.equal(control.state().realStopPromise, null);
  assert.equal(control.state().hazards[0], true);
});

test("real-car camera opens a human-only stream and closes it on release", async () => {
  const cameraSource = [
    "setRealCameraState",
    "postRealCameraCommand",
    "stopRealCameraPreview",
    "startRealCameraPreview"
  ].map(functionSource).join("\n");
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return {};
  };
  const factory = new Function("fetch", `
    let activeRealCameraBaseUrl = null;
    let realCameraGeneration = 0;
    const realCameraStage = { dataset: {} };
    const cameraStatus = { textContent: "" };
    const retryCameraButton = { disabled: false };
    const cameraStream = {
      currentSrc: null,
      onload: null,
      onerror: null,
      set src(value) { this.currentSrc = String(value); },
      get src() { return this.currentSrc; },
      removeAttribute(name) { if (name === "src") this.currentSrc = null; }
    };
    const targetSelect = { value: "real" };
    const document = { hidden: false };
    function getValidatedRobotBaseUrl() { return "http://192.168.4.1"; }
    ${cameraSource}
    return {
      start: startRealCameraPreview,
      stop: stopRealCameraPreview,
      cameraStream,
      state: () => ({
        cameraState: realCameraStage.dataset.cameraState,
        status: cameraStatus.textContent,
        retryDisabled: retryCameraButton.disabled,
        activeRealCameraBaseUrl
      })
    };
  `);
  const camera = factory(fetch);

  camera.start();
  assert.equal(camera.state().cameraState, "connecting");
  assert.equal(camera.state().retryDisabled, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(new URL(requests[0].url).pathname, "/api/camera/open");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.mode, "no-cors");
  const streamUrl = new URL(camera.cameraStream.src);
  assert.equal(streamUrl.pathname, "/api/camera/stream");
  assert.equal(streamUrl.searchParams.get("fps"), "12");
  assert.equal(camera.state().cameraState, "streaming", "MJPEG 流不应依赖 load 事件才开始显示");

  camera.cameraStream.onload();
  assert.equal(camera.state().cameraState, "live");
  assert.match(camera.state().status, /仅实时预览/);
  await camera.stop();
  assert.equal(new URL(requests.at(-1).url).pathname, "/api/camera/close");
  assert.equal(camera.cameraStream.src, null);
  assert.equal(camera.state().activeRealCameraBaseUrl, null);
});
