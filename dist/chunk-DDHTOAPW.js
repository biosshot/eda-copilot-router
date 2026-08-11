// src/polygon/dsl.ts
import { Script, createContext } from "vm";
var nonEmpty = (value, label) => {
  if (typeof value !== "string" && typeof value !== "number" || String(value).trim().length === 0) {
    throw new Error(`${label} must be a non-empty string or number`);
  }
  return String(value).trim();
};
function isTarget(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  return candidate.kind === "pad" ? typeof candidate.component === "string" && typeof candidate.pad === "string" : candidate.kind === "net" && typeof candidate.net === "string";
}
var PolygonRuleBuilder = class {
  constructor(intent) {
    this.intent = intent;
  }
  intent;
  connect(...targets) {
    if (!targets.length || !targets.every(isTarget)) {
      throw new Error("polygon.connect(...) requires pad(...) or net(...) targets");
    }
    this.intent.targets.push(...targets.map((target) => structuredClone(target)));
    return this;
  }
  on(selector) {
    if (!selector || !["outer", "top", "bottom", "named"].includes(selector.kind)) {
      throw new Error("polygon.on(...) requires a layer selector");
    }
    this.intent.layers = structuredClone(selector);
    return this;
  }
  compact() {
    this.intent.mode = "compact";
    return this;
  }
  plane() {
    this.intent.mode = "plane";
    return this;
  }
  priority(value) {
    if (!Number.isInteger(value) || value < 0) throw new Error("polygon.priority must be an integer >= 0");
    this.intent.priority = value;
    return this;
  }
  maxPadFreeGap(value) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("polygon.maxPadFreeGap must be a finite number > 0");
    }
    this.intent.maxPadFreeGapWidths = value;
    return this;
  }
};
var PolygonDslBuilder = class {
  polygons = [];
  createSandbox() {
    return {
      polygon: (net) => this.addPolygon(net),
      pad: (component, padNumber) => ({
        kind: "pad",
        component: nonEmpty(component, "pad component"),
        pad: nonEmpty(padNumber, "pad number")
      }),
      net: (name) => ({ kind: "net", net: nonEmpty(name, "target net") }),
      outerLayers: () => ({ kind: "outer" }),
      topLayer: () => ({ kind: "top" }),
      bottomLayer: () => ({ kind: "bottom" }),
      layers: (...names) => ({
        kind: "named",
        names: names.map((name, index) => {
          const normalized = nonEmpty(name, `layers[${index}]`);
          if (!/^(TOP|BOTTOM|INNER_[1-9][0-9]?)$/.test(normalized)) {
            throw new Error(`layers[${index}] must use a universal RawPcb copper layer name`);
          }
          return normalized;
        })
      })
    };
  }
  toProgram() {
    if (this.polygons.length === 0) throw new Error("polygon DSL produced no polygon rules");
    for (const [index, intent] of this.polygons.entries()) {
      if (!intent.targets.length) throw new Error(`polygon rule ${index + 1} (${intent.net}) has no connect(...) targets`);
      for (const target of intent.targets) {
        if (target.kind === "net" && target.net !== intent.net) {
          throw new Error(`polygon ${intent.net} cannot connect net(${target.net})`);
        }
      }
    }
    return {
      version: 1,
      polygons: this.polygons.map((intent) => structuredClone(intent)).sort((a, b) => b.priority - a.priority)
    };
  }
  addPolygon(netValue) {
    const intent = {
      kind: "polygon",
      net: nonEmpty(netValue, "polygon net"),
      targets: [],
      layers: { kind: "top" },
      mode: "compact",
      priority: 0,
      maxPadFreeGapWidths: 4.5
    };
    this.polygons.push(intent);
    return new PolygonRuleBuilder(intent);
  }
};
function runPolygonDsl(code) {
  const builder = new PolygonDslBuilder();
  const sandbox = createContext(builder.createSandbox(), {
    codeGeneration: { strings: false, wasm: false }
  });
  new Script(`"use strict";
${code}`, { filename: "pcb-polygon-dsl.js" }).runInContext(sandbox, { timeout: 500, displayErrors: true });
  return builder.toProgram();
}

export {
  runPolygonDsl
};
