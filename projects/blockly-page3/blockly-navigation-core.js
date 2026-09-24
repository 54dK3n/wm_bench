"use strict";

(function initBlocklyNavigationCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BlocklyNavigationCore = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const ROAD_GRAPH_SCHEMA_VERSION = "chenlong.blockly-road-graph/v1";
  const DEFAULT_WORLD_UNITS_PER_METER = 8;
  const DEFAULT_VEHICLE_RADIUS_WORLD = 0.44;
  const DEFAULT_ENDPOINT_SNAP_DIGITS = 6;
  const DEFAULT_NODE_RADIUS_CM = 25;
  const DEFAULT_STRAIGHT_TURN_LIMIT_DEG = 30;
  const DEFAULT_BACK_TURN_LIMIT_DEG = 150;
  const MAX_ROADS = 256;
  const MAX_ROAD_POINTS = 8192;
  const MAX_TEXT_LENGTH = 128;
  const EPSILON = 1e-9;

  function compareText(left, right) {
    return String(left).localeCompare(String(right), "en");
  }

  function finiteNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(`${label}必须是有限数字`);
    if (Math.abs(number) > 1e6) throw new RangeError(`${label}超出安全范围`);
    return number;
  }

  function positiveNumber(value, label) {
    const number = finiteNumber(value, label);
    if (number <= 0) throw new RangeError(`${label}必须大于 0`);
    return number;
  }

  function safeText(value, label, { optional = false } = {}) {
    if (optional && (value === null || value === undefined)) return null;
    const text = String(value ?? "").trim();
    if (!text || text.length > MAX_TEXT_LENGTH || /[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
      throw new TypeError(`${label}必须是 1 到 ${MAX_TEXT_LENGTH} 个可打印字符`);
    }
    return text;
  }

  function round1(value) {
    return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function normalizeSignedAngle(angle) {
    let normalized = Number(angle);
    while (normalized < -Math.PI) normalized += Math.PI * 2;
    while (normalized >= Math.PI) normalized -= Math.PI * 2;
    return normalized;
  }

  function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    Object.values(value).forEach(item => deepFreeze(item, seen));
    return Object.freeze(value);
  }

  function cloneFrozen(value) {
    return deepFreeze(structuredClone(value));
  }

  function normalizePoint(value, label) {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new TypeError(`${label}必须是 [x, z]`);
    }
    return [finiteNumber(value[0], `${label}.x`), finiteNumber(value[1], `${label}.z`)];
  }

  function endpointKey(point, digits) {
    return `${point[0].toFixed(digits)},${point[1].toFixed(digits)}`;
  }

  function endpointNodeId(endpoint) {
    return `node:${encodeURIComponent(endpoint.roadId)}:${endpoint.side}`;
  }

  function closestPointOnSegment(x, z, start, end) {
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared <= EPSILON) {
      return { x: start[0], z: start[1], t: 0, distance: Math.hypot(x - start[0], z - start[1]) };
    }
    const t = clamp(((x - start[0]) * dx + (z - start[1]) * dz) / lengthSquared, 0, 1);
    const projectedX = start[0] + dx * t;
    const projectedZ = start[1] + dz * t;
    return { x: projectedX, z: projectedZ, t, distance: Math.hypot(x - projectedX, z - projectedZ) };
  }

  function projectRecord(record, x, z) {
    let best = null;
    for (let index = 0; index < record.segmentLengths.length; index += 1) {
      const length = record.segmentLengths[index];
      if (length <= EPSILON) continue;
      const projected = closestPointOnSegment(x, z, record.points[index], record.points[index + 1]);
      const candidate = {
        ...projected,
        segmentIndex: index,
        progressWorld: record.cumulativeLengths[index] + length * projected.t,
        tangentX: (record.points[index + 1][0] - record.points[index][0]) / length,
        tangentZ: (record.points[index + 1][1] - record.points[index][1]) / length
      };
      if (!best || candidate.distance < best.distance - EPSILON
        || (Math.abs(candidate.distance - best.distance) <= EPSILON && candidate.progressWorld < best.progressWorld)) {
        best = candidate;
      }
    }
    if (!best) throw new Error(`道路 ${record.roadId} 没有可投影的线段`);
    return best;
  }

  function normalizePose(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("小车姿态必须包含 x、z 和 heading");
    }
    return {
      x: finiteNumber(value.x, "姿态 x"),
      z: finiteNumber(value.z, "姿态 z"),
      heading: finiteNumber(value.heading, "姿态 heading")
    };
  }

  function createNetwork(roads, options = {}) {
    if (!Array.isArray(roads) || roads.length < 1 || roads.length > MAX_ROADS) {
      throw new RangeError(`道路数量必须是 1 到 ${MAX_ROADS}`);
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("导航网络选项格式不正确");
    }
    const worldUnitsPerMeter = positiveNumber(
      options.worldUnitsPerMeter ?? DEFAULT_WORLD_UNITS_PER_METER,
      "每米地图单位"
    );
    const vehicleRadiusWorld = positiveNumber(
      options.vehicleRadiusWorld ?? DEFAULT_VEHICLE_RADIUS_WORLD,
      "小车半径"
    );
    const endpointSnapDigits = Number(options.endpointSnapDigits ?? DEFAULT_ENDPOINT_SNAP_DIGITS);
    if (!Number.isSafeInteger(endpointSnapDigits) || endpointSnapDigits < 0 || endpointSnapDigits > 9) {
      throw new RangeError("道路端点精度必须是 0 到 9 的整数");
    }
    const nodeRadiusCm = positiveNumber(options.nodeRadiusCm ?? DEFAULT_NODE_RADIUS_CM, "节点判定半径");
    const straightTurnLimitDeg = positiveNumber(
      options.straightTurnLimitDeg ?? DEFAULT_STRAIGHT_TURN_LIMIT_DEG,
      "直行角度阈值"
    );
    const backTurnLimitDeg = positiveNumber(
      options.backTurnLimitDeg ?? DEFAULT_BACK_TURN_LIMIT_DEG,
      "掉头角度阈值"
    );
    if (straightTurnLimitDeg >= 90 || backTurnLimitDeg <= 90 || backTurnLimitDeg > 180) {
      throw new RangeError("转向分类阈值不正确");
    }
    const centimetersPerWorldUnit = 100 / worldUnitsPerMeter;
    const cmToWorld = centimeters => finiteNumber(centimeters, "厘米距离") / centimetersPerWorldUnit;
    const worldToCm = world => round1(finiteNumber(world, "地图距离") * centimetersPerWorldUnit);
    const ids = new Set();
    const endpointGroups = new Map();
    let totalPointCount = 0;

    const records = roads.map((road, roadIndex) => {
      if (!road || typeof road !== "object" || Array.isArray(road)) {
        throw new TypeError(`第 ${roadIndex + 1} 条道路格式不正确`);
      }
      const roadId = safeText(road.id, `第 ${roadIndex + 1} 条道路编号`);
      if (ids.has(roadId)) throw new TypeError(`道路编号不能重复：${roadId}`);
      ids.add(roadId);
      const width = positiveNumber(road.width, `道路 ${roadId} 宽度`);
      if (!Array.isArray(road.points) || road.points.length < 2) {
        throw new TypeError(`道路 ${roadId} 至少需要两个点`);
      }
      totalPointCount += road.points.length;
      if (totalPointCount > MAX_ROAD_POINTS) {
        throw new RangeError(`道路点总数不能超过 ${MAX_ROAD_POINTS}`);
      }
      const points = road.points.map((point, pointIndex) => normalizePoint(point, `道路 ${roadId} 第 ${pointIndex + 1} 点`));
      const segmentLengths = [];
      const cumulativeLengths = [0];
      let length = 0;
      for (let index = 0; index < points.length - 1; index += 1) {
        const segmentLength = Math.hypot(
          points[index + 1][0] - points[index][0],
          points[index + 1][1] - points[index][1]
        );
        segmentLengths.push(segmentLength);
        length += segmentLength;
        cumulativeLengths.push(length);
      }
      if (length <= EPSILON) throw new TypeError(`道路 ${roadId} 必须具有正长度`);
      const startKey = endpointKey(points[0], endpointSnapDigits);
      const endKey = endpointKey(points[points.length - 1], endpointSnapDigits);
      if (startKey === endKey) throw new TypeError(`道路 ${roadId} 不能形成端点自环`);
      const record = {
        roadId,
        width,
        points,
        length,
        segmentLengths,
        cumulativeLengths,
        oneWay: Boolean(road.oneWay),
        startKey,
        endKey,
        fromNodeId: null,
        toNodeId: null
      };
      [["start", startKey, points[0]], ["end", endKey, points[points.length - 1]]]
        .forEach(([side, key, point]) => {
          const group = endpointGroups.get(key) || { key, endpoints: [] };
          group.endpoints.push({ roadId, side, point, record });
          endpointGroups.set(key, group);
        });
      return record;
    });

    const nodes = [...endpointGroups.values()].map(group => {
      group.endpoints.sort((left, right) => compareText(left.roadId, right.roadId)
        || compareText(left.side, right.side));
      const point = group.endpoints.reduce((sum, endpoint) => [
        sum[0] + endpoint.point[0], sum[1] + endpoint.point[1]
      ], [0, 0]).map(value => value / group.endpoints.length);
      return {
        nodeId: endpointNodeId(group.endpoints[0]),
        point,
        roadIds: [...new Set(group.endpoints.map(endpoint => endpoint.roadId))].sort(compareText),
        endpoints: group.endpoints
      };
    }).sort((left, right) => compareText(left.nodeId, right.nodeId));

    const nodeByKey = new Map();
    nodes.forEach(node => node.endpoints.forEach(endpoint => {
      nodeByKey.set(endpoint.side === "start" ? endpoint.record.startKey : endpoint.record.endKey, node);
    }));
    records.forEach(record => {
      record.fromNodeId = nodeByKey.get(record.startKey)?.nodeId || null;
      record.toNodeId = nodeByKey.get(record.endKey)?.nodeId || null;
    });
    const recordsById = new Map(records.map(record => [record.roadId, record]));
    const nodesById = new Map(nodes.map(node => [node.nodeId, node]));

    const graph = deepFreeze({
      schemaVersion: ROAD_GRAPH_SCHEMA_VERSION,
      nodes: nodes.map(node => ({ nodeId: node.nodeId, roadIds: [...node.roadIds] })),
      edges: records.map(record => ({
        roadId: record.roadId,
        fromNodeId: record.fromNodeId,
        toNodeId: record.toNodeId,
        lengthCm: worldToCm(record.length),
        oneWay: record.oneWay
      })).sort((left, right) => compareText(left.roadId, right.roadId))
    });

    function requireRoad(roadId) {
      const normalizedId = safeText(roadId, "道路编号");
      const record = recordsById.get(normalizedId);
      if (!record) throw new RangeError(`道路不存在：${normalizedId}`);
      return record;
    }

    function publicProjection(record, projected, radiusWorld = vehicleRadiusWorld) {
      const centerClearance = record.width / 2 - radiusWorld;
      return {
        roadId: record.roadId,
        x: projected.x,
        z: projected.z,
        tangentX: projected.tangentX,
        tangentZ: projected.tangentZ,
        segmentIndex: projected.segmentIndex,
        progressWorld: projected.progressWorld,
        progressCm: worldToCm(projected.progressWorld),
        distanceWorld: projected.distance,
        distanceCm: worldToCm(projected.distance),
        widthWorld: record.width,
        lengthWorld: record.length,
        lengthCm: worldToCm(record.length),
        onRoad: projected.distance <= centerClearance + EPSILON,
        fromNodeId: record.fromNodeId,
        toNodeId: record.toNodeId,
        oneWay: record.oneWay
      };
    }

    function project(x, z, roadId = null) {
      const pointX = finiteNumber(x, "投影 x");
      const pointZ = finiteNumber(z, "投影 z");
      if (roadId !== null && roadId !== undefined) {
        const record = requireRoad(roadId);
        return cloneFrozen(publicProjection(record, projectRecord(record, pointX, pointZ)));
      }
      const candidates = records.map(record => ({ record, projected: projectRecord(record, pointX, pointZ) }))
        .sort((left, right) => left.projected.distance - right.projected.distance
          || compareText(left.record.roadId, right.record.roadId));
      const selected = candidates[0];
      return cloneFrozen(publicProjection(selected.record, selected.projected));
    }

    function pointAt(roadId, progressCm) {
      const record = requireRoad(roadId);
      const requestedCm = finiteNumber(progressCm, "道路进度");
      const progressWorld = clamp(requestedCm / centimetersPerWorldUnit, 0, record.length);
      for (let index = 0; index < record.segmentLengths.length; index += 1) {
        const length = record.segmentLengths[index];
        if (length <= EPSILON) continue;
        const start = record.cumulativeLengths[index];
        const end = record.cumulativeLengths[index + 1];
        if (progressWorld <= end + EPSILON || index === record.segmentLengths.length - 1) {
          const ratio = clamp((progressWorld - start) / length, 0, 1);
          const tangentX = (record.points[index + 1][0] - record.points[index][0]) / length;
          const tangentZ = (record.points[index + 1][1] - record.points[index][1]) / length;
          return deepFreeze({
            roadId: record.roadId,
            progressCm: worldToCm(progressWorld),
            x: record.points[index][0] + (record.points[index + 1][0] - record.points[index][0]) * ratio,
            z: record.points[index][1] + (record.points[index + 1][1] - record.points[index][1]) * ratio,
            tangentX,
            tangentZ,
            heading: Math.atan2(-tangentX, -tangentZ)
          });
        }
      }
      throw new Error(`道路 ${record.roadId} 没有可用线段`);
    }

    function pathAlong(roadId, fromProgressCm, toProgressCm) {
      const record = requireRoad(roadId);
      const fromWorld = clamp(finiteNumber(fromProgressCm, "起始道路进度") / centimetersPerWorldUnit, 0, record.length);
      const toWorld = clamp(finiteNumber(toProgressCm, "结束道路进度") / centimetersPerWorldUnit, 0, record.length);
      const result = [];
      const append = point => {
        const previous = result[result.length - 1];
        if (!previous || Math.hypot(previous[0] - point[0], previous[1] - point[1]) > EPSILON) result.push(point);
      };
      const first = pointAt(record.roadId, worldToCm(fromWorld));
      append([first.x, first.z]);
      if (toWorld >= fromWorld) {
        for (let index = 1; index < record.points.length - 1; index += 1) {
          const progress = record.cumulativeLengths[index];
          if (progress > fromWorld + EPSILON && progress < toWorld - EPSILON) append([...record.points[index]]);
        }
      } else {
        for (let index = record.points.length - 2; index >= 1; index -= 1) {
          const progress = record.cumulativeLengths[index];
          if (progress < fromWorld - EPSILON && progress > toWorld + EPSILON) append([...record.points[index]]);
        }
      }
      const last = pointAt(record.roadId, worldToCm(toWorld));
      append([last.x, last.z]);
      return deepFreeze(result);
    }

    function anchorAt(x, z, id = null) {
      const projection = project(x, z);
      const anchor = {
        ...(id === null || id === undefined ? {} : { id: safeText(id, "锚点编号") }),
        roadId: projection.roadId,
        progressCm: projection.progressCm
      };
      return deepFreeze(anchor);
    }

    function endpointOutwardTangent(endpoint) {
      const points = endpoint.record.points;
      const originIndex = endpoint.side === "start" ? 0 : points.length - 1;
      const step = endpoint.side === "start" ? 1 : -1;
      const origin = points[originIndex];
      for (let index = originIndex + step; index >= 0 && index < points.length; index += step) {
        const dx = points[index][0] - origin[0];
        const dz = points[index][1] - origin[1];
        const length = Math.hypot(dx, dz);
        if (length > EPSILON) return [dx / length, dz / length];
      }
      return null;
    }

    function exitsAtNode(nodeRecord, heading) {
      const exitsByRoad = new Map();
      nodeRecord.endpoints.forEach(endpoint => {
        if (endpoint.record.oneWay && endpoint.side !== "start") return;
        const tangent = endpointOutwardTangent(endpoint);
        if (!tangent) return;
        const exitHeading = Math.atan2(-tangent[0], -tangent[1]);
        const turnDeg = round1(normalizeSignedAngle(exitHeading - heading) * 180 / Math.PI);
        const absoluteTurn = Math.abs(turnDeg);
        const direction = absoluteTurn <= straightTurnLimitDeg + EPSILON
          ? "straight"
          : absoluteTurn >= backTurnLimitDeg - EPSILON
            ? "back"
            : turnDeg > 0 ? "left" : "right";
        const candidate = { roadId: endpoint.roadId, direction, turnDeg };
        const previous = exitsByRoad.get(endpoint.roadId);
        if (!previous || Math.abs(candidate.turnDeg) < Math.abs(previous.turnDeg) - EPSILON) {
          exitsByRoad.set(endpoint.roadId, candidate);
        }
      });
      return [...exitsByRoad.values()].sort((left, right) => right.turnDeg - left.turnDeg
        || compareText(left.roadId, right.roadId));
    }

    function roadState(poseValue, frontClearanceCm = null) {
      const pose = normalizePose(poseValue);
      let normalizedFrontClearance = null;
      if (frontClearanceCm !== null && frontClearanceCm !== undefined) {
        const numeric = Number(frontClearanceCm);
        if (numeric === Infinity) normalizedFrontClearance = null;
        else {
          if (!Number.isFinite(numeric) || numeric < 0) throw new RangeError("前方净空必须是非负厘米数或 null");
          normalizedFrontClearance = numeric > 500 ? null : round1(numeric);
        }
      }
      const vehicleForwardX = -Math.sin(pose.heading);
      const vehicleForwardZ = -Math.cos(pose.heading);
      const candidates = records.map(record => {
        const projection = projectRecord(record, pose.x, pose.z);
        let tangentX = projection.tangentX;
        let tangentZ = projection.tangentZ;
        if (!record.oneWay && tangentX * vehicleForwardX + tangentZ * vehicleForwardZ < 0) {
          tangentX = -tangentX;
          tangentZ = -tangentZ;
        }
        const roadHeading = Math.atan2(-tangentX, -tangentZ);
        const headingError = normalizeSignedAngle(roadHeading - pose.heading);
        const centerClearance = record.width / 2 - vehicleRadiusWorld;
        return {
          record,
          projection,
          tangentX,
          tangentZ,
          headingError,
          centerClearance,
          onRoad: projection.distance <= centerClearance + EPSILON
        };
      });
      const onRoadCandidates = candidates.filter(candidate => candidate.onRoad);
      const selected = [...(onRoadCandidates.length ? onRoadCandidates : candidates)]
        .sort((left, right) => onRoadCandidates.length
          ? Math.abs(left.headingError) - Math.abs(right.headingError)
            || left.projection.distance - right.projection.distance
            || compareText(left.record.roadId, right.record.roadId)
          : left.projection.distance - right.projection.distance
            || Math.abs(left.headingError) - Math.abs(right.headingError)
            || compareText(left.record.roadId, right.record.roadId))[0];
      const onRoad = onRoadCandidates.length > 0;
      const rightNormalX = -selected.tangentZ;
      const rightNormalZ = selected.tangentX;
      const lateralWorld = (pose.x - selected.projection.x) * rightNormalX
        + (pose.z - selected.projection.z) * rightNormalZ;
      const roadIds = onRoadCandidates
        .sort((left, right) => Math.abs(left.headingError) - Math.abs(right.headingError)
          || left.projection.distance - right.projection.distance
          || compareText(left.record.roadId, right.record.roadId))
        .map(candidate => candidate.record.roadId);
      let selectedNode = null;
      if (onRoad) {
        const nodeRadiusWorld = cmToWorld(nodeRadiusCm);
        const endpointNodes = [
          nodesById.get(selected.record.fromNodeId),
          nodesById.get(selected.record.toNodeId)
        ].filter(Boolean).map(nodeRecord => {
          const dx = nodeRecord.point[0] - pose.x;
          const dz = nodeRecord.point[1] - pose.z;
          return {
            nodeRecord,
            distance: Math.hypot(dx, dz),
            ahead: dx * vehicleForwardX + dz * vehicleForwardZ > EPSILON
          };
        }).filter(candidate => candidate.distance <= nodeRadiusWorld + EPSILON)
          .sort((left, right) => Number(right.ahead) - Number(left.ahead)
            || left.distance - right.distance
            || compareText(left.nodeRecord.nodeId, right.nodeRecord.nodeId));
        selectedNode = endpointNodes[0]?.nodeRecord || null;
      }
      const exits = selectedNode ? exitsAtNode(selectedNode, pose.heading) : [];
      return deepFreeze({
        onRoad,
        roadId: selected.record.roadId,
        roadIds,
        lateralOffsetCm: worldToCm(lateralWorld),
        headingErrorDeg: round1(selected.headingError * 180 / Math.PI),
        leftClearanceCm: worldToCm(selected.centerClearance + lateralWorld),
        rightClearanceCm: worldToCm(selected.centerClearance - lateralWorld),
        frontClearanceCm: normalizedFrontClearance,
        atJunction: Boolean(selectedNode && selectedNode.roadIds.length >= 3),
        junctionId: selectedNode && selectedNode.roadIds.length >= 3 ? selectedNode.nodeId : null,
        exits,
        roadProgressCm: worldToCm(selected.projection.progressWorld),
        fromNodeId: selected.record.fromNodeId,
        toNodeId: selected.record.toNodeId,
        atNode: Boolean(selectedNode),
        nodeId: selectedNode?.nodeId || null
      });
    }

    function mapGraph() {
      return cloneFrozen(graph);
    }

    function road(roadId) {
      const record = requireRoad(roadId);
      return deepFreeze({
        roadId: record.roadId,
        widthWorld: record.width,
        lengthWorld: record.length,
        lengthCm: worldToCm(record.length),
        oneWay: record.oneWay,
        fromNodeId: record.fromNodeId,
        toNodeId: record.toNodeId,
        points: record.points.map(point => [...point]),
        segmentLengths: [...record.segmentLengths],
        cumulativeLengths: [...record.cumulativeLengths]
      });
    }

    function node(nodeId) {
      const normalizedId = safeText(nodeId, "节点编号");
      const record = nodesById.get(normalizedId);
      if (!record) throw new RangeError(`节点不存在：${normalizedId}`);
      return deepFreeze({
        nodeId: record.nodeId,
        point: [...record.point],
        roadIds: [...record.roadIds],
        exits: record.endpoints.map(endpoint => ({ roadId: endpoint.roadId, side: endpoint.side }))
      });
    }

    return Object.freeze({
      schemaVersion: "chenlong.blockly-navigation-core/v1",
      worldUnitsPerMeter,
      centimetersPerWorldUnit,
      vehicleRadiusWorld,
      nodeRadiusCm,
      mapGraph,
      anchorAt,
      project,
      pointAt,
      pathAlong,
      roadState,
      road,
      node
    });
  }

  return Object.freeze({
    ROAD_GRAPH_SCHEMA_VERSION,
    DEFAULT_WORLD_UNITS_PER_METER,
    DEFAULT_VEHICLE_RADIUS_WORLD,
    createNetwork
  });
});
