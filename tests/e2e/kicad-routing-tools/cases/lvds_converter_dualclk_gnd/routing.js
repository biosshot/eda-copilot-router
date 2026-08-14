diffPair("CLOCK", { positive: "/CLK+", negative: "/CLK-" })
diffPair("DATA", { positive: "/DATA+", negative: "/DATA-" })

// Keep the upstream ground zone and routed copper fixed while completing the board.
runRouting()
