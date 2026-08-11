import { copyFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"

const output = resolve("dist", "polygon")
await mkdir(output, { recursive: true })
await copyFile(resolve("src", "polygon", "spec-doc.d.ts"), resolve(output, "spec-doc.d.ts"))
