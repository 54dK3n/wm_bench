/* Browser-side robot backend. Only the local authenticated controller owns this
 * lifecycle. The external brain receives the limited bridge credential, never
 * the page session, evaluation exports, scene configuration or controller token.
 */
(function installRobotBackend(root) {
  "use strict";
  const VERSION = "robot-backend-v4-stage1-r1";
  let active = null;
  const clone = value => JSON.parse(JSON.stringify(value));
  const tick = () => deterministicSimulator?.tick ?? 0;

  async function request(url, body, token, method = "POST", signal) {
    const response = await fetch(url, { method, credentials: "same-origin", signal,
      headers: { "Content-Type": "application/json", ...(token ? { "X-Robot-Bridge-Controller": token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.code || `HTTP_${response.status}`);
    return result;
  }

  function cameraParameters() {
    // The scene uses eight world units per metre. These are fixed rig offsets,
    // not a world position; no camera matrix or scene coordinates leave here.
    return { ...root.RobotBridgeContract.CAMERA_PARAMETERS, mount: {
      forwardCm: worldUnitsToCm(-virtualCamera.position.z),
      rightCm: worldUnitsToCm(virtualCamera.position.x),
      upCm: worldUnitsToCm(robotGroup.position.y + virtualCamera.position.y),
      pitchDeg: THREE.MathUtils.radToDeg(virtualCamera.rotation.x)
    } };
  }

  async function observe(params) {
    const frame = await startVirtualCameraVision();
    const status = root.CarVision.getStatus();
    if (!frame || !status.fresh || status.frameId !== frame.frameId) {
      throw new root.RobotBridgeContract.ContractError("STALE_SENSOR");
    }
    // Preserve the existing pixel query and its exact frame binding in the
    // native evaluator record. Its old distance output is NOT sent to the brain.
    const args = [params.category ?? null, params.confidence ?? 0];
    addCompetitionVisionQuery("observe", args, projectSimpleVisionQuery("observe", args), frame.frameId);
    const detections = [];
    for (const item of root.CarVision.getDetections()) {
      // Only detector output is a sensor; task-role labels are translated to
      // appearance classes and taught templates are excluded.
      if (item.source !== "yolo" || !item.box) continue;
      const category = item.colorClass === "red" ? "red-ball" : item.colorClass === "blue" ? "blue-ball"
        : item.category === "obstacle" ? "obstacle" : null;
      if (!category || (params.category && category !== params.category)
        || item.confidence < (params.confidence ?? 0)) continue;
      // Frozen detector coordinates are a 640-square letterbox: padY = 80.
      const x = Math.max(0, item.box.x), y = Math.max(0, item.box.y - 80);
      const right = Math.min(640, item.box.x + item.box.width);
      const bottom = Math.min(480, item.box.y + item.box.height - 80);
      if (right <= x || bottom <= y) continue;
      detections.push({ category, confidence: item.confidence,
        bbox: { x, y, w: right - x, h: bottom - y } });
    }
    if (!params.category || params.category === "storage-zone") {
      const pixels = virtualCameraContext.getImageData(0, 0, 640, 480);
      for (const item of root.CarStorageRegionPixels.detectStorageRegions(pixels)) {
        if (item.confidence >= (params.confidence ?? 0)) detections.push(item);
      }
    }
    return { frameId: frame.frameId, tick: tick(), width: 640, height: 480, detections };
  }

  function localRoad() {
    const value = readNavigationSensor("road_state");
    return { onRoad: value.onRoad, lateralOffsetCm: value.lateralOffsetCm,
      headingErrorDeg: value.headingErrorDeg, leftClearanceCm: value.leftClearanceCm,
      rightClearanceCm: value.rightClearanceCm, frontClearanceCm: value.frontClearanceCm,
      atJunction: value.atJunction, atNode: value.atNode,
      exits: value.exits.map(exit => ({ angleDeg: exit.turnDeg })), tick: value.tick };
  }

  async function execute(command) {
    if (!active || !running || stopRequested || competitionSession?.status !== "running") {
      throw new root.RobotBridgeContract.ContractError("NOT_RUNNING");
    }
    const { method, params } = command;
    switch (method) {
      case "observe": return observe(params);
      case "camera_parameters": return cameraParameters();
      case "odometry": return readNavigationSensor("odometry");
      case "local_road": return localRoad();
      case "holding": return { holding: Boolean(heldPackageId) };
      case "follow_road": return executeNavigationControl("follow_road", {
        maxCm: params.distanceCm, speed: params.speed ?? 50, obeySpeedLimit: false });
      case "take_exit": {
        // IDs stay inside the actuator implementation. Select only the currently
        // sensed local exit by its published relative angle, with no path lookup.
        const road = readNavigationSensor("road_state");
        const exits = road.exits.filter(exit => exit.turnDeg === params.angleDeg);
        if (exits.length !== 1) throw new root.RobotBridgeContract.ContractError(
          exits.length ? "AMBIGUOUS_EXIT" : "INVALID_EXIT");
        return executeNavigationControl("take_exit", { roadId: exits[0].roadId,
          speed: params.speed ?? 50, obeySpeedLimit: false });
      }
      case "forward": case "backward": {
        const plan = driveDistancePlan(params.distanceCm);
        // The existing distance plan is exact in ticks. Optional speed changes
        // must be represented in the plan, not silently ignored.
        if (params.speed !== undefined) {
          const { stepMs, vehicle } = deterministicSimulator.config;
          const speed = normalizeDriveSpeed(params.speed);
          const duration = cmToWorldUnits(params.distanceCm) / (vehicle.maxLinearSpeed * speed / 100);
          const ticks = Math.max(1, Math.ceil(duration * 1000 / stepMs));
          plan.durationMs = ticks * stepMs;
          plan.speed = cmToWorldUnits(params.distanceCm) / (plan.durationMs / 1000);
          plan.speedPercent = plan.speed / vehicle.maxLinearSpeed * 100;
        }
        await moveRobot(method === "forward" ? 1 : -1, plan.durationMs / 1000, plan.speedPercent, plan);
        return { completed: true };
      }
      case "turn": {
        const { stepMs, vehicle } = deterministicSimulator.config;
        const duration = THREE.MathUtils.degToRad(Math.abs(params.angleDeg))
          / (vehicle.maxAngularSpeed * (params.speed ?? 50) / 100);
        await runDeterministicCommand({ kind: "turn_angle", direction: Math.sign(params.angleDeg),
          angleDegrees: Math.abs(params.angleDeg), durationMs: Math.max(1, Math.ceil(duration * 1000 / stepMs)) * stepMs });
        return { completed: true };
      }
      case "grab": case "release":
        await realtimeRun.robot[method]();
        return { completed: true };
      default: throw new root.RobotBridgeContract.ContractError("METHOD_NOT_ALLOWED");
    }
  }

  async function controlLoop(context) {
    try {
      while (!context.closed) {
        const next = await request(`${context.url}/next`, undefined, context.controllerToken, "GET", context.abort.signal);
        if (!next.command || context.closed) continue;
        const command = root.RobotBridgeContract.normalizeCommand(next.command);
        const call = context.recorder.beginCall(command.method, command.params);
        let response;
        try {
          const result = root.RobotBridgeContract.sanitizeResponse(command.method, await execute(command));
          response = { requestId: command.requestId, tick: tick(), result };
          context.recorder.endCall(call, { result });
        } catch (error) {
          const code = root.RobotBridgeContract.ERROR_CODES.includes(error.code) ? error.code : "ACTION_FAILED";
          response = { requestId: command.requestId, tick: tick(), error: { code } };
          context.recorder.endCall(call, { error: { code } });
          context.errors.push({ tick: tick(), requestId: command.requestId, message: String(error.stack || error) });
        }
        // Unknown delivery is never replayed automatically: a lost response must
        // not cause the same physical action to be performed twice.
        await request(`${context.url}/results`, response, context.controllerToken);
      }
    } catch (error) {
      if (!context.closed) {
        context.failed = true;
        context.errors.push({ tick: tick(), controllerError: String(error.stack || error) });
        // Close the channel on delivery uncertainty. No command is resubmitted.
        try { await request(`${context.url}/close`, {}, context.controllerToken); }
        catch (closeError) { context.errors.push({ tick: tick(), closeError: String(closeError) }); }
      }
    }
  }

  async function start(options = {}) {
    if (active || running) throw new Error("ROBOT_BACKEND_ALREADY_RUNNING");
    if (activeMission.environment !== "guangyang") throw new Error("ROBOT_BACKEND_REQUIRES_ROAD_SCENE");
    const sourceResponse = await fetch("./robot-backend-runtime.js", { cache: "no-store", credentials: "same-origin" });
    if (!sourceResponse.ok) throw new Error("ROBOT_BACKEND_SOURCE_UNAVAILABLE");
    const sourceHash = new Uint8Array(await crypto.subtle.digest("SHA-256", await sourceResponse.arrayBuffer()));
    const provenance = { ...options.provenance, version: VERSION,
      sourceSha256: Array.from(sourceHash, byte => byte.toString(16).padStart(2, "0")).join("") };
    const registration = await request("/api/v1/robot-bridge/controllers", {});
    try {
    setRobotBackendMode(true);
    clearCompetitionTimers();
    competitionSession = null;
    latestCompetitionRecord = null;
    restoreMissionBaseline();
    missionAttempt = null;
    resetRobot();
    rebuildSceneObjects();
    initializeMissionAttempt();
    await ensureSimulationSceneReady();
    await virtualCameraCapturePromise;
    stopRequested = false;
    pauseRequested = false;
    missionCompletionStopRequested = false;
    runToken += 1;
    actionCount = 0;
    robotLinearSpeed = 0;
    robotSteering = 0;
    const core = root.CompetitionCore;
    const simulatorCore = ensureDeterministicSimulator({ reset: true });
    competitionSession = core.createSession(activeMission.competition.config, {
      sourceCode: JSON.stringify({ version: VERSION, sourceSha256: provenance.sourceSha256 }),
      randomSeed: activeMission.competition.randomSeed ?? 0,
      simulationDefinition: simulatorCore.definition(), interactionDefinition: packageInteractionDefinition(),
      runDefinition: { visionDefinition: core.VISION_DEFINITION,
        navigationDefinition: core.NAVIGATION_DEFINITION, navigationControlDefinition: core.NAVIGATION_CONTROL_DEFINITION }
    }, { robotRuntime: { timeLimitSeconds: null, visionEvidenceLimitBytes: null,
      visionEvidenceFrameLimit: null, ...(options.limits || {}) } });
    running = true;
    realtimeRun = { target: "sim", actionCount: 0, totalSeconds: 0, navigationOrigin: { ...robotPose },
      navigationStartTick: 0, navigationDistance: 0, navigationQueryCount: 0,
      navigationControlCount: 0, navigationRoadTopology: null };
    realtimeRun.robot = makeSimRobotApi();
    beginSimulationVisionRun();
    const recorder = new root.RobotRecord.RobotRunRecorder({ session: competitionSession,
      envelope: provenance });
    const context = { ...registration, url: `/api/v1/robot-bridge/controllers/${registration.bridgeId}`,
      recorder, errors: [], abort: new AbortController(), closed: false, finalExport: null };
    active = context;
    console.info(JSON.stringify({ event: "program_version", ...provenance }));
    competitionTick(true);
    context.loop = controlLoop(context);
    return { bridgeId: registration.bridgeId, clientToken: registration.clientToken,
      protocolVersion: registration.protocolVersion, version: VERSION };
    } catch (error) {
      try { await request(`/api/v1/robot-bridge/controllers/${registration.bridgeId}/close`, {}, registration.controllerToken); }
      catch (closeError) { error.cleanupError = String(closeError); }
      clearCompetitionTimers();
      if (competitionSession?.status === "running") competitionSession.finish("program_error");
      endSimulationVisionRun();
      running = false;
      realtimeRun = null;
      active = null;
      setRobotBackendMode(false);
      throw error;
    }
  }

  async function stop(reason = "finished") {
    const context = active;
    if (!context) throw new Error("ROBOT_BACKEND_NOT_RUNNING");
    context.closed = true;
    context.abort.abort();
    await context.loop;
    await request(`${context.url}/close`, {}, context.controllerToken);
    const trace = await request(`${context.url}/trace`, undefined, context.controllerToken, "GET");
    competitionTick(true);
    competitionSession.finish(reason);
    const exported = context.recorder.finish();
    exported.record = root.RobotRecord.withBridgeCalls(exported.record, trace.events);
    exported.envelope.controllerErrors = clone(context.errors);
    context.finalExport = exported;
    endSimulationVisionRun();
    running = false;
    realtimeRun = null;
    latestCompetitionRecord = competitionSession.finalRecord;
    active = null;
    lastExport = exported;
    return clone(exported);
  }
  let lastExport = null;
  root.RobotBackend = Object.freeze({ VERSION, start, stop,
    // Evaluation exports are a page-controller facility, not a bridge method.
    exportEvaluation: () => clone(active?.recorder.export() || lastExport),
    status: () => ({ running: Boolean(active), healthy: Boolean(active && !active.failed),
      tick: tick(), errors: clone(active?.errors || []) }) });
})(globalThis);
