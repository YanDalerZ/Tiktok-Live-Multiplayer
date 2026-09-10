import { useState, useEffect, useRef, useCallback } from 'react';

// Dynamically inject Tailwind CSS script into the document head
if (typeof document !== 'undefined' && !document.getElementById('tailwind-cdn')) {
  const script = document.createElement('script');
  script.id = 'tailwind-cdn';
  script.src = 'https://cdn.tailwindcss.com';
  document.head.appendChild(script);
}

// Automatically points to secure wss:// protocol when hosted on Render HTTPS domain
const getSignalingUrl = () => {
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return `${protocol}//${host}`;
  }
  return 'ws://localhost:8080';
};

const SIGNALING_URL = getSignalingUrl();

const ALLOWED_KEY_CODES = new Set([
  'KeyW', 'KeyS', 'KeyA', 'KeyD',
  'KeyU', 'KeyI', 'KeyO', 'KeyP',
  'KeyJ', 'KeyK', 'KeyL', 'Semicolon',
  'KeyV', 'KeyB', 'KeyC', 'KeyN'
]);

interface QueuePlayerInfo {
  id: string;
  playerName: string;
}

export default function App() {
  const [playerName, setPlayerName] = useState('');
  const [inQueue, setInQueue] = useState(false);
  const [isCurrentPlayer, setIsCurrentPlayer] = useState(false);
  const [status, setStatus] = useState('CONNECTING TO SERVER...');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [activePlayerInfo, setActivePlayerInfo] = useState<QueuePlayerInfo | null>(null);
  const [queueList, setQueueList] = useState<QueuePlayerInfo[]>([]);
  const [timeLeft, setTimeLeft] = useState<number>(120);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pressedKeys = useRef<Set<string>>(new Set());

  const sendInput = useCallback((code: string, action: 'keydown' | 'keyup') => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ type: 'input_event', action, code })
      );
    }
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (ALLOWED_KEY_CODES.has(e.code)) {
      e.preventDefault();
      if (e.repeat || pressedKeys.current.has(e.code)) return;
      pressedKeys.current.add(e.code);
      sendInput(e.code, 'keydown');
    }
  }, [sendInput]);

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (ALLOWED_KEY_CODES.has(e.code)) {
      e.preventDefault();
      pressedKeys.current.delete(e.code);
      sendInput(e.code, 'keyup');
    }
  }, [sendInput]);

  useEffect(() => {
    if (isCurrentPlayer) {
      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      pressedKeys.current.clear();
    };
  }, [isCurrentPlayer, handleKeyDown, handleKeyUp]);

  useEffect(() => {
    let isMounted = true;
    const ws = new WebSocket(SIGNALING_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!isMounted) return;
      setStatus('INSERT COIN TO PLAY');
      ws.send(JSON.stringify({ type: 'request_stream' }));
    };

    ws.onmessage = async (event) => {
      if (!isMounted) return;
      try {
        const message = JSON.parse(event.data);

        if (message.type === 'queue_update') {
          setActivePlayerInfo(message.activePlayer);
          setQueueList(message.queue);
          setTimeLeft(message.timeRemaining);
        } else if (message.type === 'offer') {
          const pc = new RTCPeerConnection({
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' }
            ],
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle'
          });
          pcRef.current = pc;

          pc.onicecandidate = (e) => {
            if (e.candidate && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'candidate', candidate: e.candidate.toJSON() }));
            }
          };

          pc.ontrack = (e) => {
            if (videoRef.current && e.streams[0]) {
              videoRef.current.srcObject = e.streams[0];
            }
          };

          await pc.setRemoteDescription(new RTCSessionDescription({ type: message.sdp_type, sdp: message.sdp }));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'answer',
                sdp: answer.sdp,
                sdp_type: answer.type
              })
            );
          }
        } else if (message.type === 'candidate') {
          if (pcRef.current && message.candidate) {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(message.candidate));
          }
        } else if (message.type === 'session_started') {
          setIsCurrentPlayer(true);
          setStatus('ROUND START! YOU ARE ON STAGE.');
        } else if (message.type === 'session_ended') {
          setIsCurrentPlayer(false);
          setInQueue(false);
          setStatus('TIME EXPIRED - YIELDING TURN');
        } else if (message.type === 'error') {
          setErrorMessage(message.message);
        }
      } catch (err) {
        console.error('Signaling processing error:', err);
      }
    };

    ws.onclose = () => {
      if (!isMounted) return;
      setStatus('DISCONNECTED FROM SERVER');
      setInQueue(false);
      setIsCurrentPlayer(false);
      pcRef.current?.close();
      pcRef.current = null;
    };

    ws.onerror = () => {
      if (!isMounted) return;
      setErrorMessage('Failed to connect to signaling server.');
      setStatus('SERVER OFFLINE');
    };

    return () => {
      isMounted = false;
      pcRef.current?.close();

      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, []);

  const joinQueue = () => {
    if (!playerName.trim()) {
      setErrorMessage('Enter challenger name!');
      return;
    }

    setErrorMessage(null);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'join_queue', playerName }));
      setInQueue(true);
      setStatus('WAITING IN QUEUE...');
    } else {
      setErrorMessage('Not connected to server.');
    }
  };

  const handleTouchStart = (code: string) => (e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    if (!isCurrentPlayer) return;
    if (!pressedKeys.current.has(code)) {
      pressedKeys.current.add(code);
      sendInput(code, 'keydown');
    }
  };

  const handleTouchEnd = (code: string) => (e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    if (!isCurrentPlayer) return;
    pressedKeys.current.delete(code);
    sendInput(code, 'keyup');
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div className="w-screen h-screen overflow-hidden bg-[#0a0a0c] text-[#00ffcc] font-mono flex flex-col items-center p-2 sm:p-4 select-none touch-none">
      {/* Marquee Header */}
      <div className="w-full max-w-4xl bg-gradient-to-b from-[#e60000] to-[#800000] border-2 sm:border-3 border-[#ffcc00] rounded-lg sm:rounded-xl p-1.5 sm:p-2 text-center shadow-[0_0_15px_#ff0000] shrink-0">
        <h1 className="m-0 text-base sm:text-2xl font-black tracking-widest text-white drop-shadow-[2px_2px_0_#000]">
          TEKKEN 7 ARCADE
        </h1>
        <div className="text-[10px] sm:text-xs text-[#ffcc00] font-bold mt-0.5 tracking-wider uppercase">
          {status}
        </div>
      </div>

      {/* Error Banner */}
      {errorMessage && (
        <div className="w-full max-w-4xl bg-[#ff0055] text-white text-xs px-3 py-1 rounded my-1 text-center font-bold shrink-0">
          {errorMessage}
        </div>
      )}

      {/* Main Cabinet Display & Queue View */}
      <div className="w-full max-w-4xl flex-1 grid grid-cols-1 md:grid-cols-4 gap-2 my-1.5 min-h-0 overflow-hidden">
        {/* Stream Frame */}
        <div className="md:col-span-3 relative bg-black border-2 sm:border-4 border-[#333] rounded-lg sm:rounded-xl overflow-hidden flex flex-col justify-between shadow-[0_0_20px_rgba(0,255,204,0.15)] h-full">
          <div className="flex justify-between items-center px-3 py-1 bg-[#111] border-b border-[#222] text-[10px] sm:text-xs text-[#00ffcc] shrink-0 z-10">
            <span>TIME: <strong className="text-white">{formatTime(timeLeft)}</strong></span>
            <span className="truncate max-w-[50%]">P1: <strong className="text-white">{activePlayerInfo ? activePlayerInfo.playerName : 'WAITING'}</strong></span>
          </div>

          <div className="relative flex-1 bg-[#050505] flex items-center justify-center overflow-hidden">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              disablePictureInPicture
              className="w-full h-full object-contain"
              onLoadedMetadata={(e) => {
                const video = e.currentTarget;
                video.play();
              }}
            />

            {!isCurrentPlayer && (
              <div className="absolute bottom-2 right-2 bg-black/80 px-2 py-1 rounded border border-[#ffcc00] text-[#ffcc00] text-[10px] sm:text-xs">
                <p className="m-0 font-bold uppercase">
                  {activePlayerInfo ? `${activePlayerInfo.playerName} IS PLAYING` : 'CABINET IS IDLE'}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Upcoming Challengers Sidebar */}
        <div className="hidden md:flex md:col-span-1 bg-[#111] border-2 border-[#222] rounded-lg sm:rounded-xl p-2.5 flex-col overflow-hidden">
          <h3 className="m-0 mb-2 text-[#ffcc00] text-xs font-bold border-b border-[#222] pb-1 shrink-0">
            CHALLENGERS ({queueList.length})
          </h3>
          <div className="flex-1 overflow-y-auto text-xs text-left">
            {queueList.length === 0 ? (
              <div className="text-[#888] text-[11px] italic">No challengers in line.</div>
            ) : (
              <ol className="m-0 pl-4 space-y-1">
                {queueList.map((player, idx) => (
                  <li key={player.id} className="text-white truncate">
                    {player.playerName} {idx === 0 ? <span className="text-[#00ffcc] font-bold">(NEXT)</span> : ''}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>

      {/* Coin/Queue Controls */}
      <div className="w-full max-w-4xl shrink-0 my-1">
        {!inQueue ? (
          <div className="flex gap-2 justify-center items-center">
            <input
              type="text"
              placeholder="ENTER CHALLENGER NAME"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              className="px-3 py-1.5 text-xs bg-[#1a1a1a] text-[#00ffcc] border-2 border-[#00ffcc] rounded focus:outline-none placeholder-[#00ffcc]/50 uppercase w-48 sm:w-64"
            />
            <button
              onClick={joinQueue}
              className="px-4 py-1.5 text-xs font-bold bg-[#ffcc00] text-black border-2 border-white rounded cursor-pointer shadow-[0_3px_0_#b38f00] active:translate-y-0.5 active:shadow-none uppercase"
            >
              INSERT COIN
            </button>
          </div>
        ) : (
          <div className="p-1.5 border border-dashed border-[#00ffcc] rounded text-center text-xs bg-[#111]/80">
            {isCurrentPlayer ? (
              <span className="text-[#00ff00] font-bold animate-pulse">YOU ARE ON THE STAGE!</span>
            ) : (
              <span>
                QUEUED! NEXT IN LINE. POSITION:{' '}
                <strong className="text-white">{queueList.findIndex((p) => p.playerName === playerName) + 1}</strong>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Control Deck */}
      <div className="w-full max-w-4xl bg-[#18181c] border-2 sm:border-3 border-[#333] rounded-xl sm:rounded-2xl p-2 sm:p-3 flex flex-col gap-2 shrink-0 shadow-2xl">
        <div className="flex flex-row justify-between items-center w-full px-2 sm:px-6">
          {/* D-Pad Controls */}
          <div className="flex flex-col items-center gap-1">
            <button
              onTouchStart={handleTouchStart('KeyW')}
              onTouchEnd={handleTouchEnd('KeyW')}
              onMouseDown={handleTouchStart('KeyW')}
              onMouseUp={handleTouchEnd('KeyW')}
              onMouseLeave={handleTouchEnd('KeyW')}
              className="w-10 h-10 sm:w-12 sm:h-12 bg-[#333] rounded-lg border-2 border-white font-bold text-sm text-white shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer active:bg-[#555]"
            >
              W
            </button>
            <div className="flex gap-1">
              <button
                onTouchStart={handleTouchStart('KeyA')}
                onTouchEnd={handleTouchEnd('KeyA')}
                onMouseDown={handleTouchStart('KeyA')}
                onMouseUp={handleTouchEnd('KeyA')}
                onMouseLeave={handleTouchEnd('KeyA')}
                className="w-10 h-10 sm:w-12 sm:h-12 bg-[#333] rounded-lg border-2 border-white font-bold text-sm text-white shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer active:bg-[#555]"
              >
                A
              </button>
              <button
                onTouchStart={handleTouchStart('KeyS')}
                onTouchEnd={handleTouchEnd('KeyS')}
                onMouseDown={handleTouchStart('KeyS')}
                onMouseUp={handleTouchEnd('KeyS')}
                onMouseLeave={handleTouchEnd('KeyS')}
                className="w-10 h-10 sm:w-12 sm:h-12 bg-[#333] rounded-lg border-2 border-white font-bold text-sm text-white shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer active:bg-[#555]"
              >
                S
              </button>
              <button
                onTouchStart={handleTouchStart('KeyD')}
                onTouchEnd={handleTouchEnd('KeyD')}
                onMouseDown={handleTouchStart('KeyD')}
                onMouseUp={handleTouchEnd('KeyD')}
                onMouseLeave={handleTouchEnd('KeyD')}
                className="w-10 h-10 sm:w-12 sm:h-12 bg-[#333] rounded-lg border-2 border-white font-bold text-sm text-white shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer active:bg-[#555]"
              >
                D
              </button>
            </div>
          </div>

          {/* Action Buttons Matrix */}
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-1.5 sm:gap-2">
              <button
                onTouchStart={handleTouchStart('KeyU')}
                onTouchEnd={handleTouchEnd('KeyU')}
                onMouseDown={handleTouchStart('KeyU')}
                onMouseUp={handleTouchEnd('KeyU')}
                onMouseLeave={handleTouchEnd('KeyU')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-white bg-[#e60000] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer"
              >
                U
              </button>
              <button
                onTouchStart={handleTouchStart('KeyI')}
                onTouchEnd={handleTouchEnd('KeyI')}
                onMouseDown={handleTouchStart('KeyI')}
                onMouseUp={handleTouchEnd('KeyI')}
                onMouseLeave={handleTouchEnd('KeyI')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-black bg-[#e6b800] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer"
              >
                I
              </button>
              <button
                onTouchStart={handleTouchStart('KeyO')}
                onTouchEnd={handleTouchEnd('KeyO')}
                onMouseDown={handleTouchStart('KeyO')}
                onMouseUp={handleTouchEnd('KeyO')}
                onMouseLeave={handleTouchEnd('KeyO')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-white bg-[#0066cc] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer"
              >
                O
              </button>
              <button
                onTouchStart={handleTouchStart('KeyP')}
                onTouchEnd={handleTouchEnd('KeyP')}
                onMouseDown={handleTouchStart('KeyP')}
                onMouseUp={handleTouchEnd('KeyP')}
                onMouseLeave={handleTouchEnd('KeyP')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-white bg-[#6600cc] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer"
              >
                P
              </button>
            </div>
            <div className="flex gap-1.5 sm:gap-2">
              <button
                onTouchStart={handleTouchStart('KeyJ')}
                onTouchEnd={handleTouchEnd('KeyJ')}
                onMouseDown={handleTouchStart('KeyJ')}
                onMouseUp={handleTouchEnd('KeyJ')}
                onMouseLeave={handleTouchEnd('KeyJ')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-white bg-[#009933] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer"
              >
                J
              </button>
              <button
                onTouchStart={handleTouchStart('KeyK')}
                onTouchEnd={handleTouchEnd('KeyK')}
                onMouseDown={handleTouchStart('KeyK')}
                onMouseUp={handleTouchEnd('KeyK')}
                onMouseLeave={handleTouchEnd('KeyK')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-white bg-[#cc0088] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer"
              >
                K
              </button>
              <button
                onTouchStart={handleTouchStart('KeyL')}
                onTouchEnd={handleTouchEnd('KeyL')}
                onMouseDown={handleTouchStart('KeyL')}
                onMouseUp={handleTouchEnd('KeyL')}
                onMouseLeave={handleTouchEnd('KeyL')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-white bg-[#ff6600] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer"
              >
                L
              </button>
              <button
                onTouchStart={handleTouchStart('Semicolon')}
                onTouchEnd={handleTouchEnd('Semicolon')}
                onMouseDown={handleTouchStart('Semicolon')}
                onMouseUp={handleTouchEnd('Semicolon')}
                onMouseLeave={handleTouchEnd('Semicolon')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-white bg-[#009999] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer"
              >
                ;
              </button>
            </div>
          </div>
        </div>

        {/* Utility Row */}
        <div className="flex justify-center flex-wrap gap-2 pt-1 border-t border-dashed border-[#333]">
          <button
            onTouchStart={handleTouchStart('KeyV')}
            onTouchEnd={handleTouchEnd('KeyV')}
            onMouseDown={handleTouchStart('KeyV')}
            onMouseUp={handleTouchEnd('KeyV')}
            onMouseLeave={handleTouchEnd('KeyV')}
            className="px-2.5 py-1 bg-[#2b2b2b] text-[#ccc] border border-[#555] rounded-full text-[10px] sm:text-xs font-bold cursor-pointer shadow-[0_2px_0_#111] active:translate-y-0.5 active:shadow-none"
          >
            V (VIEW)
          </button>
          <button
            onTouchStart={handleTouchStart('KeyB')}
            onTouchEnd={handleTouchEnd('KeyB')}
            onMouseDown={handleTouchStart('KeyB')}
            onMouseUp={handleTouchEnd('KeyB')}
            onMouseLeave={handleTouchEnd('KeyB')}
            className="px-2.5 py-1 bg-[#2b2b2b] text-[#ccc] border border-[#555] rounded-full text-[10px] sm:text-xs font-bold cursor-pointer shadow-[0_2px_0_#111] active:translate-y-0.5 active:shadow-none"
          >
            B (MENU)
          </button>
          <button
            onTouchStart={handleTouchStart('KeyC')}
            onTouchEnd={handleTouchEnd('KeyC')}
            onMouseDown={handleTouchStart('KeyC')}
            onMouseUp={handleTouchEnd('KeyC')}
            onMouseLeave={handleTouchEnd('KeyC')}
            className="px-2.5 py-1 bg-[#2b2b2b] text-[#ccc] border border-[#555] rounded-full text-[10px] sm:text-xs font-bold cursor-pointer shadow-[0_2px_0_#111] active:translate-y-0.5 active:shadow-none"
          >
            C (L3)
          </button>
          <button
            onTouchStart={handleTouchStart('KeyN')}
            onTouchEnd={handleTouchEnd('KeyN')}
            onMouseDown={handleTouchStart('KeyN')}
            onMouseUp={handleTouchEnd('KeyN')}
            onMouseLeave={handleTouchEnd('KeyN')}
            className="px-2.5 py-1 bg-[#2b2b2b] text-[#ccc] border border-[#555] rounded-full text-[10px] sm:text-xs font-bold cursor-pointer shadow-[0_2px_0_#111] active:translate-y-0.5 active:shadow-none"
          >
            N (R3)
          </button>
        </div>
      </div>
    </div>
  );
}