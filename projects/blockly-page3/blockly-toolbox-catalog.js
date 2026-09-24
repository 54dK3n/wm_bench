(function (root, factory) {
  const catalog = factory();
  if (typeof module === "object" && module.exports) module.exports = catalog;
  if (root && typeof root === "object") root.BlocklyToolboxCatalog = catalog;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PROJECT = "project";
  const BUILTIN = "blockly@9.3.3";

  function input(kind, check, options) {
    return Object.assign({ kind, check: check || "Any", generatorFallback: null, limits: null }, options || {});
  }

  function field(check, defaultValue, options, limits) {
    return input("field", check, { default: defaultValue, options: options || null, limits: limits || null });
  }

  function value(check, generatorFallback, limits) {
    return input("value", check, { generatorFallback: generatorFallback ?? null, limits: limits || null });
  }

  function statement() {
    return input("statement", "Statement");
  }

  function block(provider, shape, inputs, generator, runtimeApis, limits) {
    return {
      provider,
      shape,
      inputs: inputs || {},
      generator,
      runtimeApis: runtimeApis || [],
      limits: limits || []
    };
  }

  const enumField = (defaultValue, options) => field("Enum", defaultValue, options);
  const projectStatement = (inputs, generator, runtimeApis, limits) => block(PROJECT, "statement", inputs, generator, runtimeApis, limits);
  const projectValue = (output, inputs, generator, runtimeApis, limits) => block(PROJECT, `value:${output}`, inputs, generator, runtimeApis, limits);
  const builtinStatement = (inputs, limits) => block(BUILTIN, "statement", inputs, "Blockly.JavaScript builtin/override", [], limits);
  const builtinValue = (output, inputs, limits) => block(BUILTIN, `value:${output}`, inputs, "Blockly.JavaScript builtin", [], limits);

  const blocks = {
    robot_move_cm: projectStatement({
      DIR: enumField("forward", ["forward", "backward"]),
      DISTANCE_CM: value("Number", 50, { min: 0.1, max: 500, unit: "cm", runtimeValidated: true })
    }, "Blockly.JavaScript.robot_move_cm", ["forward", "backward"]),
    robot_turn_left_90: projectStatement({}, "Blockly.JavaScript.robot_turn_left_90", ["turnAngle"], [{ parameter: "degrees", fixed: 90 }]),
    robot_turn_right_90: projectStatement({}, "Blockly.JavaScript.robot_turn_right_90", ["turnAngle"], [{ parameter: "degrees", fixed: 90 }]),
    robot_turn_left_angle: projectStatement({
      DEGREES: field("Number", 45, null, { min: 1, max: 360, integer: true, unit: "degree" })
    }, "Blockly.JavaScript.robot_turn_left_angle", ["turnAngle"]),
    robot_turn_right_angle: projectStatement({
      DEGREES: field("Number", 45, null, { min: 1, max: 360, integer: true, unit: "degree" })
    }, "Blockly.JavaScript.robot_turn_right_angle", ["turnAngle"]),
    robot_gripper: projectStatement({
      ACTION: enumField("grab", ["grab", "release"])
    }, "Blockly.JavaScript.robot_gripper", ["grab", "release"]),
    robot_sequence: projectStatement({ DO: statement() }, "Blockly.JavaScript.robot_sequence", ["emptyLoop"]),
    robot_if_obstacle: projectStatement({ DO: statement() }, "Blockly.JavaScript.robot_if_obstacle", ["checkFrontObstacle"]),
    robot_forever: projectStatement({ DO: statement() }, "Blockly.JavaScript.robot_forever", ["stopped", "loopTick", "loopYield", "emptyLoop"], [
      { behavior: "runs until Stop is pressed or the run is cancelled" }
    ]),
    robot_front_blocked: projectValue("Boolean", {}, "Blockly.JavaScript.robot_front_blocked", ["checkFrontObstacle"]),
    robot_sensor_distance: projectValue("Number", {}, "Blockly.JavaScript.robot_sensor_distance", ["distance"], [{ unit: "cm" }]),
    robot_on_road: projectValue("Boolean", {}, "Blockly.JavaScript.robot_on_road", ["onRoad"]),
    robot_holding_package: projectValue("Boolean", {}, "Blockly.JavaScript.robot_holding_package", ["holding"]),
    robot_checkpoint_count: projectValue("Number", {}, "Blockly.JavaScript.robot_checkpoint_count", ["checkpointCount"], [{ min: 0, integer: true }]),
    robot_task_complete: projectValue("Boolean", {}, "Blockly.JavaScript.robot_task_complete", ["taskComplete"]),
    robot_mission: projectValue("Object", {}, "Blockly.JavaScript.robot_mission", ["mission"], [{ queryLimitPerRun: 1000, coordinatesExposed: false }]),
    robot_task_state: projectValue("Object", {}, "Blockly.JavaScript.robot_task_state", ["task_state"], [{ queryLimitPerRun: 1000 }]),
    robot_release_preview: projectValue("Object", {}, "Blockly.JavaScript.robot_release_preview", ["release_preview"], [{ queryLimitPerRun: 1000, mutatesMission: false }]),
    robot_odometry: projectValue("Object", {}, "Blockly.JavaScript.robot_odometry", ["odometry"], [{ queryLimitPerRun: 1000, distanceUnit: "cm" }]),
    robot_road_state: projectValue("Object", {}, "Blockly.JavaScript.robot_road_state", ["road_state"], [{ queryLimitPerRun: 1000, coordinatesExposed: false }]),
    robot_map_graph: projectValue("Object", {}, "Blockly.JavaScript.robot_map_graph", ["map_graph"], [{ queryLimitPerRun: 1000, coordinatesExposed: false }]),
    robot_odometry_value: projectValue("Number", {
      FIELD: enumField("forwardCm", ["forwardCm", "rightCm", "headingDeg", "distanceCm"])
    }, "Blockly.JavaScript.robot_odometry_value", ["sensorField", "odometry"], [{ queryLimitPerRun: 1000 }]),
    robot_road_boolean: projectValue("Boolean", {
      FIELD: enumField("onRoad", ["onRoad", "atNode", "atJunction"])
    }, "Blockly.JavaScript.robot_road_boolean", ["sensorField", "road_state"], [{ queryLimitPerRun: 1000 }]),
    robot_road_number: projectValue("Number", {
      FIELD: enumField("roadProgressCm", ["roadProgressCm", "lateralOffsetCm", "headingErrorDeg", "leftClearanceCm", "rightClearanceCm", "frontClearanceCm"])
    }, "Blockly.JavaScript.robot_road_number", ["sensorField", "road_state"], [{ queryLimitPerRun: 1000 }]),
    robot_road_text: projectValue("String", {
      FIELD: enumField("roadId", ["roadId", "fromNodeId", "toNodeId", "nodeId", "junctionId"])
    }, "Blockly.JavaScript.robot_road_text", ["sensorField", "road_state"], [{ queryLimitPerRun: 1000 }]),
    robot_follow_road: projectStatement({
      MAX_CM: value("Number", 100, { min: 10, max: 500, unit: "cm", runtimeValidated: true }),
      SPEED: value("Number", 40, { min: 10, max: 100, runtimeValidated: true }),
      OBEY: value("Boolean", false, { runtimeValidated: true })
    }, "Blockly.JavaScript.robot_follow_road", ["follow_road"], [{ roadControlLimitPerRun: 300 }]),
    robot_take_exit: projectStatement({
      ROAD_ID: value("String", "", { minLength: 1, maxLength: 128, printable: true, runtimeValidated: true }),
      SPEED: value("Number", 30, { min: 10, max: 100, runtimeValidated: true }),
      OBEY: value("Boolean", false, { runtimeValidated: true })
    }, "Blockly.JavaScript.robot_take_exit", ["take_exit"], [{ roadControlLimitPerRun: 300, requiresCurrentNode: true }]),
    robot_last_road_result: projectValue("Object", {}, "Blockly.JavaScript.robot_last_road_result", ["lastRoadResult"]),
    robot_last_road_result_value: projectValue("Any", {
      FIELD: enumField("accepted", ["accepted", "stoppedBy", "roadId", "distanceCm", "elapsedTicks"])
    }, "Blockly.JavaScript.robot_last_road_result_value", ["lastRoadResult", "dataGet"]),
    robot_vision_sees: projectValue("Boolean", {
      TARGET: enumField("目标物", ["目标物", "混淆物", "障碍物", "存放点"]),
      CONFIDENCE: value("Number", 0.6, { min: 0, max: 1, runtimeValidated: true })
    }, "Blockly.JavaScript.robot_vision_sees", ["sees"], [{ queryLimitPerRun: 1000 }]),
    robot_vision_count: projectValue("Number", {
      TARGET: enumField("目标物", ["目标物", "混淆物", "障碍物", "存放点"]),
      CONFIDENCE: value("Number", 0.6, { min: 0, max: 1, runtimeValidated: true })
    }, "Blockly.JavaScript.robot_vision_count", ["count"], [{ queryLimitPerRun: 1000 }]),
    robot_vision_direction: projectValue("String", {
      TARGET: enumField("目标物", ["目标物", "混淆物", "障碍物", "存放点"]),
      CONFIDENCE: value("Number", 0.6, { min: 0, max: 1, runtimeValidated: true })
    }, "Blockly.JavaScript.robot_vision_direction", ["direction"], [{ queryLimitPerRun: 1000 }]),
    robot_vision_distance: projectValue("Number", {
      TARGET: enumField("目标物", ["目标物", "混淆物", "障碍物", "存放点"]),
      CONFIDENCE: value("Number", 0.6, { min: 0, max: 1, runtimeValidated: true })
    }, "Blockly.JavaScript.robot_vision_distance", ["distance_to"], [{ queryLimitPerRun: 1000, unit: "cm", nullable: true }]),
    robot_vision_near: projectValue("Boolean", {
      TARGET: enumField("目标物", ["目标物", "混淆物", "障碍物", "存放点"]),
      CONFIDENCE: value("Number", 0.6, { min: 0, max: 1, runtimeValidated: true })
    }, "Blockly.JavaScript.robot_vision_near", ["near"], [{ queryLimitPerRun: 1000 }]),
    robot_vision_centered: projectValue("Boolean", {
      TARGET: enumField("目标物", ["目标物", "混淆物", "障碍物", "存放点"]),
      CONFIDENCE: value("Number", 0.6, { min: 0, max: 1, runtimeValidated: true })
    }, "Blockly.JavaScript.robot_vision_centered", ["centered"], [{ queryLimitPerRun: 1000 }]),
    robot_vision_observe: projectValue("Array", {
      TARGET: enumField("全部", ["全部", "目标物", "混淆物", "障碍物", "存放点"]),
      CONFIDENCE: value("Number", 0.6, { min: 0, max: 1, runtimeValidated: true })
    }, "Blockly.JavaScript.robot_vision_observe", ["observe"], [{ queryLimitPerRun: 1000 }]),
    robot_vision_detect: projectValue("Array", {
      TARGET: enumField("全部", ["全部", "目标物", "混淆物", "障碍物", "存放点"]),
      CONFIDENCE: value("Number", 0.6, { min: 0, max: 1, runtimeValidated: true })
    }, "Blockly.JavaScript.robot_vision_detect", ["detect"], [{ queryLimitPerRun: 1000 }]),
    robot_vision_approach: projectStatement({
      TARGET: enumField("目标物", ["目标物", "混淆物", "障碍物", "存放点"]),
      DISTANCE_CM: value("Number", 20, { min: 5, max: 200, unit: "cm", runtimeValidated: true }),
      MAX_STEPS: value("Number", 60, { min: 1, max: 100, integer: true, runtimeValidated: true })
    }, "Blockly.JavaScript.robot_vision_approach", ["approach"], [{ queryLimitPerRun: 1000 }]),
    robot_data_get: projectValue("Any", {
      OBJECT: value("Any", null),
      KEY: value("String", "", { minLength: 1, maxLength: 80, blocked: ["__proto__", "prototype", "constructor", "x", "z", "points", "point"], runtimeValidated: true })
    }, "Blockly.JavaScript.robot_data_get", ["dataGet"]),
    robot_list_item: projectValue("Any", {
      LIST: value("Any", [], { mustBeArray: true, runtimeValidated: true }),
      INDEX: value("Number", 1, { min: 1, integer: true, oneBased: true, runtimeValidated: true })
    }, "Blockly.JavaScript.robot_list_item", ["listItem"]),
    robot_data_length: projectValue("Number", {
      VALUE: value("Any", null)
    }, "Blockly.JavaScript.robot_data_length", ["dataLength"], [{ unsupportedValueReturns: 0 }]),
    robot_json_text: projectValue("String", {
      VALUE: value("Any", null)
    }, "Blockly.JavaScript.robot_json_text", ["jsonText"]),
    robot_wait: projectStatement({
      SECONDS: value("Number", 0.5, { min: 0, max: 60, unit: "second", runtimeValidated: true })
    }, "Blockly.JavaScript.robot_wait", ["wait"]),

    controls_if: builtinStatement({
      IF0: value("Boolean", false), DO0: statement(), ELSE: statement()
    }, [{ mutatorAddsElseIfAndElse: true }]),
    controls_repeat_ext: builtinStatement({
      TIMES: value("Number", 0, { min: 0, max: 100, integerAfterFloor: true, runtimeValidated: true }), DO: statement()
    }, [{ projectOverride: "safe loop generator", iterationLimit: 100 }]),
    controls_whileUntil: builtinStatement({
      MODE: enumField("WHILE", ["WHILE", "UNTIL"]), BOOL: value("Boolean", false), DO: statement()
    }, [{ projectOverride: "safe loop generator", iterationLimit: 100 }]),
    controls_for: builtinStatement({
      VAR: field("Variable", "i"), FROM: value("Number", 0), TO: value("Number", 0), BY: value("Number", 1, { nonZero: true }), DO: statement()
    }, [{ projectOverride: "safe loop generator", finiteNumbersRequired: true, iterationLimit: 100 }]),
    controls_forEach: builtinStatement({
      VAR: field("Variable", "项目"), LIST: value("Array", []), DO: statement()
    }, [{ projectOverride: "safe loop generator", arrayRequired: true, iterationLimit: 100 }]),
    controls_flow_statements: builtinStatement({
      FLOW: enumField("BREAK", ["BREAK", "CONTINUE"])
    }, [{ requiresEnclosingLoop: true }]),
    logic_compare: builtinValue("Boolean", { A: value("Any", null), OP: enumField("EQ", ["EQ", "NEQ", "LT", "LTE", "GT", "GTE"]), B: value("Any", null) }),
    logic_boolean: builtinValue("Boolean", { BOOL: enumField("TRUE", ["TRUE", "FALSE"]) }),
    logic_operation: builtinValue("Boolean", { A: value("Boolean", false), OP: enumField("AND", ["AND", "OR"]), B: value("Boolean", false) }),
    logic_negate: builtinValue("Boolean", { BOOL: value("Boolean", false) }),
    logic_ternary: builtinValue("Any", { IF: value("Boolean", false), THEN: value("Any", null), ELSE: value("Any", null) }),
    math_number: builtinValue("Number", { NUM: field("Number", 0) }),
    math_arithmetic: builtinValue("Number", { A: value("Number", 0), OP: enumField("ADD", ["ADD", "MINUS", "MULTIPLY", "DIVIDE", "POWER"]), B: value("Number", 0) }),
    math_number_property: builtinValue("Boolean", { NUMBER_TO_CHECK: value("Number", 0), PROPERTY: field("Enum", "EVEN") }),
    math_single: builtinValue("Number", { NUM: value("Number", 0), OP: field("Enum", "ROOT") }),
    math_round: builtinValue("Number", { NUM: value("Number", 0), OP: enumField("ROUND", ["ROUND", "ROUNDUP", "ROUNDDOWN"]) }),
    math_modulo: builtinValue("Number", { DIVIDEND: value("Number", 0), DIVISOR: value("Number", 0) }),
    math_constrain: builtinValue("Number", { VALUE: value("Number", 0), LOW: value("Number", 0), HIGH: value("Number", Infinity) }),
    lists_create_with: builtinValue("Array", { ADD: input("dynamic-value", "Any") }, [{ mutatorControlsItemCount: true }]),
    lists_length: builtinValue("Number", { VALUE: value("ArrayOrString", []) }),
    lists_isEmpty: builtinValue("Boolean", { VALUE: value("ArrayOrString", []) }),
    lists_getIndex: builtinValue("Any", { VALUE: value("ArrayOrString", []), MODE: field("Enum", "GET"), WHERE: field("Enum", "FROM_START"), AT: value("Number", 1) }, [{ indexSemanticsControlledByDropdown: true }]),
    lists_setIndex: builtinStatement({ LIST: value("Array", []), MODE: field("Enum", "SET"), WHERE: field("Enum", "FROM_START"), AT: value("Number", 1), TO: value("Any", null) }, [{ mutatesConnectedList: true }]),
    text: builtinValue("String", { TEXT: field("String", "") }),
    text_join: builtinValue("String", { ADD: input("dynamic-value", "Any") }, [{ mutatorControlsItemCount: true }]),
    text_length: builtinValue("Number", { VALUE: value("StringOrArray", "") }),
    text_isEmpty: builtinValue("Boolean", { VALUE: value("StringOrArray", "") }),
    text_indexOf: builtinValue("Number", { VALUE: value("String", ""), END: field("Enum", "FIRST"), FIND: value("String", "") }, [{ BlocklyIndexing: "workspace oneBasedIndex setting" }]),
    text_charAt: builtinValue("String", { VALUE: value("String", ""), WHERE: field("Enum", "FROM_START"), AT: value("Number", 1) }, [{ BlocklyIndexing: "workspace oneBasedIndex setting" }]),
    text_print: builtinStatement({ TEXT: value("Any", "") }, [{ projectGeneratorOverride: true, runtimeApi: "print" }])
  };

  const dynamicBlocks = {
    variables_get: builtinValue("Any", { VAR: field("Variable", null) }),
    variables_set: builtinStatement({ VAR: field("Variable", null), VALUE: value("Any", null) }),
    math_change: builtinStatement({ VAR: field("Variable", null), DELTA: value("Number", 0) }),
    procedures_defnoreturn: block(BUILTIN, "definition", { NAME: field("Procedure", null), STACK: statement() }, "project async override", ["procedureEnter", "procedureExit"], [{ supportsParameters: true, callLimitPerRun: 1000, recursionDepthLimit: 50 }]),
    procedures_defreturn: block(BUILTIN, "definition", { NAME: field("Procedure", null), STACK: statement(), RETURN: value("Any", null) }, "project async override", ["procedureEnter", "procedureExit"], [{ supportsParameters: true, supportsReturn: true, callLimitPerRun: 1000, recursionDepthLimit: 50 }]),
    procedures_ifreturn: builtinStatement({ CONDITION: value("Boolean", false), VALUE: value("Any", null) }, [{ requiresEnclosingProcedure: true, projectAsyncCompatible: true }]),
    procedures_callnoreturn: builtinStatement({ ARG: input("dynamic-value", "Any") }, [{ projectAsyncOverride: true }]),
    procedures_callreturn: builtinValue("Any", { ARG: input("dynamic-value", "Any") }, [{ projectAsyncOverride: true }])
  };

  function item(type, fields, values, mutation) {
    return { type, fields: fields || {}, values: values || {}, mutation: mutation || {} };
  }

  function shadow(type, fields) {
    return { kind: "shadow", type, fields: fields || {} };
  }

  function nested(type, fields) {
    return { kind: "block", type, fields: fields || {} };
  }

  const categories = [
    { name: "小车移动", items: [
      item("robot_move_cm", { DIR: "forward" }, { DISTANCE_CM: shadow("math_number", { NUM: "50" }) }),
      item("robot_move_cm", { DIR: "backward" }, { DISTANCE_CM: shadow("math_number", { NUM: "20" }) }),
      item("robot_turn_left_90"), item("robot_turn_right_90"),
      item("robot_turn_left_angle", { DEGREES: "45" }), item("robot_turn_right_angle", { DEGREES: "45" })
    ] },
    { name: "物品操作", items: [item("robot_gripper", { ACTION: "grab" }), item("robot_gripper", { ACTION: "release" })] },
    { name: "顺序与选择", items: [item("robot_sequence"), item("controls_if"), item("controls_if", {}, {}, { else: "1" }), item("robot_if_obstacle")] },
    { name: "循环", items: [
      item("controls_repeat_ext", {}, { TIMES: shadow("math_number", { NUM: "4" }) }),
      item("controls_whileUntil", { MODE: "WHILE" }, { BOOL: shadow("logic_boolean", { BOOL: "TRUE" }) }),
      item("controls_whileUntil", { MODE: "UNTIL" }, { BOOL: shadow("logic_boolean", { BOOL: "FALSE" }) }),
      item("controls_for", { VAR: "i" }, {
        FROM: shadow("math_number", { NUM: "1" }), TO: shadow("math_number", { NUM: "10" }), BY: shadow("math_number", { NUM: "1" })
      }),
      item("controls_forEach", { VAR: "项目" }), item("robot_forever"),
      item("controls_flow_statements", { FLOW: "BREAK" }), item("controls_flow_statements", { FLOW: "CONTINUE" })
    ] },
    { name: "基础传感", items: [
      item("robot_front_blocked"), item("robot_sensor_distance"), item("robot_on_road"), item("robot_holding_package"),
      item("robot_checkpoint_count"), item("robot_task_complete"),
      item("logic_compare", { OP: "LT" }, { A: nested("robot_sensor_distance"), B: shadow("math_number", { NUM: "30" }) })
    ] },
    { name: "导航传感", items: [
      item("robot_mission"), item("robot_task_state"), item("robot_release_preview"), item("robot_odometry"),
      item("robot_odometry_value", { FIELD: "distanceCm" }), item("robot_road_state"),
      item("robot_road_boolean", { FIELD: "onRoad" }), item("robot_road_number", { FIELD: "roadProgressCm" }),
      item("robot_road_text", { FIELD: "roadId" }), item("robot_map_graph")
    ] },
    { name: "道路控制", items: [
      item("robot_follow_road", {}, {
        MAX_CM: shadow("math_number", { NUM: "100" }), SPEED: shadow("math_number", { NUM: "40" }), OBEY: shadow("logic_boolean", { BOOL: "FALSE" })
      }),
      item("robot_take_exit", {}, {
        ROAD_ID: shadow("text", { TEXT: "道路编号" }), SPEED: shadow("math_number", { NUM: "30" }), OBEY: shadow("logic_boolean", { BOOL: "FALSE" })
      }),
      item("robot_last_road_result"), item("robot_last_road_result_value", { FIELD: "stoppedBy" })
    ] },
    { name: "摄像头感知", items: [
      ...["robot_vision_sees", "robot_vision_count", "robot_vision_direction", "robot_vision_distance", "robot_vision_near", "robot_vision_centered"].map(type =>
        item(type, { TARGET: "目标物" }, { CONFIDENCE: shadow("math_number", { NUM: "0.6" }) })
      ),
      item("robot_vision_observe", { TARGET: "全部" }, { CONFIDENCE: shadow("math_number", { NUM: "0.6" }) }),
      item("robot_vision_detect", { TARGET: "全部" }, { CONFIDENCE: shadow("math_number", { NUM: "0.6" }) }),
      item("robot_vision_approach", { TARGET: "目标物" }, {
        DISTANCE_CM: shadow("math_number", { NUM: "20" }), MAX_STEPS: shadow("math_number", { NUM: "60" })
      })
    ] },
    { name: "数据与列表", items: [
      item("robot_data_get", {}, { KEY: shadow("text", { TEXT: "roadId" }) }),
      item("robot_list_item", {}, { INDEX: shadow("math_number", { NUM: "1" }) }),
      item("robot_data_length"), item("robot_json_text"),
      item("lists_create_with", {}, {}, { items: "0" }), item("lists_create_with"),
      item("lists_length"), item("lists_isEmpty"), item("lists_getIndex"), item("lists_setIndex")
    ] },
    { name: "等待与输出", items: [
      item("robot_wait", {}, { SECONDS: shadow("math_number", { NUM: "1" }) }),
      item("text_print", {}, { TEXT: shadow("text", { TEXT: "你好，小车！" }) })
    ] },
    { name: "数学与逻辑", items: [
      item("math_number"), item("math_arithmetic"), item("math_number_property"), item("logic_boolean"),
      item("logic_compare"), item("logic_operation"), item("logic_negate"), item("logic_ternary"),
      item("math_single"), item("math_round"), item("math_modulo"), item("math_constrain")
    ] },
    { name: "文本", items: [item("text"), item("text_join"), item("text_length"), item("text_isEmpty"), item("text_indexOf"), item("text_charAt")] },
    { name: "变量", custom: "VARIABLE", dynamicTypes: ["variables_get", "variables_set", "math_change"], items: [] },
    { name: "函数", custom: "PROCEDURE", dynamicTypes: ["procedures_defnoreturn", "procedures_defreturn", "procedures_ifreturn", "procedures_callnoreturn", "procedures_callreturn"], items: [] }
  ];

  const compatibilityOnlyTypes = ["robot_move", "robot_turn", "robot_turn_left", "robot_turn_right"];
  const staticTypes = [...new Set(categories.flatMap(category => category.items.map(entry => entry.type)))];
  const dynamicTypes = [...new Set(categories.flatMap(category => category.dynamicTypes || []))];
  const summary = {
    categoryCount: categories.length,
    staticCategoryCount: categories.filter(category => !category.custom).length,
    dynamicCategoryCount: categories.filter(category => category.custom).length,
    staticItemCount: categories.reduce((total, category) => total + category.items.length, 0),
    staticTypeCount: staticTypes.length,
    projectStaticTypeCount: staticTypes.filter(type => blocks[type]?.provider === PROJECT).length,
    builtinStaticTypeCount: staticTypes.filter(type => blocks[type]?.provider === BUILTIN).length,
    dynamicTypeCount: dynamicTypes.length,
    auditedTypeCount: staticTypes.length + dynamicTypes.length
  };

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.getOwnPropertyNames(value).forEach(key => deepFreeze(value[key]));
    return Object.freeze(value);
  }

  return deepFreeze({
    schemaVersion: "chenlong.blockly-toolbox-catalog/v1",
    blocklyVersion: "9.3.3",
    categories,
    blocks,
    dynamicBlocks,
    compatibilityOnlyTypes,
    summary
  });
});
