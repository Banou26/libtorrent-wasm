// A verbatim port of ripple/src/torrent/stream-plan.ts.
//
// Duplicated rather than imported: ripple is TypeScript in another repo, and the
// rig has to stay runnable from this one alone. The formulas are the whole point
// of the rig, so if ripple's change here and these do not, every result silently
// describes a plan production no longer uses. Diff the two files when either moves.

/** One in-flight demuxer read. Matches @banou/media-player's default bufferSize. */
export const READ_SIZE = 2_500_000

/** Past this the in-order walk is starved regardless of how few pieces that is. */
export const MAX_WINDOW_BYTES = 8 * 1024 * 1024

export const FALLBACK_WINDOW_PIECES = 12

export const windowPiecesFor = (pieceLength) => {
  if (!Number.isFinite(pieceLength) || pieceLength <= 0) return FALLBACK_WINDOW_PIECES
  const need = Math.ceil(READ_SIZE / pieceLength) + 1
  const cap = Math.max(2, Math.floor(MAX_WINDOW_BYTES / pieceLength))
  return Math.min(Math.max(need, 2), cap)
}

export const windowBytes = (pieceLength) =>
  windowPiecesFor(pieceLength) * Math.max(0, pieceLength)

export const anchorStep = (pieceLength) =>
  Math.max(1, Math.floor(windowBytes(pieceLength) / 2))

export const deadlineStepMsFor = (pieceLength, bytesPerSecond) =>
  Math.min(2000, Math.max(50, Math.round((pieceLength / Math.max(bytesPerSecond, 250_000)) * 1000)))

/**
 * A read that ENDS in the file's last piece is the demuxer loading its index
 * (matroska cues, a trailing moov), not the playhead moving there.
 */
export const shouldReanchor = (span, fromOffset, offset, len = READ_SIZE) => {
  const lastByte = span.fileOffset + offset + Math.max(0, len - 1)
  if (Math.floor(lastByte / span.pieceLength) >= span.p1) return false
  return Math.abs(offset - fromOffset) >= anchorStep(span.pieceLength)
}
