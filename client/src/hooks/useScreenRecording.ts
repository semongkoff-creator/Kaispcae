import { useCallback, useEffect, useRef, useState } from 'react';
import { ActiveRecordingInfo } from '@/stores/gameStore';
import { RECORDING_MAX_DURATION_MS } from '@virtualmeet/shared';
import { webrtcService } from '@/services/webrtcService';
import { api } from '@/services/api';

interface UseScreenRecordingOptions {
  activeRecording: ActiveRecordingInfo | null;
  findSocketIdByUserId: (userId: string) => string | undefined;
  emitRecordingStop: (recordingId: string) => void;
  // fileUrl is null to signal "capture never produced anything" (couldn't
  // resolve the target's stream, or the upload failed) — recordingHandler.ts
  // marks the row 'failed' and releases the one-recording-per-room lock in
  // that case, instead of leaving it stuck at 'recording' forever.
  emitRecordingFinalize: (recordingId: string, fileUrl: string | null) => void;
}

// §7 — Screen Recording capture, entirely client-side (see the Recording
// Prisma model's doc comment for why). Only the browser that actually
// STARTED the recording ever runs a MediaRecorder — everyone else who
// receives activeRecording (the target, or another admin) just sees a
// badge; this hook tells the two apart via pendingTargetRef, set the
// moment *this* client requests a recording, before the server confirms it.
export function useScreenRecording({ activeRecording, findSocketIdByUserId, emitRecordingStop, emitRecordingFinalize }: UseScreenRecordingOptions) {
  const pendingTargetRef = useRef<string | null>(null);
  const pendingClearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [myRecordingId, setMyRecordingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const stopCapture = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
  }, []);

  // Request a new recording — capture itself only begins once the server
  // confirms via RECORDING_STARTED (see the effect below), so a rejected
  // request (no permission, lock held, target gone) never spins up a
  // MediaRecorder at all. But a rejection arrives as the generic
  // 'admin:error' event (see useSocket.ts), which this hook has no way to
  // react to — without the timeout below, pendingTargetRef would stay set
  // to targetUserId forever, and a LATER, unrelated recording of that same
  // person (started by someone else entirely) would be wrongly claimed as
  // mine the moment its RECORDING_STARTED arrives.
  const requestRecording = useCallback((targetUserId: string, title: string, emitStart: (targetUserId: string, title: string) => void) => {
    pendingTargetRef.current = targetUserId;
    emitStart(targetUserId, title);
    if (pendingClearTimeoutRef.current) clearTimeout(pendingClearTimeoutRef.current);
    pendingClearTimeoutRef.current = setTimeout(() => {
      if (pendingTargetRef.current === targetUserId) pendingTargetRef.current = null;
    }, 5000);
  }, []);

  const stopMyRecording = useCallback(() => {
    if (!myRecordingId) return;
    emitRecordingStop(myRecordingId);
    stopCapture();
  }, [myRecordingId, emitRecordingStop, stopCapture]);

  useEffect(() => {
    if (!activeRecording) return;
    if (pendingTargetRef.current !== activeRecording.targetUserId) return; // not my request
    pendingTargetRef.current = null;
    if (pendingClearTimeoutRef.current) {
      clearTimeout(pendingClearTimeoutRef.current);
      pendingClearTimeoutRef.current = null;
    }

    const targetSocketId = findSocketIdByUserId(activeRecording.targetUserId);
    const stream = targetSocketId ? webrtcService.getRecordingStream(targetSocketId) : null;
    if (!stream) {
      console.error('[recording] could not capture target stream — no active connection to them');
      // Release the lock immediately — without this the row stays at
      // 'recording' until the starter disconnects (see the bug this fixes).
      emitRecordingFinalize(activeRecording.recordingId, null);
      return;
    }

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType });
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' });
      chunksRef.current = [];
      setUploading(true);
      try {
        const { url } = await api.uploadRecording(blob);
        emitRecordingFinalize(activeRecording.recordingId, url);
      } catch (e) {
        console.error('[recording] upload failed:', e);
        emitRecordingFinalize(activeRecording.recordingId, null);
      } finally {
        setUploading(false);
        recorderRef.current = null;
        setMyRecordingId(null);
      }
    };

    recorder.start();
    recorderRef.current = recorder;
    setMyRecordingId(activeRecording.recordingId);
    // Auto-stop at the spec's own duration cap (§7) — a client-side timer
    // stands in for the spec's separate scheduler process, since the whole
    // capture pipeline already lives in this one tab.
    timeoutRef.current = setTimeout(stopCapture, RECORDING_MAX_DURATION_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRecording]);

  // If the recording I'm capturing ends for any other reason (creator — me
  // — disconnecting isn't reachable here, but a stale reference shouldn't
  // linger if activeRecording is cleared out from under me).
  useEffect(() => {
    if (!activeRecording && myRecordingId) {
      stopCapture();
    }
  }, [activeRecording, myRecordingId, stopCapture]);

  return {
    requestRecording,
    stopMyRecording,
    isRecordingMine: !!myRecordingId,
    uploading,
  };
}
