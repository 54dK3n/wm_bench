"use strict";

(function initGuangyangScoring(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PrimaryGuangyangScoring = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const VEHICLE_RADIUS = 0.44;
  const SCORE_MAXIMUM = 100;
  const WEIGHTS = Object.freeze({ task: 40, rules: 25, autonomous: 15, efficiency: 20 });
  const PENALTIES = Object.freeze({ offRoadEpisode: 2.5, offRoadPerSecond: 0.42, collision: 1.7 });
  const EFFICIENCY = Object.freeze({ targetMs: 120000, maximumMs: 600000 });
  const ROADS = Object.freeze([["nw-bag",2.35,[[-11.0116,-8.3243],[-10.4865,-8.1081],[-10.0849,-7.7992],[-9.6525,-7.1815],[-9.4363,-6.5637],[-9.4054,-5.9459],[-9.529,-5.5135]]],["north-west-main",2.25,[[-9.529,-5.5135],[-8.139,-5.4517],[-5.3591,-5.4826],[-2.4865,-5.4826]]],["northwest-connector",2.35,[[-9.529,-5.5135],[-9.8996,-5.0193],[-10.3938,-4.4015],[-10.8571,-3.7838],[-11.1351,-3.166],[-11.3205,-2.2394],[-11.4749,-1.3127],[-11.5985,-0.7568]]],["parking-connector",2.05,[[-2.4865,-7.6757],[-2.4865,-6.4093],[-2.4865,-5.4826]]],["north-east-main",2.25,[[-2.4865,-5.4826],[0.5097,-5.4826],[2.2703,-5.4826],[4.5251,-5.4826],[6.0695,-5.4826]]],["central-north",2.25,[[-2.4865,-5.4826],[-2.4556,-3.2587],[-2.4865,-0.7568]]],["bailu-west-arc",2.35,[[6.0695,-5.4826],[6.1931,-5.0193],[6.471,-4.4015],[6.8726,-3.7838],[7.1815,-3.2587]]],["bailu-outer-arc",2.45,[[6.0695,-5.4826],[6.1004,-6.2548],[6.2857,-6.8726],[6.5637,-7.4903],[6.9653,-8.1081],[7.4286,-8.7259],[8.0772,-9.1892],[9.251,-9.4672],[10.9189,-9.4672],[11.7838,-9.251],[12.4942,-8.7259],[12.8031,-7.9537],[12.9575,-6.8726],[12.8958,-5.6371],[12.6486,-5.0193],[12.3707,-4.4015],[12.0309,-3.7838],[11.8456,-3.2587]]],["bailu-south",2.25,[[7.1815,-3.2587],[9.4672,-3.2587],[11.8456,-3.2587]]],["bailu-to-middle",2.3,[[7.1815,-3.2587],[7.0579,-2.6409],[6.749,-2.332],[6.4402,-2.0232],[6.1931,-1.7143],[6.0386,-1.4054],[5.9151,-0.7568]]],["east-north-outer",2.4,[[11.8456,-3.2587],[11.9691,-2.6409],[12.1236,-2.332],[12.4324,-1.7143],[12.5869,-1.4054],[12.8649,-0.7876],[13.0193,-0.4788],[13.3591,0.139],[13.7297,0.7568]]],["west-middle",2.25,[[-16.9421,-0.7568],[-14.6255,-0.7568],[-11.5985,-0.7568]]],["middle-west",2.25,[[-11.5985,-0.7568],[-6.9035,-0.7568],[-2.4865,-0.7568]]],["middle-east",2.25,[[-2.4865,-0.7568],[0.8185,-0.7568],[3.9073,-0.7568],[5.9151,-0.7568]]],["oil-west-arc",2.3,[[5.9151,-0.7568],[6.0077,-0.1699],[6.2239,0.139],[6.471,0.4479],[6.7181,0.7568],[6.9653,1.0656],[7.1815,1.3436]]],["oil-south",2.25,[[7.1815,1.3436],[8.5405,1.3127],[10.3938,1.251],[11.9382,1.1583],[13.1737,0.973],[13.7297,0.7568]]],["east-inner-south",2.35,[[7.1815,1.3436],[7.3977,2.0849],[7.4595,2.7027],[7.3668,3.3205],[7.1506,3.9382],[6.8726,4.556],[6.4093,5.1737],[5.7606,5.7915],[5.0811,6.4093],[4.4324,6.8726]]],["east-outer-south",2.45,[[13.7297,0.7568],[14.4402,1.1583],[14.8108,1.4672],[15.0579,1.7761],[15.2741,2.3938],[15.3359,3.0116],[15.2741,3.3205],[15.1197,3.6293],[14.9653,3.9382],[14.6873,4.2471],[14.3784,4.556],[14.0077,4.8649],[13.5444,5.1737],[13.0811,5.4826],[12.556,5.7915],[11.8764,6.1004],[10.7027,6.2857],[9.9305,6.4093],[9.5907,6.8726],[9.4363,7.4903],[9.2819,8.1081],[8.6641,8.5714],[8.4479,8.7259],[4.7722,8.7259]]],["west-south-connector",2.35,[[-11.5985,-0.7568],[-11.5985,0.5405],[-11.4749,1.4672],[-11.2278,1.7761],[-10.9498,2.0849],[-10.6409,2.3938],[-10.3012,2.7027],[-9.9614,3.0116],[-9.6525,3.3205],[-9.3127,3.6293],[-9.0039,3.9382],[-8.7876,4.2471],[-8.6332,4.5251]]],["huangge-spur",2.25,[[-8.6332,4.5251],[-8.5405,5.3282],[-8.5405,6.1004],[-8.5405,6.749]]],["lower-west",2.25,[[-8.6332,4.5251],[-6.9035,4.4633],[-4.7413,4.4324],[-2.4865,4.4324]]],["central-south",2.25,[[-2.4865,-0.7568],[-2.4556,1.7761],[-2.4865,4.4324]]],["southwest-spur",2.35,[[-2.4865,4.4324],[-2.5792,5.1737],[-2.7645,5.9459],[-2.9807,6.7181],[-3.3514,7.3359],[-3.7529,7.7992],[-4.3707,8.3243],[-5.112,8.8803],[-5.9151,9.251],[-6.9035,9.6216],[-7.8301,9.8687],[-8.3552,9.9614]]],["lower-east",2.35,[[-2.4865,4.4324],[0.8185,4.4324],[1.7452,4.6178],[2.2394,4.8649],[2.6718,5.2973],[3.1351,5.7297],[3.5985,6.1622],[4,6.4093],[4.4324,6.8726]]],["camp-connector",2.3,[[4.4324,6.8726],[4.5869,7.3359],[4.834,7.9537],[4.8649,8.3243],[4.7722,8.7259]]],["southeast-spur",2.35,[[4.7722,8.7259],[4.6795,9.1892],[4.4015,9.7761],[3.9073,10.3629],[3.444,10.8263]]]].map(([id, width, points]) => Object.freeze({
    id,
    width,
    points: Object.freeze(points.map(point => Object.freeze(point)))
  })));

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function round1(value) {
    return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
  }

  function distanceToSegment(x, z, start, end) {
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared <= Number.EPSILON) return Math.hypot(x - start[0], z - start[1]);
    const progress = clamp(((x - start[0]) * dx + (z - start[1]) * dz) / lengthSquared, 0, 1);
    return Math.hypot(x - (start[0] + dx * progress), z - (start[1] + dz * progress));
  }

  function roadMatch(x, z, vehicleRadius = VEHICLE_RADIUS) {
    if (![x, z, vehicleRadius].every(Number.isFinite) || vehicleRadius < 0) {
      return { onRoad: false, roadId: null, clearance: -Infinity };
    }
    let nearest = null;
    for (const road of ROADS) {
      for (let index = 1; index < road.points.length; index += 1) {
        const distance = distanceToSegment(x, z, road.points[index - 1], road.points[index]);
        const clearance = road.width / 2 - vehicleRadius - distance;
        if (!nearest || clearance > nearest.clearance) nearest = { onRoad: clearance >= -1e-6, roadId: road.id, clearance };
      }
    }
    return nearest || { onRoad: false, roadId: null, clearance: -Infinity };
  }

  function roadEdgeClearance(x, z, objectRadius = 0) {
    if (![x, z, objectRadius].every(Number.isFinite) || objectRadius < 0) return -Infinity;
    let nearestClearance = Infinity;
    for (const road of ROADS) {
      for (let index = 1; index < road.points.length; index += 1) {
        const distance = distanceToSegment(x, z, road.points[index - 1], road.points[index]);
        nearestClearance = Math.min(nearestClearance, distance - road.width / 2 - objectRadius);
      }
    }
    return nearestClearance;
  }

  function compositeTaskProgress({
    checkpointCount = 0,
    checkpointTotal = 0,
    targetDeliveredCount = 0,
    targetTotal = 0,
    distractorClearedCount = 0,
    distractorTotal = 0,
    failedObstacleCount = 0,
    obstacleTotal = 0,
    goalReached = false
  } = {}) {
    const safeCheckpointTotal = Math.max(0, Math.trunc(Number(checkpointTotal) || 0));
    const safeTargetTotal = Math.max(0, Math.trunc(Number(targetTotal) || 0));
    const safeDistractorTotal = Math.max(0, Math.trunc(Number(distractorTotal) || 0));
    const safeObstacleTotal = Math.max(0, Math.trunc(Number(obstacleTotal) || 0));
    const checkpoints = clamp(Math.trunc(Number(checkpointCount) || 0), 0, safeCheckpointTotal);
    const targets = clamp(Math.trunc(Number(targetDeliveredCount) || 0), 0, safeTargetTotal);
    const distractors = clamp(Math.trunc(Number(distractorClearedCount) || 0), 0, safeDistractorTotal);
    const failedObstacles = clamp(Math.trunc(Number(failedObstacleCount) || 0), 0, safeObstacleTotal);
    const goal = Boolean(goalReached) ? 1 : 0;
    const objectiveTotal = safeCheckpointTotal + safeTargetTotal + safeDistractorTotal + 1;
    const objectiveCompleted = checkpoints + targets + distractors + goal;
    const avoidanceCompleted = objectiveCompleted === objectiveTotal ? safeObstacleTotal - failedObstacles : 0;
    const total = objectiveTotal + safeObstacleTotal;
    const completed = objectiveCompleted + avoidanceCompleted;
    return Object.freeze({
      completed,
      total,
      finished: completed === total && failedObstacles === 0,
      checkpointCount: checkpoints,
      checkpointTotal: safeCheckpointTotal,
      targetDeliveredCount: targets,
      targetTotal: safeTargetTotal,
      distractorClearedCount: distractors,
      distractorTotal: safeDistractorTotal,
      failedObstacleCount: failedObstacles,
      obstacleTotal: safeObstacleTotal,
      avoidanceCompleted,
      goalReached: Boolean(goalReached)
    });
  }

  function scoreRun({
    completed = false,
    checkpointCount = 0,
    checkpointTotal = 0,
    taskCompleted = null,
    taskTotal = null,
    collisionCount = 0,
    offRoadEpisodes = 0,
    offRoadDurationMs = 0,
    durationMs = 0
  } = {}) {
    const hasCompositeProgress = Number.isFinite(Number(taskTotal)) && Number(taskTotal) > 0
      && Number.isFinite(Number(taskCompleted));
    const safeCheckpointTotal = Math.max(1, Math.trunc(Number(checkpointTotal) || 0));
    const safeCheckpointCount = clamp(Math.trunc(Number(checkpointCount) || 0), 0, safeCheckpointTotal);
    const taskUnits = hasCompositeProgress
      ? Math.max(1, Math.trunc(Number(taskTotal)))
      : safeCheckpointTotal + 1;
    const completedUnits = hasCompositeProgress
      ? clamp(Math.trunc(Number(taskCompleted)), 0, taskUnits)
      : safeCheckpointCount + (completed ? 1 : 0);
    const task = round1(WEIGHTS.task * completedUnits / taskUnits);

    const safeCollisions = clamp(Math.trunc(Number(collisionCount) || 0), 0, 99);
    const safeOffRoadEpisodes = clamp(Math.trunc(Number(offRoadEpisodes) || 0), 0, 99);
    const safeOffRoadDurationMs = clamp(Number(offRoadDurationMs) || 0, 0, EFFICIENCY.maximumMs);
    const eventDeduction = safeCollisions * PENALTIES.collision + safeOffRoadEpisodes * PENALTIES.offRoadEpisode;
    const durationDeduction = safeOffRoadDurationMs / 1000 * PENALTIES.offRoadPerSecond;
    const ruleDeduction = round1(eventDeduction + durationDeduction);
    const rule = round1(Math.max(0, WEIGHTS.rules - ruleDeduction));
    const autonomous = WEIGHTS.autonomous;

    const safeDurationMs = clamp(Number(durationMs) || 0, 0, EFFICIENCY.maximumMs);
    let efficiency = 0;
    if (completed) {
      const ratio = safeDurationMs <= EFFICIENCY.targetMs
        ? 1
        : clamp((EFFICIENCY.maximumMs - safeDurationMs) / (EFFICIENCY.maximumMs - EFFICIENCY.targetMs), 0, 1);
      efficiency = round1(WEIGHTS.efficiency * ratio);
    }

    return Object.freeze({
      task,
      rule,
      autonomous,
      efficiency,
      total: round1(clamp(task + rule + autonomous + efficiency, 0, SCORE_MAXIMUM)),
      ruleDeduction,
      taskCompleted: completedUnits,
      taskTotal: taskUnits,
      collisionCount: safeCollisions,
      offRoadEpisodes: safeOffRoadEpisodes,
      offRoadDurationMs: Math.round(safeOffRoadDurationMs)
    });
  }

  return Object.freeze({
    SCORE_MAXIMUM,
    VEHICLE_RADIUS,
    WEIGHTS,
    PENALTIES,
    EFFICIENCY,
    ROADS,
    roadMatch,
    roadEdgeClearance,
    compositeTaskProgress,
    scoreRun
  });
});
