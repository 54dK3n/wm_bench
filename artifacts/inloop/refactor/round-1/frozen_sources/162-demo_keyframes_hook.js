"use strict";

// Driver-only observer of already rendered main-view frames. Serialized into
// the browser; never calls render, observe, an interaction, or a recorder API.
function installDemoKeyframesCapture() {
  if (globalThis.__wmDriverDemoKeyframes) throw new Error("demo keyframe hook already installed");
  if (typeof renderer?.render !== "function" || !renderer.domElement?.toDataURL || typeof camera === "undefined") {
    throw new Error("native main-view renderer unavailable");
  }
  const ledger = { schema: "wm-demo-keyframes/v1", frames: [], errors: [], renderCount: 0,
    nativeEvidenceBudgetBytes: 20 * 1024 * 1024, screenshotBytes: 0, maxScreenshots: 4,
    budgetEnforcedOn: "native_vision_only",
    source: "first native main-view render after each target package's first successful grab/delivery; no extra render or observe" };
  globalThis.__wmDriverDemoKeyframes = ledger;
  const originalRender = renderer.render;
  let runId = null, eventIndex = 0;
  const seen = new Set();
  const copy = value => JSON.parse(JSON.stringify(value));
  const fail = (phase, cause, event = null) => ledger.errors.push({ phase,
    message: String(cause?.message || cause), eventSeq: event?.seq ?? null });
  renderer.render = function (...args) {
    // Keep the native call (and any previously installed truth hook) unchanged.
    const returned = originalRender.apply(this, args);
    if (args[1] !== camera || typeof competitionSession === "undefined") return returned;
    try {
      const session = competitionSession;
      const record = session?.recorder?.record;
      if (!record || record.taskId !== "R2-GYI-MVP-02") return returned;
      if (runId && runId !== record.runId) throw new Error("demo hook cannot combine multiple runs");
      runId = record.runId;
      ledger.runId = runId;
      ledger.taskId = record.taskId;
      ledger.renderCount += 1;
      const events = record.events || [];
      const fresh = events.slice(eventIndex);
      eventIndex = events.length;
      const relevant = fresh.filter(event => event.objectRole === "target"
        && ((event.type === "package_grabbed" && event.accepted === true) || event.type === "package_delivered"));
      if (!relevant.length) return returned;
      for (const event of relevant) {
        const eventKey = `${event.packageId}:${event.type}`;
        if (seen.has(eventKey)) continue;
        seen.add(eventKey);
        try {
          if (ledger.frames.length >= ledger.maxScreenshots) throw new Error("demo requires more than four target keyframes");
          const inputType = event.type === "package_grabbed" ? "package_grab" : "package_release";
          const input = [...(record.inputs || [])].reverse().find(item => item.type === inputType
            && item.seq < event.seq && item.t === event.t
            && (event.stateRevision === undefined || item.stateRevision === event.stateRevision));
          if (!input || !Number.isSafeInteger(input.tick)) throw new Error("success event has no exact interaction input");
          const captureTick = deterministicSimulator.tick;
          if (captureTick < input.tick) throw new Error("main render precedes interaction tick");
          const dataUrl = renderer.domElement.toDataURL("image/png");
          if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error("main-view PNG readback failed");
          const pngBase64 = dataUrl.slice("data:image/png;base64,".length);
          const byteLength = pngBase64.length * 3 / 4 - (pngBase64.endsWith("==") ? 2 : pngBase64.endsWith("=") ? 1 : 0);
          const nativeBytes = (record.visionFrames || []).reduce((n, frame) => n + Number(frame.byteLength || 0), 0);
          const matrix = Array.from(camera.matrixWorld.elements);
          const objectState = session.packageStateEngine?.snapshot();
          ledger.frames.push({ index: ledger.frames.length + 1, runId, taskId: record.taskId,
            event: copy(event), packageId: event.packageId, objectRole: event.objectRole ?? null,
            eventType: event.type, eventSeq: event.seq, eventTimeMs: event.t,
            eventTick: input.tick, eventStateRevision: input.stateRevision ?? null,
            interactionInputSeq: input.seq, eventTickSource: "exact native interaction input at same t before event",
            captureTick, captureStateRevision: session.stateRevision, tickDelta: captureTick - input.tick,
            sessionStatusAtCapture: session.status, sameTickAndRevision: captureTick === input.tick
              && session.stateRevision === input.stateRevision,
            view: "main_scene", cameraMode: typeof cameraMode === "undefined" ? null : cameraMode,
            source: "synchronous main renderer canvas PNG readback after original render returns",
            vehicle: { x: robotPose.x, z: robotPose.z, heading: robotPose.heading },
            camera: { matrixWorld: matrix, world: [matrix[12], matrix[13], matrix[14]],
              forward: [-matrix[8], -matrix[9], -matrix[10]] },
            objectState: objectState ? copy(objectState) : null,
            width: renderer.domElement.width, height: renderer.domElement.height,
            mimeType: "image/png", byteLength, pngBase64, nativeFrameBytesAtCapture: nativeBytes });
          ledger.screenshotBytes += byteLength;
        } catch (cause) { fail("event_capture", cause, event); }
      }
    } catch (cause) { fail("main_render_observer", cause); }
    return returned;
  };
  return { installed: true, schema: ledger.schema, source: ledger.source };
}

module.exports = { installDemoKeyframesCapture };
