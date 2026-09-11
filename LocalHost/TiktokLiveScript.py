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

# Configuration Parameters
SIGNALING_SERVER_URL = "wss://tiktok-live-multiplayer.onrender.com/"
TARGET_FPS = 60
FRAME_INTERVAL = 1.0 / TARGET_FPS

# DirectInput Hardware Scan Codes (Tekken 7 / DirectInput Compatible)
KEY_SCANCODES = {
    "KeyW": 0x11,      # W (Up)
    "KeyS": 0x1F,      # S (Down)
    "KeyA": 0x1E,      # A (Left)
    "KeyD": 0x20,      # D (Right)
    "KeyU": 0x16,      # U (X)
    "KeyI": 0x17,      # I (Y)
    "KeyO": 0x18,      # O (RB)
    "KeyP": 0x19,      # P (LB)
    "KeyJ": 0x24,      # J (A)
    "KeyK": 0x25,      # K (B)
    "KeyL": 0x26,      # L (RT)
    "Semicolon": 0x27, # ; (LT)
    "KeyB": 0x30,      # B (Menu/Start)
    "KeyV": 0x2F,      # V (View/Select)
    "KeyC": 0x2E,      # C (L3)
    "KeyN": 0x31,      # R3
}

# Win32 C-Struct Definitions for High-Speed Input Injection
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
        tk.Button(btn_frame, text="Start Low-Latency Stream", command=self.set_source, bg="#0070f3", fg="white").pack(side=tk.LEFT, padx=5)

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

                    with latest_frame_lock:
                        latest_frame = np.ascontiguousarray(bgr_img)
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
            frame_bgr = np.zeros((720, 1280, 3), dtype=np.uint8)
            cv2.putText(
                frame_bgr,
                "Awaiting Source Window Stream...",
                (320, 360),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (255, 255, 255),
                2,
            )

        h, w, _ = frame_bgr.shape
        h &= ~1
        w &= ~1
        frame_bgr = frame_bgr[:h, :w]

        new_frame = VideoFrame.from_ndarray(frame_bgr, format="bgr24")
        new_frame.pts = pts
        new_frame.time_base = Fraction(1, 90000)

        return new_frame

peers = {}

rtc_config = RTCConfiguration(
    iceServers=[
        RTCIceServer(urls=["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"])
    ]
)

def force_low_latency_codecs(pc):
    """Restructures transceiver codec preferences to enforce real-time hardware H264 baseline profiles."""
    transceivers = pc.getTransceivers()
    for t in transceivers:
        if t.kind == "video":
            codecs = RTCRtpSender.getCapabilities("video").codecs
            h264_codecs = [c for c in codecs if c.mimeType.lower() == "video/h264"]
            if h264_codecs:
                t.setCodecPreferences(h264_codecs)

def optimize_sdp_for_low_latency(sdp):
    """Applies low-latency SDP munging flags and elevates H.264 profile level limits."""
    lines = sdp.split("\r\n")
    new_lines = []
    for line in lines:
        if line.startswith("a=fmtp:"):
            # Force level 4.2 (level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e02a)
            if "profile-level-id=" in line:
                line = line.replace("profile-level-id=42e01f", "profile-level-id=42e02a")
            if "max-fs" not in line:
                line += ";x-google-min-bitrate=2000;x-google-max-bitrate=6000;x-google-start-bitrate=4000"
        new_lines.append(line)
    return "\r\n".join(new_lines)

async def connect_and_listen():
    global peers

    try:
        async with websockets.connect(SIGNALING_SERVER_URL) as websocket:
            print("Connected to Signaling Server as Host.")
            await websocket.send(json.dumps({"type": "register_host"}))

            async for message in websocket:
                try:
                    data = json.loads(message)
                    msg_type = data.get("type")

                    if msg_type == "viewer_joined":
                        viewer_id = data.get("viewerId")
                        print(f"Viewer {viewer_id} connected. Negotiating WebRTC peer connection...")

                        pc = RTCPeerConnection(configuration=rtc_config)
                        peers[viewer_id] = pc

                        pc.addTrack(ScreenCaptureTrack())
                        force_low_latency_codecs(pc)

                        offer = await pc.createOffer()
                        await pc.setLocalDescription(offer)

                        munged_sdp = optimize_sdp_for_low_latency(pc.localDescription.sdp)

                        await websocket.send(
                            json.dumps(
                                {
                                    "type": "offer",
                                    "targetViewerId": viewer_id,
                                    "sdp": munged_sdp,
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
                                    sdp_mid = cand_data.get("sdpMid")
                                    sdp_mline_index = cand_data.get("sdpMLineIndex")
                                else:
                                    cand_str = str(cand_data)
                                    sdp_mid = None
                                    sdp_mline_index = None

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
        print(f"[WebSocket] Peer dropped connection: {e}. Reconnecting in 3 seconds...")
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