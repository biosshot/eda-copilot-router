import {
  listHead,
  parseSExpression,
  printSExpression
} from "./chunk-L7USXWVD.js";

// ../kicad-copilot/src/kicad/pcb-writer.ts
import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { basename, dirname, resolve } from "path";
function parsePcbSource(source) {
  const root = parseSExpression(source);
  if (!Array.isArray(root) || listHead(root) !== "kicad_pcb") throw new Error("invalid KiCad PCB");
  return root;
}
function serializePcb(root) {
  return `${printSExpression(root)}
`;
}

export {
  parsePcbSource,
  serializePcb
};
