import { copyFile, mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = resolve(root, "..", "kicad-copilot", "dist", "autorouter")
const target = join(root, "dist", "autorouter")

await mkdir(target, { recursive: true })
await Promise.all([
  copyFile(join(source, "pcbRouterWorker.js"), join(target, "pcbRouterWorker.js")),
  copyFile(join(source, "PCBRouter-YFDILLBW-YFDILLBW.wasm"), join(target, "PCBRouter-YFDILLBW-YFDILLBW.wasm")),
])
