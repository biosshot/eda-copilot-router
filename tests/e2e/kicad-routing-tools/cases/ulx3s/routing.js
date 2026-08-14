const pairs = [
  ["FPDI_D2", "FPDI_D2+", "FPDI_D2-"],
  ["FPDI_D1", "FPDI_D1+", "FPDI_D1-"],
  ["FPDI_D0", "FPDI_D0+", "FPDI_D0-"],
  ["FPDI_CLK", "FPDI_CLK+", "FPDI_CLK-"],
  ["USB_FPGA_PULL", "USB_FPGA_PULL_D+", "USB_FPGA_PULL_D-"],
  ["USB_FPGA", "USB_FPGA_D+", "USB_FPGA_D-"],
  ["GPDI_D2", "/gpdi/GPDI_D2+", "/gpdi/GPDI_D2-"],
  ["GPDI_D1", "/gpdi/GPDI_D1+", "/gpdi/GPDI_D1-"],
  ["GPDI_D0", "/gpdi/GPDI_D0+", "/gpdi/GPDI_D0-"],
  ["GPDI_CLK", "/gpdi/GPDI_CLK+", "/gpdi/GPDI_CLK-"],
  ["USB_FTD", "/usb/FTD+", "/usb/FTD-"],
  ["USB_FPD", "/usb/FPD+", "/usb/FPD-"],
  ["USB_FTDI", "USB_FTDI_D+", "USB_FTDI_D-"],
]

for (const [id, positive, negative] of pairs) diffPair(id, { positive, negative })

runRouting()
