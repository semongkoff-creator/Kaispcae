import { useEffect, useRef, useCallback, useState } from 'react';
import { Socket } from 'socket.io-client';
import { ProximityPlayer, PROXIMITY_THRESHOLD, DISCONNECT_DEBOUNCE_MS } from '@virtualmeet/shared';
import { webrtcService } from '@/services/webrtcService';
import { calcGain } from './useProximity';

interface UseWebRTCOptions {
  socketRef: React.MutableRefObject<Socket | null>;
  onRemoteStream?: (id: string, stream: MediaStream) => void;
}

export function useWebRTC({ socketRef, onRemoteStream }: UseWebRTCOptions) {
  const connectedRef = useRef<Set<string>>(new Set());
  const initRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const disconnectTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const initMedia = useCallback(async () => {
    if (initRef.current) return;
    initRef.current = true;
    await webrtcService.initLocalMedia();
    streamRef.current = webrtcService.getLocalStream();
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (socket) {
      webrtcService.setSocket(socket);
      webrtcService.setOnRemoteStream((id, stream) => {
        onRemoteStream?.(id, stream);
      });
      webrtcService.setOnScreenShareEnded(() => setIsScreenSharing(false));
    }
  }, [onRemoteStream]);

  // Watch proximity: connect if within 3 tiles, disconnect with debounce
  const updateProximity = useCallback((nearby: ProximityPlayer[]) => {
    const inRangeIds = new Set(nearby.filter((p) => p.inProximity).map((p) => p.id));
    const connectedIds = connectedRef.current;

    // Connect new in-range players
    for (const p of nearby) {
      if (p.inProximity) {
        // Clear any pending disconnect timer
        const timer = disconnectTimers.current.get(p.id);
        if (timer) {
          clearTimeout(timer);
          disconnectTimers.current.delete(p.id);
        }

        if (!connectedIds.has(p.id)) {
          webrtcService.connectToPlayer(p.id);
          connectedIds.add(p.id);
        }

        // Zone-mates always get full volume; otherwise fall off with distance.
        webrtcService.setAudioVolume(p.id, p.viaZone ? 1 : calcGain(p.distanceTiles));
      }
    }

    // Debounced disconnect for players out of range
    for (const id of connectedIds) {
      if (!inRangeIds.has(id)) {
        if (!disconnectTimers.current.has(id)) {
          disconnectTimers.current.set(id, setTimeout(() => {
            webrtcService.disconnectFromPlayer(id);
            connectedIds.delete(id);
            disconnectTimers.current.delete(id);
          }, DISCONNECT_DEBOUNCE_MS));
        }
      }
    }
  }, []);

  const toggleMic = useCallback(() => {
    const track = streamRef.current?.getAudioTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    setIsMicMuted(!track.enabled);
    return track.enabled;
  }, []);

  const toggleCamera = useCallback(() => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    setIsCameraOn(track.enabled);
    return track.enabled;
  }, []);

  const toggleScreenShare = useCallback(async () => {
    if (webrtcService.isScreenSharing()) {
      webrtcService.stopScreenShare();
      setIsScreenSharing(false);
      return true;
    }
    const result = await webrtcService.startScreenShare();
    setIsScreenSharing(result.success);
    return result.success;
  }, []);

  const destroy = useCallback(() => {
    for (const timer of disconnectTimers.current.values()) {
      clearTimeout(timer);
    }
    disconnectTimers.current.clear();
    webrtcService.destroy();
    connectedRef.current.clear();
    initRef.current = false;
    streamRef.current = null;
  }, []);

  return {
    initMedia,
    updateProximity,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    isMicMuted,
    isCameraOn,
    isScreenSharing,
    destroy,
    getLocalStream: () => webrtcService.getLocalStream(),
  };
}
