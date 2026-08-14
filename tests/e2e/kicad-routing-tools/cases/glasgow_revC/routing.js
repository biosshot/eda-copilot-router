diffPair("USB", { positive: "/USB_P", negative: "/USB_N" })

for (let index = 0; index <= 12; index += 1) {
  diffPair(`IO_BANK_Z${index}`, {
    positive: `/IO_Banks/Z${index}_P`,
    negative: `/IO_Banks/Z${index}_N`,
  })
}

runRouting()
