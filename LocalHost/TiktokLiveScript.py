import asyncio
import json
import threading
import queue
import time
import ctypes
from ctypes import wintypes
import tkinter as tk
from tkinter import ttk
import cv2
import numpy as np
import websockets
import pygetwindow as gw
from fractions import Fraction

from windows_capture import WindowsCapture
from aiortc import (
    RTCPeerConnection,
    RTCSessionDescription,
    RTCIceCandidate,
    VideoStreamTrack,
    RTCConfiguration,
    RTCIceServer,
)
from aiortc.rtcrtpsender import RTCRtpSender
from av import VideoFrame

# Direct Production Configuration
SIGNALING_SERVER_URL = "wss://tiktok-live-multiplayer.onrender.com"
print(f"[Config] Connecting directly to Production Signaling Endpoint: {SIGNALING_SERVER_URL}")

TARGET_FPS = 60
FRAME_INTERVAL = 1.0 / TARGET_FPS
STREAM_WIDTH = 1280
STREAM_HEIGHT = 720

# Robust STUN/TURN ICE Configuration for universal cross-network WebRTC traversal
rtc_config = RTCConfiguration(
    iceServers=[
        RTCIceServer(urls=["stun:stun.l.google.com:19302"]),
        RTCIceServer(urls=["stun:stun1.l.google.com:19302"]),
        RTCIceServer(
            urls=["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turn:openrelay.metered.ca:443?transport=tcp"],
            username="openrelayproject",
            credential="openrelayproject"
        ),
        RTCIceServer(
            urls=["turn:openrelay.metered.ca:443?transport=tcp"],
            username="openrelayproject",
            credential="openrelayproject"
        )
    ]
)

KEY_SCANCODES = {
    "KeyW": 0x11, "KeyS": 0x1F, "KeyA": 0x1E, "KeyD": 0x20,
    "KeyU": 0x16, "KeyI": 0x17, "KeyO": 0x18, "KeyP": 0x19,
    "KeyJ": 0x24, "KeyK": 0x25, "KeyL": 0x26, "Semicolon": 0x27,
    "KeyB": 0x30, "KeyV": 0x2F, "KeyC": 0x2E, "KeyN": 0x31,
}

user32 = ctypes.WinDLL('user32', use_last_error=True)
wintypes.ULONG_PTR = wintypes.WPARAM
user32.GetForegroundWindow.restype = wintypes.HWND
user32.SetForegroundWindow.argtypes = [wintypes.HWND]

class MOUSEINPUT(ctypes.Structure):
    _fields_ = (
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", wintypes.ULONG_PTR),
    )

class KEYBDINPUT(ctypes.Structure):
    _fields_ = (
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", wintypes.ULONG_PTR),
    )

class HARDWAREINPUT(ctypes.Structure):
    _fields_ = (
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    )

class INPUT(ctypes.Structure):
    class _INPUT(ctypes.Union):
        _fields_ = (
            ("ki", KEYBDINPUT),
            ("mi", MOUSEINPUT),
            ("hi", HARDWAREINPUT),
        )
    _anonymous_ = ("_input",)
    _fields_ = (
        ("type", wintypes.DWORD),
        ("_input", _INPUT),
    )

INPUT_KEYBOARD = 1
KEYEVENTF_SCANCODE = 0x0008
KEYEVENTF_KEYUP = 0x0002

def press_key_direct(scan_code):
    x = INPUT(
        type=INPUT_KEYBOARD,
        ki=KEYBDINPUT(
            wVk=0,
            wScan=scan_code,
            dwFlags=KEYEVENTF_SCANCODE,
            time=0,
            dwExtraInfo=0,
        ),
    )
    user32.SendInput(1, ctypes.byref(x), ctypes.sizeof(x))

def release_key_direct(scan_code):
    x = INPUT(
        type=INPUT_KEYBOARD,
        ki=KEYBDINPUT(
            wVk=0,
            wScan=scan_code,
            dwFlags=KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP,
            time=0,
            dwExtraInfo=0,
        ),
    )
    user32.SendInput(1, ctypes.byref(x), ctypes.sizeof(x))

input_queue = queue.Queue()

def focus_target_window():
    global selected_hwnd
    if selected_hwnd:
        try:
            current_fg = user32.GetForegroundWindow()
            if current_fg != selected_hwnd:
                user32.keybd_event(0x12, 0, 0, 0)
                user32.keybd_event(0x12, 0, 2, 0)
                user32.SetForegroundWindow(selected_hwnd)
        except Exception as err:
            print(f"[Focus Error] Could not activate window: {err}")

def input_worker():
    while True:
        try:
            key_code, action = input_queue.get(timeout=1.0)
            if key_code in KEY_SCANCODES:
                scan_code = KEY_SCANCODES[key_code]
                if selected_hwnd:
                    current_fg = user32.GetForegroundWindow()
                    if current_fg != selected_hwnd:
                        focus_target_window()

                if action == "keydown":
                    press_key_direct(scan_code)
                elif action == "keyup":
                    release_key_direct(scan_code)
            input_queue.task_done()
        except queue.Empty:
            continue

threading.Thread(target=input_worker, daemon=True).start()

latest_frame = None
latest_frame_lock = threading.Lock()

selected_hwnd = None
selected_window_title = None
capture_thread = None
capture_instance = None

class AppSelectorGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("GPU WebRTC Streamer")
        self.root.geometry("420x180")
        self.root.attributes("-topmost", True)

        tk.Label(root, text="Select Target Window:", font=("Arial", 10, "bold")).pack(pady=10)
        self.window_cb = ttk.Combobox(root, state="readonly", width=48)
        self.window_cb.pack(pady=5)

        btn_frame = tk.Frame(root)
        btn_frame.pack(pady=10)

        tk.Button(btn_frame, text="Refresh", command=self.refresh_windows).pack(side=tk.LEFT, padx=5)
        tk.Button(btn_frame, text="Start Stream", command=self.set_source, bg="#0070f3", fg="white").pack(side=tk.LEFT, padx=5)

        self.status_label = tk.Label(root, text="Status: Waiting for selection...", fg="gray")
        self.status_label.pack(pady=5)

        self.windows_map = {}
        self.refresh_windows()

    def refresh_windows(self):
        self.windows_map.clear()
        windows = gw.getAllWindows()
        options = []
        for w in windows:
            if w.title and w.title.strip() and w.title != "GPU WebRTC Streamer":
                display_str = f"{w.title} (HWND: {w._hWnd})"
                self.windows_map[display_str] = (w._hWnd, w.title)
                options.append(display_str)

        options.sort()
        self.window_cb["values"] = options
        if options:
            self.window_cb.current(0)

    def set_source(self):
        global selected_hwnd, selected_window_title
        selected_key = self.window_cb.get()
        if selected_key in self.windows_map:
            selected_hwnd, selected_window_title = self.windows_map[selected_key]
            self.status_label.config(text=f"Streaming HWND: {selected_hwnd}", fg="green")
            self.root.attributes("-topmost", False)
            self.root.iconify()
            focus_target_window()
            start_window_capture(selected_hwnd)

def start_window_capture(hwnd):
    global capture_thread, capture_instance

    if capture_instance:
        try:
            capture_instance.stop()
        except Exception:
            pass

    def capture_worker():
        global latest_frame, capture_instance
        try:
            capture = WindowsCapture(
                window_hwnd=hwnd,
                cursor_capture=False,
                draw_border=False
            )
            capture_instance = capture

            @capture.event
            def on_frame_arrived(frame, capture_control):
                global latest_frame
                try:
                    if hasattr(frame, 'to_numpy'):
                        img = frame.to_numpy()
                    elif hasattr(frame, 'frame_buffer'):
                        img = frame.frame_buffer
                    else:
                        img = np.array(frame)

                    if img.ndim == 3 and img.shape[2] == 4:
                        bgr_img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
                    else:
                        bgr_img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR) if img.ndim == 3 else img

                    # Standardize frame resolution to 720p for WebRTC macroblock compliance
                    resized = cv2.resize(bgr_img, (STREAM_WIDTH, STREAM_HEIGHT), interpolation=cv2.INTER_AREA)

                    with latest_frame_lock:
                        latest_frame = np.ascontiguousarray(resized)
                except Exception:
                    pass

            @capture.event
            def on_closed():
                print("[Graphics Capture] Session terminated.")

            capture.start()
        except Exception as e:
            print(f"[Graphics Capture Error] {e}")

    capture_thread = threading.Thread(target=capture_worker, daemon=True)
    capture_thread.start()

class ScreenCaptureTrack(VideoStreamTrack):
    def __init__(self):
        super().__init__()
        self._timestamp = 0
        self._start_time = time.perf_counter()

    async def recv(self):
        target_time = self._start_time + (self._timestamp + 1) * FRAME_INTERVAL
        sleep_duration = target_time - time.perf_counter()
        if sleep_duration > 0:
            await asyncio.sleep(sleep_duration)

        pts = self._timestamp * int(90000 / TARGET_FPS)
        self._timestamp += 1

        with latest_frame_lock:
            frame_bgr = latest_frame

        if frame_bgr is None:
            frame_bgr = np.zeros((STREAM_HEIGHT, STREAM_WIDTH, 3), dtype=np.uint8)
            cv2.putText(
                frame_bgr,
                "Awaiting Source Window Stream...",
                (320, 360),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (255, 255, 255),
                2,
            )

        new_frame = VideoFrame.from_ndarray(frame_bgr, format="bgr24")
        new_frame.pts = pts
        new_frame.time_base = Fraction(1, 90000)

        return new_frame

peers = {}

def configure_transceiver_codecs(pc):
    """Prefers H.264 for mobile/iOS compatibility; falls back to VP8."""
    for t in pc.getTransceivers():
        if t.kind == "video":
            capabilities = RTCRtpSender.getCapabilities("video")
            codecs = capabilities.codecs
            h264_codecs = [c for c in codecs if c.mimeType.lower() == "video/h264"]
            vp8_codecs = [c for c in codecs if c.mimeType.lower() == "video/vp8"]
            
            preferred = h264_codecs + vp8_codecs
            if preferred:
                t.setCodecPreferences(preferred)

async def connect_and_listen():
    global peers

    websocket = None
    retry_delay = 5
    max_retries = 12
    attempts = 0

    while attempts < max_retries:
        try:
            attempts += 1
            print(f"[Production Render] Connecting to {SIGNALING_SERVER_URL} (Attempt {attempts}/{max_retries})...")
            websocket = await websockets.connect(SIGNALING_SERVER_URL, open_timeout=20)
            print(f"Successfully Connected to Production Signaling Server as Host!")
            break
        except (Exception, OSError) as e:
            print(f"[Render Spinning Up] Host connection failed: {e}. Retrying in {retry_delay}s...")
            await asyncio.sleep(retry_delay)

    if not websocket:
        print("[Fatal] Unable to connect to Render signaling server.")
        return

    try:
        await websocket.send(json.dumps({"type": "register_host"}))

        async for message in websocket:
            try:
                data = json.loads(message)
                msg_type = data.get("type")

                if msg_type == "viewer_joined":
                    viewer_id = data.get("viewerId")
                    print(f"Viewer {viewer_id} connected via Render. Negotiating WebRTC peer connection...")

                    pc = RTCPeerConnection(configuration=rtc_config)
                    peers[viewer_id] = pc

                    pc.addTrack(ScreenCaptureTrack())
                    configure_transceiver_codecs(pc)

                    @pc.on("icecandidate")
                    async def on_icecandidate(event):
                        if event.candidate:
                            cand_dict = {
                                "candidate": event.candidate.candidate,
                                "sdpMid": event.candidate.sdpMid if event.candidate.sdpMid is not None else "0",
                                "sdpMLineIndex": event.candidate.sdpMLineIndex if event.candidate.sdpMLineIndex is not None else 0
                            }
                            await websocket.send(
                                json.dumps(
                                    {
                                        "type": "candidate",
                                        "targetViewerId": viewer_id,
                                        "candidate": cand_dict
                                    }
                                )
                            )

                    @pc.on("connectionstatechange")
                    async def on_connectionstatechange():
                        print(f"Peer {viewer_id} connection state: {pc.connectionState}")

                    offer = await pc.createOffer()
                    await pc.setLocalDescription(offer)

                    await websocket.send(
                        json.dumps(
                            {
                                "type": "offer",
                                "targetViewerId": viewer_id,
                                "sdp": pc.localDescription.sdp,
                                "sdp_type": pc.localDescription.type,
                            }
                        )
                    )

                elif msg_type == "viewer_left":
                    viewer_id = data.get("viewerId")
                    if viewer_id in peers:
                        print(f"Disconnecting WebRTC pipeline for viewer: {viewer_id}")
                        await peers[viewer_id].close()
                        del peers[viewer_id]

                elif msg_type == "answer":
                    viewer_id = data.get("viewerId")
                    if viewer_id in peers:
                        answer = RTCSessionDescription(sdp=data["sdp"], type=data["sdp_type"])
                        await peers[viewer_id].setRemoteDescription(answer)

                elif msg_type == "candidate":
                    viewer_id = data.get("viewerId")
                    if viewer_id in peers:
                        pc = peers[viewer_id]
                        cand_data = data.get("candidate")
                        if cand_data and pc.remoteDescription is not None:
                            if isinstance(cand_data, dict):
                                cand_str = cand_data.get("candidate", "")
                                sdp_mid = cand_data.get("sdpMid", "0")
                                sdp_mline_index = cand_data.get("sdpMLineIndex", 0)
                            else:
                                cand_str = str(cand_data)
                                sdp_mid = "0"
                                sdp_mline_index = 0

                            if cand_str:
                                parts = cand_str.replace("candidate:", "").split()
                                if len(parts) >= 8:
                                    candidate_obj = RTCIceCandidate(
                                        component=int(parts[1]),
                                        foundation=parts[0],
                                        ip=parts[4],
                                        port=int(parts[5]),
                                        priority=int(parts[3]),
                                        protocol=parts[2],
                                        type=parts[7],
                                        sdpMid=sdp_mid,
                                        sdpMLineIndex=sdp_mline_index,
                                    )
                                    await pc.addIceCandidate(candidate_obj)

                elif msg_type == "input_event":
                    key_code = data.get("code")
                    action = data.get("action")
                    input_queue.put((key_code, action))

            except Exception as e:
                print(f"Message handling exception: {e}")

    except (websockets.exceptions.ConnectionClosedError, ConnectionResetError) as e:
        print(f"[Production Connection] Disconnected: {e}. Reconnecting in 3 seconds...")
        for vid, pc in list(peers.items()):
            await pc.close()
        peers.clear()
        await asyncio.sleep(3)

def run_asyncio_loop(loop):
    asyncio.set_event_loop(loop)
    loop.run_until_complete(async_main())

async def async_main():
    while True:
        await connect_and_listen()

if __name__ == "__main__":
    loop = asyncio.new_event_loop()
    t = threading.Thread(target=run_asyncio_loop, args=(loop,), daemon=True)
    t.start()

    root = tk.Tk()
    app = AppSelectorGUI(root)
    root.mainloop()