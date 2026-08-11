// ../kicad-copilot/src/kicad/sexpr/ast.ts
function token(value, quoted = false) {
  return { value, quoted };
}
function isSExpressionList(value) {
  return Array.isArray(value);
}
function atom(value) {
  return value && !isSExpressionList(value) ? value.value : void 0;
}
function listHead(value) {
  return isSExpressionList(value) ? atom(value[0]) : void 0;
}
function findChild(value, head) {
  return value.find((item) => isSExpressionList(item) && listHead(item) === head);
}
function tokenize(source) {
  const output = [];
  for (let index = 0; index < source.length; ) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === ";") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "(" || char === ")") {
      output.push(char);
      index += 1;
      continue;
    }
    if (char === '"') {
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\" && index + 1 < source.length) {
          const escaped = source[index + 1];
          value += escaped === "n" ? "\n" : escaped;
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      if (source[index] !== '"') throw new Error("unterminated S-expression string");
      output.push(token(value, true));
      index += 1;
      continue;
    }
    let end = index;
    while (end < source.length && !/[\s()]/.test(source[end])) end += 1;
    output.push(token(source.slice(index, end)));
    index = end;
  }
  return output;
}
function parseSExpression(source) {
  const tokens = tokenize(source);
  let cursor = 0;
  const parseOne = () => {
    const current = tokens[cursor];
    cursor += 1;
    if (current !== "(") {
      if (current === ")" || current === void 0) throw new Error("unexpected S-expression token");
      return current;
    }
    const list = [];
    while (tokens[cursor] !== ")") {
      if (cursor >= tokens.length) throw new Error("unclosed S-expression list");
      list.push(parseOne());
    }
    cursor += 1;
    return list;
  };
  const root = parseOne();
  if (!isSExpressionList(root) || cursor !== tokens.length) {
    throw new Error("invalid S-expression root");
  }
  return root;
}
function quote(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}
function printSExpression(value) {
  if (!isSExpressionList(value)) return value.quoted ? quote(value.value) : value.value;
  return `(${value.map(printSExpression).join(" ")})`;
}

// ../kicad-copilot/src/kicad/pcb-reader.ts
import { readFile, stat } from "fs/promises";
import { resolve } from "path";
function listChildren(root, head) {
  return root.filter((item) => isSExpressionList(item) && listHead(item) === head);
}
function childText(node, head) {
  var _a;
  return atom((_a = findChild(node, head)) == null ? void 0 : _a[1]);
}
function propertyValue(node, name) {
  for (const child of node) {
    if (!isSExpressionList(child) || listHead(child) !== "property") continue;
    if (atom(child[1]) === name) return atom(child[2]);
  }
  return void 0;
}
function footprintReference(node) {
  const property = propertyValue(node, "Reference");
  if (property) return property;
  for (const child of node) {
    if (!isSExpressionList(child) || listHead(child) !== "fp_text") continue;
    if (atom(child[1]) === "reference") return atom(child[2]);
  }
  return void 0;
}
function footprintLayer(node) {
  return childText(node, "layer") || "F.Cu";
}
function footprintAt(node) {
  const at = findChild(node, "at");
  return {
    x: Number(atom(at == null ? void 0 : at[1]) || 0),
    y: Number(atom(at == null ? void 0 : at[2]) || 0),
    rotate: Number(atom(at == null ? void 0 : at[3]) || 0)
  };
}
function padNumber(node) {
  return listHead(node) === "pad" ? atom(node[1]) : void 0;
}
function padNet(node) {
  const net = findChild(node, "net");
  if (!net) return "";
  return atom(net.length >= 3 ? net[2] : net[1]) || "";
}
async function readPcb(path) {
  const target = resolve(path);
  const info = await stat(target).catch(() => void 0);
  if (!(info == null ? void 0 : info.isFile())) throw new Error(`path not found: ${target}`);
  const source = await readFile(target, "utf8");
  const root = parseSExpression(source);
  if (listHead(root) !== "kicad_pcb") throw new Error("invalid KiCad PCB");
  const version = Number(childText(root, "version"));
  if (!Number.isFinite(version)) throw new Error("invalid KiCad PCB version");
  return { path: target, source, root, version };
}
function pcbFootprints(root) {
  return listChildren(root, "footprint");
}
function pcbNetNames(root) {
  const result = /* @__PURE__ */ new Set();
  for (const footprint of pcbFootprints(root)) {
    for (const pad of listChildren(footprint, "pad")) {
      const net = padNet(pad);
      if (net) result.add(net);
    }
  }
  return result;
}

export {
  token,
  isSExpressionList,
  atom,
  listHead,
  findChild,
  parseSExpression,
  printSExpression,
  listChildren,
  childText,
  footprintReference,
  footprintLayer,
  footprintAt,
  padNumber,
  padNet,
  readPcb,
  pcbFootprints,
  pcbNetNames
};
