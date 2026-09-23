"use strict";

// Serialized by the driver and installed in its browser context. This observes
// existing rendering/recording only; no task API, physics or ledger is changed.
function installVisionTruthCapture() {
  if (globalThis.__wmDriverVisionTruth) throw new Error("vision truth hook already installed");
  if (typeof renderer?.render !== "function" || typeof addCompetitionVisionEvidence !== "function") {
    throw new Error("native camera rendering/evidence functions unavailable");
  }
  const ledger = { schema: "wm-camera-render-truth/v1", frames: [], errors: [], renderCount: 0 };
  globalThis.__wmDriverVisionTruth = ledger;
  const originalRender = renderer.render;
  const originalEvidence = addCompetitionVisionEvidence;
  let pending = null;
  const copy = value => JSON.parse(JSON.stringify(value));
  const error = (phase, cause) => ledger.errors.push({ phase, message: String(cause?.message || cause) });
  renderer.render = function (...args) {
    if (args[1] === virtualCamera && competitionSession?.status === "running") {
      pending = null;
      try {
        const matrix = Array.from(virtualCamera.matrixWorld.elements);
        if (matrix.length !== 16 || !matrix.every(Number.isFinite)) throw new Error("invalid camera matrixWorld");
        const objects = competitionSession.packageStateEngine?.snapshot();
        if (!objects || !Array.isArray(objects.packages)) throw new Error("native package snapshot unavailable");
        pending = {
          captureSerial: ++ledger.renderCount,
          runId: competitionSession.recorder.record.runId,
          captureTick: deterministicSimulator.tick,
          captureStateRevision: competitionSession.stateRevision,
          vehicle: { x: robotPose.x, z: robotPose.z, heading: robotPose.heading },
          camera: { matrixWorld: matrix, world: [matrix[12], matrix[13], matrix[14]],
            forward: [-matrix[8], -matrix[9], -matrix[10]], right: [matrix[0], matrix[1], matrix[2]] },
          objectState: copy(objects),
          source: "synchronous renderer.render(scene, virtualCamera) entry after updateVirtualCameraPose",
          exactRenderState: true
        };
      } catch (cause) { error("render_snapshot", cause); }
    }
    return originalRender.apply(this, args);
  };
  addCompetitionVisionEvidence = function (...args) {
    // Native return value and exceptions are preserved. Diagnostics only attach
    // to the native record that was just created, in this separate driver ledger.
    const recorded = originalEvidence.apply(this, args);
    if (recorded && args[0] === virtualCameraCanvas) {
      try {
        if (!pending || pending.runId !== competitionSession.recorder.record.runId) {
          throw new Error("native evidence has no matching camera render snapshot");
        }
        ledger.frames.push({ ...pending, frameId: recorded.frameId, evidenceId: recorded.evidenceId,
          evidenceSeq: recorded.seq, evidenceTick: recorded.tick, evidenceStateRevision: recorded.stateRevision,
          imageSha256: recorded.sha256, nativeByteLength: recorded.byteLength,
          sameTickAndRevision: pending.captureTick === recorded.tick
            && pending.captureStateRevision === recorded.stateRevision });
        pending = null;
      } catch (cause) { error("evidence_binding", cause); }
    }
    return recorded;
  };
  return { installed: true, schema: ledger.schema,
    source: "native camera render entry + native evidence return; driver-only truth" };
}

module.exports = { installVisionTruthCapture };
