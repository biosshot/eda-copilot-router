const pairs = [
  ["RAM_LDQS", "RAM_LDQS+", "RAM_LDQS-"],
  ["RAM_UDQS", "RAM_UDQS+", "RAM_UDQS-"],
  ["RAM_CK", "RAM_CK+", "RAM_CK-"],
  ["USB", "USB_D+", "USB_D-"],
  ["EXT_PLL", "EXT_PLL+", "EXT_PLL-"],
  ["SHEET_USB", "/sheetIO/_USB_D_P", "/sheetIO/_USB_D_N"],
]

for (const [id, positive, negative] of pairs) diffPair(id, { positive, negative })

runRouting()
