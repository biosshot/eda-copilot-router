// The same 56-pair declaration as the unrouted Haasoscope fixture also tests
// preservation: pre-existing routes must not be needlessly rewritten.
for (let bank = 1; bank <= 4; bank += 1) {
  for (let lane = 1; lane <= 13; lane += 1) {
    diffPair(`LVDS_RX${bank}_${lane}`, {
      positive: `/fpga_adc/lvds_rx${bank}_${lane}_P`,
      negative: `/fpga_adc/lvds_rx${bank}_${lane}_N`,
    })
  }
  diffPair(`LVDS_CLKIN${bank}`, {
    positive: `/fpga_adc/lvds_rx_top_clkin${bank}_P`,
    negative: `/fpga_adc/lvds_rx_top_clkin${bank}_N`,
  })
}

runRouting()
