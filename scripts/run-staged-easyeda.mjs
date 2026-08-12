import { spawn } from "node:child_process"

const env = {
  ...process.env,
  COPILOT_ROUTER_REMAINING_BACKEND: "easyeda-wasm",
  COPILOT_ROUTER_FULL_RESULT: process.env.COPILOT_ROUTER_FULL_RESULT ?? "results/full-cycle-easyeda",
}

const child = spawn(process.execPath, ["dist/staged-routing.js", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env,
  shell: false,
  windowsHide: true,
  stdio: "inherit",
})

child.on("error", (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on("exit", (code, signal) => {
  if (signal) console.error(`staged workflow ended by ${signal}`)
  process.exitCode = code ?? 1
})
