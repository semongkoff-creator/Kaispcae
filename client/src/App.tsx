import { useEffect, useState } from 'react';
import { GameCanvas } from './components/canvas/GameCanvas';
import { createDefaultRoom } from './utils/createDefaultRoom';
import { useGameStore } from './stores/gameStore';

export default function App() {
  const [isReady, setIsReady] = useState(false);
  const setRoomState = useGameStore((s) => s.setRoomState);

  // Generate the default room on mount
  useEffect(() => {
    const room = createDefaultRoom('default', 'Main Office');
    setRoomState(room);
    setIsReady(true);
  }, [setRoomState]);

  if (!isReady) {
    return (
      <div className="w-screen h-screen bg-gray-900 flex items-center justify-center">
        <p className="text-white text-xl">Loading VirtualMeet…</p>
      </div>
    );
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-gray-900">
      <GameCanvas />
      {/* HUD overlay — placeholder for future UI */}
      <div className="absolute top-4 left-4 pointer-events-none">
        <p className="text-white/50 text-sm font-mono">WASD / Arrow keys to move</p>
      </div>
    </div>
  );
}
