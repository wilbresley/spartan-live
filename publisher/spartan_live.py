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
from urllib.parse import quote

from PySide6.QtCore import Qt, QTimer, QRectF, QPoint, QEvent, QObject, QSize, Signal
from PySide6.QtGui import QPainter, QColor, QPen, QFont, QFontMetrics, QPainterPath, QIcon, QCursor
from PySide6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QHBoxLayout, QGridLayout,
    QLabel, QLineEdit, QCheckBox, QScrollArea, QFrame, QMessageBox,
)

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
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "ffmpeg"),
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
    if action not in ("stop", "claim", "switch", "thumb", "viewers") or not text:
        return []
    local = f"http://{text}:8097/api/{action}"
    if looks_like_ip(text):
        return [local]
    return [f"https://{text}/api/{action}", local]


def notify_publisher(host, nick, user, password, action, extra=None):
    targets = notify_targets(host, action)
    if not targets or not nick or not user or not password:
        return
    payload = {"name": nick, "user": user, "password": password}
    if isinstance(extra, dict):
        payload.update(extra)
    body = json.dumps(payload).encode("utf-8")
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


def fetch_viewers(host, nick, user, password):
    targets = notify_targets(host, "viewers")
    if not targets or not nick or not user or not password:
        return 0
    payload = json.dumps({"name": nick, "user": user, "password": password}).encode("utf-8")
    for url in targets:
        request = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                body = json.loads(response.read().decode("utf-8", "replace"))
            return max(0, int(body.get("viewers") or 0))
        except Exception:
            continue
    return 0


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


class _GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_uint32),
        ("Data2", ctypes.c_uint16),
        ("Data3", ctypes.c_uint16),
        ("Data4", ctypes.c_ubyte * 8),
    ]


class _DXGI_RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class _DXGI_OUTPUT_DESC(ctypes.Structure):
    _fields_ = [
        ("DeviceName", ctypes.c_wchar * 32),
        ("DesktopCoordinates", _DXGI_RECT),
        ("AttachedToDesktop", ctypes.c_int),
        ("Rotation", ctypes.c_uint),
        ("Monitor", ctypes.c_void_p),
    ]


def _guid(value):
    text = value.replace("-", "")
    tail = bytes.fromhex(text[16:])
    return _GUID(
        int(text[0:8], 16),
        int(text[8:12], 16),
        int(text[12:16], 16),
        (ctypes.c_ubyte * 8)(*tail),
    )


def _com(ptr, index, restype, *argtypes):
    table = ctypes.cast(ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    proto = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)
    return proto(table[index])


def _release(ptr):
    if ptr:
        _com(ptr, 2, ctypes.c_ulong)(ptr)


def _dxgi_outputs():
    dxgi = ctypes.WinDLL("dxgi")
    factory = ctypes.c_void_p()
    iid = _guid("770aae78-f26f-4dba-a829-253c83d1b387")
    if dxgi.CreateDXGIFactory1(ctypes.byref(iid), ctypes.byref(factory)) < 0 or not factory.value:
        return []
    outputs = []
    try:
        for adapter_index in range(16):
            adapter = ctypes.c_void_p()
            if _com(factory, 7, ctypes.c_long, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p))(
                factory, adapter_index, ctypes.byref(adapter),
            ) < 0 or not adapter.value:
                break
            try:
                for output_index in range(16):
                    output = ctypes.c_void_p()
                    if _com(adapter, 7, ctypes.c_long, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p))(
                        adapter, output_index, ctypes.byref(output),
                    ) < 0 or not output.value:
                        break
                    try:
                        desc = _DXGI_OUTPUT_DESC()
                        if _com(output, 7, ctypes.c_long, ctypes.POINTER(_DXGI_OUTPUT_DESC))(
                            output, ctypes.byref(desc),
                        ) < 0 or not desc.AttachedToDesktop:
                            continue
                        box = desc.DesktopCoordinates
                        outputs.append({
                            "left": int(box.left),
                            "top": int(box.top),
                            "width": int(box.right - box.left),
                            "height": int(box.bottom - box.top),
                        })
                    finally:
                        _release(output)
            finally:
                _release(adapter)
    finally:
        _release(factory)
    return outputs


def list_dxgi_outputs():
    try:
        return _dxgi_outputs()
    except Exception:
        return []


def match_output_index(monitor, outputs):
    left = int(monitor["left"])
    top = int(monitor["top"])
    for index, output in enumerate(outputs or []):
        if int(output["left"]) == left and int(output["top"]) == top:
            return index
    return None


def capture_output_index(monitor, output_idx):
    found = monitor.get("output") if isinstance(monitor, dict) else None
    if isinstance(found, int) and not isinstance(found, bool) and found >= 0:
        return found
    return int(output_idx)


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
    outputs = list_dxgi_outputs()
    for index, monitor in enumerate(monitors):
        found = match_output_index(monitor, outputs)
        monitor["output"] = index if found is None else found
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
    ("480p30", "480p 30", 854, 480, 30),
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
    if int(height) <= 480:
        limit = "1500k"
        window = "3000k"
    elif int(height) <= 720:
        rate = (8 if fps >= 60 else 5) if hardware else (6 if fps >= 60 else 4)
        limit = f"{rate}M"
        window = f"{rate * 2}M"
    else:
        rate = (14 if fps >= 60 else 8) if hardware else (12 if fps >= 60 else 8)
        limit = f"{rate}M"
        window = f"{rate * 2}M"
    common = ["-b:v", limit, "-maxrate", limit, "-bufsize", window, "-g", gop, "-bf", "0", "-pix_fmt", "yuv420p"]
    if encoder == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "cbr", "-profile:v", "high", *common]
    if encoder == "h264_amf":
        return ["-c:v", "h264_amf", "-quality", "quality", "-rc", "cbr", *common]
    if encoder == "h264_qsv":
        return ["-c:v", "h264_qsv", "-preset", "medium", "-profile:v", "high", *common]
    preset = "ultrafast" if (int(height) <= 480 or (int(height) <= 720 and fps >= 60)) else "veryfast"
    return ["-c:v", "libx264", "-preset", preset, "-tune", "zerolatency", "-profile:v", "high", *common]


def scale_filter(width=1920, height=1080, mode="gdigrab"):
    scale = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p"
    )
    if mode == "ddagrab":
        return f"hwdownload,format=bgra,{scale}"
    return scale


def prefer_capture(filter_listing):
    for line in (filter_listing or "").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "ddagrab":
            return "ddagrab"
    return "gdigrab"


def ffmpeg_filters(ffmpeg):
    try:
        done = subprocess.run(
            [ffmpeg, "-hide_banner", "-filters"],
            capture_output=True,
            text=True,
            timeout=8,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return f"{done.stdout or ''}\n{done.stderr or ''}"


def capture_input(mode, fps, monitor, output_idx):
    if mode == "ddagrab":
        index = capture_output_index(monitor, output_idx)
        spec = f"ddagrab=output_idx={index}:framerate={int(fps)}:draw_mouse=1"
        return ["-f", "lavfi", "-i", spec]
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


def progress_speed(line):
    """Velocidade real de codificação/envio lida do progresso do ffmpeg (ex.: '0.82x' -> 0.82)."""
    text = (line or "").strip()
    if not text.startswith("speed="):
        return None
    raw = text.split("=", 1)[1].strip().rstrip("xX")
    if not raw or raw.upper() == "N/A":
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def network_slow_streak(streak, speed, threshold=0.88):
    if speed is None:
        return streak
    return streak + 1 if float(speed) < threshold else 0


def clamp_gain(percent):
    return max(0, min(150, int(round(float(percent) / 5.0) * 5)))


def peak_level(stereo):
    if stereo is None or len(stereo) == 0:
        return 0.0
    peak = float(np.max(np.abs(stereo)))
    return min(1.0, max(0.0, peak * 1.8))


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
        "-filter:v", scale_filter(width, height, mode),
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

    def __init__(self, pc_name, mic_name, pc_gain=1.0, mic_gain=1.0):
        self.pc_name = pc_name
        self.mic_name = mic_name
        self.pc_gain = max(0.0, min(1.5, float(pc_gain)))
        self.mic_gain = max(0.0, min(1.5, float(mic_gain)))
        self.mic_muted = False
        self.levels = {"pc": 0.0, "mic": 0.0}
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

    def set_gains(self, pc_gain=None, mic_gain=None, mic_muted=None):
        if pc_gain is not None:
            self.pc_gain = max(0.0, min(1.5, float(pc_gain)))
        if mic_gain is not None:
            self.mic_gain = max(0.0, min(1.5, float(mic_gain)))
        if mic_muted is not None:
            self.mic_muted = bool(mic_muted)

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
                gain = 0.0 if (key == "mic" and self.mic_muted) else (self.pc_gain if key == "pc" else self.mic_gain)
                if gain != 1.0:
                    stereo = np.clip(stereo * np.float32(gain), -1.0, 1.0)
                self.levels[key] = peak_level(stereo)
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


def valid_saved_geom(geom, monitors):
    match = re.match(r"^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$", str(geom or "").strip())
    if not match:
        return None
    w, h, x, y = (int(part) for part in match.groups())
    if w < 200 or h < 200:
        return None
    cx = x + w // 2
    cy = y + min(40, h // 2)
    for mon in monitors or []:
        ml = int(mon.get("left", 0))
        mt = int(mon.get("top", 0))
        mr = ml + int(mon.get("width", 1920))
        mb = mt + int(mon.get("height", 1080))
        if ml <= cx <= mr and mt <= cy <= mb:
            return f"{w}x{h}+{x}+{y}"
    return None


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


class _QtVar:
    """Variável reativa compatível com .get(), .set() e .trace_add('write', cb)."""

    def __init__(self, value=None):
        self._value = value
        self._callbacks = []
        self._sync_fn = None

    def get(self):
        if self._sync_fn is not None:
            return self._sync_fn()
        return self._value

    def set(self, value):
        self._value = value
        for cb in list(self._callbacks):
            try:
                cb()
            except Exception:
                pass

    def trace_add(self, _mode, callback):
        self._callbacks.append(callback)
        return f"trace_{len(self._callbacks)}"


def _ensure_qt_app():
    os.environ.setdefault("QT_ENABLE_HIGHDPI_SCALING", "0")
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv[:1] or ["SpartanLive"])
    return app


class _ChoicePopup(QFrame):
    def __init__(self, owner, labels, field, fg, accent, line):
        super().__init__(None, Qt.WindowType.Popup | Qt.WindowType.FramelessWindowHint | Qt.WindowType.NoDropShadowWindowHint)
        self.owner = owner
        self.setStyleSheet(
            f"QFrame {{ background-color: {field}; border: 1px solid {line}; border-radius: 10px; }}"
            f"QScrollArea {{ background: transparent; border: none; }}"
        )
        layout = QVBoxLayout(self)
        layout.setContentsMargins(2, 4, 2, 4)
        layout.setSpacing(0)
        scroll = QScrollArea(self)
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        inner = QWidget()
        inner.setStyleSheet(f"background-color: {field}; border: none;")
        vbox = QVBoxLayout(inner)
        vbox.setContentsMargins(2, 2, 2, 2)
        vbox.setSpacing(1)
        for label in labels:
            item = QLabel(label, inner)
            item.setFont(QFont("Segoe UI", 10))
            item.setCursor(Qt.CursorShape.PointingHandCursor)
            item.setStyleSheet(
                f"QLabel {{ background-color: {field}; color: {fg}; padding: 7px 12px; border-radius: 6px; border: none; }}"
                f"QLabel:hover {{ background-color: {accent}; color: #f6f1f1; }}"
            )
            item.mousePressEvent = lambda _ev, val=label: self.owner.pick(val)
            vbox.addWidget(item)
        scroll.setWidget(inner)
        layout.addWidget(scroll)

    def hideEvent(self, event):
        super().hideEvent(event)
        if self.owner.popup is self:
            self.owner.popup = None


class Choice(QWidget):
    """Lista escura com canto arredondado e anti-aliasing nativo Qt."""

    def __init__(self, master, variable, labels, bg, field, fg, accent):
        _ensure_qt_app()
        super().__init__(master if isinstance(master, QWidget) else None)
        self.variable = variable
        self.labels = list(labels) or [""]
        self.bg = bg
        self.field = field
        self.fg = fg
        self.accent = accent
        self.line = "#343434"
        self.popup = None
        self.canvas = self
        self.setFixedHeight(44)
        self.setMinimumWidth(80)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.variable.trace_add("write", lambda *_args: self.redraw())

    def pack(self, **_kwargs):
        return

    def find_all(self):
        return [1]

    def type(self, _item):
        return "image"

    def itemcget(self, _item, key):
        return self.field if key == "fill" else ""

    def _wheel_cycle(self, event):
        if not self.labels or len(self.labels) <= 1:
            return "break"
        delta = int(getattr(event, "delta", 0) or 0)
        if delta == 0:
            return "break"
        step = -1 if delta > 0 else 1
        current = self.variable.get()
        try:
            idx = self.labels.index(current)
        except ValueError:
            idx = 0
        next_idx = max(0, min(len(self.labels) - 1, idx + step))
        if self.labels[next_idx] != current:
            self.variable.set(self.labels[next_idx])
        return "break"

    def wheelEvent(self, event):
        delta = event.angleDelta().y()
        self._wheel_cycle(type("Ev", (), {"delta": delta})())
        event.accept()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.open_menu()
            event.accept()

    def redraw(self):
        self.update()

    def paintEvent(self, _event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
        w = max(40, self.width())
        h = self.height()
        path = QPainterPath()
        path.addRoundedRect(QRectF(1.0, 1.0, w - 2.0, h - 2.0), 12.0, 12.0)
        painter.fillPath(path, QColor(self.field))
        pen = QPen(QColor(self.line), 1.0)
        painter.setPen(pen)
        painter.drawPath(path)

        font = QFont("Segoe UI", 10)
        painter.setFont(font)
        fm = QFontMetrics(font)
        shown = fm.elidedText(str(self.variable.get() or ""), Qt.TextElideMode.ElideRight, max(40, w - 48))
        painter.setPen(QColor(self.fg))
        painter.drawText(QRectF(16, 0, max(40, w - 48), h), int(Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft), shown)

        arrow_font = QFont("Segoe UI", 11)
        painter.setFont(arrow_font)
        painter.setPen(QColor("#9a9a9a"))
        painter.drawText(QRectF(w - 30, 0, 20, h), int(Qt.AlignmentFlag.AlignCenter), "▾")
        painter.end()

    def open_menu(self):
        self.close_menu()
        w = max(self.width(), 220)
        row = 36
        h = min(320, 12 + row * len(self.labels))
        popup = _ChoicePopup(self, self.labels, self.field, self.fg, self.accent, self.line)
        popup.setFixedSize(w, h)
        global_pos = self.mapToGlobal(QPoint(0, self.height() + 4))
        popup.move(global_pos)
        self.popup = popup
        popup.show()

    def pick(self, label):
        self.variable.set(label)
        self.close_menu()

    def close_menu(self):
        popup = self.popup
        self.popup = None
        if popup is not None:
            popup.close()


class _MiniTagButton(QLabel):
    def __init__(self, parent, text, bg, fg, accent, on_click):
        super().__init__(text, parent)
        self._text = text
        self._bg = bg
        self._fg = fg
        self._accent = accent
        self._on_click = on_click
        self.setFont(QFont("Segoe UI", 8, QFont.Weight.Bold))
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setFixedHeight(20)
        self.setContentsMargins(6, 1, 6, 1)
        self._apply_style(False)

    def _apply_style(self, hover):
        bg = self._accent if hover else self._bg
        fg = "#f6f1f1" if hover else self._fg
        self.setStyleSheet(f"QLabel {{ background-color: {bg}; color: {fg}; border-radius: 5px; padding: 1px 5px; }}")

    def enterEvent(self, event):
        self._apply_style(True)
        super().enterEvent(event)

    def leaveEvent(self, event):
        self._apply_style(False)
        super().leaveEvent(event)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._on_click()
            event.accept()

    def cget(self, key):
        if key == "text":
            return self.text()
        return ""


class _VolumeTrackCanvas(QWidget):
    def __init__(self, pill):
        super().__init__(pill)
        self.pill = pill
        self.setFixedSize(112, 20)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.pill._pick_x(event.position().x())
            event.accept()

    def mouseMoveEvent(self, event):
        if event.buttons() & Qt.MouseButton.LeftButton:
            self.pill._pick_x(event.position().x())
            event.accept()

    def paintEvent(self, _event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
        w = self.width()
        h = self.height()
        bar_w = max(20, w - 42)
        val = clamp_gain(self.pill.variable.get() or 0)
        ratio = min(1.0, max(0.0, val / 150.0))
        y0 = h // 2 - 3
        track_path = QPainterPath()
        track_path.addRoundedRect(QRectF(4, y0, bar_w, 6), 3.0, 3.0)
        painter.fillPath(track_path, QColor("#2a2a2a"))
        fill_color = "#555555" if self.pill.muted or val == 0 else self.pill.accent
        if ratio > 0:
            fill_w = max(4.0, bar_w * ratio)
            fill_path = QPainterPath()
            fill_path.addRoundedRect(QRectF(4, y0, fill_w, 6), 3.0, 3.0)
            painter.fillPath(fill_path, QColor(fill_color))
        if self.pill.level > 0.02 and not self.pill.muted and val > 0:
            meter_w = max(2.0, bar_w * min(1.0, self.pill.level))
            painter.fillRect(QRectF(4, y0 + 7, meter_w, 2), QColor("#3dbe6e"))
        label = "Mudo" if self.pill.muted else f"{val}%"
        painter.setFont(QFont("Segoe UI", 8))
        painter.setPen(QColor(self.pill.fg))
        painter.drawText(QRectF(0, 0, w - 2, h), int(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter), label)
        painter.end()


class VolumePill(QWidget):
    def __init__(self, master, variable, command, bg, field, fg, accent):
        _ensure_qt_app()
        super().__init__(master if isinstance(master, QWidget) else None)
        self.variable = variable
        self.command = command
        self.field = field
        self.fg = fg
        self.accent = accent
        self.level = 0.0
        self.muted = False
        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(4)
        self.zero_btn = _MiniTagButton(self, "0%", "#252525", fg, accent, lambda: self._set_exact(0))
        self.canvas = _VolumeTrackCanvas(self)
        self.hundred_btn = _MiniTagButton(self, "100%", "#252525", fg, accent, lambda: self._set_exact(100))
        row.addWidget(self.zero_btn)
        row.addWidget(self.canvas)
        row.addWidget(self.hundred_btn)
        self.variable.trace_add("write", lambda *_args: self.redraw())

    def _set_exact(self, val):
        self.variable.set(clamp_gain(val))
        if self.command:
            self.command()
        return "break"

    def _wheel(self, event):
        delta = int(getattr(event, "delta", 0) or 0)
        if delta == 0:
            return "break"
        step = 5 if delta > 0 else -5
        cur = clamp_gain(self.variable.get() or 0)
        self.variable.set(clamp_gain(cur + step))
        if self.command:
            self.command()
        return "break"

    def wheelEvent(self, event):
        self._wheel(type("Ev", (), {"delta": event.angleDelta().y()})())
        event.accept()

    def set_level(self, level, muted=False):
        level = max(0.0, min(1.0, float(level)))
        if abs(level - self.level) > 0.02 or bool(muted) != self.muted:
            self.level = level
            self.muted = bool(muted)
            self.redraw()

    def _pick_x(self, x):
        w = max(20, self.canvas.width() - 42)
        ratio = max(0.0, min(1.0, (x - 4.0) / w))
        val = clamp_gain(ratio * 150.0)
        self.variable.set(val)
        if self.command:
            self.command()

    def _pick(self, event):
        self._pick_x(getattr(event, "x", 0))
        return "break"

    def redraw(self):
        self.canvas.update()


class PillButton(QWidget):
    def __init__(self, master, text, command, bg, fill, fg, height=48):
        _ensure_qt_app()
        super().__init__(master if isinstance(master, QWidget) else None)
        self.label = text
        self.command = command
        self.bg = bg
        self.fill = fill
        self.fg = fg
        self._height = int(height)
        self.setFixedHeight(self._height)
        self.setMinimumWidth(80)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    def config(self, **kwargs):
        if "text" in kwargs:
            self.label = kwargs.pop("text")
        if "width" in kwargs:
            self.setMinimumWidth(int(kwargs.pop("width")))
        self.redraw()

    configure = config

    def redraw(self):
        self.update()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self.command:
            self.command()
            event.accept()

    def paintEvent(self, _event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
        w = max(40, self.width())
        h = self.height()
        radius = (h - 2.0) / 2.0
        path = QPainterPath()
        path.addRoundedRect(QRectF(1.0, 1.0, w - 2.0, h - 2.0), radius, radius)
        painter.fillPath(path, QColor(self.fill))
        font = QFont("Segoe UI", 10 if h <= 34 else 11, QFont.Weight.Bold)
        painter.setFont(font)
        painter.setPen(QColor(self.fg))
        painter.drawText(QRectF(0, 0, w, h), int(Qt.AlignmentFlag.AlignCenter), self.label)
        painter.end()

    def winfo_y(self):
        parent = self.parentWidget()
        while parent is not None and not isinstance(parent, _ContentWidget):
            parent = parent.parentWidget()
        return self.mapTo(parent or self.window(), QPoint(0, 0)).y()

    def winfo_height(self):
        return self.height()

    def winfo_width(self):
        return self.width()


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


def taskbar_exstyle(exstyle, visible):
    """Aberta, a janela fica na barra. Na bandeja, o botão sai."""
    if visible:
        return (int(exstyle) | 0x00040000) & ~0x00000080
    return (int(exstyle) & ~0x00040000) | 0x00000080


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


DEFAULT_WIDTH = 560
DEFAULT_HEIGHT = 720
RESIZE_GRIP = 6


def scroll_bars_needed(view_w, view_h, base_w=DEFAULT_WIDTH, base_h=DEFAULT_HEIGHT):
    """Barras independentes: aparecem só quando a área fica menor que o conteúdo."""
    return int(view_w) < int(base_w), int(view_h) < int(base_h)


def resize_hit_test(x, y, width, height, grip=RESIZE_GRIP):
    """Zona de arraste das bordas e cantos da janela."""
    left = int(x) < int(grip)
    right = int(x) >= int(width) - int(grip)
    top = int(y) < int(grip)
    bottom = int(y) >= int(height) - int(grip)
    if top and left:
        return 13
    if top and right:
        return 14
    if bottom and left:
        return 16
    if bottom and right:
        return 17
    if left:
        return 10
    if right:
        return 11
    if top:
        return 12
    if bottom:
        return 15
    return 0


_RESIZE_CURSORS = {
    10: "size_we",
    11: "size_we",
    12: "size_ns",
    15: "size_ns",
    13: "size_nw_se",
    17: "size_nw_se",
    14: "size_ne_sw",
    16: "size_ne_sw",
}


_QT_EDGE_MAP = {
    10: Qt.Edge.LeftEdge,
    11: Qt.Edge.RightEdge,
    12: Qt.Edge.TopEdge,
    15: Qt.Edge.BottomEdge,
    13: Qt.Edge.TopEdge | Qt.Edge.LeftEdge,
    14: Qt.Edge.TopEdge | Qt.Edge.RightEdge,
    16: Qt.Edge.BottomEdge | Qt.Edge.LeftEdge,
    17: Qt.Edge.BottomEdge | Qt.Edge.RightEdge,
}

_QT_CURSOR_MAP = {
    10: Qt.CursorShape.SizeHorCursor,
    11: Qt.CursorShape.SizeHorCursor,
    12: Qt.CursorShape.SizeVerCursor,
    15: Qt.CursorShape.SizeVerCursor,
    13: Qt.CursorShape.SizeFDiagCursor,
    17: Qt.CursorShape.SizeFDiagCursor,
    14: Qt.CursorShape.SizeBDiagCursor,
    16: Qt.CursorShape.SizeBDiagCursor,
}


class _ScrollProxy:
    def __init__(self, fn):
        self._fn = fn

    def winfo_ismapped(self):
        return bool(self._fn())


class _LabelProxy(QLabel):
    def cget(self, key):
        if key == "text":
            return self.text()
        return ""

    def config(self, **kwargs):
        if "text" in kwargs:
            self.setText(str(kwargs["text"]))

    configure = config

    def winfo_y(self):
        parent = self.parentWidget()
        while parent is not None and not isinstance(parent, _ContentWidget):
            parent = parent.parentWidget()
        return self.mapTo(parent or self.window(), QPoint(0, 0)).y()

    def winfo_height(self):
        return self.height()

    def winfo_width(self):
        return self.width()


class _CheckProxy(QCheckBox):
    def winfo_y(self):
        parent = self.parentWidget()
        while parent is not None and not isinstance(parent, _ContentWidget):
            parent = parent.parentWidget()
        return self.mapTo(parent or self.window(), QPoint(0, 0)).y()

    def winfo_height(self):
        return self.height()

    def winfo_width(self):
        return self.width()


class _ScrollArea(QScrollArea):
    def wheelEvent(self, event):
        mods = event.modifiers()
        shift = bool(mods & Qt.KeyboardModifier.ShiftModifier)
        delta_y = event.angleDelta().y()
        delta_x = event.angleDelta().x()
        raw = delta_y if delta_y != 0 else delta_x
        if raw == 0:
            event.ignore()
            return
        step = int(-raw / 120 * 48) or (-16 if raw > 0 else 16)
        bar = self.horizontalScrollBar() if shift else self.verticalScrollBar()
        if bar is not None and bar.maximum() > 0:
            bar.setValue(max(bar.minimum(), min(bar.maximum(), bar.value() + step)))
            event.accept()
            return
        super().wheelEvent(event)


class _ContentWidget(QWidget):
    def sizeHint(self):
        return QSize(DEFAULT_WIDTH - 2, DEFAULT_HEIGHT - 44)

    def minimumSizeHint(self):
        return QSize(1, 1)

    def winfo_reqheight(self):
        return DEFAULT_HEIGHT - 44

    def winfo_height(self):
        return self.height()

    def winfo_width(self):
        return self.width()


class App(QWidget):
    _dispatch_sig = Signal(object)

    def __init__(self):
        _ensure_qt_app()
        super().__init__(None, Qt.WindowType.Window | Qt.WindowType.FramelessWindowHint)
        self._main_thread_id = threading.get_ident()
        self._dispatch_sig.connect(self._on_dispatch)
        self.setWindowTitle("Spartan Live")
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
        self._timers = {}
        self._timer_seq = 0
        self._edge_cursor_code = 0

        icon = icon_file()
        if icon:
            try:
                self.setWindowIcon(QIcon(icon))
            except Exception:
                pass
        width, height = DEFAULT_WIDTH, DEFAULT_HEIGHT
        origin_x, origin_y = center_on_workarea(primary_workarea(), width, height)
        self.setMinimumSize(240, 240)
        self.setGeometry(origin_x, origin_y, width, height)
        self.setMouseTracking(True)

        self.proc = None
        self.video_proc = None
        self._video_time = 0.0
        self._progress_sock = None
        self._av_ticket = 0
        self.reader = None
        self.running = False
        self.stopping = False
        self._switch_to = None
        self._switch_quality = None
        self._switch_ready = False
        self._switch_ticket = 0
        self._base_status = ""
        self._slow_net = False
        self._slow_streak = 0
        self._viewers_count = 0
        self._last_viewer_poll = 0.0
        self._hotkeys_installed = False
        self.publish = load_json(existing_file("publish.json"), {})
        self.settings = load_json(settings_path(), {})
        self.monitors = list_monitors()
        safe_geom = valid_saved_geom(self.settings.get("window_geom"), self.monitors)
        if safe_geom:
            self.geometry(safe_geom)
        self._build()
        self._tray_job = None
        self._dragging = False
        self.show()
        self.after(0, self._borderless)
        self.after(0, self._install_tray_hook)
        self._tray_job = self.after(80, self._pump_tray)
        QApplication.instance().installEventFilter(self)

    def _on_dispatch(self, callback):
        try:
            callback()
        except Exception:
            pass

    def after(self, ms, callback):
        if threading.get_ident() != getattr(self, "_main_thread_id", None):
            if int(ms) <= 0:
                self._dispatch_sig.emit(callback)
                return 0
            self._dispatch_sig.emit(lambda: self.after(ms, callback))
            return 0
        self._timer_seq += 1
        tid = self._timer_seq
        timer = QTimer(self)
        timer.setSingleShot(True)

        def _fire():
            self._timers.pop(tid, None)
            try:
                callback()
            except Exception:
                pass

        timer.timeout.connect(_fire)
        self._timers[tid] = timer
        timer.start(max(0, int(ms)))
        return tid

    def after_cancel(self, tid):
        timer = self._timers.pop(tid, None)
        if timer is not None:
            timer.stop()
            timer.deleteLater()

    def geometry(self, spec=None):
        if spec is None:
            ms = getattr(self, "_manual_size", None)
            w, h = ms if ms else (self.width(), self.height())
            return f"{w}x{h}+{self.x()}+{self.y()}"
        m = re.match(r"^\s*(\d+)x(\d+)([+-]+\d+)([+-]+\d+)\s*$", str(spec))
        if m:
            w, h = int(m.group(1)), int(m.group(2))
            x = int(re.sub(r"^\+\+", "+", re.sub(r"^\+-", "-", m.group(3))))
            y = int(re.sub(r"^\+\+", "+", re.sub(r"^\+-", "-", m.group(4))))
            self._manual_size = (w, h)
            self._in_geometry = True
            try:
                self.move(x, y)
                self.resize(w, h)
                self._sync_viewport(w, h)
            finally:
                self._in_geometry = False

    def update_idletasks(self):
        QApplication.processEvents()
        ms = getattr(self, "_manual_size", None)
        if ms:
            self._sync_viewport(ms[0], ms[1])

    def update(self):
        super().update()
        QApplication.processEvents()
        ms = getattr(self, "_manual_size", None)
        if ms:
            self._sync_viewport(ms[0], ms[1])

    def winfo_width(self):
        ms = getattr(self, "_manual_size", None)
        return ms[0] if ms else self.width()

    def winfo_height(self):
        ms = getattr(self, "_manual_size", None)
        return ms[1] if ms else self.height()

    def winfo_x(self):
        return self.x()

    def winfo_y(self):
        return self.y()

    def _hwnd(self):
        try:
            return int(self.winId())
        except Exception:
            return 0

    def _borderless(self):
        try:
            hwnd = self._hwnd()
            if not hwnd:
                return
            user32 = ctypes.windll.user32
            ex = user32.GetWindowLongW(hwnd, -20)
            user32.SetWindowLongW(hwnd, -20, taskbar_exstyle(ex, not self._in_tray))
            self._set_win32_icons(hwnd, presence_icon(self._on_air))
        except Exception:
            pass

    def _set_win32_icons(self, hwnd, path):
        if not hwnd or not path:
            return
        try:
            user32 = ctypes.windll.user32
            small = load_square_icon(path, 16)
            big = load_square_icon(path, 32)
            if small:
                user32.SendMessageW(hwnd, 0x0080, 0, small)
            if big:
                user32.SendMessageW(hwnd, 0x0080, 1, big)
        except Exception:
            pass

    def paintEvent(self, _event):
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(self.bg))
        pen = QPen(QColor("#343434"), 1)
        painter.setPen(pen)
        painter.drawRect(0, 0, self.width() - 1, self.height() - 1)
        painter.end()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        sz = event.size()
        ms = getattr(self, "_manual_size", None)
        if ms and (sz.width(), sz.height()) != ms:
            self._sync_viewport(ms[0], ms[1])
            return
        self._sync_viewport(sz.width(), sz.height())

    def _over_scrollbar(self, watched, global_pos):
        if not hasattr(self, "scroll_area"):
            return False
        w = watched if isinstance(watched, QWidget) else QApplication.widgetAt(global_pos)
        vbar = self.scroll_area.verticalScrollBar()
        hbar = self.scroll_area.horizontalScrollBar()
        cur = w
        while cur is not None:
            if cur is vbar or cur is hbar:
                return True
            cur = cur.parentWidget()
        for bar, active in ((vbar, getattr(self, "_need_y", False)), (hbar, getattr(self, "_need_x", False))):
            if active and bar is not None and bar.isVisible():
                bp = bar.mapFromGlobal(global_pos)
                if 0 <= bp.x() < bar.width() and 0 <= bp.y() < bar.height():
                    return True
        return False

    def eventFilter(self, watched, event):
        if not self.isVisible():
            return False
        etype = event.type()
        if etype == QEvent.Type.Wheel and hasattr(self, "scroll_area"):
            w = watched if isinstance(watched, QWidget) else None
            cur = w
            while cur is not None:
                if isinstance(cur, VolumePill):
                    return False
                cur = cur.parentWidget()
            mods = event.modifiers()
            shift = bool(mods & Qt.KeyboardModifier.ShiftModifier)
            delta_y = event.angleDelta().y()
            delta_x = event.angleDelta().x()
            raw = delta_y if delta_y != 0 else delta_x
            if raw != 0:
                step = int(-raw / 120 * 48) or (-16 if raw > 0 else 16)
                bar = self.scroll_area.horizontalScrollBar() if shift else self.scroll_area.verticalScrollBar()
                if bar is not None and bar.maximum() > 0:
                    bar.setValue(max(bar.minimum(), min(bar.maximum(), bar.value() + step)))
                    event.accept()
                    return True
            return False
        if etype == QEvent.Type.MouseMove and not (event.buttons() & Qt.MouseButton.LeftButton):
            gp = QCursor.pos()
            if self._over_scrollbar(watched, gp):
                if self._edge_cursor_code != 0:
                    self._edge_cursor_code = 0
                    self.unsetCursor()
                return False
            lp = self.mapFromGlobal(gp)
            if 0 <= lp.x() < self.width() and 0 <= lp.y() < self.height():
                code = resize_hit_test(lp.x(), lp.y(), self.width(), self.height(), RESIZE_GRIP)
                if code != self._edge_cursor_code:
                    self._edge_cursor_code = code
                    if code in _QT_CURSOR_MAP:
                        self.setCursor(_QT_CURSOR_MAP[code])
                    else:
                        self.unsetCursor()
        elif etype == QEvent.Type.MouseButtonPress and event.button() == Qt.MouseButton.LeftButton:
            self._manual_size = None
            gp = QCursor.pos()
            if self._over_scrollbar(watched, gp):
                return False
            lp = self.mapFromGlobal(gp)
            if 0 <= lp.x() < self.width() and 0 <= lp.y() < self.height():
                code = resize_hit_test(lp.x(), lp.y(), self.width(), self.height(), RESIZE_GRIP)
                edges = _QT_EDGE_MAP.get(code)
                if edges is not None:
                    self._maximized = False
                    if getattr(self, "max_button", None):
                        self.max_button.configure(text="□")
                    wh = self.windowHandle()
                    if wh is not None and wh.startSystemResize(edges):
                        return True
        return False

    def _caption(self, root_layout):
        bar = QWidget(self)
        bar.setFixedHeight(34)
        bar.setStyleSheet(f"background-color: {self.bg};")
        hbox = QHBoxLayout(bar)
        hbox.setContentsMargins(8, 0, 0, 0)
        hbox.setSpacing(0)
        hbox.addStretch(1)
        self._maximized = False
        self._restore_geom = None
        for text, command, color in (
            ("—", self._minimize, self.fg),
            ("□", self._toggle_maximize, self.fg),
            ("✕", self.destroy, "#f0d0d0"),
        ):
            btn = _LabelProxy(text, bar)
            btn.setFixedSize(42, 34)
            btn.setAlignment(Qt.AlignmentFlag.AlignCenter)
            btn.setFont(QFont("Segoe UI", 11))
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            hover_bg = "#c14b4b" if command == self.destroy else "#2a2a2a"
            btn.setStyleSheet(
                f"QLabel {{ background-color: {self.bg}; color: {color}; }}"
                f"QLabel:hover {{ background-color: {hover_bg}; color: #ffffff; }}"
            )
            btn.mousePressEvent = lambda ev, cmd=command: cmd() if ev.button() == Qt.MouseButton.LeftButton else None
            hbox.addWidget(btn)
            if command == self._toggle_maximize:
                self.max_button = btn

        def _bar_press(ev):
            if ev.button() == Qt.MouseButton.LeftButton:
                lp = self.mapFromGlobal(QCursor.pos())
                code = resize_hit_test(lp.x(), lp.y(), self.width(), self.height(), RESIZE_GRIP)
                if code in _QT_EDGE_MAP:
                    wh = self.windowHandle()
                    if wh is not None:
                        wh.startSystemResize(_QT_EDGE_MAP[code])
                    return
                wh = self.windowHandle()
                if wh is not None:
                    wh.startSystemMove()

        def _bar_dblclick(ev):
            if ev.button() == Qt.MouseButton.LeftButton:
                self._toggle_maximize()

        bar.mousePressEvent = _bar_press
        bar.mouseDoubleClickEvent = _bar_dblclick
        root_layout.addWidget(bar)

    def _toggle_maximize(self):
        if getattr(self, "_maximized", False):
            self._maximized = False
            if getattr(self, "max_button", None):
                self.max_button.configure(text="□")
            geom = self._restore_geom
            if not geom:
                ox, oy = center_on_workarea(primary_workarea(), DEFAULT_WIDTH, DEFAULT_HEIGHT)
                geom = f"{DEFAULT_WIDTH}x{DEFAULT_HEIGHT}+{ox}+{oy}"
            self.geometry(geom)
            return "break"
        self._restore_geom = f"{max(200, self.width())}x{max(200, self.height())}+{self.x()}+{self.y()}"
        left, top, right, bottom = primary_workarea()
        self._maximized = True
        if getattr(self, "max_button", None):
            self.max_button.configure(text="❐")
        self.geometry(f"{max(200, right - left)}x{max(200, bottom - top)}+{left}+{top}")
        return "break"

    def _taskbar_button(self, visible):
        hwnd = self._hwnd()
        if not hwnd:
            return
        user32 = ctypes.windll.user32
        ex = user32.GetWindowLongW(hwnd, -20)
        user32.SetWindowLongW(hwnd, -20, taskbar_exstyle(ex, visible))
        user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x0037)

    def _minimize(self):
        if self._show_tray():
            self._in_tray = True
            self._taskbar_button(False)
            self.hide()
            hwnd = self._hwnd()
            if hwnd:
                ctypes.windll.user32.ShowWindow(hwnd, 0)
            self._taskbar_button(False)
            return
        self.showMinimized()

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
        pending = int(self._tray_pending.value)
        if pending:
            self._tray_pending.value = 0
            if pending == 1:
                self._restore_from_tray()
            elif pending == 2:
                self._tray_menu()
        self._tick_meters_and_viewers()
        self._tray_job = self.after(80, self._pump_tray)

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
        self._taskbar_button(True)
        self.showNormal()
        self.raise_()
        self.activateWindow()
        hwnd = self._hwnd()
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 9)
            ctypes.windll.user32.SetForegroundWindow(hwnd)
        self._taskbar_button(True)
        self._hide_tray()
        self._borderless()

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
                self.setWindowIcon(QIcon(path))
                self._set_win32_icons(self._hwnd(), path)
            except Exception:
                pass
        if self._tray_added:
            self._show_tray()

    def _build(self):
        root_layout = QVBoxLayout(self)
        root_layout.setContentsMargins(6, 1, 6, 6)
        root_layout.setSpacing(0)
        self._caption(root_layout)

        self.scroll_area = _ScrollArea(self)
        self.scroll_area.setWidgetResizable(False)
        self.scroll_area.setFrameShape(QFrame.Shape.NoFrame)
        self.scroll_area.setStyleSheet(
            f"""
            QScrollArea {{ background-color: {self.bg}; border: none; }}
            QScrollBar:vertical {{
                background: #202020; width: 12px; margin: 0px; border-radius: 6px;
            }}
            QScrollBar::handle:vertical {{
                background: #666666; min-height: 28px; border-radius: 5px; margin: 2px;
            }}
            QScrollBar::handle:vertical:hover {{
                background: #c14b4b;
            }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical,
            QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{
                background: none; height: 0px;
            }}
            QScrollBar:horizontal {{
                background: #202020; height: 12px; margin: 0px; border-radius: 6px;
            }}
            QScrollBar::handle:horizontal {{
                background: #666666; min-width: 28px; border-radius: 5px; margin: 2px;
            }}
            QScrollBar::handle:horizontal:hover {{
                background: #c14b4b;
            }}
            QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal,
            QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal {{
                background: none; width: 0px;
            }}
            """
        )
        root_layout.addWidget(self.scroll_area, 1)

        self.content = _ContentWidget()
        self.content.setStyleSheet(f"background-color: {self.bg};")
        self._content_layout = QVBoxLayout(self.content)
        self._content_layout.setContentsMargins(18, 2, 18, 8)
        self._content_layout.setSpacing(6)
        self.scroll_area.setWidget(self.content)

        self._need_x = False
        self._need_y = False
        self.v_scroll = _ScrollProxy(lambda: self._need_y)
        self.h_scroll = _ScrollProxy(lambda: self._need_x)

        title = QLabel("Spartan Live", self.content)
        title.setFont(QFont("Segoe UI", 18, QFont.Weight.Bold))
        title.setStyleSheet(f"color: {self.fg};")
        self._content_layout.addWidget(title)

        hint = QLabel("Escolhe a tela, o som e a imagem.", self.content)
        hint.setFont(QFont("Segoe UI", 10))
        hint.setStyleSheet(f"color: {self.muted};")
        self._content_layout.addWidget(hint)

        self.nick = _QtVar(self.settings.get("nick", ""))
        self.host = _QtVar(clean_host(self.settings.get("host") or "", ""))
        chosen = parse_quality(self.settings.get("quality"), self.settings.get("fps"))
        self.quality = _QtVar(chosen[0])
        self.monitor_index = _QtVar(int(self.settings.get("monitor") or 0))
        if self.monitor_index.get() >= len(self.monitors):
            self.monitor_index.set(0)

        self._field("Apelido", self.nick)
        self._field("Servidor", self.host)

        self.monitor_labels = [monitor_label(i, monitor) for i, monitor in enumerate(self.monitors)] or ["Tela 1"]
        saved = self.monitor_index.get()
        if saved >= len(self.monitor_labels):
            saved = 0
        self.monitor_choice = _QtVar(self.monitor_labels[saved])
        self._choice("Tela", self.monitor_choice, self.monitor_labels)
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
        self.pc_choice = _QtVar(saved_pc_label)
        self.mic_choice = _QtVar(saved_mic or "Sem microfone")
        self.pc_volume = _QtVar(clamp_gain(self.settings.get("pc_volume", 100)))
        self.mic_volume = _QtVar(clamp_gain(self.settings.get("mic_volume", 100)))
        self._mic_muted = False
        self.pc_meter = self._choice("Som do PC", self.pc_choice, pc_labels, self.pc_volume, self._gain_changed)
        self.mic_meter = self._choice("Microfone", self.mic_choice, ["Sem microfone", *self.mic_devices], self.mic_volume, self._gain_changed)
        self.audio_live = None
        self.live_nick = ""
        self.live_host = ""
        self.pc_choice.trace_add("write", lambda *_args: self._audio_changed())
        self.mic_choice.trace_add("write", lambda *_args: self._audio_changed())

        quality_box = QWidget(self.content)
        q_vbox = QVBoxLayout(quality_box)
        q_vbox.setContentsMargins(0, 2, 0, 0)
        q_vbox.setSpacing(4)
        q_lbl = QLabel("Imagem", quality_box)
        q_lbl.setFont(QFont("Segoe UI", 10))
        q_lbl.setStyleSheet(f"color: {self.muted};")
        q_vbox.addWidget(q_lbl)

        quality_grid_w = QWidget(quality_box)
        q_grid = QGridLayout(quality_grid_w)
        q_grid.setContentsMargins(0, 0, 0, 0)
        q_grid.setHorizontalSpacing(8)
        q_grid.setVerticalSpacing(4)
        self.quality_buttons = {}
        for index, (key, label, _width, _height, _fps) in enumerate(QUALITY_OPTIONS[:4]):
            button = PillButton(
                quality_grid_w, label, lambda key=key: self.quality.set(key),
                self.bg, self.field, self.fg, height=32,
            )
            q_grid.addWidget(button, index // 2, index % 2)
            self.quality_buttons[key] = button

        self.potato_hint = QLabel("PC batata, ou internet discada? tente a opção abaixo!", quality_grid_w)
        self.potato_hint.setFont(QFont("Segoe UI", 9))
        self.potato_hint.setStyleSheet(f"color: {self.muted};")
        q_grid.addWidget(self.potato_hint, 2, 0, 1, 2)

        potato_key, potato_label, _pw, _ph, _pfps = QUALITY_OPTIONS[4]
        potato_button = PillButton(
            quality_grid_w, potato_label, lambda key=potato_key: self.quality.set(key),
            self.bg, self.field, self.fg, height=32,
        )
        q_grid.addWidget(potato_button, 3, 0, 1, 2)
        self.quality_buttons[potato_key] = potato_button
        q_grid.setColumnStretch(0, 1)
        q_grid.setColumnStretch(1, 1)
        q_vbox.addWidget(quality_grid_w)
        self._content_layout.addWidget(quality_box)

        self.quality.trace_add("write", lambda *_args: self._quality_changed())
        self._paint_quality()

        self.status = _LabelProxy("Parado.", self.content)
        self.status.setFont(QFont("Segoe UI", 10))
        self.status.setWordWrap(True)
        self.status.setStyleSheet(f"color: {self.muted};")
        self._content_layout.addWidget(self.status)

        self.start_with_windows = _QtVar(read_startup_enabled())
        self.windows_check = _CheckProxy("Abrir com o Windows, sem iniciar a live", self.content)
        self.windows_check.setFont(QFont("Segoe UI", 10))
        self.windows_check.setChecked(bool(self.start_with_windows.get()))
        self.windows_check.setStyleSheet(
            f"""
            QCheckBox {{ color: {self.fg}; spacing: 8px; }}
            QCheckBox::indicator {{
                width: 16px; height: 16px; border-radius: 4px;
                border: 1px solid #484848; background-color: {self.field};
            }}
            QCheckBox::indicator:checked {{
                background-color: {self.accent}; border-color: {self.accent};
            }}
            """
        )

        def _on_chk(state):
            self.start_with_windows._value = bool(state)
            self._startup_toggled()

        self.windows_check.toggled.connect(_on_chk)
        self._content_layout.addWidget(self.windows_check)

        self._content_layout.addStretch(1)

        self.button = PillButton(self.content, "Transmitir", self.toggle, self.bg, self.accent, "#f6f1f1", height=40)
        self._content_layout.addWidget(self.button)
        self._sync_viewport()

    def _sync_viewport(self, w=None, h=None):
        if not hasattr(self, "scroll_area") or not hasattr(self, "content"):
            return
        base_w = DEFAULT_WIDTH - 12
        base_h = DEFAULT_HEIGHT - 44
        ms = getattr(self, "_manual_size", None)
        eff_w = int(w) if isinstance(w, (int, float)) else (ms[0] if ms else self.width())
        eff_h = int(h) if isinstance(h, (int, float)) else (ms[1] if ms else self.height())
        total_w = max(1, eff_w - 12)
        total_h = max(1, eff_h - 41)
        bar = 12
        need_x, need_y = scroll_bars_needed(total_w, total_h, base_w, base_h)
        for _ in range(2):
            avail_w = max(1, total_w - (bar if need_y else 0))
            avail_h = max(1, total_h - (bar if need_x else 0))
            need_x, need_y = scroll_bars_needed(avail_w, avail_h, base_w, base_h)
        avail_w = max(1, total_w - (bar if need_y else 0))
        avail_h = max(1, total_h - (bar if need_x else 0))
        target_w = max(base_w, avail_w)
        target_h = max(base_h, avail_h)
        self._need_x = need_x
        self._need_y = need_y
        self.scroll_area.setVerticalScrollBarPolicy(
            Qt.ScrollBarPolicy.ScrollBarAlwaysOn if need_y else Qt.ScrollBarPolicy.ScrollBarAlwaysOff
        )
        self.scroll_area.setHorizontalScrollBarPolicy(
            Qt.ScrollBarPolicy.ScrollBarAlwaysOn if need_x else Qt.ScrollBarPolicy.ScrollBarAlwaysOff
        )
        self.content.resize(target_w, target_h)

    def _field(self, label, variable):
        box = QWidget(self.content)
        vbox = QVBoxLayout(box)
        vbox.setContentsMargins(0, 0, 0, 0)
        vbox.setSpacing(2)
        lbl = QLabel(label, box)
        lbl.setFont(QFont("Segoe UI", 10))
        lbl.setStyleSheet(f"color: {self.muted};")
        vbox.addWidget(lbl)
        entry = QLineEdit(str(variable.get() or ""), box)
        entry.setFont(QFont("Segoe UI", 11))
        entry.setFixedHeight(36)
        entry.setStyleSheet(
            f"""
            QLineEdit {{
                background-color: {self.field}; color: {self.fg};
                border: 1px solid #343434; border-radius: 8px; padding: 2px 10px;
            }}
            QLineEdit:focus {{
                border: 1px solid {self.accent};
            }}
            """
        )
        entry.textChanged.connect(lambda txt: setattr(variable, "_value", txt))
        variable._sync_fn = entry.text
        variable.trace_add("write", lambda: entry.setText(str(variable._value or "")) if entry.text() != str(variable._value or "") else None)
        vbox.addWidget(entry)
        self._content_layout.addWidget(box)

    def _choice(self, label, variable, labels, volume_var=None, volume_cmd=None):
        box = QWidget(self.content)
        vbox = QVBoxLayout(box)
        vbox.setContentsMargins(0, 0, 0, 0)
        vbox.setSpacing(3)
        head = QWidget(box)
        hbox = QHBoxLayout(head)
        hbox.setContentsMargins(0, 0, 0, 0)
        hbox.setSpacing(4)
        lbl = QLabel(label, head)
        lbl.setFont(QFont("Segoe UI", 10))
        lbl.setStyleSheet(f"color: {self.muted};")
        hbox.addWidget(lbl)
        hbox.addStretch(1)
        pill = None
        if volume_var is not None:
            pill = VolumePill(head, volume_var, volume_cmd, self.bg, self.field, self.muted, self.accent)
            hbox.addWidget(pill)
        vbox.addWidget(head)
        ch = Choice(box, variable, labels, self.bg, self.field, self.fg, self.accent)
        vbox.addWidget(ch)
        self._content_layout.addWidget(box)
        return pill

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

    def _compose_live_status(self):
        base = self._base_status
        if not base or not self.running:
            return base
        parts = [base]
        if self._viewers_count > 0:
            parts.append(f"👁 {self._viewers_count} assistindo")
        if self._mic_muted and self.selected_mic():
            parts.append("Mic mudo")
        if self._slow_net:
            parts.append("Internet ou PC sofrendo — tente 720p 30 ou 480p 30")
        return " · ".join(parts)

    def _refresh_live_status(self):
        if not self.running or not self._base_status:
            return
        self.set_status(self._compose_live_status())

    def _gain_changed(self):
        try:
            self.save_settings()
        except Exception:
            pass
        audio = getattr(self, "audio_live", None)
        if audio is not None:
            audio.set_gains(
                pc_gain=clamp_gain(self.pc_volume.get()) / 100.0,
                mic_gain=clamp_gain(self.mic_volume.get()) / 100.0,
                mic_muted=self._mic_muted,
            )

    def _tick_meters_and_viewers(self):
        audio = getattr(self, "audio_live", None)
        pc_lvl = audio.levels.get("pc", 0.0) if audio and self.running else 0.0
        mic_lvl = audio.levels.get("mic", 0.0) if audio and self.running else 0.0
        if getattr(self, "pc_meter", None) is not None:
            self.pc_meter.set_level(pc_lvl, False)
        if getattr(self, "mic_meter", None) is not None:
            self.mic_meter.set_level(mic_lvl, getattr(self, "_mic_muted", False))
        if self.running and not self.stopping and self._base_status:
            now = time.perf_counter()
            if now - getattr(self, "_last_viewer_poll", 0.0) >= 2.0:
                self._last_viewer_poll = now
                nick = self.live_nick
                host = self.live_host
                user = str(self.publish.get("user") or "")
                password = str(self.publish.get("password") or "")
                if nick and host and user and password:
                    threading.Thread(
                        target=self._poll_viewers_worker,
                        args=(host, nick, user, password),
                        daemon=True,
                    ).start()

    def _poll_viewers_worker(self, host, nick, user, password):
        count = fetch_viewers(host, nick, user, password)
        if not self.running or self.stopping or self.live_nick != nick:
            return
        if count != self._viewers_count:
            self._viewers_count = count
            self.after(0, self._refresh_live_status)

    def _current_window_geom(self):
        if getattr(self, "_maximized", False) and getattr(self, "_restore_geom", None):
            return self._restore_geom
        try:
            w = max(200, self.winfo_width())
            h = max(200, self.winfo_height())
            x = self.winfo_x()
            y = self.winfo_y()
            return f"{w}x{h}+{x}+{y}"
        except Exception:
            return ""

    def save_settings(self):
        data = {
            "nick": self.nick.get().strip(),
            "host": clean_host(self.host.get(), ""),
            "quality": self.selected_quality()[0],
            "fps": self.selected_quality()[4],
            "monitor": self.selected_monitor(),
            "pc_audio": self.selected_pc_audio(),
            "mic": self.selected_mic(),
            "pc_volume": clamp_gain(self.pc_volume.get()) if hasattr(self, "pc_volume") else 100,
            "mic_volume": clamp_gain(self.mic_volume.get()) if hasattr(self, "mic_volume") else 100,
            "start_with_windows": bool(self.start_with_windows.get()),
        }
        geom = valid_saved_geom(self._current_window_geom(), self.monitors)
        if geom:
            data["window_geom"] = geom
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
            QMessageBox.critical(self, "Spartan Live", "O apelido precisa ter 2 a 24 letras, números, _ ou -.")
            return
        if not host or not self.publish.get("password") or not self.publish.get("user"):
            QMessageBox.critical(self, "Spartan Live", "Falta o servidor neste programa.")
            return
        ffmpeg = existing_file("ffmpeg.exe")
        if not ffmpeg:
            QMessageBox.critical(self, "Spartan Live", "Não achei o ffmpeg neste programa.")
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
            live_audio = LiveAudio(
                pc_audio,
                mic,
                pc_gain=clamp_gain(self.pc_volume.get()) / 100.0 if hasattr(self, "pc_volume") else 1.0,
                mic_gain=clamp_gain(self.mic_volume.get()) / 100.0 if hasattr(self, "mic_volume") else 1.0,
            )
            live_audio.set_gains(mic_muted=getattr(self, "_mic_muted", False))
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
        self._capture_mode = prefer_capture(ffmpeg_filters(ffmpeg))
        log_event(f"captura {self._capture_mode}")
        preferred = None
        try:
            while not self.stopping:
                output_idx = self._consume_switch(output_idx)
                if output_idx >= len(self.monitors):
                    output_idx = 0
                self._live_monitor = output_idx
                monitor = self.monitors[output_idx]
                q_key, _q_label, width, height, fps = self._consume_quality_switch()
                self._live_quality = q_key
                order = [preferred, *[item for item in encoders if item != preferred]] if preferred else encoders
                restarted = False
                lost = False
                for encoder in order:
                    if self.stopping:
                        return
                    mode = self._capture_mode or "gdigrab"
                    outcome = self._open_capture(
                        ffmpeg, mode, encoder, fps, monitor, output_idx, url,
                        live_audio, note, width, height,
                    )
                    if (
                        outcome is False
                        and mode == "ddagrab"
                        and not self._frame_seen
                        and not self.stopping
                    ):
                        log_event("ddagrab nao abriu, usando gdigrab")
                        self._capture_mode = "gdigrab"
                        outcome = self._open_capture(
                            ffmpeg, "gdigrab", encoder, fps, monitor, output_idx, url,
                            live_audio, note, width, height,
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

    def _consume_quality_switch(self):
        nxt = getattr(self, "_switch_quality", None)
        self._switch_quality = None
        if nxt:
            return parse_quality(nxt)
        return self.selected_quality()

    def _has_pending_switch(self):
        return self._switch_to is not None or getattr(self, "_switch_quality", None) is not None

    def _quality_changed(self):
        self._paint_quality()
        if not getattr(self, "status", None):
            return
        try:
            self.save_settings()
        except Exception:
            pass
        if not self.running or self.stopping:
            return
        key, label, _w, _h, _fps = self.selected_quality()
        if key == getattr(self, "_live_quality", None) and getattr(self, "_switch_quality", None) is None:
            return
        if key == getattr(self, "_live_quality", None):
            self._switch_quality = None
            return
        self._switch_ticket += 1
        ticket = self._switch_ticket
        self._switch_quality = key
        self._switch_ready = False
        self.set_status(f"Trocando a qualidade para {label}...")
        threading.Thread(target=self._announce_switch, args=(ticket, "quality"), daemon=True).start()

    def _screen_changed(self):
        job = getattr(self, "_screen_debounce_job", None)
        if job:
            try:
                self.after_cancel(job)
            except Exception:
                pass
            self._screen_debounce_job = None
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
        try:
            self._screen_debounce_job = self.after(3000, self._apply_screen_changed)
        except Exception:
            self._apply_screen_changed()

    def _apply_screen_changed(self):
        self._screen_debounce_job = None
        if not self.running or self.stopping:
            return
        index = self.selected_monitor()
        if index == getattr(self, "_live_monitor", None):
            self._switch_to = None
            return
        if not 0 <= index < len(self.monitors):
            return
        self._switch_ticket += 1
        ticket = self._switch_ticket
        self._switch_to = index
        self._switch_ready = False
        self.set_status("Trocando a tela...")
        threading.Thread(target=self._announce_switch, args=(ticket, "screen"), daemon=True).start()

    def _announce_switch(self, ticket, kind="screen"):
        nick = self.live_nick
        host = self.live_host
        log_event(f"troca de {'qualidade' if kind == 'quality' else 'tela'} apelido={nick or '-'}")
        try:
            notify_publisher(host, nick, self.publish.get("user", ""), self.publish.get("password", ""), "switch", {"kind": kind})
        finally:
            if ticket == self._switch_ticket:
                self._switch_ready = True

    def _wait_proc(self, proc, timeout=None):
        deadline = None if timeout is None else time.perf_counter() + timeout
        while proc.poll() is None:
            video = getattr(self, "video_proc", None)
            video_exited = video is not None and video is not proc and video.poll() is not None
            stalled = timeout is None and capture_stalled(
                getattr(self, "_frame_seen", 0),
                getattr(self, "_frame_at", time.perf_counter()),
                time.perf_counter(),
            )
            has_switch = self._switch_to is not None or getattr(self, "_switch_quality", None) is not None
            if self.stopping or video_exited or stalled or (has_switch and self._switch_ready):
                if (stalled or video_exited) and not self.stopping:
                    log_event("captura parada, retomando")
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
            spd = progress_speed(text)
            if spd is not None:
                self._slow_streak = network_slow_streak(getattr(self, "_slow_streak", 0), spd)
                slow_now = self._slow_streak >= 6
                if slow_now != getattr(self, "_slow_net", False):
                    self._slow_net = slow_now
                    self.after(0, self._refresh_live_status)
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

    def _open_capture(self, ffmpeg, mode, encoder, fps, monitor, output_idx, url, live_audio, note, width, height):
        if live_audio is None:
            command = build_command(
                ffmpeg, mode, encoder, fps, monitor, output_idx, url, False, width, height,
            )
            return self._attempt(command, encoder, fps, mode, None, note, width, height)
        self._av_ticket += 1
        port = 20000 + ((os.getpid() + self._av_ticket) % 20000)
        relay = f"tcp://127.0.0.1:{port}"
        pipe = rf"\\.\pipe\spartan-live-{os.getpid()}-{self._av_ticket}"
        video = build_command(
            ffmpeg, mode, encoder, fps, monitor, output_idx, url, True, width, height, relay,
        )
        return self._attempt_synced(
            video, pipe, relay, url, encoder, fps, live_audio, note, width, height, mode,
        )

    def _attempt_synced(self, video_command, pipe_name, relay, rtmp, encoder, fps, live_audio, note, width, height, mode="gdigrab"):
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
        return self._watch_result(mux, live_audio, lines, encoder, fps, note, width, height, mode)

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
            if not self.stopping and self._has_pending_switch():
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
        if not self.stopping and self._has_pending_switch():
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
        first = getattr(self, "_lost_since", None) is None
        if first:
            self._lost_since = now
        if now - self._lost_since > 45:
            return False
        self.after(0, lambda: self.set_status("A tela mudou, retomando a live..."))
        pause = 0.25 if first else 0.6
        deadline = time.perf_counter() + pause
        while time.perf_counter() < deadline:
            if self.stopping:
                return False
            time.sleep(0.1)
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
        self._base_status = text
        self._slow_net = False
        self._slow_streak = 0
        self.button.config(text="Parar")
        self._refresh_live_status()
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
            QMessageBox.critical(self, "Spartan Live", message)

    def _audio_changed(self):
        if not getattr(self, "status", None):
            return
        job = getattr(self, "_audio_debounce_job", None)
        if job:
            try:
                self.after_cancel(job)
            except Exception:
                pass
            self._audio_debounce_job = None
        try:
            self.save_settings()
        except Exception:
            pass
        audio = self.audio_live
        if not self.running or audio is None:
            return
        target_pc = self.selected_pc_audio()
        target_mic = self.selected_mic()
        if target_pc == getattr(audio, "pc_name", "") and target_mic == getattr(audio, "mic_name", ""):
            return
        try:
            self._audio_debounce_job = self.after(3000, self._apply_audio_changed)
        except Exception:
            self._apply_audio_changed()

    def _apply_audio_changed(self):
        self._audio_debounce_job = None
        audio = self.audio_live
        if not self.running or audio is None:
            return
        target_pc = self.selected_pc_audio()
        target_mic = self.selected_mic()
        if target_pc == getattr(audio, "pc_name", "") and target_mic == getattr(audio, "mic_name", ""):
            return
        try:
            audio.retarget(target_pc, target_mic)
            log_event(f"som pc={target_pc or '-'} mic={target_mic or '-'}")
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
        try:
            QApplication.instance().removeEventFilter(self)
        except Exception:
            pass
        try:
            self.save_settings()
        except Exception:
            pass
        for tid in list(self._timers.keys()):
            self.after_cancel(tid)
        for attr in ("_tray_job", "_screen_debounce_job", "_audio_debounce_job"):
            setattr(self, attr, None)
        self._hide_tray()
        tray = self._tray_hwnd
        self._tray_hwnd = None
        if tray:
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            user32.DestroyWindow.argtypes = [wintypes.HWND]
            user32.DestroyWindow(tray)
        if self.running:
            self.stop()
        self.close()

    def mainloop(self):
        QApplication.instance().exec()

    def stop(self):
        self._switch_to = None
        self._switch_quality = None
        self._base_status = ""
        self._slow_net = False
        self._slow_streak = 0
        self._viewers_count = 0
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
