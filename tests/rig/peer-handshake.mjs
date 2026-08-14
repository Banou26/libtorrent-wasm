// One inbound peer, spoken by hand, plus the wait loop the inbound tests share.

export const PROTOCOL = 'BitTorrent protocol'

/** BEP 3: 1 byte pstrlen, 19 byte pstr, 8 reserved, 20 infohash, 20 peer id. */
export const handshake = (infoHash, peerId) => Buffer.concat([
  Buffer.from([PROTOCOL.length]),
  Buffer.from(PROTOCOL, 'ascii'),
  // reserved: bit 20 of byte 5 is the extension protocol (BEP 10). libtorrent answers either way,
  // but announcing it keeps this a connection a real client would make.
  Buffer.from([0, 0, 0, 0, 0, 0x10, 0, 0]),
  Buffer.from(infoHash, 'hex'),
  Buffer.from(peerId, 'ascii'),
])

export const waitFor = async (what, predicate, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}
