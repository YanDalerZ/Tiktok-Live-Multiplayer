import express, { type Express } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ExtendedWebSocket extends WebSocket {
    isAlive?: boolean;
    id?: string;
    playerName?: string;
}

interface QueuePlayer {
    id: string;
    playerName: string;
    ws: ExtendedWebSocket;
}

const app: Express = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const frontendDistPath = path.resolve(__dirname, '../../Frontend/dist');
app.use(express.static(frontendDistPath));

let hostSocket: ExtendedWebSocket | null = null;
let activePlayer: QueuePlayer | null = null;
const playerQueue: QueuePlayer[] = [];
let matchTimer: NodeJS.Timeout | null = null;
let timerSecondsRemaining = 120;
let timerInterval: NodeJS.Timeout | null = null;

const MATCH_DURATION_SECONDS = 120;

app.get('/health', (_req, res) => {
    res.json({
        status: 'online',
        hostConnected: !!(hostSocket && hostSocket.readyState === WebSocket.OPEN),
        activePlayer: activePlayer ? activePlayer.playerName : null,
        queueLength: playerQueue.length,
    });
});

const broadcastQueueUpdate = () => {
    const queueData = {
        type: 'queue_update',
        activePlayer: activePlayer ? { id: activePlayer.id, playerName: activePlayer.playerName } : null,
        queue: playerQueue.map((p) => ({ id: p.id, playerName: p.playerName })),
        timeRemaining: timerSecondsRemaining,
        hostOnline: !!(hostSocket && hostSocket.readyState === WebSocket.OPEN),
    };

    const payload = JSON.stringify(queueData);

    wss.clients.forEach((client: ExtendedWebSocket) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
};

const stopMatchTimer = () => {
    if (matchTimer) {
        clearTimeout(matchTimer);
        matchTimer = null;
    }
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    timerSecondsRemaining = MATCH_DURATION_SECONDS;
};

const startNextMatch = () => {
    stopMatchTimer();

    if (activePlayer && activePlayer.ws.readyState === WebSocket.OPEN) {
        activePlayer.ws.send(JSON.stringify({ type: 'session_ended', message: 'Time limit reached! Yielding turn.' }));
    }

    if (playerQueue.length > 0) {
        activePlayer = playerQueue.shift()!;
        timerSecondsRemaining = MATCH_DURATION_SECONDS;

        activePlayer.ws.send(JSON.stringify({ type: 'session_started', role: 'guest' }));

        timerInterval = setInterval(() => {
            timerSecondsRemaining -= 1;
            broadcastQueueUpdate();
        }, 1000);

        matchTimer = setTimeout(() => {
            startNextMatch();
        }, MATCH_DURATION_SECONDS * 1000);
    } else {
        activePlayer = null;
    }

    broadcastQueueUpdate();
};

const interval = setInterval(() => {
    wss.clients.forEach((ws: ExtendedWebSocket) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(interval));

wss.on('connection', (ws: ExtendedWebSocket) => {
    ws.isAlive = true;
    ws.id = Math.random().toString(36).substring(2, 9);

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (message: Buffer) => {
        try {
            const rawMessage = message.toString();
            const data = JSON.parse(rawMessage);

            if (data.type === 'register_host') {
                if (hostSocket && hostSocket !== ws && hostSocket.readyState === WebSocket.OPEN) {
                    hostSocket.close(1000, 'Replaced by new host instance');
                }
                hostSocket = ws;
                console.log(`[Server] Python Host connected and registered. Socket ID: ${ws.id}`);
                ws.send(JSON.stringify({ type: 'registered', role: 'host' }));

                wss.clients.forEach((client: ExtendedWebSocket) => {
                    if (client !== hostSocket && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'host_connected' }));
                    }
                });

                broadcastQueueUpdate();
            }

            else if (data.type === 'request_stream') {
                console.log(`[Server] Viewer ${ws.id} requested WebRTC stream.`);
                if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
                    hostSocket.send(JSON.stringify({
                        type: 'viewer_joined',
                        viewerId: ws.id
                    }));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Host stream is currently offline.' }));
                }
            }

            else if (data.type === 'join_queue') {
                const playerName = data.playerName?.trim() || `Player_${ws.id?.substring(0, 4)}`;
                ws.playerName = playerName;

                const newPlayer: QueuePlayer = { id: ws.id!, playerName, ws };

                if (!activePlayer) {
                    activePlayer = newPlayer;
                    console.log(`[Server] Player ${playerName} (${ws.id}) took active control.`);
                    ws.send(JSON.stringify({ type: 'session_started', role: 'guest' }));

                    timerSecondsRemaining = MATCH_DURATION_SECONDS;
                    timerInterval = setInterval(() => {
                        timerSecondsRemaining -= 1;
                        broadcastQueueUpdate();
                    }, 1000);

                    matchTimer = setTimeout(() => {
                        startNextMatch();
                    }, MATCH_DURATION_SECONDS * 1000);
                } else {
                    playerQueue.push(newPlayer);
                    console.log(`[Server] Player ${playerName} (${ws.id}) added to queue at position ${playerQueue.length}.`);
                    ws.send(JSON.stringify({ type: 'queued', position: playerQueue.length }));
                }

                broadcastQueueUpdate();
            }

            else if (data.type === 'input_event') {
                if (activePlayer && activePlayer.ws === ws && hostSocket && hostSocket.readyState === WebSocket.OPEN) {
                    hostSocket.send(rawMessage);
                }
            }

            else if (data.type === 'offer' || (data.type === 'candidate' && ws === hostSocket)) {
                const targetId = data.targetViewerId;
                wss.clients.forEach((client: ExtendedWebSocket) => {
                    if (client.id === targetId && client.readyState === WebSocket.OPEN) {
                        client.send(rawMessage);
                    }
                });
            }

            else if (data.type === 'answer' || (data.type === 'candidate' && ws !== hostSocket)) {
                if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
                    const payload = { ...data, viewerId: ws.id };
                    hostSocket.send(JSON.stringify(payload));
                }
            }

        } catch (err) {
            console.error('[Server] Failed to process incoming message:', err);
        }
    });

    ws.on('close', () => {
        if (ws === hostSocket) {
            console.log('[Server] Host disconnected.');
            hostSocket = null;
            stopMatchTimer();
            if (activePlayer && activePlayer.ws.readyState === WebSocket.OPEN) {
                activePlayer.ws.send(JSON.stringify({ type: 'error', message: 'Host connection lost.' }));
            }
            activePlayer = null;
            playerQueue.length = 0;
            broadcastQueueUpdate();
        } else {
            if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
                hostSocket.send(JSON.stringify({ type: 'viewer_left', viewerId: ws.id }));
            }

            if (activePlayer && activePlayer.ws === ws) {
                console.log(`[Server] Active player ${ws.playerName} disconnected.`);
                startNextMatch();
            } else {
                const idx = playerQueue.findIndex((p) => p.ws === ws);
                if (idx !== -1) {
                    console.log(`[Server] Queue player ${ws.playerName} left queue.`);
                    playerQueue.splice(idx, 1);
                    broadcastQueueUpdate();
                }
            }
        }
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDistPath, 'index.html'));
});

const PORT: number = Number(process.env.PORT) || 8080;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Monolith server running on http://0.0.0.0:${PORT}`);
});