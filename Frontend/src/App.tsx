import { useState, useEffect, useRef, useCallback } from 'react';

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

type DPadMode = 'buttons' | 'joystick';

export default function App() {
  const [playerName, setPlayerName] = useState('');
  const [inQueue, setInQueue] = useState(false);
  const [isCurrentPlayer, setIsCurrentPlayer] = useState(false);
  const [status, setStatus] = useState('CONNECTING TO SERVER...');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [activePlayerInfo, setActivePlayerInfo] = useState<QueuePlayerInfo | null>(null);
  const [queueList, setQueueList] = useState<QueuePlayerInfo[]>([]);
  const [timeLeft, setTimeLeft] = useState<number>(120);

  const [dPadMode, setDPadMode] = useState<DPadMode>('buttons');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const candidateQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const pressedKeys = useRef<Set<string>>(new Set());

  const joystickBaseRef = useRef<HTMLDivElement | null>(null);
  const [joystickPos, setJoystickPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const isDraggingJoystick = useRef(false);
  const joystickTouchIdRef = useRef<number | null>(null);

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

  const requestVideoStream = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'request_stream' }));
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    const ws = new WebSocket(SIGNALING_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!isMounted) return;
      setStatus('INSERT COIN TO PLAY');
      requestVideoStream();
    };

    ws.onmessage = async (event) => {
      if (!isMounted) return;
      try {
        const message = JSON.parse(event.data);

        if (message.type === 'queue_update') {
          setActivePlayerInfo(message.activePlayer);
          setQueueList(message.queue);
          setTimeLeft(message.timeRemaining);
        } else if (message.type === 'host_connected') {
          requestVideoStream();
        } else if (message.type === 'offer') {
          if (pcRef.current) {
            pcRef.current.close();
            pcRef.current = null;
          }

          candidateQueueRef.current = [];

          // Updated RTCPeerConnection to include TURN Server Relays for cross-network WebRTC traversal
          const pc = new RTCPeerConnection({
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' },
              {
                urls: `turn:${window.location.hostname}:3478`,
                username: 'myuser',
                credential: 'MyStrongPassword123!'
              }
            ],
            bundlePolicy: 'max-bundle'
          });
          pcRef.current = pc;

          pc.onicecandidate = (e) => {
            if (e.candidate && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'candidate', candidate: e.candidate.toJSON() }));
            }
          };

          pc.ontrack = (e) => {
            if (videoRef.current) {
              const stream = (e.streams && e.streams[0]) ? e.streams[0] : new MediaStream([e.track]);
              videoRef.current.srcObject = stream;
              videoRef.current.play().catch((err) => {
                console.warn('Autoplay prevented, retrying on user click:', err);
              });
            }
          };

          const remoteSdpType = message.sdp_type || message.type || 'offer';
          await pc.setRemoteDescription(new RTCSessionDescription({ type: remoteSdpType, sdp: message.sdp }));

          while (candidateQueueRef.current.length > 0) {
            const cand = candidateQueueRef.current.shift();
            if (cand) {
              await pc.addIceCandidate(new RTCIceCandidate(cand));
            }
          }

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
          if (message.candidate) {
            if (pcRef.current && pcRef.current.remoteDescription && pcRef.current.remoteDescription.type) {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(message.candidate));
            } else {
              candidateQueueRef.current.push(message.candidate);
            }
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
  }, [requestVideoStream]);

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

  const handlePressStart = useCallback((code: string) => {
    if (!isCurrentPlayer) return;
    if (!pressedKeys.current.has(code)) {
      pressedKeys.current.add(code);
      sendInput(code, 'keydown');
    }
  }, [isCurrentPlayer, sendInput]);

  const handlePressEnd = useCallback((code: string) => {
    if (!isCurrentPlayer) return;
    if (pressedKeys.current.has(code)) {
      pressedKeys.current.delete(code);
      sendInput(code, 'keyup');
    }
  }, [isCurrentPlayer, sendInput]);

  const createInputHandlers = useCallback((code: string) => {
    return {
      onTouchStart: (e: React.TouchEvent) => {
        e.preventDefault();
        handlePressStart(code);
      },
      onTouchEnd: (e: React.TouchEvent) => {
        e.preventDefault();
        handlePressEnd(code);
      },
      onMouseDown: (e: React.MouseEvent) => {
        if ('ontouchstart' in window) return;
        e.preventDefault();
        handlePressStart(code);
      },
      onMouseUp: (e: React.MouseEvent) => {
        if ('ontouchstart' in window) return;
        e.preventDefault();
        handlePressEnd(code);
      },
      onMouseLeave: (e: React.MouseEvent) => {
        if ('ontouchstart' in window) return;
        e.preventDefault();
        handlePressEnd(code);
      }
    };
  }, [handlePressStart, handlePressEnd]);

  const updateJoystickPosition = useCallback((clientX: number, clientY: number) => {
    if (!joystickBaseRef.current || !isCurrentPlayer) return;

    const rect = joystickBaseRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const deltaX = clientX - centerX;
    const deltaY = clientY - centerY;
    const distance = Math.hypot(deltaX, deltaY);

    const maxRadius = rect.width / 2 - 10;
    const clampedDistance = Math.min(distance, maxRadius);
    const angle = Math.atan2(deltaY, deltaX);

    const knobX = Math.cos(angle) * clampedDistance;
    const knobY = Math.sin(angle) * clampedDistance;

    setJoystickPos({ x: knobX, y: knobY });

    const threshold = 12;
    const activeDirections = {
      KeyW: false,
      KeyS: false,
      KeyA: false,
      KeyD: false
    };

    if (clampedDistance > threshold) {
      const deg = (angle * 180) / Math.PI;

      if (deg > -135 && deg < -45) activeDirections.KeyW = true;
      if (deg > 45 && deg < 135) activeDirections.KeyS = true;
      if (deg > 135 || deg < -135) activeDirections.KeyA = true;
      if (deg > -45 && deg < 45) activeDirections.KeyD = true;
    }

    (['KeyW', 'KeyS', 'KeyA', 'KeyD'] as const).forEach((code) => {
      if (activeDirections[code]) {
        if (!pressedKeys.current.has(code)) {
          pressedKeys.current.add(code);
          sendInput(code, 'keydown');
        }
      } else {
        if (pressedKeys.current.has(code)) {
          pressedKeys.current.delete(code);
          sendInput(code, 'keyup');
        }
      }
    });
  }, [isCurrentPlayer, sendInput]);

  const resetJoystick = useCallback(() => {
    isDraggingJoystick.current = false;
    joystickTouchIdRef.current = null;
    setJoystickPos({ x: 0, y: 0 });

    (['KeyW', 'KeyS', 'KeyA', 'KeyD'] as const).forEach((code) => {
      if (pressedKeys.current.has(code)) {
        pressedKeys.current.delete(code);
        sendInput(code, 'keyup');
      }
    });
  }, [sendInput]);

  const handleJoystickTouchStart = (e: React.TouchEvent) => {
    if (!isCurrentPlayer || isDraggingJoystick.current) return;
    const touch = e.changedTouches[0];
    if (!touch) return;

    isDraggingJoystick.current = true;
    joystickTouchIdRef.current = touch.identifier;
    updateJoystickPosition(touch.clientX, touch.clientY);
  };

  const handleJoystickMouseDown = (e: React.MouseEvent) => {
    if ('ontouchstart' in window || !isCurrentPlayer) return;
    e.preventDefault();
    isDraggingJoystick.current = true;
    updateJoystickPosition(e.clientX, e.clientY);
  };

  useEffect(() => {
    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (!isDraggingJoystick.current) return;

      if ('touches' in e) {
        for (let i = 0; i < e.touches.length; i++) {
          const touch = e.touches[i];
          if (touch.identifier === joystickTouchIdRef.current) {
            updateJoystickPosition(touch.clientX, touch.clientY);
            break;
          }
        }
      } else if ('clientX' in e) {
        updateJoystickPosition(e.clientX, e.clientY);
      }
    };

    const handleEnd = (e: MouseEvent | TouchEvent) => {
      if (!isDraggingJoystick.current) return;

      if ('changedTouches' in e) {
        for (let i = 0; i < e.changedTouches.length; i++) {
          if (e.changedTouches[i].identifier === joystickTouchIdRef.current) {
            resetJoystick();
            break;
          }
        }
      } else {
        resetJoystick();
      }
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleEnd);
    window.addEventListener('touchmove', handleMove, { passive: false });
    window.addEventListener('touchend', handleEnd);
    window.addEventListener('touchcancel', handleEnd);

    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleEnd);
      window.removeEventListener('touchcancel', handleEnd);
    };
  }, [updateJoystickPosition, resetJoystick]);

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div className="min-h-screen w-full bg-[#0a0a0c] text-[#00ffcc] font-mono flex flex-col items-center p-2 sm:p-4 overflow-y-auto">
      <div className="w-full max-w-4xl bg-gradient-to-b from-[#e60000] to-[#800000] border-2 sm:border-3 border-[#ffcc00] rounded-lg sm:rounded-xl p-1.5 sm:p-2 text-center shadow-[0_0_15px_#ff0000] shrink-0">
        <h1 className="m-0 text-base sm:text-2xl font-black tracking-widest text-white drop-shadow-[2px_2px_0_#000]">
          TEKKEN 7 ARCADE TIKTOK LIVE MULTIPLAYER
        </h1>
        <div className="text-[10px] sm:text-xs text-[#ffcc00] font-bold mt-0.5 tracking-wider uppercase">
          {status}
        </div>
      </div>

      {errorMessage && (
        <div className="w-full max-w-4xl bg-[#ff0055] text-white text-xs px-3 py-1 rounded my-1 text-center font-bold shrink-0">
          {errorMessage}
        </div>
      )}

      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-4 gap-2 my-1.5 min-h-[300px]">
        <div className="md:col-span-3 relative bg-black border-2 sm:border-4 border-[#333] rounded-lg sm:rounded-xl overflow-hidden flex flex-col justify-between shadow-[0_0_20px_rgba(0,255,204,0.15)] min-h-[250px]">
          <div className="flex justify-between items-center px-3 py-1 bg-[#111] border-b border-[#222] text-[10px] sm:text-xs text-[#00ffcc] shrink-0 z-10">
            <span>TIME: <strong className="text-white">{formatTime(timeLeft)}</strong></span>
            <span className="truncate max-w-[50%]">P1: <strong className="text-white">{activePlayerInfo ? activePlayerInfo.playerName : 'WAITING'}</strong></span>
          </div>

          <div className="relative flex-1 bg-[#050505] flex items-center justify-center overflow-hidden min-h-[200px]">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              disablePictureInPicture
              className="w-full h-full object-contain"
              onClick={() => {
                if (videoRef.current) {
                  videoRef.current.play().catch(() => { });
                }
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

        <div className="hidden md:flex md:col-span-1 bg-[#111] border-2 border-[#222] rounded-lg sm:rounded-xl p-2.5 flex-col max-h-[400px]">
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

      <div className="w-full max-w-4xl bg-[#18181c] border-2 sm:border-3 border-[#333] rounded-xl sm:rounded-2xl p-2 sm:p-3 flex flex-col gap-2 shrink-0 shadow-2xl my-2">
        <div className="flex justify-center items-center gap-2 pb-1 border-b border-[#222]">
          <span className="text-[10px] sm:text-xs text-[#888] uppercase font-bold">STICK MODE:</span>
          <div className="flex bg-[#0d0d10] p-0.5 rounded-lg border border-[#333]">
            <button
              onClick={() => setDPadMode('buttons')}
              className={`px-3 py-0.5 text-[10px] font-bold rounded uppercase cursor-pointer transition-colors ${dPadMode === 'buttons' ? 'bg-[#00ffcc] text-black' : 'text-[#888] hover:text-white'
                }`}
            >
              WASD
            </button>
            <button
              onClick={() => setDPadMode('joystick')}
              className={`px-3 py-0.5 text-[10px] font-bold rounded uppercase cursor-pointer transition-colors ${dPadMode === 'joystick' ? 'bg-[#00ffcc] text-black' : 'text-[#888] hover:text-white'
                }`}
            >
              JOYSTICK
            </button>
          </div>
        </div>

        <div className="flex flex-row justify-between items-center w-full px-2 sm:px-6 gap-2">
          <div className="flex items-center gap-3">
            {dPadMode === 'buttons' ? (
              <div className="flex flex-col items-center gap-1">
                <button
                  style={{ touchAction: 'manipulation' }}
                  {...createInputHandlers('KeyW')}
                  className="w-10 h-10 sm:w-12 sm:h-12 bg-[#333] rounded-lg border-2 border-white font-bold text-sm text-white shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer active:bg-[#555] select-none"
                >
                  W
                </button>
                <div className="flex gap-1">
                  <button
                    style={{ touchAction: 'manipulation' }}
                    {...createInputHandlers('KeyA')}
                    className="w-10 h-10 sm:w-12 sm:h-12 bg-[#333] rounded-lg border-2 border-white font-bold text-sm text-white shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer active:bg-[#555] select-none"
                  >
                    A
                  </button>
                  <button
                    style={{ touchAction: 'manipulation' }}
                    {...createInputHandlers('KeyS')}
                    className="w-10 h-10 sm:w-12 sm:h-12 bg-[#333] rounded-lg border-2 border-white font-bold text-sm text-white shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer active:bg-[#555] select-none"
                  >
                    S
                  </button>
                  <button
                    style={{ touchAction: 'manipulation' }}
                    {...createInputHandlers('KeyD')}
                    className="w-10 h-10 sm:w-12 sm:h-12 bg-[#333] rounded-lg border-2 border-white font-bold text-sm text-white shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer active:bg-[#555] select-none"
                  >
                    D
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <div
                  ref={joystickBaseRef}
                  style={{ touchAction: 'none' }}
                  onContextMenu={(e) => e.preventDefault()}
                  onMouseDown={handleJoystickMouseDown}
                  onTouchStart={handleJoystickTouchStart}
                  className="relative w-28 h-28 sm:w-32 sm:h-32 bg-[#111] rounded-full border-4 border-[#333] flex items-center justify-center shadow-inner cursor-grab active:cursor-grabbing select-none"
                >
                  <div className="absolute inset-2 border border-dashed border-[#222] rounded-full pointer-events-none" />
                  <span className="absolute top-1 text-[9px] text-[#444] font-bold pointer-events-none">W</span>
                  <span className="absolute bottom-1 text-[9px] text-[#444] font-bold pointer-events-none">S</span>
                  <span className="absolute left-1 text-[9px] text-[#444] font-bold pointer-events-none">A</span>
                  <span className="absolute right-1 text-[9px] text-[#444] font-bold pointer-events-none">D</span>

                  <div
                    className="absolute w-12 h-12 sm:w-14 sm:h-14 bg-gradient-to-tr from-[#cc0000] via-[#ff3333] to-[#ff9999] rounded-full border-2 border-white shadow-[0_4px_10px_rgba(0,0,0,0.8)] flex items-center justify-center transition-transform duration-75 ease-out pointer-events-none"
                    style={{
                      transform: `translate(${joystickPos.x}px, ${joystickPos.y}px)`
                    }}
                  >
                    <div className="w-4 h-4 bg-white/40 rounded-full" />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex gap-1.5 sm:gap-2">
              <button
                style={{ touchAction: 'manipulation' }}
                {...createInputHandlers('KeyU')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-white bg-[#e60000] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer select-none"
              >
                U
              </button>
              <button
                style={{ touchAction: 'manipulation' }}
                {...createInputHandlers('KeyI')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-black bg-[#e6b800] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer select-none"
              >
                I
              </button>
              <button
                style={{ touchAction: 'manipulation' }}
                {...createInputHandlers('KeyO')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-white bg-[#0066cc] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer select-none"
              >
                O
              </button>
              <button
                style={{ touchAction: 'manipulation' }}
                {...createInputHandlers('KeyP')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-white bg-[#6600cc] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer select-none"
              >
                P
              </button>
            </div>
            <div className="flex gap-1.5 sm:gap-2">
              <button
                style={{ touchAction: 'manipulation' }}
                {...createInputHandlers('KeyJ')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-white bg-[#009933] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer select-none"
              >
                J
              </button>
              <button
                style={{ touchAction: 'manipulation' }}
                {...createInputHandlers('KeyK')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-white bg-[#cc0088] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer select-none"
              >
                K
              </button>
              <button
                style={{ touchAction: 'manipulation' }}
                {...createInputHandlers('KeyL')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-white bg-[#ff6600] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer select-none"
              >
                L
              </button>
              <button
                style={{ touchAction: 'manipulation' }}
                {...createInputHandlers('Semicolon')}
                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full border-2 border-white font-bold text-sm text-white bg-[#009999] shadow-[0_4px_0_rgba(0,0,0,0.5)] active:translate-y-1 active:shadow-none flex items-center justify-center cursor-pointer select-none"
              >
                ;
              </button>
            </div>
          </div>
        </div>

        <div className="flex justify-center flex-wrap gap-2 pt-1 border-t border-dashed border-[#333]">
          <button
            style={{ touchAction: 'manipulation' }}
            {...createInputHandlers('KeyV')}
            className="px-2.5 py-1 bg-[#2b2b2b] text-[#ccc] border border-[#555] rounded-full text-[10px] sm:text-xs font-bold cursor-pointer shadow-[0_2px_0_#111] active:translate-y-0.5 active:shadow-none select-none"
          >
            V (SELECT)
          </button>
          <button
            style={{ touchAction: 'manipulation' }}
            {...createInputHandlers('KeyB')}
            className="px-2.5 py-1 bg-[#2b2b2b] text-[#ccc] border border-[#555] rounded-full text-[10px] sm:text-xs font-bold cursor-pointer shadow-[0_2px_0_#111] active:translate-y-0.5 active:shadow-none select-none"
          >
            B (START)
          </button>
          <button
            style={{ touchAction: 'manipulation' }}
            {...createInputHandlers('KeyC')}
            className="px-2.5 py-1 bg-[#2b2b2b] text-[#ccc] border border-[#555] rounded-full text-[10px] sm:text-xs font-bold cursor-pointer shadow-[0_2px_0_#111] active:translate-y-0.5 active:shadow-none select-none"
          >
            C (L3)
          </button>
          <button
            style={{ touchAction: 'manipulation' }}
            {...createInputHandlers('KeyN')}
            className="px-2.5 py-1 bg-[#2b2b2b] text-[#ccc] border border-[#555] rounded-full text-[10px] sm:text-xs font-bold cursor-pointer shadow-[0_2px_0_#111] active:translate-y-0.5 active:shadow-none select-none"
          >
            N (R3)
          </button>
        </div>
      </div>
    </div>
  );
}