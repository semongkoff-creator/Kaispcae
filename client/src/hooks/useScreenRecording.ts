import { useCallback, useEffect, useRef, useState } from 'react';
import { ActiveRecordingInfo } from '@/stores/gameStore';
import { RECORDING_MAX_DURATION_MS } from '@kaispace/shared';
import { webrtcService } from '@/services/webrtcService';
import { api } from '@/services/api';

interface UseScreenRecordingOptions {
  activeRecording: ActiveRecordingInfo | null;
  localUserId: string;
  findSocketIdByUserId: (userId: string) => string | undefined;
  emitRecordingStop: (recordingId: string) => void;
  // fileUrl is null to signal "capture never produced anything" (couldn't
  // resolve the target's stream, or the upload failed) — recordingHandler.ts
  // marks the row 'failed' and releases the one-recording-per-room lock in
  // that case, instead of leaving it stuck at 'recording' forever.
  emitRecordingFinalize: (recordingId: string, fileUrl: string | null) => void;
}

// Bug fix — Chrome's hardware H.264 encoder corrupts a fixed band of
// macroblocks on EVERY frame whenever the captured video's height isn't a
// multiple of 16 (getDisplayMedia — and a remote peer's negotiated
// resolution — can be any arbitrary size, never guaranteed mod-16).
// Confirmed directly against a real production recording: captured at
// 868px height (868 / 16 = 54.25), it decoded with an identical
// "concealing ~600 MV errors" defect on literally every frame from the
// first keyframe onward, while a comparison recording captured at a
// mod-16-safe 912px height decoded perfectly clean. Re-drawing each frame
// onto a canvas cropped down to the nearest multiple of 16 (at most 15px
// lost off the right/bottom edge — imperceptible for a screen recording)
// sidesteps the encoder bug entirely, regardless of source size. Returns
// the original stream untouched (and a no-op cleanup) when it's already
// mod-16-safe, so the common case pays no extra canvas/CPU cost.
function toSafeDimensionStream(sourceStream: MediaStream): { stream: MediaStream; cleanup: () => void } {
  const videoTrack = sourceStream.getVideoTracks()[0];
  if (!videoTrack) return { stream: sourceStream, cleanup: () => {} };

  const settings = videoTrack.getSettings();
  const width = settings.width ?? 0;
  const height = settings.height ?? 0;
  const safeWidth = Math.floor(width / 16) * 16;
  const safeHeight = Math.floor(height / 16) * 16;
  if (!width || !height || (width === safeWidth && height === safeHeight)) {
    return { stream: sourceStream, cleanup: () => {} };
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([videoTrack]);
  video.play().catch(() => {});

  const canvas = document.createElement('canvas');
  canvas.width = safeWidth;
  canvas.height = safeHeight;
  const ctx = canvas.getContext('2d', { alpha: false });

  let stopped = false;
  const drawFrame = () => {
    if (stopped) return;
    // Source rect == dest rect (no scale factor) — a direct pixel crop of
    // the bottom-right edge, not a resize, so there's no blur/interpolation.
    ctx?.drawImage(video, 0, 0, safeWidth, safeHeight, 0, 0, safeWidth, safeHeight);
    if ('requestVideoFrameCallback' in video) {
      (video as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(drawFrame);
    } else {
      requestAnimationFrame(drawFrame);
    }
  };
  drawFrame();

  const canvasStream = canvas.captureStream(settings.frameRate ?? 30);
  const combined = new MediaStream([...canvasStream.getVideoTracks(), ...sourceStream.getAudioTracks()]);

  const cleanup = () => {
    stopped = true;
    video.pause();
    video.srcObject = null;
    canvasStream.getTracks().forEach((t) => t.stop());
  };

  return { stream: combined, cleanup };
}

// §7 — Screen Recording capture, entirely client-side (see the Recording
// Prisma model's doc comment for why). Only the browser that actually
// STARTED the recording ever runs a MediaRecorder — everyone else who
// receives activeRecording (the target, or another admin) just sees a
// badge; this hook tells the two apart via pendingTargetRef, set the
// moment *this* client requests a recording, before the server confirms it.
export function useScreenRecording({ activeRecording, localUserId, findSocketIdByUserId, emitRecordingStop, emitRecordingFinalize }: UseScreenRecordingOptions) {
  const pendingTargetRef = useRef<string | null>(null);
  const pendingClearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [myRecordingId, setMyRecordingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const stopCapture = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    setIsPaused(false);
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

  // Pause/resume — real MediaRecorder.pause()/.resume(), entirely
  // client-local (no server event, no Recording.status change): the server
  // has no visibility into the capture pipeline by this feature's own
  // existing architecture (capture lives only in the recorder's own
  // browser), and the one-recording-per-room lock is keyed on
  // status IN ('recording','processing'), unaffected by pause either way.
  // The wall-clock 80-minute auto-stop timer is cleared while paused and
  // restarted at FULL duration on resume — a deliberate simplification
  // (a recording paused/resumed several times can span more than 80 minutes
  // of wall-clock time since the original Start, though never more than 80
  // minutes of any single actively-capturing segment) rather than tracking
  // precise cumulative active time, matching the cap's original purpose of
  // bounding one unattended capture session.
  const pauseRecording = useCallback(() => {
    if (!recorderRef.current || recorderRef.current.state !== 'recording') return;
    recorderRef.current.pause();
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsPaused(true);
  }, []);

  const resumeRecording = useCallback(() => {
    if (!recorderRef.current || recorderRef.current.state !== 'paused') return;
    recorderRef.current.resume();
    timeoutRef.current = setTimeout(stopCapture, RECORDING_MAX_DURATION_MS);
    setIsPaused(false);
  }, [stopCapture]);

  useEffect(() => {
    if (!activeRecording) return;
    if (pendingTargetRef.current !== activeRecording.targetUserId) return; // not my request
    pendingTargetRef.current = null;
    if (pendingClearTimeoutRef.current) {
      clearTimeout(pendingClearTimeoutRef.current);
      pendingClearTimeoutRef.current = null;
    }

    let cancelled = false;
    // Only set for a self-recording — the getDisplayMedia() capture belongs
    // solely to this hook (nothing else uses it, unlike getLocalStream()'s
    // persistent camera track), so it's the one stream we're responsible
    // for stopping ourselves once the recorder is done with it.
    let displayStream: MediaStream | null = null;

    const startCapture = async () => {
      const isSelfTarget = activeRecording.targetUserId === localUserId;
      let stream: MediaStream | null;

      if (isSelfTarget) {
        // "Recording myself" means recording what's actually on screen —
        // the game canvas AND every HTML overlay (chat, sidebar, video
        // tiles) — not just my webcam. getDisplayMedia() is the only
        // browser API that composites all of that live; getLocalStream()
        // would only ever show my face. The mic track comes from the
        // existing camera/mic stream so my voice is captured too.
        try {
          // preferCurrentTab biases the browser's own "choose what to
          // share" picker toward this tab as the default/highlighted
          // choice — it does NOT remove the picker (no web API can; every
          // major browser requires this prompt as a security boundary),
          // but "this tab" is the one capture-source choice that keeps
          // recording this tab's content regardless of which OS window or
          // browser tab later has focus (unlike "Entire Screen" or "a
          // Window", both of which silently start showing whatever the
          // user switches to). TypeScript's DOM lib (as pinned in this repo)
          // doesn't yet type `preferCurrentTab` on DisplayMediaStreamOptions,
          // so the options object below is cast to add it.
          displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, preferCurrentTab: true } as DisplayMediaStreamOptions & { preferCurrentTab?: boolean });
          const micTrack = webrtcService.getLocalStream()?.getAudioTracks()[0];
          stream = new MediaStream([...displayStream.getVideoTracks(), ...(micTrack ? [micTrack] : [])]);
        } catch (e) {
          console.warn('[recording] screen capture permission denied or cancelled:', e);
          stream = null;
        }
      } else {
        const targetSocketId = findSocketIdByUserId(activeRecording.targetUserId);
        stream = targetSocketId ? webrtcService.getRecordingStream(targetSocketId) : null;
      }

      if (cancelled) {
        displayStream?.getTracks().forEach((t) => t.stop());
        return;
      }
      if (!stream) {
        console.error('[recording] could not capture target stream — no active connection to them');
        // Release the lock immediately — without this the row stays at
        // 'recording' until the starter disconnects (see the bug this fixes).
        emitRecordingFinalize(activeRecording.recordingId, null);
        return;
      }

      // MP4 first, WebM fallback — isTypeSupported() never throws, so a
      // browser with no MP4 MediaRecorder support (e.g. Firefox) silently
      // falls through to the existing WebM chain with zero behavior change.
      const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')
        ? 'video/mp4;codecs=avc1,mp4a.40.2'
        : MediaRecorder.isTypeSupported('video/mp4')
        ? 'video/mp4'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';
      const { stream: recordingStream, cleanup: cleanupSafeStream } = toSafeDimensionStream(stream);
      const recorder = new MediaRecorder(recordingStream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        cleanupSafeStream();
        displayStream?.getTracks().forEach((t) => t.stop());
        displayStream = null;
        // recorder.mimeType is the browser's own authoritative value — it
        // may normalize/drop codec parameters even if the request above
        // included them, so this is more reliable than reusing the
        // `mimeType` const from startCapture.
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' });
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

      // The browser's own "Stop sharing" bar ends the video track directly
      // — treat that exactly like clicking our own Stop Recording button
      // instead of leaving the recorder (and the server-side lock) hanging.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        emitRecordingStop(activeRecording.recordingId);
        stopCapture();
      });

      setIsPaused(false);
      recorder.start();
      recorderRef.current = recorder;
      setMyRecordingId(activeRecording.recordingId);
      // Auto-stop at the spec's own duration cap (§7) — a client-side timer
      // stands in for the spec's separate scheduler process, since the whole
      // capture pipeline already lives in this one tab.
      timeoutRef.current = setTimeout(stopCapture, RECORDING_MAX_DURATION_MS);
    };

    startCapture();

    return () => {
      cancelled = true;
    };
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
    pauseRecording,
    resumeRecording,
    isRecordingMine: !!myRecordingId,
    isPaused,
    uploading,
  };
}
