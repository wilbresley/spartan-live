# -*- coding: utf-8 -*-
"""Captura a tela e publica em Full HD no Spartan Live."""

import ctypes
from ctypes import wintypes
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import winreg
import tkinter as tk
from tkinter import font as tkfont
from tkinter import messagebox
from urllib.parse import quote

import numpy as np
import soxr

try:
    import pyaudiowpatch as pyaudio
except ImportError:
    pyaudio = None


def app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def bundle_dir():
    packed = getattr(sys, "_MEIPASS", "")
    if packed and os.path.isdir(packed):
        return packed
    return os.path.dirname(os.path.abspath(__file__))


def existing_file(*names):
    folders = [
        app_dir(),
        bundle_dir(),
        os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")),
    ]
    for folder in folders:
        for name in names:
            path = os.path.join(folder, name)
            if os.path.isfile(path):
                return path
    return ""


RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_NAME = "SpartanLive"


def startup_command(exe):
    return f'"{exe}"'


def apply_startup(enabled, exe, store):
    if enabled:
        store[RUN_NAME] = startup_command(exe)
    else:
        store.pop(RUN_NAME, None)
    return store


def read_startup_enabled():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_READ) as key:
            winreg.QueryValueEx(key, RUN_NAME)
            return True
    except OSError:
        return False


def write_startup(enabled):
    if getattr(sys, "frozen", False):
        command = startup_command(sys.executable)
    else:
        command = f'"{sys.executable}" "{os.path.abspath(sys.argv[0])}"'
    try:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
            if enabled:
                winreg.SetValueEx(key, RUN_NAME, 0, winreg.REG_SZ, command)
            else:
                try:
                    winreg.DeleteValue(key, RUN_NAME)
                except OSError:
                    pass
    except OSError:
        return False
    return True


def settings_path():
    root = os.environ.get("APPDATA") or os.path.expanduser("~")
    folder = os.path.join(root, "SpartanLive")
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, "config.json")


_LOG_LOCK = threading.Lock()
_log_pruned = False


def log_path():
    return os.path.join(os.path.dirname(settings_path()), "spartan.log")


def prune_log_text(text, now, keep_days=30):
    limit = now - keep_days * 86400
    kept = []
    for line in str(text).splitlines():
        try:
            stamp = time.mktime(time.strptime(line[:19], "%Y-%m-%dT%H:%M:%S"))
        except (ValueError, OverflowError):
            continue
        if stamp >= limit:
            kept.append(line)
    if not kept:
        return ""
    return "\n".join(kept) + "\n"


def log_event(message):
    global _log_pruned
    text = " ".join(str(message).split())[:400]
    if not text:
        return
    path = log_path()
    line = time.strftime("%Y-%m-%dT%H:%M:%S") + " " + text + "\n"
    try:
        with _LOG_LOCK:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            if os.path.isfile(path) and (not _log_pruned or os.path.getsize(path) > 300000):
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    blob = prune_log_text(handle.read(), time.time())
                with open(path, "w", encoding="utf-8") as handle:
                    handle.write(blob)
                _log_pruned = True
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(line)
    except OSError:
        return


def looks_like_ip(host):
    text = str(host or "").strip()
    if text.startswith("[") and text.endswith("]"):
        return True
    parts = text.split(".")
    if len(parts) != 4:
        return False
    for part in parts:
        if not part.isdigit() or not 0 <= int(part) <= 255:
            return False
    return True


def notify_targets(host, action):
    text = clean_host(host, "")
    if action not in ("stop", "claim", "switch", "thumb") or not text:
        return []
    local = f"http://{text}:8097/api/{action}"
    if looks_like_ip(text):
        return [local]
    return [f"https://{text}/api/{action}", local]


def notify_publisher(host, nick, user, password, action):
    targets = notify_targets(host, action)
    if not targets or not nick or not user or not password:
        return
    body = json.dumps({"name": nick, "user": user, "password": password}).encode("utf-8")
    last_error = "falhou"
    for url in targets:
        request = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=4) as response:
                response.read()
            log_event(f"{action} aceito apelido={nick}")
            return
        except Exception as error:
            last_error = type(error).__name__
    log_event(f"{action} falhou apelido={nick} {last_error}")


def notify_stopped(host, nick, user, password):
    notify_publisher(host, nick, user, password, "stop")


def grab_thumb(ffmpeg, monitor):
    folder = tempfile.mkdtemp(prefix="spartan-thumb-")
    target = os.path.join(folder, "frame.jpg")
    command = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-f", "gdigrab", "-framerate", "1",
        "-offset_x", str(int(monitor["left"])),
        "-offset_y", str(int(monitor["top"])),
        "-video_size", f"{int(monitor['width'])}x{int(monitor['height'])}",
        "-i", "desktop",
        "-frames:v", "1",
        "-vf", "scale=1280:-2",
        "-q:v", "5",
        "-y", target,
    ]
    try:
        subprocess.run(
            command,
            timeout=8,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
            check=False,
        )
        if not os.path.isfile(target) or os.path.getsize(target) < 32:
            return b""
        with open(target, "rb") as handle:
            return handle.read()
    except (OSError, subprocess.SubprocessError):
        return b""
    finally:
        try:
            os.remove(target)
        except OSError:
            pass
        try:
            os.rmdir(folder)
        except OSError:
            pass


def upload_thumb(host, nick, user, password, data):
    targets = notify_targets(host, "thumb")
    if not targets or not nick or not user or not password or not data:
        return
    for url in targets:
        request = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "image/jpeg",
                "x-spartan-user": str(user),
                "x-spartan-password": str(password),
                "x-spartan-name": str(nick),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                response.read()
            log_event(f"thumb aceita apelido={nick}")
            return
        except Exception as error:
            last = type(error).__name__
    log_event(f"thumb falhou apelido={nick} {last}")


class _JobBasicLimit(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _JobExtendedLimit(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JobBasicLimit),
        ("IoReadOperationCount", ctypes.c_uint64),
        ("IoWriteOperationCount", ctypes.c_uint64),
        ("IoOtherOperationCount", ctypes.c_uint64),
        ("IoReadTransferCount", ctypes.c_uint64),
        ("IoWriteTransferCount", ctypes.c_uint64),
        ("IoOtherTransferCount", ctypes.c_uint64),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def assign_kill_with_parent(process, job=None):
    kernel = ctypes.windll.kernel32
    kernel.CreateJobObjectW.restype = ctypes.c_void_p
    job_created = job is None
    if job is None:
        job = kernel.CreateJobObjectW(None, None)
        if not job:
            return None
        info = _JobExtendedLimit()
        info.BasicLimitInformation.LimitFlags = 0x2000
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            kernel.CloseHandle(job)
            return None
    handle = getattr(process, "_handle", None)
    if not handle or not kernel.AssignProcessToJobObject(job, int(handle)):
        if job_created:
            kernel.CloseHandle(job)
            return None
        return job
    return job


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return default


def valid_nick(nick):
    if not 2 <= len(nick) <= 24:
        return False
    return all(ch.isalnum() or ch in "_-" for ch in nick)


def list_monitors():
    user32 = ctypes.windll.user32
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass

    class RECT(ctypes.Structure):
        _fields_ = [
            ("left", ctypes.c_long),
            ("top", ctypes.c_long),
            ("right", ctypes.c_long),
            ("bottom", ctypes.c_long),
        ]

    monitors = []

    @ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(RECT), ctypes.c_longlong)
    def callback(_monitor, _hdc, rect, _data):
        box = rect.contents
        monitors.append({
            "left": int(box.left),
            "top": int(box.top),
            "width": int(box.right - box.left),
            "height": int(box.bottom - box.top),
        })
        return 1

    user32.EnumDisplayMonitors(None, None, callback, 0)
    if not monitors:
        monitors.append({"left": 0, "top": 0, "width": 1920, "height": 1080})
    return monitors


def monitor_label(index, monitor):
    label = f"Tela {index + 1} — {monitor['width']}x{monitor['height']}"
    if monitor["left"] == 0 and monitor["top"] == 0:
        label += " (principal)"
    return label


QUALITY_OPTIONS = (
    ("1080p60", "1080p 60", 1920, 1080, 60),
    ("1080p30", "1080p 30", 1920, 1080, 30),
    ("720p60", "720p 60", 1280, 720, 60),
    ("720p30", "720p 30", 1280, 720, 30),
)


def parse_quality(value, fps=None):
    text = str(value or "").strip()
    for item in QUALITY_OPTIONS:
        if text in (item[0], item[1]):
            return item
    try:
        if int(fps) < 60:
            return QUALITY_OPTIONS[1]
    except (TypeError, ValueError):
        pass
    return QUALITY_OPTIONS[0]


def encoder_args(encoder, fps, height=1080):
    gop = str(fps)
    hardware = encoder != "libx264"
    if int(height) <= 720:
        rate = (8 if fps >= 60 else 5) if hardware else (6 if fps >= 60 else 4)
    else:
        rate = (14 if fps >= 60 else 8) if hardware else (12 if fps >= 60 else 8)
    bitrate = f"{rate}M"
    common = ["-b:v", bitrate, "-maxrate", bitrate, "-bufsize", f"{rate * 2}M", "-g", gop, "-bf", "0", "-pix_fmt", "yuv420p"]
    if encoder == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "cbr", "-profile:v", "high", *common]
    if encoder == "h264_amf":
        return ["-c:v", "h264_amf", "-quality", "quality", "-rc", "cbr", *common]
    if encoder == "h264_qsv":
        return ["-c:v", "h264_qsv", "-preset", "medium", "-profile:v", "high", *common]
    preset = "ultrafast" if int(height) <= 720 and fps >= 60 else "veryfast"
    return ["-c:v", "libx264", "-preset", preset, "-tune", "zerolatency", "-profile:v", "high", *common]


def scale_filter(width=1920, height=1080):
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p"
    )


def capture_input(mode, fps, monitor, output_idx):
    if mode == "ddagrab":
        return [
            "-f", "ddagrab",
            "-framerate", str(fps),
            "-draw_mouse", "1",
            "-output_idx", str(output_idx),
            "-i", "desktop",
        ]
    return [
        "-f", "gdigrab",
        "-framerate", str(fps),
        "-offset_x", str(monitor["left"]),
        "-offset_y", str(monitor["top"]),
        "-video_size", f"{monitor['width']}x{monitor['height']}",
        "-draw_mouse", "1",
        "-i", "desktop",
    ]


AUDIO_RATE = 48000
AUDIO_CHUNK = 960  # 20 ms em estéreo


def capture_stalled(frame_seen, frame_at, now, limit=5.0):
    """A captura travou se o ffmpeg já emitia quadros e parou."""
    return frame_seen > 0 and now - frame_at > limit


def video_clock(line):
    """O horário real em que a captura da imagem começou, em segundos do relógio do Windows."""
    match = re.search(r"start:\s*([0-9]+(?:\.[0-9]+)?)", line or "")
    if not match:
        return None
    value = float(match.group(1))
    if value < 1_000_000_000:
        return None
    return value


def progress_seconds(line):
    """Segundos já gravados na imagem, lidos do progresso do ffmpeg."""
    text = (line or "").strip()
    if text.startswith("out_time_us="):
        try:
            return int(text.split("=", 1)[1]) / 1_000_000
        except ValueError:
            return None
    if text.startswith("out_time="):
        raw = text.split("=", 1)[1]
        try:
            hours, minutes, seconds = raw.split(":")
            return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
        except ValueError:
            return None
    return None


def plan_audio(buf, limit, chunk):
    """O som sai na ordem em que chegou. Acima do limite, o excesso antigo sai. Sem um bloco inteiro, o buraco é silêncio."""
    if limit < chunk:
        limit = chunk
    if len(buf) > limit:
        keep = max(chunk, (limit // 5) // 4 * 4)
        extra = len(buf) - keep
        extra -= extra % 4
        if extra > 0:
            del buf[:extra]
    if len(buf) >= chunk:
        return 0, chunk
    return chunk, 0


def wav_header():
    """Cabeçalho WAV de um fluxo contínuo. O tamanho grande evita o ffmpeg esperar o fim do arquivo."""
    rate, channels, bits = AUDIO_RATE, 2, 16
    size = 0x7FFFFF00
    block = channels * bits // 8
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + size, b"WAVE", b"fmt ", 16, 1, channels, rate, rate * block, block, bits, b"data", size,
    )


def build_command(ffmpeg, mode, encoder, fps, monitor, output_idx, rtmp, with_audio=False, width=1920, height=1080, relay=None):
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "info" if with_audio else "warning",
        "-nostats",
        "-progress", "pipe:1",
    ]
    if with_audio:
        command.append("-use_wallclock_as_timestamps")
        command.append("1")
    command += [
        *capture_input(mode, fps, monitor, output_idx),
        "-filter:v", scale_filter(width, height),
        *encoder_args(encoder, fps, height),
    ]
    if with_audio:
        command += [
            "-an",
            "-fps_mode", "passthrough",
            "-flush_packets", "1",
            "-f", "mpegts",
            "-listen", "1",
            relay,
        ]
        return command
    command += ["-an", "-muxdelay", "0", "-muxpreload", "0", "-f", "flv", "-flvflags", "no_duration_filesize", rtmp]
    return command


def build_mux_command(ffmpeg, pipe, relay, offset, rtmp):
    """Copia a imagem já codificada e grava o som no mesmo horário, sem reescalar o vídeo."""
    return [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "warning",
        "-itsoffset", f"{float(offset):.6f}",
        "-f", "wav",
        "-analyzeduration", "0",
        "-probesize", "512",
        "-i", pipe,
        "-f", "mpegts",
        "-analyzeduration", "200000",
        "-probesize", "100000",
        "-i", relay,
        "-map", "0:a:0",
        "-map", "1:v:0",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2",
        "-muxdelay", "0",
        "-muxpreload", "0",
        "-flush_packets", "1",
        "-f", "flv",
        "-flvflags", "no_duration_filesize",
        rtmp,
    ]


def playback_label(name):
    suffix = " [Loopback]"
    if name.endswith(suffix):
        return name[:-len(suffix)]
    return name


def merge_playback(names):
    playback = []
    for name in names:
        if name and name not in playback:
            playback.append(name)
    return playback


def list_sound_devices():
    if pyaudio is None:
        return [], []
    audio = pyaudio.PyAudio()
    try:
        api = audio.get_host_api_info_by_type(pyaudio.paWASAPI)["index"]
        found = []
        capture = []
        try:
            found.extend(info.get("name") or "" for info in audio.get_loopback_device_info_generator())
        except Exception:
            pass
        for index in range(audio.get_device_count()):
            info = audio.get_device_info_by_index(index)
            if info.get("hostApi") != api:
                continue
            name = info.get("name") or ""
            if info.get("isLoopbackDevice"):
                found.append(name)
            elif int(info.get("maxOutputChannels") or 0) > 0:
                try:
                    loop = audio.get_wasapi_loopback_analogue_by_dict(info)
                except Exception:
                    loop = None
                if loop and loop.get("name"):
                    found.append(loop.get("name"))
            elif int(info.get("maxInputChannels") or 0) > 0 and name not in capture:
                capture.append(name)
        return merge_playback(found), capture
    finally:
        audio.terminate()


def chosen_pc_audio(saved, devices, system_default):
    """O padrão é o alto-falante do Windows. Um aparelho salvo só vale se ele existir neste PC."""
    if saved:
        if saved in devices:
            return saved
    elif saved == "":
        return ""
    if system_default in devices:
        return system_default
    return ""


def system_default_playback():
    if pyaudio is None:
        return ""
    audio = pyaudio.PyAudio()
    try:
        return audio.get_default_wasapi_loopback().get("name") or ""
    except Exception:
        return ""
    finally:
        audio.terminate()


def run_with_timeout(action, timeout):
    outcome = []
    failure = []

    def work():
        try:
            outcome.append(action())
        except Exception as error:
            failure.append(error)

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        raise TimeoutError("demorou")
    if failure:
        raise failure[0]
    return outcome[0] if outcome else None


def _layout(channels):
    """Ordem do WASAPI: frente, centro, grave, traseira e laterais. A frente fica em volume cheio."""
    table = {
        1: ((1.0,), (1.0,)),
        2: ((1.0, 0.0), (0.0, 1.0)),
        4: ((1.0, 0.0, 0.7071, 0.0), (0.0, 1.0, 0.0, 0.7071)),
        6: ((1.0, 0.0, 0.7071, 0.5, 0.7071, 0.0), (0.0, 1.0, 0.7071, 0.5, 0.0, 0.7071)),
        8: ((1.0, 0.0, 0.7071, 0.5, 0.7071, 0.0, 0.7071, 0.0), (0.0, 1.0, 0.7071, 0.5, 0.0, 0.7071, 0.0, 0.7071)),
    }
    if channels in table:
        return table[channels]
    left = [0.0] * channels
    right = [0.0] * channels
    left[0] = 1.0
    right[1 if channels > 1 else 0] = 1.0
    return tuple(left), tuple(right)


def downmix_float(data, channels, kind):
    """Converte o bloco do dispositivo para estéreo float, sem descartar o centro nem as laterais."""
    width = 4 if kind == "float" else 2
    frame = channels * width
    usable = len(data) - (len(data) % frame)
    if usable < frame:
        return np.zeros((0, 2), np.float32)
    raw = data[:usable]
    if kind == "float":
        samples = np.frombuffer(raw, dtype=np.float32).astype(np.float32, copy=True)
    else:
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    frames = samples.reshape(-1, channels)
    left_c, right_c = _layout(channels)
    left = frames @ np.asarray(left_c, dtype=np.float32)
    right = frames @ np.asarray(right_c, dtype=np.float32)
    stereo = np.column_stack((left, right))
    np.clip(stereo, -1.0, 1.0, out=stereo)
    return stereo


def next_chunk(buf, size):
    """Entrega um bloco real. Se ainda não chegou, o buraco é silêncio — nunca o bloco anterior."""
    if len(buf) >= size:
        chunk = bytes(buf[:size])
        del buf[:size]
        return chunk
    return bytes(size)


_PIPE_OUT = 2
_PIPE_CONNECTED = 535
_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_k32.CreateNamedPipeW.argtypes = [
    wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
    wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
]
_k32.CreateNamedPipeW.restype = wintypes.HANDLE
_k32.ConnectNamedPipe.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
_k32.ConnectNamedPipe.restype = wintypes.BOOL
_k32.WriteFile.argtypes = [
    wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
]
_k32.WriteFile.restype = wintypes.BOOL


def _pipe_ok(handle):
    if not handle:
        return False
    invalid = int(ctypes.c_void_p(-1).value or 0)
    return int(handle) not in (0, -1, invalid, 0xFFFFFFFF)


def _pipe_write(handle, blob):
    data = bytes(blob)
    wrote = wintypes.DWORD()
    ok = _k32.WriteFile(handle, data, len(data), ctypes.byref(wrote), None)
    return bool(ok) and wrote.value == len(data)


class LiveAudio:
    """Lê o WASAPI no formato do aparelho, reamostra com soxr e soma em float. Um buraco vira silêncio."""

    def __init__(self, pc_name, mic_name):
        self.pc_name = pc_name
        self.mic_name = mic_name
        self.audio = None
        self.keep_audio = None
        self.streams = []
        self.keepalive = None
        self.queues = {}
        self.resample = {}
        self.buf = bytearray()
        self.lock = threading.Lock()
        self.stop = False
        self._epoch = 0
        self.writing = False
        self.pipe = None
        self.clock = None
        self.thread = None
        self.jobs = []
        self.pumps = []
        self.silence = b""

    def start(self):
        if pyaudio is None:
            raise RuntimeError("Não consegui acessar o som do Windows.")
        self.audio = pyaudio.PyAudio()
        try:
            self._open_devices()
        except Exception:
            self.close()
            raise
        self._start_pumps()

    def _open_devices(self):
        api = self.audio.get_host_api_info_by_type(pyaudio.paWASAPI)["index"]
        devices = [self.audio.get_device_info_by_index(i) for i in range(self.audio.get_device_count())]
        if self.pc_name:
            source = self._find(devices, api, self.pc_name, loopback=True)
            self._open_keepalive(devices, api, source)
            self._open_capture(source, "pc")
        if self.mic_name:
            source = self._find(devices, api, self.mic_name, loopback=False)
            self._open_capture(source, "mic")

    def _find(self, devices, api, name, loopback):
        for info in devices:
            if info.get("hostApi") != api or bool(info.get("isLoopbackDevice")) != loopback:
                continue
            if info.get("name") != name:
                continue
            if int(info.get("maxInputChannels") or 0) > 0:
                return info
        kind = "som do PC" if loopback else "microfone"
        raise RuntimeError(f"Não achei o {kind} escolhido. Abre o programa de novo pra atualizar a lista.")

    def _open_capture(self, info, key):
        channels = int(info["maxInputChannels"])
        rate = int(info["defaultSampleRate"])
        block = max(128, rate // 50)
        self.queues[key] = np.zeros((0, 2), np.float32)
        if rate != AUDIO_RATE:
            self.resample[key] = soxr.ResampleStream(rate, AUDIO_RATE, 2, dtype="float32", quality=soxr.VHQ)
        stream = None
        kind = "float"
        try:
            stream = self.audio.open(
                format=pyaudio.paFloat32,
                channels=channels,
                rate=rate,
                input=True,
                frames_per_buffer=block,
                input_device_index=int(info["index"]),
            )
        except Exception:
            kind = "int16"
            stream = self.audio.open(
                format=pyaudio.paInt16,
                channels=channels,
                rate=rate,
                input=True,
                frames_per_buffer=block,
                input_device_index=int(info["index"]),
            )
        self.streams.append(stream)
        self.jobs.append((stream, channels, rate, key, block, kind))

    def _open_keepalive(self, devices, api, loopback):
        render_name = playback_label(loopback.get("name") or "")
        render = None
        for info in devices:
            if info.get("hostApi") != api or info.get("isLoopbackDevice"):
                continue
            if info.get("name") == render_name and int(info.get("maxOutputChannels") or 0) > 0:
                render = info
                break
        if render is None:
            return
        channels = int(render["maxOutputChannels"])
        rate = int(render["defaultSampleRate"])
        try:
            self.keep_audio = self._output_audio()
            self.keepalive = self.keep_audio.open(
                format=pyaudio.paInt16,
                channels=channels,
                rate=rate,
                output=True,
                frames_per_buffer=max(128, rate // 50),
                output_device_index=int(render["index"]),
            )
        except OSError:
            self.keepalive = None
            return
        self.silence = bytes(max(128, rate // 50) * channels * 2)

    def _output_audio(self):
        return pyaudio.PyAudio()

    def _start_pumps(self):
        epoch = self._epoch
        for stream, channels, rate, key, block, kind in self.jobs:
            thread = threading.Thread(
                target=self._pump_capture,
                args=(stream, channels, key, kind, block, epoch),
                daemon=True,
            )
            self.pumps.append(thread)
            thread.start()
        if self.keepalive is not None and self.silence:
            thread = threading.Thread(target=self._pump_silence, args=(epoch,), daemon=True)
            self.pumps.append(thread)
            thread.start()

    def _close_stream(self, stream):
        if stream is None or getattr(stream, "_spartan_closed", False):
            return
        stream._spartan_closed = True
        try:
            stream.stop_stream()
        except Exception:
            pass
        try:
            stream.close()
        except Exception:
            pass

    def _pump_capture(self, stream, channels, key, kind, block, epoch):
        try:
            while not self.stop and epoch == self._epoch:
                try:
                    data = stream.read(block, exception_on_overflow=False)
                except Exception:
                    return
                stereo = downmix_float(data, channels, kind)
                resampler = self.resample.get(key)
                if resampler is not None and len(stereo):
                    block_in = np.ascontiguousarray(stereo, dtype=np.float32)
                    stereo = np.asarray(resampler.resample_chunk(block_in), dtype=np.float32)
                if len(stereo) == 0:
                    continue
                with self.lock:
                    self.queues[key] = np.concatenate((self.queues[key], stereo))
                    self._mix_ready()
        finally:
            self._close_stream(stream)

    def _pump_silence(self, epoch):
        try:
            while not self.stop and epoch == self._epoch and self.keepalive is not None:
                try:
                    self.keepalive.write(self.silence)
                except Exception:
                    return
        finally:
            self._close_stream(self.keepalive)

    def _emit(self, mixed):
        pcm = np.clip(np.rint(mixed * 32767.0), -32767, 32767).astype(np.int16).tobytes()
        self.buf.extend(pcm)
        self._trim()

    def _mix_ready(self):
        keys = [key for key in ("pc", "mic") if key in self.queues]
        if not keys:
            return
        if len(keys) == 2:
            lengths = [len(self.queues[key]) for key in keys]
            if min(lengths) == 0 and max(lengths) >= AUDIO_CHUNK * 5:
                parts = []
                for key in keys:
                    have = self.queues[key]
                    if len(have) >= AUDIO_CHUNK:
                        parts.append(have[:AUDIO_CHUNK])
                        self.queues[key] = have[AUDIO_CHUNK:]
                    else:
                        parts.append(np.zeros((AUDIO_CHUNK, 2), np.float32))
                self._emit(np.clip(parts[0] + parts[1], -1.0, 1.0))
                return
            for key in keys:
                if len(self.queues[key]) > AUDIO_RATE:
                    self.queues[key] = self.queues[key][-AUDIO_CHUNK * 2:]
        ready = min(len(self.queues[key]) for key in keys)
        if ready <= 0:
            return
        parts = []
        for key in keys:
            parts.append(self.queues[key][:ready])
            self.queues[key] = self.queues[key][ready:]
        mixed = parts[0] if len(parts) == 1 else np.clip(parts[0] + parts[1], -1.0, 1.0)
        self._emit(mixed)

    def _trim(self):
        keep = AUDIO_RATE * 4 * 2
        if len(self.buf) > keep:
            del self.buf[:len(self.buf) - (AUDIO_RATE * 4 // 5)]

    def open_pipe(self, name):
        self.detach()
        handle = _k32.CreateNamedPipeW(name, _PIPE_OUT, 0, 1, 1 << 20, 65536, 0, None)
        if not _pipe_ok(handle):
            raise OSError(f"não abri o cano do som ({ctypes.get_last_error()})")
        self.pipe = handle

    def attach(self, clock):
        self.clock = clock
        self.writing = True
        self.thread = threading.Thread(target=self._write, daemon=True)
        self.thread.start()

    def detach(self):
        self.writing = False
        handle = self.pipe
        self.pipe = None
        if handle:
            ctypes.windll.kernel32.CloseHandle(int(handle))
        thread = self.thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1)
        self.thread = None

    def _write(self):
        handle = self.pipe
        if not _pipe_ok(handle):
            return
        connected = _k32.ConnectNamedPipe(handle, None)
        if not connected and ctypes.get_last_error() not in (0, _PIPE_CONNECTED):
            return
        if not self.writing or not _pipe_write(handle, wav_header()):
            return
        frame = AUDIO_CHUNK * 4
        limit = AUDIO_RATE * 4 // 5
        with self.lock:
            extra = len(self.buf) - (frame * 2)
            extra -= extra % 4
            if extra > 0:
                del self.buf[:extra]
        for _prime in range(2):
            with self.lock:
                silence, take = plan_audio(self.buf, limit, frame)
                chunk = bytes(frame) if silence else next_chunk(self.buf, frame)
            if not _pipe_write(handle, chunk):
                return
        next_at = time.perf_counter()
        while self.writing and not self.stop:
            delay = next_at - time.perf_counter()
            if delay > 0:
                time.sleep(delay if delay < 0.02 else 0.02)
                continue
            next_at += 0.02
            if time.perf_counter() - next_at > 0.1:
                next_at = time.perf_counter()
            with self.lock:
                silence, take = plan_audio(self.buf, limit, frame)
                chunk = bytes(frame) if silence else next_chunk(self.buf, frame)
            if not _pipe_write(handle, chunk):
                return

    def retarget(self, pc_name, mic_name):
        """Troca o aparelho sem reiniciar a imagem. O cano do ffmpeg continua o mesmo."""
        self.pc_name = pc_name or ""
        self.mic_name = mic_name or ""
        self._epoch += 1
        for thread in list(self.pumps):
            thread.join(timeout=1)
        for stream in list(self.streams):
            self._close_stream(stream)
        self._close_stream(self.keepalive)
        self.streams = []
        self.keepalive = None
        self.jobs = []
        self.pumps = []
        self.queues = {}
        self.resample = {}
        if not self.pc_name and not self.mic_name:
            return
        self._open_devices()
        self._start_pumps()

    def close(self):
        self.stop = True
        self.detach()
        for thread in self.pumps:
            thread.join(timeout=1)
        busy = any(thread.is_alive() for thread in self.pumps)
        if not busy:
            for stream in self.streams:
                self._close_stream(stream)
            self._close_stream(self.keepalive)
        if busy:
            return
        if self.audio is not None:
            try:
                self.audio.terminate()
            except Exception:
                pass
        if self.keep_audio is not None:
            try:
                self.keep_audio.terminate()
            except Exception:
                pass


def icon_file():
    return existing_file("Spartan-Live.ico")


def presence_icon(live):
    if live:
        found = existing_file("Spartan-Live-ON.ico")
        if found:
            return found
    return existing_file("Spartan-Live.ico")


def center_on_workarea(area, width, height):
    left, top, right, bottom = area
    return (
        left + max(0, (right - left - width) // 2),
        top + max(0, (bottom - top - height) // 2),
    )


def primary_workarea():
    class RECT(ctypes.Structure):
        _fields_ = [
            ("left", ctypes.c_long),
            ("top", ctypes.c_long),
            ("right", ctypes.c_long),
            ("bottom", ctypes.c_long),
        ]

    rect = RECT()
    if ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0):
        return (int(rect.left), int(rect.top), int(rect.right), int(rect.bottom))
    user32 = ctypes.windll.user32
    return (0, 0, int(user32.GetSystemMetrics(0)), int(user32.GetSystemMetrics(1)))


def icon_png():
    return existing_file("Spartan-Live.png", "spartan-taskbar.png")


def rounded_points(x1, y1, x2, y2, radius):
    radius = min(radius, (x2 - x1) / 2, (y2 - y1) / 2)
    return [
        x1 + radius, y1, x2 - radius, y1, x2, y1, x2, y1 + radius,
        x2, y2 - radius, x2, y2, x2 - radius, y2, x1 + radius, y2,
        x1, y2, x1, y2 - radius, x1, y1 + radius, x1, y1,
    ]


class Choice(tk.Frame):
    """Lista escura, com canto arredondado. O menu nativo do Windows fica branco."""

    def __init__(self, master, variable, labels, bg, field, fg, accent):
        super().__init__(master, bg=bg)
        self.variable = variable
        self.labels = list(labels) or [""]
        self.field = field
        self.fg = fg
        self.accent = accent
        self.line = "#343434"
        self.popup = None
        self.canvas = tk.Canvas(self, height=44, bg=bg, highlightthickness=0, bd=0, cursor="hand2")
        self.canvas.pack(fill="x")
        self.canvas.bind("<Configure>", lambda _event: self.redraw())
        self.canvas.bind("<Button-1>", lambda _event: self.open_menu())
        self.variable.trace_add("write", lambda *_args: self.redraw())

    def redraw(self):
        canvas = self.canvas
        width = max(canvas.winfo_width(), 40)
        signature = (width, self.variable.get())
        if signature == getattr(self, "_drawn", None):
            return
        self._drawn = signature
        canvas.delete("all")
        height = 44
        canvas.create_polygon(
            rounded_points(1, 1, width - 2, height - 2, 14),
            smooth=True, fill=self.field, outline=self.line,
        )
        shown = self.variable.get()
        font = tkfont.Font(family="Segoe UI", size=11)
        limit = max(40, width - 48)
        while shown and font.measure(shown) > limit:
            shown = shown[:-2] + "…"
        canvas.create_text(16, height / 2, text=shown, anchor="w", fill=self.fg, font=font)
        canvas.create_text(width - 18, height / 2, text="▾", fill="#9a9a9a", font=("Segoe UI", 12))

    def open_menu(self):
        self.close_menu()
        width = max(self.winfo_width(), 220)
        row = 36
        height = min(320, 8 + row * len(self.labels))
        popup = tk.Toplevel(self)
        popup.overrideredirect(True)
        popup.configure(bg=self.field)
        left = self.winfo_rootx()
        top = self.winfo_rooty() + self.winfo_height() + 6
        if top + height > self.winfo_screenheight() - 8:
            top = max(8, self.winfo_rooty() - height - 6)
        left = min(max(8, left), max(8, self.winfo_screenwidth() - width - 8))
        popup.geometry(f"{width}x{height}+{left}+{top}")
        popup.attributes("-topmost", True)
        canvas = tk.Canvas(popup, bg=self.field, highlightthickness=1, highlightbackground=self.line, height=height)
        canvas.pack(fill="both", expand=True)
        inner = tk.Frame(canvas, bg=self.field)
        window = canvas.create_window((0, 0), window=inner, anchor="nw")

        def fit(_event=None):
            canvas.itemconfigure(window, width=canvas.winfo_width())
            canvas.configure(scrollregion=canvas.bbox("all"))

        def wheel(event):
            canvas.yview_scroll(int(-event.delta / 120), "units")

        inner.bind("<Configure>", fit)
        canvas.bind("<MouseWheel>", wheel)
        for label in self.labels:
            item = tk.Label(
                inner, text=label, anchor="w", bg=self.field, fg=self.fg,
                font=("Segoe UI", 11), padx=14, pady=8, cursor="hand2",
            )
            item.pack(fill="x")
            item.bind("<Enter>", lambda _event, widget=item: widget.configure(bg=self.accent, fg="#f6f1f1"))
            item.bind("<Leave>", lambda _event, widget=item: widget.configure(bg=self.field, fg=self.fg))
            item.bind("<Button-1>", lambda _event, value=label: self.pick(value))
            item.bind("<MouseWheel>", wheel)
        self.popup = popup
        popup.focus_force()
        popup.bind("<Escape>", lambda _event: self.close_menu())
        popup.after(250, lambda: popup.bind("<FocusOut>", lambda _event: self.after(160, self._away)))

    def _away(self):
        popup = self.popup
        if popup is None:
            return
        try:
            focus = popup.focus_get()
        except tk.TclError:
            self.close_menu()
            return
        if focus is not None and str(focus).startswith(str(popup)):
            return
        self.close_menu()

    def pick(self, label):
        self.variable.set(label)
        self.close_menu()

    def close_menu(self):
        popup = self.popup
        self.popup = None
        if popup is not None:
            try:
                popup.destroy()
            except tk.TclError:
                pass


class PillButton(tk.Canvas):
    def __init__(self, master, text, command, bg, fill, fg, height=48):
        super().__init__(master, height=height, bg=bg, highlightthickness=0, bd=0, cursor="hand2")
        self.label = text
        self.command = command
        self.fill = fill
        self.fg = fg
        self.bind("<Configure>", lambda _event: self.redraw())
        self.bind("<Button-1>", lambda _event: self.command())

    def config(self, **kwargs):
        if "text" in kwargs:
            self.label = kwargs.pop("text")
            self.redraw()
        if kwargs:
            super().config(**kwargs)

    configure = config

    def redraw(self):
        self.delete("all")
        width = max(self.winfo_width(), 40)
        height = int(self["height"])
        self.create_polygon(
            rounded_points(1, 1, width - 2, height - 2, height / 2),
            smooth=True, fill=self.fill, outline=self.fill,
        )
        self.create_text(width / 2, height / 2, text=self.label, fill=self.fg, font=("Segoe UI", 12, "bold"))


def clean_host(value, fallback=""):
    text = (value or "").strip()
    if not text:
        return fallback
    for prefix in ("https://", "http://"):
        if text.lower().startswith(prefix):
            text = text[len(prefix):]
    text = text.split("/")[0].strip()
    if text.count(":") == 1:
        host, port = text.rsplit(":", 1)
        if port.isdigit():
            text = host
    return text or fallback


def rtmp_url(publish, nick):
    user = quote(str(publish["user"]), safe="")
    password = quote(str(publish["password"]), safe="")
    host = clean_host(publish.get("host"), "")
    port = int(publish.get("port") or 1935)
    return f"rtmp://{host}:{port}/{nick}?user={user}&pass={password}"


def available_encoders(ffmpeg):
    output = subprocess.check_output(
        [ffmpeg, "-hide_banner", "-encoders"],
        text=True,
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    order = ["h264_nvenc", "h264_amf", "h264_qsv", "libx264"]
    return [name for name in order if name in output]


def encoder_works(ffmpeg, encoder):
    proc = subprocess.Popen(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30",
            "-frames:v", "1", "-c:v", encoder, "-f", "null", "-",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    try:
        return proc.wait(timeout=8) == 0
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=3)
        return False


def usable_encoders(ffmpeg):
    found = available_encoders(ffmpeg)
    working = [name for name in found if name != "libx264" and encoder_works(ffmpeg, name)]
    if "libx264" in found:
        working.append("libx264")
    return working


ENCODER_LABEL = {
    "h264_nvenc": "NVIDIA",
    "h264_amf": "AMD",
    "h264_qsv": "Intel",
    "libx264": "processador",
}


def explain_error(text):
    low = (text or "").lower()
    if "not configured" in low:
        return "O servidor ainda não aceita esse apelido. Tenta de novo em alguns segundos."
    if "connection refused" in low or "timed out" in low or "i/o error" in low or "error number -10049" in low:
        return "Não consegui chegar no servidor. Confere o IP e se a porta 1935 está aberta."
    if "10053" in low or "error closing file" in low:
        return "A tela mudou e a captura caiu. Se não voltar sozinha, clica em Transmitir de novo."
    if "auth" in low or "forbidden" in low or "401" in low or "403" in low:
        return "O servidor recusou a transmissão."
    if "invalid audio channel" in low:
        return "Esse aparelho de som não aceitou a captura. Escolhe outro canal, ou deixa sem som."
    if "error opening output files: invalid argument" in low:
        return "Não consegui abrir o envio. O servidor é o IP ou o domínio, por exemplo 192.168.1.10, sem http."
    return text or "A transmissão caiu."


WM_TRAY = 0x0400 + 20
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_LBUTTONDBLCLK = 0x0203
WM_RBUTTONUP = 0x0205
WM_CONTEXTMENU = 0x007B
NIN_SELECT = 0x0400
NIN_KEYSELECT = 0x0401
NIF_MESSAGE = 0x1
NIF_ICON = 0x2
NIF_TIP = 0x4
NIM_ADD = 0
NIM_MODIFY = 1
NIM_DELETE = 2
_WNDPROC = ctypes.WINFUNCTYPE(
    ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
)


class NOTIFYICONDATAW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("hWnd", wintypes.HWND),
        ("uID", wintypes.UINT),
        ("uFlags", wintypes.UINT),
        ("uCallbackMessage", wintypes.UINT),
        ("hIcon", wintypes.HICON),
        ("szTip", wintypes.WCHAR * 128),
        ("dwState", wintypes.DWORD),
        ("dwStateMask", wintypes.DWORD),
        ("szInfo", wintypes.WCHAR * 256),
        ("uVersion", wintypes.UINT),
        ("szInfoTitle", wintypes.WCHAR * 64),
        ("dwInfoFlags", wintypes.DWORD),
        ("guidItem", ctypes.c_byte * 16),
        ("hBalloonIcon", wintypes.HICON),
    ]


class _ICONINFO(ctypes.Structure):
    _fields_ = [
        ("fIcon", wintypes.BOOL),
        ("xHotspot", wintypes.DWORD),
        ("yHotspot", wintypes.DWORD),
        ("hbmMask", wintypes.HBITMAP),
        ("hbmColor", wintypes.HBITMAP),
    ]


class _BITMAP(ctypes.Structure):
    _fields_ = [
        ("bmType", ctypes.c_long),
        ("bmWidth", ctypes.c_long),
        ("bmHeight", ctypes.c_long),
        ("bmWidthBytes", ctypes.c_long),
        ("bmPlanes", ctypes.c_ushort),
        ("bmBitsPixel", ctypes.c_ushort),
        ("bmBits", ctypes.c_void_p),
    ]


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", ctypes.c_long),
        ("biHeight", ctypes.c_long),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


def tray_action(lparam):
    """O Windows manda o clique no trecho de baixo da mensagem. O número do ícone fica no de cima."""
    code = int(lparam) & 0xFFFF
    if code in (WM_LBUTTONUP, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, NIN_SELECT, NIN_KEYSELECT):
        return "open"
    if code in (WM_RBUTTONUP, WM_CONTEXTMENU):
        return "menu"
    return ""


def icon_content_box(width, height, pixels, threshold=24):
    min_x, min_y = width, height
    max_x, max_y = -1, -1
    for y in range(height):
        row = y * width * 4
        for x in range(width):
            if pixels[row + x * 4 + 3] > threshold:
                if x < min_x:
                    min_x = x
                if y < min_y:
                    min_y = y
                if x > max_x:
                    max_x = x
                if y > max_y:
                    max_y = y
    if max_x < 0:
        return 0, 0, width, height
    return min_x, min_y, max_x + 1, max_y + 1


def fit_icon_pixels(width, height, pixels, size):
    """Recorta a margem vazia e amplia o desenho até preencher o quadrado, sem perder a transparência."""
    left, top, right, bottom = icon_content_box(width, height, pixels)
    span_x = max(1, right - left)
    span_y = max(1, bottom - top)
    scale = min(size / span_x, size / span_y)
    draw_w = max(1, min(size, int(round(span_x * scale))))
    draw_h = max(1, min(size, int(round(span_y * scale))))
    origin_x = (size - draw_w) // 2
    origin_y = (size - draw_h) // 2
    out = bytearray(size * size * 4)
    for y in range(draw_h):
        src_y0 = top + (y * span_y) // draw_h
        src_y1 = max(src_y0 + 1, top + ((y + 1) * span_y) // draw_h)
        for x in range(draw_w):
            src_x0 = left + (x * span_x) // draw_w
            src_x1 = max(src_x0 + 1, left + ((x + 1) * span_x) // draw_w)
            total_b = total_g = total_r = total_a = count = 0
            for src_y in range(src_y0, min(src_y1, bottom)):
                row = src_y * width
                for src_x in range(src_x0, min(src_x1, right)):
                    index = (row + src_x) * 4
                    total_b += pixels[index]
                    total_g += pixels[index + 1]
                    total_r += pixels[index + 2]
                    total_a += pixels[index + 3]
                    count += 1
            if not count:
                continue
            dest = ((origin_y + y) * size + origin_x + x) * 4
            out[dest] = total_b // count
            out[dest + 1] = total_g // count
            out[dest + 2] = total_r // count
            out[dest + 3] = total_a // count
    return bytes(out)


def load_square_icon(path, size):
    """A arte tem margem vazia. A bandeja mostra só o desenho, grande, no quadrado do ícone."""
    if not path:
        return None
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user32.LoadImageW.restype = wintypes.HANDLE
    user32.GetIconInfo.argtypes = [wintypes.HICON, ctypes.POINTER(_ICONINFO)]
    user32.DrawIconEx.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.HICON, ctypes.c_int, ctypes.c_int, wintypes.UINT, wintypes.HBRUSH, wintypes.UINT]
    user32.GetDC.restype = wintypes.HDC
    user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    user32.DestroyIcon.argtypes = [wintypes.HICON]
    user32.CreateIconIndirect.argtypes = [ctypes.POINTER(_ICONINFO)]
    user32.CreateIconIndirect.restype = wintypes.HICON
    gdi32.GetObjectW.argtypes = [wintypes.HGDIOBJ, ctypes.c_int, ctypes.c_void_p]
    gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi32.CreateCompatibleDC.restype = wintypes.HDC
    gdi32.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.c_void_p, wintypes.UINT, ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
    gdi32.CreateDIBSection.restype = wintypes.HBITMAP
    gdi32.CreateBitmap.argtypes = [ctypes.c_int, ctypes.c_int, wintypes.UINT, wintypes.UINT, ctypes.c_void_p]
    gdi32.CreateBitmap.restype = wintypes.HBITMAP
    gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    gdi32.SelectObject.restype = wintypes.HGDIOBJ
    gdi32.DeleteDC.argtypes = [wintypes.HDC]
    gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]

    def icon_size(handle):
        info = _ICONINFO()
        user32.GetIconInfo(handle, ctypes.byref(info))
        bitmap = _BITMAP()
        gdi32.GetObjectW(info.hbmColor, ctypes.sizeof(bitmap), ctypes.byref(bitmap))
        gdi32.DeleteObject(info.hbmColor)
        gdi32.DeleteObject(info.hbmMask)
        return max(1, int(bitmap.bmWidth)), max(1, abs(int(bitmap.bmHeight)))

    def blank(width, height):
        header = _BITMAPINFOHEADER()
        header.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
        header.biWidth = width
        header.biHeight = -height
        header.biPlanes = 1
        header.biBitCount = 32
        bits = ctypes.c_void_p()
        bitmap_handle = gdi32.CreateDIBSection(screen, ctypes.byref(header), 0, ctypes.byref(bits), None, 0)
        if bits:
            ctypes.memset(bits, 0, width * height * 4)
        return bitmap_handle, bits

    source = user32.LoadImageW(None, path, 1, 0, 0, 0x0010)
    if not source:
        return None
    src_w, src_h = icon_size(source)
    screen = user32.GetDC(None)
    source_bitmap, source_bits = blank(src_w, src_h)
    source_dc = gdi32.CreateCompatibleDC(screen)
    gdi32.SelectObject(source_dc, source_bitmap)
    user32.DrawIconEx(source_dc, 0, 0, source, src_w, src_h, 0, None, 3)
    raw = ctypes.create_string_buffer(src_w * src_h * 4)
    if source_bits:
        ctypes.memmove(raw, source_bits, src_w * src_h * 4)
    box_left, box_top, box_right, box_bottom = icon_content_box(src_w, src_h, raw.raw)
    covers = (box_right - box_left) >= src_w * 0.9 and (box_bottom - box_top) >= src_h * 0.9
    color, dest_bits = blank(size, size)
    memory = gdi32.CreateCompatibleDC(screen)
    gdi32.SelectObject(memory, color)
    if covers and (src_w != size or src_h != size):
        user32.DestroyIcon(source)
        source = user32.LoadImageW(None, path, 1, size, size, 0x0010)
        if source:
            user32.DrawIconEx(memory, 0, 0, source, size, size, 0, None, 3)
    elif covers:
        user32.DrawIconEx(memory, 0, 0, source, size, size, 0, None, 3)
    elif dest_bits:
        fitted = fit_icon_pixels(src_w, src_h, raw.raw, size)
        ctypes.memmove(dest_bits, fitted, size * size * 4)
    mask = gdi32.CreateBitmap(size, size, 1, 1, None)
    icon = _ICONINFO()
    icon.fIcon = True
    icon.hbmColor = color
    icon.hbmMask = mask
    handle = user32.CreateIconIndirect(ctypes.byref(icon))
    gdi32.DeleteDC(memory)
    gdi32.DeleteDC(source_dc)
    gdi32.DeleteObject(color)
    gdi32.DeleteObject(source_bitmap)
    gdi32.DeleteObject(mask)
    user32.ReleaseDC(None, screen)
    if source:
        user32.DestroyIcon(source)
    return handle or None


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Spartan Live")
        self.bg = "#171717"
        self.fg = "#ececec"
        self.muted = "#9a9a9a"
        self.field = "#1c1c1c"
        self.accent = "#c14b4b"
        self._in_tray = False
        self._tray_added = False
        self._tray_hwnd = None
        self._tray_callback = None
        self._old_wndproc = None
        self._tray_pending = ctypes.c_int(0)
        self._on_air = False
        icon = icon_file()
        if icon:
            try:
                self.iconbitmap(default=icon)
            except tk.TclError:
                pass
        width, height = 560, 720
        origin_x, origin_y = center_on_workarea(primary_workarea(), width, height)
        self.geometry(f"{width}x{height}+{origin_x}+{origin_y}")
        self.configure(bg=self.bg, highlightthickness=1, highlightbackground="#343434")
        self.proc = None
        self.video_proc = None
        self._video_time = 0.0
        self._progress_sock = None
        self._av_ticket = 0
        self.reader = None
        self.running = False
        self.stopping = False
        self._switch_to = None
        self._switch_ready = False
        self._switch_ticket = 0
        self.publish = load_json(existing_file("publish.json"), {})
        self.settings = load_json(settings_path(), {})
        self.monitors = list_monitors()
        self._build()
        self.bind("<Map>", self._on_map)
        self._tray_job = None
        self._dragging = False
        self.after(0, self._borderless)
        self.after(0, self._install_tray_hook)
        self.after(80, self._pump_tray)

    def _hwnd(self):
        parent = ctypes.windll.user32.GetParent(self.winfo_id())
        return parent or self.winfo_id()

    def _borderless(self):
        try:
            hwnd = self._hwnd()
            if not hwnd:
                return
            style = ctypes.windll.user32.GetWindowLongW(hwnd, -16)
            if not (style & 0x00C00000):
                return
            style = (style & ~0x00C00000 & ~0x00040000) | 0x00020000 | 0x00010000 | 0x00080000
            ctypes.windll.user32.SetWindowLongW(hwnd, -16, style)
            ex = ctypes.windll.user32.GetWindowLongW(hwnd, -20)
            ex = (ex | 0x00040000) & ~0x00000080
            ctypes.windll.user32.SetWindowLongW(hwnd, -20, ex)
            ctypes.windll.user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x0027)
        except Exception:
            pass

    def _on_map(self, _event=None):
        self._borderless()

    def _caption(self):
        bar = tk.Frame(self, bg=self.bg, height=42)
        bar.pack(fill="x")
        bar.pack_propagate(False)
        name = tk.Label(bar, text="Spartan Live", bg=self.bg, fg=self.fg, font=("Segoe UI", 11, "bold"))
        name.pack(side="left", padx=16)
        for text, command, color in (
            ("✕", self.destroy, "#f0d0d0"),
            ("—", self._minimize, self.fg),
        ):
            button = tk.Label(bar, text=text, bg=self.bg, fg=color, font=("Segoe UI", 12), width=4, cursor="hand2")
            button.pack(side="right", fill="y")
            button.bind("<Button-1>", lambda _event, command=command: command())
            button.bind("<Enter>", lambda _event, widget=button: widget.configure(bg="#2a2a2a"))
            button.bind("<Leave>", lambda _event, widget=button: widget.configure(bg=self.bg))
        for widget in (bar, name):
            widget.bind("<Button-1>", self._drag_start)

    def _drag_start(self, _event):
        self.after(1, self._drag_window)
        return "break"

    def _drag_window(self):
        job = self._tray_job
        self._tray_job = None
        if job:
            try:
                self.after_cancel(job)
            except tk.TclError:
                pass
        self._dragging = True
        try:
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            user32.ReleaseCapture.argtypes = []
            user32.GetCursorPos.argtypes = [ctypes.c_void_p]
            user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
            user32.SendMessageW.restype = ctypes.c_ssize_t

            class POINT(ctypes.Structure):
                _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

            point = POINT()
            user32.GetCursorPos(ctypes.byref(point))
            packed = ((int(point.y) & 0xFFFF) << 16) | (int(point.x) & 0xFFFF)
            user32.ReleaseCapture()
            user32.SendMessageW(self._hwnd(), 0x00A1, 2, packed)
        finally:
            self._dragging = False
            self._pump_tray()

    def _minimize(self):
        if self._show_tray():
            self._in_tray = True
            self.withdraw()
            return
        ctypes.windll.user32.ShowWindow(self._hwnd(), 6)

    def _install_tray_hook(self):
        if self._tray_hwnd:
            return
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.CreateWindowExW.argtypes = [
            wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
        ]
        user32.CreateWindowExW.restype = wintypes.HWND
        user32.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_void_p]
        user32.SetWindowLongPtrW.restype = ctypes.c_void_p
        user32.DestroyWindow.argtypes = [wintypes.HWND]
        hwnd = user32.CreateWindowExW(0, "Static", "SpartanLiveTray", 0, 0, 0, 0, 0, -3, None, None, None)
        if not hwnd:
            return
        self._tray_callback = _WNDPROC(self._tray_message)
        previous = user32.SetWindowLongPtrW(hwnd, -4, ctypes.cast(self._tray_callback, ctypes.c_void_p))
        if not previous and ctypes.get_last_error():
            user32.DestroyWindow(hwnd)
            self._tray_callback = None
            return
        self._tray_hwnd = hwnd
        self._old_wndproc = previous

    def _tray_message(self, hwnd, msg, wparam, lparam):
        if msg == WM_TRAY:
            action = tray_action(lparam)
            if action == "open":
                self._tray_pending.value = 1
            elif action == "menu":
                self._tray_pending.value = 2
            return 0
        if self._old_wndproc:
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            user32.CallWindowProcW.argtypes = [ctypes.c_void_p, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
            user32.CallWindowProcW.restype = ctypes.c_ssize_t
            return user32.CallWindowProcW(self._old_wndproc, hwnd, msg, wparam, lparam)
        return 0

    def _pump_tray(self):
        if self._dragging:
            return
        pending = int(self._tray_pending.value)
        if pending:
            self._tray_pending.value = 0
            if pending == 1:
                self._restore_from_tray()
            elif pending == 2:
                self._tray_menu()
        try:
            self._tray_job = self.after(80, self._pump_tray)
        except tk.TclError:
            self._tray_job = None

    def _tray_icon(self):
        user32 = ctypes.windll.user32
        small = int(user32.GetSystemMetrics(49) or 16)
        large = int(user32.GetSystemMetrics(11) or 32)
        size = max(32, small * 2, large)
        return load_square_icon(presence_icon(self._on_air), size)

    def _notify(self, action, icon):
        shell32 = ctypes.WinDLL("shell32", use_last_error=True)
        shell32.Shell_NotifyIconW.argtypes = [wintypes.DWORD, ctypes.POINTER(NOTIFYICONDATAW)]
        shell32.Shell_NotifyIconW.restype = wintypes.BOOL
        data = NOTIFYICONDATAW()
        data.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
        data.hWnd = self._tray_hwnd or self._hwnd()
        data.uID = 1
        data.uFlags = NIF_MESSAGE | NIF_TIP | (NIF_ICON if icon else 0)
        data.uCallbackMessage = WM_TRAY
        data.hIcon = icon or 0
        data.szTip = "Spartan Live — ao vivo" if self._on_air else "Spartan Live"
        return bool(shell32.Shell_NotifyIconW(action, ctypes.byref(data)))

    def _show_tray(self):
        self._install_tray_hook()
        if not self._tray_hwnd:
            return False
        icon = self._tray_icon()
        if not icon:
            return False
        action = NIM_MODIFY if self._tray_added else NIM_ADD
        ok = self._notify(action, icon)
        ctypes.windll.user32.DestroyIcon(icon)
        if ok:
            self._tray_added = True
        return ok

    def _hide_tray(self):
        if not self._tray_added:
            return
        self._notify(NIM_DELETE, None)
        self._tray_added = False

    def _restore_from_tray(self):
        self._in_tray = False
        try:
            self.deiconify()
            self.lift()
            self.focus_force()
        except tk.TclError:
            pass
        hwnd = self._hwnd()
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 9)
            ctypes.windll.user32.SetForegroundWindow(hwnd)
        self._hide_tray()
        self._borderless()
        self.update_idletasks()

    def _tray_menu(self):
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.CreatePopupMenu.restype = wintypes.HMENU
        user32.AppendMenuW.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_size_t, wintypes.LPCWSTR]
        user32.TrackPopupMenu.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND, ctypes.c_void_p]
        user32.TrackPopupMenu.restype = wintypes.UINT
        user32.DestroyMenu.argtypes = [wintypes.HMENU]
        user32.GetCursorPos.argtypes = [ctypes.c_void_p]
        menu = user32.CreatePopupMenu()
        user32.AppendMenuW(menu, 0, 1, "Abrir")
        user32.AppendMenuW(menu, 0, 2, "Sair")

        class POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

        point = POINT()
        user32.GetCursorPos(ctypes.byref(point))
        user32.SetForegroundWindow(self._hwnd())
        command = user32.TrackPopupMenu(menu, 0x0100 | 0x0080 | 0x0008 | 0x0020, point.x, point.y, 0, self._hwnd(), None)
        user32.DestroyMenu(menu)
        if command == 1:
            self._restore_from_tray()
        elif command == 2:
            self.destroy()

    def _paint_presence(self, live):
        self._on_air = bool(live)
        path = presence_icon(self._on_air)
        if path:
            try:
                self.iconbitmap(default=path)
            except tk.TclError:
                pass
        if self._tray_added:
            self._show_tray()

    def _build(self):
        self._caption()
        self.button = PillButton(self, "Transmitir", self.toggle, self.bg, self.accent, "#f6f1f1", height=44)
        self.button.pack(side="bottom", fill="x", padx=18, pady=(6, 8))
        pad = {"padx": 18, "pady": 3}
        title = tk.Label(self, text="Spartan Live", bg=self.bg, fg=self.fg, font=("Segoe UI", 20, "bold"))
        title.pack(anchor="w", padx=18, pady=(6, 0))
        hint = tk.Label(self, text="Escolhe a tela, o som e a imagem.", bg=self.bg, fg=self.muted, wraplength=490, justify="left")
        hint.pack(anchor="w", padx=18, pady=(0, 4))

        self.nick = tk.StringVar(value=self.settings.get("nick", ""))
        self.host = tk.StringVar(value=clean_host(self.settings.get("host") or "", ""))
        chosen = parse_quality(self.settings.get("quality"), self.settings.get("fps"))
        self.quality = tk.StringVar(value=chosen[0])
        self.monitor_index = tk.IntVar(value=int(self.settings.get("monitor") or 0))
        if self.monitor_index.get() >= len(self.monitors):
            self.monitor_index.set(0)

        self._field("Apelido", self.nick)
        self._field("Servidor", self.host)

        self.monitor_labels = [monitor_label(i, monitor) for i, monitor in enumerate(self.monitors)] or ["Tela 1"]
        saved = self.monitor_index.get()
        if saved >= len(self.monitor_labels):
            saved = 0
        self.monitor_choice = tk.StringVar(value=self.monitor_labels[saved])
        self._choice(pad, "Tela", self.monitor_choice, self.monitor_labels)
        self.monitor_choice.trace_add("write", lambda *_args: self._screen_changed())

        self.pc_devices = []
        self.mic_devices = []
        self.pc_by_label = {}
        try:
            self.pc_devices, self.mic_devices = list_sound_devices()
        except Exception:
            self.pc_devices, self.mic_devices = [], []
        pc_labels = ["Sem som do PC"]
        for name in self.pc_devices:
            label = playback_label(name)
            self.pc_by_label[label] = name
            pc_labels.append(label)
        saved_pc = chosen_pc_audio(self.settings.get("pc_audio"), self.pc_devices, system_default_playback())
        saved_pc_label = next((label for label, full in self.pc_by_label.items() if full == saved_pc), "Sem som do PC")
        saved_mic = self.settings.get("mic") or ""
        if saved_mic not in self.mic_devices:
            saved_mic = ""
        self.pc_choice = tk.StringVar(value=saved_pc_label)
        self.mic_choice = tk.StringVar(value=saved_mic or "Sem microfone")
        self._choice(pad, "Som do PC", self.pc_choice, pc_labels)
        self._choice(pad, "Microfone", self.mic_choice, ["Sem microfone", *self.mic_devices])
        self.audio_live = None
        self.live_nick = ""
        self.live_host = ""
        self.pc_choice.trace_add("write", lambda *_args: self._audio_changed())
        self.mic_choice.trace_add("write", lambda *_args: self._audio_changed())

        quality_box = tk.Frame(self, bg=self.bg)
        quality_box.pack(fill="x", **pad)
        tk.Label(quality_box, text="Imagem", bg=self.bg, fg=self.muted).pack(anchor="w")
        quality_grid = tk.Frame(quality_box, bg=self.bg)
        quality_grid.pack(fill="x", pady=(4, 0))
        self.quality_buttons = {}
        for index, (key, label, _width, _height, _fps) in enumerate(QUALITY_OPTIONS):
            button = PillButton(
                quality_grid, label, lambda key=key: self.quality.set(key),
                self.bg, self.field, self.fg, height=34,
            )
            button.configure(width=120)
            button.grid(row=index // 2, column=index % 2, padx=(0, 8), pady=(0, 4), sticky="ew")
            self.quality_buttons[key] = button
        quality_grid.columnconfigure(0, weight=1)
        quality_grid.columnconfigure(1, weight=1)
        self.quality.trace_add("write", lambda *_args: self._paint_quality())
        self._paint_quality()

        self.status = tk.Label(self, text="Parado.", bg=self.bg, fg=self.muted, wraplength=500, justify="left")
        self.status.pack(anchor="w", padx=18, pady=(4, 0))
        self.start_with_windows = tk.BooleanVar(value=read_startup_enabled())
        self.windows_check = tk.Checkbutton(
            self,
            text="Abrir com o Windows, sem iniciar a live",
            variable=self.start_with_windows,
            command=self._startup_toggled,
            bg=self.bg,
            fg=self.fg,
            selectcolor=self.field,
            activebackground=self.bg,
            activeforeground=self.fg,
            highlightthickness=0,
            font=("Segoe UI", 10),
            anchor="w",
        )
        self.windows_check.pack(fill="x", padx=14, pady=(2, 0))

    def _field(self, label, variable):
        frame = tk.Frame(self, bg=self.bg)
        frame.pack(fill="x", padx=18, pady=6)
        tk.Label(frame, text=label, bg=self.bg, fg=self.muted).pack(anchor="w")
        entry = tk.Entry(
            frame, textvariable=variable, bg=self.field, fg=self.fg, insertbackground=self.fg,
            relief="flat", highlightthickness=1, highlightbackground="#343434", highlightcolor=self.accent,
            font=("Segoe UI", 11),
        )
        entry.pack(fill="x", ipady=6, pady=(2, 0))

    def _choice(self, pad, label, variable, labels):
        frame = tk.Frame(self, bg=self.bg)
        frame.pack(fill="x", **pad)
        tk.Label(frame, text=label, bg=self.bg, fg=self.muted, font=("Segoe UI", 10)).pack(anchor="w")
        Choice(frame, variable, labels, self.bg, self.field, self.fg, self.accent).pack(fill="x", pady=(4, 0))

    def _paint_quality(self):
        current = self.quality.get()
        for key, button in self.quality_buttons.items():
            selected = key == current
            button.fill = self.accent if selected else self.field
            button.fg = "#f6f1f1" if selected else self.fg
            button.redraw()

    def selected_quality(self):
        return parse_quality(self.quality.get())

    def selected_monitor(self):
        try:
            return self.monitor_labels.index(self.monitor_choice.get())
        except ValueError:
            return 0

    def selected_pc_audio(self):
        return self.pc_by_label.get(self.pc_choice.get(), "")

    def selected_mic(self):
        choice = self.mic_choice.get()
        if choice == "Sem microfone" or choice not in self.mic_devices:
            return ""
        return choice

    def set_status(self, text):
        self.status.config(text=text)

    def save_settings(self):
        data = {
            "nick": self.nick.get().strip(),
            "host": clean_host(self.host.get(), ""),
            "quality": self.selected_quality()[0],
            "fps": self.selected_quality()[4],
            "monitor": self.selected_monitor(),
            "pc_audio": self.selected_pc_audio(),
            "mic": self.selected_mic(),
            "start_with_windows": bool(self.start_with_windows.get()),
        }
        with open(settings_path(), "w", encoding="utf-8") as handle:
            json.dump(data, handle)

    def _startup_toggled(self):
        enabled = bool(self.start_with_windows.get())
        if not write_startup(enabled):
            self.start_with_windows.set(read_startup_enabled())
            self.set_status("Não consegui mudar a abertura com o Windows.")
            return
        try:
            self.save_settings()
        except OSError:
            pass
        self.set_status("Vai abrir com o Windows." if enabled else "Não abre mais com o Windows.")

    def toggle(self):
        if self.running:
            self.stop()
            return
        self.start()

    def start(self):
        nick = self.nick.get().strip()
        host = clean_host(self.host.get(), "")
        self.host.set(host)
        if not valid_nick(nick):
            messagebox.showerror("Spartan Live", "O apelido precisa ter 2 a 24 letras, números, _ ou -.")
            return
        if not host or not self.publish.get("password") or not self.publish.get("user"):
            messagebox.showerror("Spartan Live", "Falta o servidor neste programa.")
            return
        ffmpeg = existing_file("ffmpeg.exe")
        if not ffmpeg:
            messagebox.showerror("Spartan Live", "Não achei o ffmpeg neste programa.")
            return

        self.save_settings()
        self.running = True
        self.stopping = False
        self.button.config(text="Parar")
        self.set_status("Preparando a captura...")
        output_idx = self.selected_monitor()
        pc_audio = self.selected_pc_audio()
        mic = self.selected_mic()
        threading.Thread(target=self._run, args=(ffmpeg, nick, host, output_idx, pc_audio, mic), daemon=True).start()

    def _run(self, ffmpeg, nick, host, output_idx, pc_audio, mic):
        try:
            self._transmit(ffmpeg, nick, host, output_idx, pc_audio, mic)
        except Exception as error:
            self.after(0, lambda: self._fail(f"A captura falhou: {error}"))

    def _transmit(self, ffmpeg, nick, host, output_idx, pc_audio, mic):
        self.after(0, lambda: self.set_status("Conferindo o encoder..."))
        try:
            encoders = usable_encoders(ffmpeg)
        except (OSError, subprocess.SubprocessError) as error:
            self.after(0, lambda: self._fail(f"Não consegui consultar o ffmpeg: {error}"))
            return
        if self.stopping:
            return
        if not encoders:
            self.after(0, lambda: self._fail("Esse ffmpeg não tem encoder H.264."))
            return

        publish = dict(self.publish)
        publish["host"] = host
        url = rtmp_url(publish, nick)
        _key, _label, width, height, fps = self.selected_quality()
        monitor = self.monitors[output_idx]

        last_error = "A transmissão caiu."
        self.live_nick = nick
        self.live_host = host
        log_event(f"inicio apelido={nick} {width}x{height} fps={fps} pc={pc_audio or '-'} mic={mic or '-'}")
        notify_publisher(host, nick, self.publish.get("user", ""), self.publish.get("password", ""), "claim")
        live_audio = None
        if pc_audio or mic:
            self.after(0, lambda: self.set_status("Abrindo o som do PC..."))
            live_audio = LiveAudio(pc_audio, mic)
            try:
                run_with_timeout(live_audio.start, 5)
                self.audio_live = live_audio
            except TimeoutError:
                live_audio.close()
                self.after(0, lambda: self._fail("O som do PC não abriu. Escolhe outro dispositivo, ou Sem som do PC."))
                return
            except Exception as error:
                live_audio.close()
                self.after(0, lambda message=str(error): self._fail(message))
                return
        if pc_audio and mic:
            note = " Com som do PC e microfone."
        elif pc_audio:
            note = " Com som do PC."
        elif mic:
            note = " Com microfone."
        else:
            note = ""
        preferred = None
        try:
            while not self.stopping:
                output_idx = self._consume_switch(output_idx)
                if output_idx >= len(self.monitors):
                    output_idx = 0
                self._live_monitor = output_idx
                monitor = self.monitors[output_idx]
                order = [preferred, *[item for item in encoders if item != preferred]] if preferred else encoders
                restarted = False
                lost = False
                for encoder in order:
                    if self.stopping:
                        return
                    if live_audio is None:
                        command = build_command(
                            ffmpeg, "gdigrab", encoder, fps, monitor, output_idx, url, False, width, height,
                        )
                        outcome = self._attempt(command, encoder, fps, "gdigrab", None, note, width, height)
                    else:
                        self._av_ticket += 1
                        port = 20000 + ((os.getpid() + self._av_ticket) % 20000)
                        relay = f"tcp://127.0.0.1:{port}"
                        pipe = rf"\\.\pipe\spartan-live-{os.getpid()}-{self._av_ticket}"
                        video = build_command(
                            ffmpeg, "gdigrab", encoder, fps, monitor, output_idx, url, True, width, height, relay,
                        )
                        outcome = self._attempt_synced(
                            video, pipe, relay, url, encoder, fps, live_audio, note, width, height,
                        )
                    if outcome == "switch":
                        preferred = encoder
                        restarted = True
                        break
                    if outcome == "down" or self.stopping:
                        return
                    last_error = getattr(self, "last_error", last_error)
                    if outcome == "lost":
                        lost = True
                        break
                if restarted:
                    continue
                if lost or getattr(self, "_lost_since", None) is not None:
                    if self._retry_capture():
                        continue
                    self.after(0, lambda detail=last_error: self._fail(detail))
                    return
                self.after(0, lambda detail=last_error: self._fail(detail))
                return
        finally:
            self.audio_live = None
            if live_audio is not None:
                live_audio.close()

    def _consume_switch(self, current):
        nxt = self._switch_to
        self._switch_to = None
        if isinstance(nxt, int) and 0 <= nxt < len(self.monitors):
            return nxt
        return current

    def _screen_changed(self):
        try:
            self.save_settings()
        except Exception:
            pass
        if not self.running or self.stopping:
            return
        index = self.selected_monitor()
        if index == getattr(self, "_live_monitor", None) and self._switch_to is None:
            return
        if not 0 <= index < len(self.monitors):
            return
        self._switch_ticket += 1
        ticket = self._switch_ticket
        self._switch_to = index
        self._switch_ready = False
        self.set_status("Trocando a tela...")
        threading.Thread(target=self._announce_switch, args=(ticket,), daemon=True).start()

    def _announce_switch(self, ticket):
        nick = self.live_nick
        host = self.live_host
        log_event(f"troca de tela apelido={nick or '-'}")
        try:
            notify_publisher(host, nick, self.publish.get("user", ""), self.publish.get("password", ""), "switch")
        finally:
            if ticket == self._switch_ticket:
                self._switch_ready = True

    def _wait_proc(self, proc, timeout=None):
        deadline = None if timeout is None else time.perf_counter() + timeout
        while proc.poll() is None:
            stalled = timeout is None and capture_stalled(
                getattr(self, "_frame_seen", 0),
                getattr(self, "_frame_at", time.perf_counter()),
                time.perf_counter(),
            )
            if self.stopping or stalled or (self._switch_to is not None and self._switch_ready):
                if stalled and not self.stopping:
                    log_event("captura parada, retomando")
                    self._hold_viewers()
                self._kill_ffmpeg()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
                return proc.poll()
            slice_timeout = 0.2
            if deadline is not None:
                left = deadline - time.perf_counter()
                if left <= 0:
                    raise subprocess.TimeoutExpired(proc.args, timeout)
                slice_timeout = min(0.2, left)
            try:
                return proc.wait(timeout=slice_timeout)
            except subprocess.TimeoutExpired:
                continue
        return proc.poll()

    def _kill_ffmpeg(self):
        for proc in (getattr(self, "proc", None), getattr(self, "video_proc", None)):
            if proc is None or proc.poll() is not None:
                continue
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )

    def _track_processes(self, *procs):
        previous = getattr(self, "_capture_job", None)
        job = None
        for proc in procs:
            if proc is not None:
                job = assign_kill_with_parent(proc, job)
        self._capture_job = job
        if previous:
            ctypes.windll.kernel32.CloseHandle(previous)
        if not job:
            log_event("captura sem vinculo de encerramento")

    def _note_ffmpeg(self, text, lines, secret):
        if not text:
            return
        if secret:
            text = text.replace(secret, "******")
        if "Non-monotonic DTS" in text or text.startswith("frame="):
            return
        lowered = text.lower()
        if "error" in lowered or "invalid" in lowered or "failed" in lowered:
            lines.append(text)
            self.last_error = text
            log_event("ffmpeg " + text[:300])

    def _read_progress(self, proc):
        if not proc.stdout:
            return
        for line in proc.stdout:
            text = line.decode("utf-8", "replace").strip() if isinstance(line, bytes) else line.strip()
            seconds = progress_seconds(text)
            if seconds is not None and seconds > self._video_time:
                self._video_time = seconds
            if not text.startswith("frame="):
                continue
            try:
                count = int(text.split("=", 1)[1].strip())
            except ValueError:
                continue
            if count > self._frame_seen:
                self._frame_seen = count
                self._frame_at = time.perf_counter()

    def _close_progress(self):
        sock = getattr(self, "_progress_sock", None)
        self._progress_sock = None
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    def _spawn(self, command, stdout):
        return subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

    def _attempt_synced(self, video_command, pipe_name, relay, rtmp, encoder, fps, live_audio, note, width, height):
        """A imagem é codificada sozinha. O som entra em seguida, na ordem da captura."""
        if self.stopping:
            self._close_progress()
            return "down"
        self.last_error = ""
        self._frame_seen = 0
        self._frame_at = time.perf_counter()
        self._video_time = 0.0
        try:
            live_audio.open_pipe(pipe_name)
        except OSError as error:
            self._close_progress()
            self.last_error = str(error)
            log_event(f"cano do som {error}")
            return False
        try:
            video = self._spawn(video_command, subprocess.PIPE)
        except OSError as error:
            live_audio.detach()
            self.last_error = str(error)
            log_event(f"ffmpeg nao abriu {error}")
            return False
        self.video_proc = video
        self.proc = None
        started = threading.Event()
        clock = {}
        lines = []
        secret = str(self.publish.get("password") or "")

        def read_video_err():
            if not video.stderr:
                return
            for line in video.stderr:
                text = line.strip()
                found = video_clock(text)
                if found is not None and "t" not in clock:
                    clock["t"] = found
                    started.set()
                self._note_ffmpeg(text, lines, secret)

        threading.Thread(target=read_video_err, daemon=True).start()
        self.progress_reader = threading.Thread(target=self._read_progress, args=(video,), daemon=True)
        self.progress_reader.start()
        if not started.wait(4):
            self._kill_ffmpeg()
            live_audio.detach()
            self.video_proc = None
            self.last_error = lines[-1] if lines else "A imagem não informou o horário."
            return False
        started_at = clock["t"]
        live_audio.attach(lambda: time.time() - started_at)
        log_event("som na ordem da captura")
        try:
            mux = self._spawn(build_mux_command(video_command[0], pipe_name, relay, 0.0, rtmp), subprocess.DEVNULL)
        except OSError as error:
            self._kill_ffmpeg()
            live_audio.detach()
            self._close_progress()
            self.video_proc = None
            self.last_error = str(error)
            log_event(f"ffmpeg nao abriu {error}")
            return False
        self.proc = mux
        self._track_processes(video, mux)

        def read_mux_err():
            if not mux.stderr:
                return
            for line in mux.stderr:
                self._note_ffmpeg(line.strip(), lines, secret)

        self.reader = threading.Thread(target=read_mux_err, daemon=True)
        self.reader.start()
        return self._watch_result(mux, live_audio, lines, encoder, fps, note, width, height, "gdigrab")

    def _watch_result(self, proc, live_audio, lines, encoder, fps, note, width, height, mode):
        try:
            code = self._wait_proc(proc, 2.5)
        except subprocess.TimeoutExpired:
            code = None

        if code is None and proc.poll() is None:
            label = ENCODER_LABEL.get(encoder, encoder)
            extra = " PC pode ficar pesado; 720p 30 alivia." if encoder == "libx264" and height >= 1080 and fps >= 60 else ""
            message = f"Transmitindo em {height}p a {fps} fps ({label}).{note}{extra}"
            self.after(0, lambda message=message: self._live(message))
            self._wait_proc(proc)
            if not self.stopping and self._switch_to is not None:
                if live_audio is not None:
                    live_audio.detach()
                self.proc = None
                self.video_proc = None
                self._close_progress()
                return "switch"
            if not self.stopping:
                self.last_error = self.last_error or "A transmissão parou."
                if live_audio is not None:
                    live_audio.detach()
                self.proc = None
                self.video_proc = None
                self._close_progress()
                return "lost"
            if live_audio is not None:
                live_audio.detach()
            self._close_progress()
            return "down"

        self.last_error = lines[-1] if lines else f"A captura {mode} não iniciou."
        if live_audio is not None:
            live_audio.detach()
        self._kill_ffmpeg()
        self._close_progress()
        if not self.stopping and self._switch_to is not None:
            self.proc = None
            self.video_proc = None
            return "switch"
        self.proc = None
        self.video_proc = None
        return False

    def _attempt(self, command, encoder, fps, mode, live_audio=None, note="", width=1920, height=1080):
        if self.stopping:
            return "down"
        self.last_error = ""
        self._frame_seen = 0
        self._frame_at = time.perf_counter()
        try:
            proc = self._spawn(command, subprocess.PIPE)
        except OSError as error:
            self.last_error = str(error)
            log_event(f"ffmpeg nao abriu {error}")
            return False

        self.proc = proc
        self.video_proc = None
        self._track_processes(proc)
        lines = []
        secret = str(self.publish.get("password") or "")

        def read_stderr():
            if not proc.stderr:
                return
            for line in proc.stderr:
                text = line.decode("utf-8", "replace").strip() if isinstance(line, bytes) else line.strip()
                if secret:
                    text = text.replace(secret, "******")
                if text:
                    lines.append(text)
                    self.last_error = text
                    if not text.startswith("frame="):
                        log_event("ffmpeg " + text[:300])

        self.reader = threading.Thread(target=read_stderr, daemon=True)
        self.reader.start()
        self.progress_reader = threading.Thread(target=self._read_progress, args=(proc,), daemon=True)
        self.progress_reader.start()
        return self._watch_result(proc, live_audio, lines, encoder, fps, note, width, height, mode)

    def _retry_capture(self):
        if self.stopping:
            return False
        now = time.perf_counter()
        if getattr(self, "_lost_since", None) is None:
            self._lost_since = now
        if now - self._lost_since > 45:
            return False
        self.after(0, lambda: self.set_status("A tela mudou, retomando a live..."))
        self._hold_viewers()
        deadline = time.perf_counter() + 1.5
        while time.perf_counter() < deadline:
            if self.stopping:
                return False
            time.sleep(0.2)
        return not self.stopping

    def _hold_viewers(self):
        now = time.perf_counter()
        if now - getattr(self, "_hold_at", 0) < 12:
            return
        self._hold_at = now
        nick = self.live_nick
        host = self.live_host
        if not nick or not host:
            return
        threading.Thread(
            target=notify_publisher,
            args=(host, nick, self.publish.get("user", ""), self.publish.get("password", ""), "switch"),
            daemon=True,
        ).start()

    def _live(self, text):
        if self.stopping:
            return
        self._lost_since = None
        self.button.config(text="Parar")
        self.set_status(text)
        self._paint_presence(True)
        self._send_thumb()

    def _send_thumb(self):
        index = getattr(self, "_live_monitor", None)
        if self.stopping or not isinstance(index, int) or not 0 <= index < len(self.monitors):
            return
        nick = self.live_nick
        host = self.live_host
        if not nick or not host:
            return
        monitor = dict(self.monitors[index])
        ffmpeg = existing_file("ffmpeg.exe")
        user = str(self.publish.get("user") or "")
        password = str(self.publish.get("password") or "")
        threading.Thread(
            target=self._thumb_job,
            args=(ffmpeg, monitor, host, nick, user, password),
            daemon=True,
        ).start()

    def _thumb_job(self, ffmpeg, monitor, host, nick, user, password):
        if not ffmpeg or self.stopping or self.live_nick != nick:
            return
        data = grab_thumb(ffmpeg, monitor)
        if not data or self.stopping or self.live_nick != nick:
            return
        upload_thumb(host, nick, user, password, data)

    def _fail(self, text):
        self.running = False
        self.proc = None
        self.video_proc = None
        self.button.config(text="Transmitir")
        message = explain_error(text)
        self.set_status(message)
        log_event("falha " + message[:300])
        self._paint_presence(False)
        if self._in_tray:
            self._restore_from_tray()
        if not self.stopping:
            messagebox.showerror("Spartan Live", message)

    def _audio_changed(self):
        if not getattr(self, "status", None):
            return
        try:
            self.save_settings()
        except Exception:
            pass
        audio = self.audio_live
        if not self.running or audio is None:
            return
        try:
            audio.retarget(self.selected_pc_audio(), self.selected_mic())
            log_event(f"som pc={self.selected_pc_audio() or '-'} mic={self.selected_mic() or '-'}")
            self.set_status("Som atualizado na live.")
        except Exception as error:
            self.set_status(f"Não troquei o som: {error}")

    def _signal_stop(self):
        nick = self.live_nick
        host = self.live_host
        if not nick or not host:
            return
        self.live_nick = ""
        log_event(f"parado apelido={nick}")
        notify_stopped(host, nick, self.publish.get("user", ""), self.publish.get("password", ""))

    def destroy(self):
        self._hide_tray()
        tray = self._tray_hwnd
        self._tray_hwnd = None
        if tray:
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            user32.DestroyWindow.argtypes = [wintypes.HWND]
            user32.DestroyWindow(tray)
        if self.running:
            self.stop()
        super().destroy()

    def stop(self):
        self._switch_to = None
        self._signal_stop()
        self.stopping = True
        self.running = False
        self._paint_presence(False)
        self._kill_ffmpeg()
        self.proc = None
        self.video_proc = None
        self.button.config(text="Transmitir")
        self.set_status("Parado.")


def main():
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("SpartanLive.Publisher")
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass
    app = App()
    app.mainloop()


if __name__ == "__main__":
    main()
