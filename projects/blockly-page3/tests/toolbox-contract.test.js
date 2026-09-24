const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const catalog = require(path.join(root, "blockly-toolbox-catalog.js"));

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) attributes[match[1]] = decodeXmlText(match[2] ?? match[3]);
  return attributes;
}

function parseXmlFragment(source) {
  const rootNode = { tag: "root", attributes: {}, children: [], text: "" };
  const stack = [rootNode];
  const tokenPattern = /<!--[\s\S]*?-->|<\/?[\w:-]+(?:\s[^<>]*?)?\s*\/?>|[^<]+/g;
  for (const tokenMatch of source.matchAll(tokenPattern)) {
    const token = tokenMatch[0];
    if (token.startsWith("<!--")) continue;
    if (!token.startsWith("<")) {
      stack[stack.length - 1].text += decodeXmlText(token);
      continue;
    }
    if (token.startsWith("</")) {
      const tag = token.slice(2, -1).trim();
      assert.equal(stack[stack.length - 1].tag, tag, `XML close tag mismatch for ${tag}`);
      stack.pop();
      continue;
    }
    const selfClosing = /\/\s*>$/.test(token);
    const body = token.slice(1, selfClosing ? token.lastIndexOf("/") : -1).trim();
    const splitAt = body.search(/\s/);
    const tag = splitAt < 0 ? body : body.slice(0, splitAt);
    const attributeSource = splitAt < 0 ? "" : body.slice(splitAt + 1);
    const node = { tag, attributes: parseAttributes(attributeSource), children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  assert.equal(stack.length, 1, "toolbox XML must be balanced");
  return rootNode.children[0];
}

function directChildren(node, tag) {
  return node.children.filter(child => child.tag === tag);
}

function directFields(node) {
  return Object.fromEntries(directChildren(node, "field").map(fieldNode => [
    fieldNode.attributes.name,
    fieldNode.text.trim()
  ]));
}

function parsedToolboxContract() {
  const source = html.match(/<xml id="toolbox"[\s\S]*?<\/xml>/)?.[0];
  assert.ok(source, "index.html must contain #toolbox XML");
  const toolbox = parseXmlFragment(source);
  return directChildren(toolbox, "category").map(category => ({
    name: category.attributes.name,
    ...(category.attributes.custom ? { custom: category.attributes.custom } : {}),
    ...(category.attributes.custom ? {
      dynamicTypes: catalog.categories.find(item => item.name === category.attributes.name)?.dynamicTypes || []
    } : {}),
    items: directChildren(category, "block").map(blockNode => {
      const values = {};
      for (const valueNode of directChildren(blockNode, "value")) {
        const connected = valueNode.children.find(child => child.tag === "shadow" || child.tag === "block");
        if (!connected) continue;
        values[valueNode.attributes.name] = {
          kind: connected.tag,
          type: connected.attributes.type,
          fields: directFields(connected)
        };
      }
      const mutation = directChildren(blockNode, "mutation")[0]?.attributes || {};
      return {
        type: blockNode.attributes.type,
        fields: directFields(blockNode),
        values,
        mutation
      };
    })
  }));
}

function extractFunctionSource(source, functionName) {
  const startPattern = new RegExp(`function\\s+${functionName}\\s*\\(`, "g");
  const match = startPattern.exec(source);
  assert.ok(match, `missing function ${functionName}`);
  const open = source.indexOf("{", match.index);
  assert.ok(open >= 0, `missing body for ${functionName}`);
  let depth = 0;
  let mode = "code";
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (mode === "line-comment") {
      if (char === "\n") mode = "code";
      continue;
    }
    if (mode === "block-comment") {
      if (char === "*" && next === "/") { mode = "code"; index += 1; }
      continue;
    }
    if (mode !== "code") {
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if ((mode === "single" && char === "'") || (mode === "double" && char === '"') || (mode === "template" && char === "`")) mode = "code";
      continue;
    }
    if (char === "/" && next === "/") { mode = "line-comment"; index += 1; continue; }
    if (char === "/" && next === "*") { mode = "block-comment"; index += 1; continue; }
    if (char === "'") { mode = "single"; continue; }
    if (char === '"') { mode = "double"; continue; }
    if (char === "`") { mode = "template"; continue; }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`unterminated function ${functionName}`);
}

class FakeFieldDropdown {
  constructor(options) {
    this.kind = "dropdown";
    this.options = options;
    this.defaultValue = options[0][1];
  }
}

class FakeFieldNumber {
  constructor(defaultValue, min, max, precision) {
    this.kind = "number";
    this.defaultValue = defaultValue;
    this.min = min;
    this.max = max;
    this.precision = precision;
  }
}

class FakeInput {
  constructor(owner, kind, name) {
    this.owner = owner;
    this.kind = kind;
    this.name = name || null;
    this.check = null;
  }

  setCheck(check) {
    this.check = check;
    return this;
  }

  appendField(field, name) {
    if (name) this.owner.fields[name] = field;
    return this;
  }
}

class FakeBlock {
  constructor() {
    this.valueInputs = {};
    this.statementInputs = {};
    this.fields = {};
    this.previous = false;
    this.next = false;
    this.output = null;
  }

  appendDummyInput(name) { return new FakeInput(this, "dummy", name); }
  appendValueInput(name) {
    const input = new FakeInput(this, "value", name);
    this.valueInputs[name] = input;
    return input;
  }
  appendStatementInput(name) {
    const input = new FakeInput(this, "statement", name);
    this.statementInputs[name] = input;
    return input;
  }
  setPreviousStatement(enabled) { this.previous = Boolean(enabled); return this; }
  setNextStatement(enabled) { this.next = Boolean(enabled); return this; }
  setOutput(enabled, check) { this.output = enabled ? (check || "Any") : null; return this; }
  setInputsInline() { return this; }
  setColour() { return this; }
  setTooltip() { return this; }
}

function registeredProjectBlocks() {
  const JavaScript = {
    addReservedWords() {},
    valueToCode() { return "VALUE"; },
    statementToCode() { return "  await child();\n"; },
    ORDER_ASSIGNMENT: 0,
    ORDER_FUNCTION_CALL: 1,
    ORDER_NONE: 99,
    definitions_: {},
    STATEMENT_PREFIX: "",
    nameDB_: { getName(value) { return String(value || "name").replace(/\W/g, "_"); } }
  };
  const Blockly = {
    Blocks: {},
    JavaScript,
    FieldDropdown: FakeFieldDropdown,
    FieldNumber: FakeFieldNumber,
    PROCEDURE_CATEGORY_NAME: "PROCEDURE",
    VARIABLE_CATEGORY_NAME: "VARIABLE"
  };
  const script = [
    "const MAX_PROGRAM_LOOP_ITERATIONS = 100;",
    extractFunctionSource(app, "defineAsyncProcedureGenerators"),
    extractFunctionSource(app, "defineSafeLoopGenerators"),
    extractFunctionSource(app, "defineBlocks"),
    "defineBlocks();"
  ].join("\n");
  vm.runInNewContext(script, { Blockly });
  return Blockly;
}

function actualProjectShape(definition) {
  const instance = new FakeBlock();
  definition.init.call(instance);
  return instance;
}

function expectedShapeName(instance) {
  if (instance.output) return `value:${instance.output}`;
  if (instance.previous || instance.next) return "statement";
  return "definition";
}

function runtimeApiIsDeclared(apiName) {
  const escaped = apiName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:`).test(app)
    || new RegExp(`api\\.${escaped}\\s*=`).test(app);
}

test("machine catalog exactly matches every static toolbox item and dynamic category", () => {
  assert.equal(catalog.schemaVersion, "chenlong.blockly-toolbox-catalog/v1");
  assert.deepEqual(parsedToolboxContract(), catalog.categories);
  assert.deepEqual(catalog.summary, {
    categoryCount: 14,
    staticCategoryCount: 12,
    dynamicCategoryCount: 2,
    staticItemCount: 80,
    staticTypeCount: 73,
    projectStaticTypeCount: 43,
    builtinStaticTypeCount: 30,
    dynamicTypeCount: 8,
    auditedTypeCount: 81
  });
  assert.ok(Object.isFrozen(catalog));
  assert.ok(Object.isFrozen(catalog.categories));
});

test("every unique static and dynamic type has a complete metadata record and no stale record", () => {
  const staticTypes = [...new Set(catalog.categories.flatMap(category => category.items.map(item => item.type)))].sort();
  const dynamicTypes = [...new Set(catalog.categories.flatMap(category => category.dynamicTypes || []))].sort();
  assert.deepEqual(Object.keys(catalog.blocks).sort(), staticTypes);
  assert.deepEqual(Object.keys(catalog.dynamicBlocks).sort(), dynamicTypes);
  for (const [type, record] of Object.entries({ ...catalog.blocks, ...catalog.dynamicBlocks })) {
    assert.ok(["project", "blockly@9.3.3"].includes(record.provider), `${type} provider`);
    assert.match(record.shape, /^(statement|definition|value:(Any|Array|Boolean|Number|Object|String))$/, `${type} shape`);
    assert.equal(typeof record.inputs, "object", `${type} inputs`);
    assert.equal(typeof record.generator, "string", `${type} generator`);
    assert.ok(Array.isArray(record.runtimeApis), `${type} runtimeApis`);
    assert.ok(Array.isArray(record.limits), `${type} limits`);
  }
});

test("all 43 project toolbox types register both a block definition and JavaScript generator", () => {
  const Blockly = registeredProjectBlocks();
  const projectTypes = Object.entries(catalog.blocks)
    .filter(([, record]) => record.provider === "project")
    .map(([type]) => type);
  assert.equal(projectTypes.length, 43);
  for (const type of projectTypes) {
    assert.equal(typeof Blockly.Blocks[type]?.init, "function", `${type} block definition`);
    assert.equal(typeof Blockly.JavaScript[type], "function", `${type} JavaScript generator`);
    const generated = Blockly.JavaScript[type]({
      id: "audit-block",
      getFieldValue(name) {
        return catalog.blocks[type].inputs[name]?.default ?? "value";
      }
    });
    if (catalog.blocks[type].shape.startsWith("value:")) {
      assert.ok(Array.isArray(generated) && typeof generated[0] === "string", `${type} must generate a value expression`);
    } else {
      assert.equal(typeof generated, "string", `${type} must generate statements`);
    }
  }
});

test("project block shapes, named inputs, dropdown defaults and numeric field bounds match the catalog", () => {
  const Blockly = registeredProjectBlocks();
  for (const [type, record] of Object.entries(catalog.blocks).filter(([, item]) => item.provider === "project")) {
    const actual = actualProjectShape(Blockly.Blocks[type]);
    assert.equal(expectedShapeName(actual), record.shape, `${type} connection shape`);
    const actualInputNames = [...Object.keys(actual.valueInputs), ...Object.keys(actual.statementInputs), ...Object.keys(actual.fields)].sort();
    assert.deepEqual(actualInputNames, Object.keys(record.inputs).sort(), `${type} named inputs`);
    for (const [name, expected] of Object.entries(record.inputs)) {
      if (expected.kind === "value") {
        assert.ok(actual.valueInputs[name], `${type}.${name} value input`);
        assert.equal(actual.valueInputs[name].check || "Any", expected.check, `${type}.${name} value check`);
      } else if (expected.kind === "statement") {
        assert.ok(actual.statementInputs[name], `${type}.${name} statement input`);
      } else if (expected.kind === "field") {
        const field = actual.fields[name];
        assert.ok(field, `${type}.${name} field`);
        assert.equal(field.defaultValue, expected.default, `${type}.${name} default`);
        if (field.kind === "dropdown") {
          assert.deepEqual(Array.from(field.options, option => option[1]), expected.options, `${type}.${name} options`);
        }
        if (field.kind === "number") {
          assert.equal(field.min, expected.limits.min, `${type}.${name} min`);
          assert.equal(field.max, expected.limits.max, `${type}.${name} max`);
          assert.equal(field.precision, expected.limits.integer ? 1 : undefined, `${type}.${name} precision`);
        }
      }
    }
  }
});

test("every project runtime API named by the catalog exists in the simulator API", () => {
  const apiNames = [...new Set(Object.values(catalog.blocks)
    .filter(record => record.provider === "project")
    .flatMap(record => record.runtimeApis))].sort();
  assert.equal(apiNames.length, 39);
  for (const apiName of apiNames) assert.ok(runtimeApiIsDeclared(apiName), `runtime API ${apiName}`);
});

test("custom runtime validators cover every documented project boundary", () => {
  assert.match(app, /移动距离必须是 0\.1 到 500 厘米/);
  assert.match(app, /转向角度必须是 1 到 360 度/);
  assert.match(app, /等待[\s\S]*?minimum: 0, maximum: 60/);
  assert.match(app, /导航传感查询超过每次运行 1000 次的上限/);
  assert.match(app, /摄像头最低置信度必须是 0 到 1/);
  assert.match(app, /摄像头查询超过每次运行 1000 次的上限/);
  assert.match(app, /自动靠近停止距离必须是 5 到 200 厘米/);
  assert.match(app, /自动靠近控制步数必须是 1 到 100 的整数/);
  assert.match(app, /道路控制速度必须是 10 到 100/);
  assert.match(app, /道路控制超过每次运行 300 次的上限/);
  assert.match(app, /沿路行驶距离必须是 10 到 500 厘米/);
  assert.match(app, /出口道路编号必须是 1 到 128 个可打印字符/);
  assert.match(app, /字段名称无效，导航数据不开放坐标或内部几何字段/);
  assert.match(app, /列表序号必须是从 1 开始的整数/);
  assert.match(app, /const MAX_PROGRAM_LOOP_ITERATIONS = 100/);
  assert.match(app, /const MAX_PROGRAM_PROCEDURE_CALLS = 1000/);
  assert.match(app, /const MAX_PROGRAM_PROCEDURE_DEPTH = 50/);
  assert.match(app, /procedureCallCount\s*>\s*MAX_PROGRAM_PROCEDURE_CALLS/);
  assert.match(app, /procedureCallDepth\s*>\s*MAX_PROGRAM_PROCEDURE_DEPTH/);
  assert.match(app, /abortRunContext\(context, "procedure-limit"\)/);
});

test("Blockly built-ins, dynamic variables/functions and compatibility-only blocks are explicitly covered", () => {
  assert.match(html, /\.\/vendor\/blockly\/blockly_compressed\.js/);
  assert.doesNotMatch(html, /<script[^>]+src="https?:\/\//);
  assert.match(html, /\.\/vendor\/blockly\/blocks_compressed\.js/);
  assert.match(html, /\.\/vendor\/blockly\/javascript_compressed\.js/);
  for (const type of catalog.compatibilityOnlyTypes) {
    assert.ok(!catalog.categories.some(category => category.items.some(item => item.type === type)), `${type} stays out of toolbox`);
    assert.match(app, new RegExp(`Blockly\\.Blocks\\.${type}\\s*=`));
    assert.match(app, new RegExp(`Blockly\\.JavaScript\\.${type}\\s*=`));
  }
  for (const type of ["procedures_defnoreturn", "procedures_defreturn", "procedures_callnoreturn", "procedures_callreturn", "procedures_ifreturn"]) {
    assert.match(app, new RegExp(`Blockly\\.JavaScript\\.${type}\\s*=`), `${type} async generator override`);
  }
  for (const apiName of ["procedureEnter", "procedureExit"]) {
    assert.ok(runtimeApiIsDeclared(apiName), `procedure runtime API ${apiName}`);
  }
  assert.match(app, /try\s*\{[\s\S]*?finally\s*\{[\s\S]*?robot\.procedureExit\(\)/);
  for (const type of ["controls_repeat_ext", "controls_whileUntil", "controls_for", "controls_forEach"]) {
    assert.match(app, new RegExp(`Blockly\\.JavaScript\\.${type}\\s*=`), `${type} safe-loop generator override`);
  }
});

test("all browser runtime dependencies are vendored for offline delivery", () => {
  for (const pageName of ["index.html", "login.html", "admin.html"]) {
    const page = fs.readFileSync(path.join(root, pageName), "utf8");
    assert.doesNotMatch(page, /<script[^>]+src=["']https?:\/\//i, `${pageName} must not execute CDN scripts`);
  }
  for (const assetPath of [
    "vendor/blockly/blockly_compressed.js",
    "vendor/blockly/blocks_compressed.js",
    "vendor/blockly/javascript_compressed.js",
    "vendor/blockly/msg/zh-hans.js",
    "vendor/three/three.min.js",
    "vendor/lucide/lucide.min.js",
    "vendor/licenses/Blockly-9.3.3-LICENSE.txt",
    "vendor/licenses/Three-0.160.0-LICENSE.txt",
    "vendor/licenses/Lucide-0.468.0-LICENSE.txt"
  ]) {
    assert.ok(fs.statSync(path.join(root, assetPath)).size > 0, `${assetPath} must be included`);
  }
  const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.doesNotMatch(serverSource, /script-src[^;]*unpkg\.com/);
  for (const requestPath of [
    "/vendor/blockly/blockly_compressed.js",
    "/vendor/blockly/blocks_compressed.js",
    "/vendor/blockly/javascript_compressed.js",
    "/vendor/blockly/msg/zh-hans.js",
    "/vendor/three/three.min.js",
    "/vendor/lucide/lucide.min.js"
  ]) {
    assert.match(serverSource, new RegExp(requestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${requestPath} must be present in STATIC_FILES`);
  }
});
