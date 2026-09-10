import { useState, useEffect, useRef, useCallback } from 'react';

const SIGNALING_URL = 'ws://localhost:8080';

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

  // Connect everyone as a viewer upon loading the page
  useEffect(() => {
    let isMounted = true;
    const ws = new WebSocket(SIGNALING_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      // Prevent state updates if component unmounted during socket handshakes
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
            ]
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

      // Only close if the socket is actively open or connecting
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
    e.preventDefault(); // Prevents touch scrolling/zooming while tapping buttons
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
    <div style={styles.container}>
      {/* Cabinet Header */}
      <div style={styles.marquee}>
        <h1 style={styles.marqueeText}>TEKKEN 7 ARCADE</h1>
        <div style={styles.statusDisplay}>{status}</div>
      </div>

      {errorMessage && <div style={styles.errorBox}>{errorMessage}</div>}

      {/* Main Screen Frame */}
      <div style={styles.screenFrame}>
        <div style={styles.timerBar}>
          <span>TIME REMAINING: <strong>{formatTime(timeLeft)}</strong></span>
          <span>P1: {activePlayerInfo ? activePlayerInfo.playerName : 'WAITING FOR CHALLENGER'}</span>
        </div>

        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={styles.videoStream}
        />

        {!isCurrentPlayer && (
          <div style={styles.overlay}>
            <p style={{ margin: 0, fontWeight: 'bold' }}>
              {activePlayerInfo ? `${activePlayerInfo.playerName} IS PLAYING` : 'CABINET IS IDLE'}
            </p>
          </div>
        )}
      </div>

      {/* Queue & Join Controls */}
      {!inQueue ? (
        <div style={styles.insertCoinSection}>
          <input
            type="text"
            placeholder="ENTER CHALLENGER NAME"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            style={styles.inputField}
          />
          <button onClick={joinQueue} style={styles.coinButton}>
            INSERT COIN / JOIN QUEUE
          </button>
        </div>
      ) : (
        <div style={styles.queueStatusBox}>
          {isCurrentPlayer ? (
            <span style={{ color: '#00ff00', fontWeight: 'bold' }}>YOU ARE ON THE STAGE!</span>
          ) : (
            <span>
              QUEUED! NEXT IN LINE. QUEUE POSITION: {' '}
              <strong>{queueList.findIndex((p) => p.playerName === playerName) + 1}</strong>
            </span>
          )}
        </div>
      )}

      {/* Arcade Physical Controls Section */}
      <div style={styles.controlDeck}>
        <div style={styles.controlDeckTop}>
          {/* D-PAD / Movement Controls */}
          <div style={styles.dpadContainer}>
            <div style={styles.dpadRow}>
              <button
                onTouchStart={handleTouchStart('KeyW')}
                onTouchEnd={handleTouchEnd('KeyW')}
                onMouseDown={handleTouchStart('KeyW')}
                onMouseUp={handleTouchEnd('KeyW')}
                onMouseLeave={handleTouchEnd('KeyW')}
                style={{ ...styles.arcadeBtn, ...styles.dpadBtn }}
              >
                W
              </button>
            </div>
            <div style={styles.dpadRow}>
              <button
                onTouchStart={handleTouchStart('KeyA')}
                onTouchEnd={handleTouchEnd('KeyA')}
                onMouseDown={handleTouchStart('KeyA')}
                onMouseUp={handleTouchEnd('KeyA')}
                onMouseLeave={handleTouchEnd('KeyA')}
                style={{ ...styles.arcadeBtn, ...styles.dpadBtn }}
              >
                A
              </button>
              <button
                onTouchStart={handleTouchStart('KeyS')}
                onTouchEnd={handleTouchEnd('KeyS')}
                onMouseDown={handleTouchStart('KeyS')}
                onMouseUp={handleTouchEnd('KeyS')}
                onMouseLeave={handleTouchEnd('KeyS')}
                style={{ ...styles.arcadeBtn, ...styles.dpadBtn }}
              >
                S
              </button>
              <button
                onTouchStart={handleTouchStart('KeyD')}
                onTouchEnd={handleTouchEnd('KeyD')}
                onMouseDown={handleTouchStart('KeyD')}
                onMouseUp={handleTouchEnd('KeyD')}
                onMouseLeave={handleTouchEnd('KeyD')}
                style={{ ...styles.arcadeBtn, ...styles.dpadBtn }}
              >
                D
              </button>
            </div>
          </div>

          {/* Action / Fight Buttons Layout */}
          <div style={styles.actionButtonsContainer}>
            <div style={styles.actionRow}>
              <button
                onTouchStart={handleTouchStart('KeyU')}
                onTouchEnd={handleTouchEnd('KeyU')}
                onMouseDown={handleTouchStart('KeyU')}
                onMouseUp={handleTouchEnd('KeyU')}
                onMouseLeave={handleTouchEnd('KeyU')}
                style={{ ...styles.arcadeBtn, ...styles.btnRed }}
              >
                U
              </button>
              <button
                onTouchStart={handleTouchStart('KeyI')}
                onTouchEnd={handleTouchEnd('KeyI')}
                onMouseDown={handleTouchStart('KeyI')}
                onMouseUp={handleTouchEnd('KeyI')}
                onMouseLeave={handleTouchEnd('KeyI')}
                style={{ ...styles.arcadeBtn, ...styles.btnYellow }}
              >
                I
              </button>
              <button
                onTouchStart={handleTouchStart('KeyO')}
                onTouchEnd={handleTouchEnd('KeyO')}
                onMouseDown={handleTouchStart('KeyO')}
                onMouseUp={handleTouchEnd('KeyO')}
                onMouseLeave={handleTouchEnd('KeyO')}
                style={{ ...styles.arcadeBtn, ...styles.btnBlue }}
              >
                O
              </button>
              <button
                onTouchStart={handleTouchStart('KeyP')}
                onTouchEnd={handleTouchEnd('KeyP')}
                onMouseDown={handleTouchStart('KeyP')}
                onMouseUp={handleTouchEnd('KeyP')}
                onMouseLeave={handleTouchEnd('KeyP')}
                style={{ ...styles.arcadeBtn, ...styles.btnPurple }}
              >
                P
              </button>
            </div>
            <div style={styles.actionRow}>
              <button
                onTouchStart={handleTouchStart('KeyJ')}
                onTouchEnd={handleTouchEnd('KeyJ')}
                onMouseDown={handleTouchStart('KeyJ')}
                onMouseUp={handleTouchEnd('KeyJ')}
                onMouseLeave={handleTouchEnd('KeyJ')}
                style={{ ...styles.arcadeBtn, ...styles.btnGreen }}
              >
                J
              </button>
              <button
                onTouchStart={handleTouchStart('KeyK')}
                onTouchEnd={handleTouchEnd('KeyK')}
                onMouseDown={handleTouchStart('KeyK')}
                onMouseUp={handleTouchEnd('KeyK')}
                onMouseLeave={handleTouchEnd('KeyK')}
                style={{ ...styles.arcadeBtn, ...styles.btnPink }}
              >
                K
              </button>
              <button
                onTouchStart={handleTouchStart('KeyL')}
                onTouchEnd={handleTouchEnd('KeyL')}
                onMouseDown={handleTouchStart('KeyL')}
                onMouseUp={handleTouchEnd('KeyL')}
                onMouseLeave={handleTouchEnd('KeyL')}
                style={{ ...styles.arcadeBtn, ...styles.btnOrange }}
              >
                L
              </button>
              <button
                onTouchStart={handleTouchStart('Semicolon')}
                onTouchEnd={handleTouchEnd('Semicolon')}
                onMouseDown={handleTouchStart('Semicolon')}
                onMouseUp={handleTouchEnd('Semicolon')}
                onMouseLeave={handleTouchEnd('Semicolon')}
                style={{ ...styles.arcadeBtn, ...styles.btnTeal }}
              >
                ;
              </button>
            </div>
          </div>
        </div>

        {/* System / Utility Buttons Row */}
        <div style={styles.utilityRow}>
          <button
            onTouchStart={handleTouchStart('KeyV')}
            onTouchEnd={handleTouchEnd('KeyV')}
            onMouseDown={handleTouchStart('KeyV')}
            onMouseUp={handleTouchEnd('KeyV')}
            onMouseLeave={handleTouchEnd('KeyV')}
            style={styles.utilityBtn}
          >
            V (VIEW)
          </button>
          <button
            onTouchStart={handleTouchStart('KeyB')}
            onTouchEnd={handleTouchEnd('KeyB')}
            onMouseDown={handleTouchStart('KeyB')}
            onMouseUp={handleTouchEnd('KeyB')}
            onMouseLeave={handleTouchEnd('KeyB')}
            style={styles.utilityBtn}
          >
            B (MENU)
          </button>
          <button
            onTouchStart={handleTouchStart('KeyC')}
            onTouchEnd={handleTouchEnd('KeyC')}
            onMouseDown={handleTouchStart('KeyC')}
            onMouseUp={handleTouchEnd('KeyC')}
            onMouseLeave={handleTouchEnd('KeyC')}
            style={styles.utilityBtn}
          >
            C (L3)
          </button>
          <button
            onTouchStart={handleTouchStart('KeyN')}
            onTouchEnd={handleTouchEnd('KeyN')}
            onMouseDown={handleTouchStart('KeyN')}
            onMouseUp={handleTouchEnd('KeyN')}
            onMouseLeave={handleTouchEnd('KeyN')}
            style={styles.utilityBtn}
          >
            N (R3)
          </button>
        </div>
      </div>

      {/* Queue Listing Display (Always Visible) */}
      <div style={styles.queueContainer}>
        <h3 style={{ margin: '0 0 10px 0', color: '#ffcc00' }}>UPCOMING CHALLENGERS ({queueList.length})</h3>
        {queueList.length === 0 ? (
          <div style={{ color: '#888' }}>No challengers in line. Insert coin to play!</div>
        ) : (
          <ol style={{ margin: 0, paddingLeft: '20px', textAlign: 'left' }}>
            {queueList.map((player, idx) => (
              <li key={player.id} style={{ padding: '4px 0', color: '#fff' }}>
                {player.playerName} {idx === 0 ? '(NEXT)' : ''}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '15px',
    fontFamily: '"Courier New", Courier, monospace',
    textAlign: 'center',
    backgroundColor: '#0a0a0c',
    color: '#00ffcc',
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    boxSizing: 'border-box',
  },
  marquee: {
    background: 'linear-gradient(180deg, #e60000 0%, #800000 100%)',
    border: '3px solid #ffcc00',
    borderRadius: '12px',
    padding: '10px 20px',
    width: '100%',
    maxWidth: '800px',
    boxShadow: '0 0 15px #ff0000',
    marginBottom: '15px',
  },
  marqueeText: {
    margin: 0,
    fontSize: '28px',
    letterSpacing: '3px',
    color: '#fff',
    textShadow: '2px 2px #000',
  },
  statusDisplay: {
    fontSize: '14px',
    color: '#ffcc00',
    marginTop: '5px',
    fontWeight: 'bold',
  },
  errorBox: {
    backgroundColor: '#ff0055',
    color: '#fff',
    padding: '8px 16px',
    borderRadius: '6px',
    marginBottom: '10px',
    fontWeight: 'bold',
  },
  screenFrame: {
    position: 'relative',
    width: '100%',
    maxWidth: '800px',
    backgroundColor: '#000',
    border: '4px solid #333',
    borderRadius: '12px',
    overflow: 'hidden',
    boxShadow: '0 0 20px rgba(0, 255, 204, 0.2)',
  },
  timerBar: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 15px',
    backgroundColor: '#111',
    borderBottom: '2px solid #222',
    fontSize: '13px',
    color: '#00ffcc',
  },
  videoStream: {
    width: '100%',
    aspectRatio: '16/9',
    backgroundColor: '#050505',
    display: 'block',
  },
  overlay: {
    position: 'absolute',
    bottom: '10px',
    right: '10px',
    backgroundColor: 'rgba(0,0,0,0.7)',
    padding: '6px 12px',
    borderRadius: '4px',
    border: '1px solid #ffcc00',
    color: '#ffcc00',
    fontSize: '12px',
  },
  insertCoinSection: {
    marginTop: '15px',
    display: 'flex',
    gap: '10px',
    justifyContent: 'center',
    width: '100%',
    maxWidth: '800px',
    flexWrap: 'wrap',
  },
  inputField: {
    padding: '10px 14px',
    fontSize: '14px',
    fontFamily: 'inherit',
    backgroundColor: '#1a1a1a',
    color: '#00ffcc',
    border: '2px solid #00ffcc',
    borderRadius: '6px',
    outline: 'none',
  },
  coinButton: {
    padding: '10px 20px',
    fontSize: '14px',
    fontWeight: 'bold',
    fontFamily: 'inherit',
    backgroundColor: '#ffcc00',
    color: '#000',
    border: '2px solid #fff',
    borderRadius: '6px',
    cursor: 'pointer',
    boxShadow: '0 4px 0 #b38f00',
  },
  queueStatusBox: {
    marginTop: '15px',
    padding: '10px',
    border: '1px dashed #00ffcc',
    borderRadius: '6px',
    width: '100%',
    maxWidth: '800px',
    boxSizing: 'border-box',
  },
  controlDeck: {
    marginTop: '20px',
    width: '100%',
    maxWidth: '800px',
    backgroundColor: '#18181c',
    border: '3px solid #333',
    borderRadius: '16px',
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
    boxSizing: 'border-box',
    touchAction: 'none'
  },
  controlDeckTop: {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%'
  },
  dpadContainer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '5px'
  },
  dpadRow: {
    display: 'flex',
    gap: '5px',
  },
  actionButtonsContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  actionRow: {
    display: 'flex',
    gap: '10px',
  },
  utilityRow: {
    display: 'flex',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: '15px',
    paddingTop: '15px',
    borderTop: '2px dashed #333'
  },
  arcadeBtn: {
    width: '55px',
    height: '55px',
    borderRadius: '50%',
    border: '3px solid #fff',
    fontWeight: 'bold',
    fontSize: '18px',
    cursor: 'pointer',
    userSelect: 'none',
    touchAction: 'none',
    boxShadow: '0 5px 0 rgba(0,0,0,0.5)',
    color: '#fff',
    textShadow: '1px 1px #000',
  },
  dpadBtn: {
    backgroundColor: '#333',
    borderRadius: '8px',
    width: '50px',
    height: '50px',
  },
  utilityBtn: {
    padding: '8px 12px',
    backgroundColor: '#2b2b2b',
    color: '#ccc',
    border: '2px solid #555',
    borderRadius: '15px',
    fontSize: '12px',
    fontWeight: 'bold',
    cursor: 'pointer',
    userSelect: 'none',
    touchAction: 'none',
    boxShadow: '0 3px 0 #111',
  },
  btnRed: { backgroundColor: '#e60000' },
  btnYellow: { backgroundColor: '#e6b800', color: '#000' },
  btnBlue: { backgroundColor: '#0066cc' },
  btnPurple: { backgroundColor: '#6600cc' },
  btnGreen: { backgroundColor: '#009933' },
  btnPink: { backgroundColor: '#cc0088' },
  btnOrange: { backgroundColor: '#ff6600' },
  btnTeal: { backgroundColor: '#009999' },
  queueContainer: {
    marginTop: '20px',
    width: '100%',
    maxWidth: '800px',
    backgroundColor: '#111',
    border: '2px solid #222',
    borderRadius: '8px',
    padding: '15px',
    boxSizing: 'border-box',
  },
};