const lastMoveSeqBySocket = new Map<string, number>();

function normalizeMoveSeq(seq: unknown): number | null {
  if (typeof seq !== 'number') return null;
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  return seq;
}

export function shouldAcceptMoveSequence(socketId: string, seq: unknown): boolean {
  const normalized = normalizeMoveSeq(seq);
  if (normalized === null) return true;

  const lastSeq = lastMoveSeqBySocket.get(socketId);
  if (lastSeq !== undefined && normalized <= lastSeq) return false;

  lastMoveSeqBySocket.set(socketId, normalized);
  return true;
}

export function clearMovementSequence(socketId: string): void {
  lastMoveSeqBySocket.delete(socketId);
}
