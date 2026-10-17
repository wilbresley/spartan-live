import array
import os
import struct
import subprocess
import tempfile
import threading
import time
import unittest

import numpy as np
import soxr
from PySide6.QtWidgets import QWidget

from spartan_live import (
    App,
    Choice,
    LiveAudio,
    _QtVar,
    apply_startup,
    build_command,
    build_mux_command,
    capture_stalled,
    capture_input,
    match_output_index,
    prefer_capture,
    plan_audio,
    progress_seconds,
    progress_speed,
    network_slow_streak,
    clamp_gain,
    peak_level,
    valid_saved_geom,
    video_clock,
    wav_header,
    downmix_float,
    merge_playback,
    next_chunk,
    chosen_pc_audio,
    clean_host,
    encoder_args,
    parse_quality,
    explain_error,
    prune_log_text,
    rtmp_url,
    run_with_timeout,
    list_sound_devices,
    looks_like_ip,
    notify_targets,
    center_on_workarea,
    fit_icon_pixels,
    icon_content_box,
    presence_icon,
    resize_hit_test,
    scroll_bars_needed,
    taskbar_exstyle,
    tray_action,
    startup_command,
    system_default_playback,
    usable_encoders,
    valid_nick,
)


class PublisherTests(unittest.TestCase):
    def test_nick(self):
        self.assertTrue(valid_nick("ana"))
        self.assertFalse(valid_nick("a"))
        self.assertFalse(valid_nick("com espaco"))

    def test_aviso_pelo_dominio_usa_o_site_e_o_ip_usa_a_porta_local(self):
        self.assertTrue(looks_like_ip("192.168.1.10"))
        self.assertTrue(looks_like_ip("203.0.113.10"))
        self.assertFalse(looks_like_ip("live.exemplo.net"))
        self.assertEqual(
            notify_targets("live.exemplo.net", "stop"),
            [
                "https://live.exemplo.net/api/stop",
                "http://live.exemplo.net:8097/api/stop",
            ],
        )
        self.assertEqual(
            notify_targets("192.168.1.10", "claim"),
            ["http://192.168.1.10:8097/api/claim"],
        )
        self.assertEqual(
            notify_targets("live.exemplo.net", "switch"),
            [
                "https://live.exemplo.net/api/switch",
                "http://live.exemplo.net:8097/api/switch",
            ],
        )
        self.assertEqual(
            notify_targets("203.0.113.10", "thumb"),
            ["http://203.0.113.10:8097/api/thumb"],
        )

    def test_abrir_com_o_windows_so_abre_o_programa(self):
        command = startup_command(r"C:\Apps\SpartanLive.exe")
        self.assertEqual(command, r'"C:\Apps\SpartanLive.exe"')
        self.assertNotIn("transmit", command.lower())
        store = {}
        apply_startup(True, r"C:\Apps\SpartanLive.exe", store)
        self.assertEqual(store, {"SpartanLive": r'"C:\Apps\SpartanLive.exe"'})
        apply_startup(False, r"C:\Apps\SpartanLive.exe", store)
        self.assertEqual(store, {})

    def test_arquivo_unico_acha_o_arquivo_ao_lado_do_programa(self):
        import spartan_live
        folder = tempfile.mkdtemp()
        name = "spartan-marker.txt"
        path = os.path.join(folder, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("ok")
        original = spartan_live.app_dir
        try:
            spartan_live.app_dir = lambda: folder
            self.assertEqual(spartan_live.existing_file(name), path)
        finally:
            spartan_live.app_dir = original
            os.remove(path)
            os.rmdir(folder)

    def test_log_esquece_linhas_com_mais_de_30_dias(self):
        now = time.mktime(time.strptime("2026-10-10T12:00:00", "%Y-%m-%dT%H:%M:%S"))
        old = "2026-08-01T12:00:00 inicio antigo\n"
        fresh = "2026-10-09T12:00:00 inicio novo\n"
        junk = "sem data\n"
        self.assertEqual(prune_log_text(old + junk + fresh, now), fresh)

    def test_rtmp_esconde_a_senha_na_montagem_sem_quebrar_url(self):
        url = rtmp_url({"host": "http://192.168.1.10:8097/", "port": 1935, "user": "publisher", "password": "abc"}, "Ana_1")
        self.assertEqual(url, "rtmp://192.168.1.10:1935/Ana_1?user=publisher&pass=abc")
        self.assertEqual(clean_host("192.168.1.10"), "192.168.1.10")
        self.assertEqual(clean_host("https://live.exemplo.net/sala"), "live.exemplo.net")

    def test_comando_full_hd(self):
        command = build_command(
            "ffmpeg.exe",
            "ddagrab",
            "h264_nvenc",
            60,
            {"left": 0, "top": 0, "width": 2560, "height": 1440},
            0,
            "rtmp://servidor/nick",
        )
        self.assertIn("1920:1080", command[command.index("-filter:v") + 1])
        self.assertIn("hwdownload", command[command.index("-filter:v") + 1])
        self.assertIn("draw_mouse=1", " ".join(command))
        self.assertIn("lavfi", command)
        self.assertNotIn("gdigrab", command)
        self.assertIn("h264_nvenc", command)
        self.assertIn("-an", command)
        self.assertIn("14M", encoder_args("h264_nvenc", 60))
        self.assertIn("28M", encoder_args("h264_nvenc", 60))
        self.assertIn("8M", encoder_args("h264_nvenc", 30))
        cpu60 = encoder_args("libx264", 60, 1080)
        self.assertIn("12M", cpu60)
        self.assertIn("24M", cpu60)
        self.assertIn("veryfast", cpu60)
        light = build_command(
            "ffmpeg.exe", "gdigrab", "libx264", 30,
            {"left": 0, "top": 0, "width": 1920, "height": 1080},
            0, "rtmp://servidor/nick", False, 1280, 720,
        )
        self.assertIn("1280:720", light[light.index("-filter:v") + 1])
        self.assertNotIn("hwdownload", light[light.index("-filter:v") + 1])
        self.assertIn("4M", encoder_args("libx264", 30, 720))
        self.assertIn("6M", encoder_args("libx264", 60, 720))
        self.assertIn("ultrafast", encoder_args("libx264", 60, 720))
        self.assertEqual(parse_quality(None, 30)[0], "1080p30")
        self.assertEqual(parse_quality("720p 60")[0], "720p60")
        self.assertEqual(command[-1], "rtmp://servidor/nick")
        self.assertNotIn("-thread_queue_size", command)
        self.assertNotIn("-fps_mode:v", command)

    def test_ponteiro_usa_o_ddagrab_na_tela_certa(self):
        self.assertEqual(prefer_capture(" .. ddagrab           |->V       Grab\n"), "ddagrab")
        self.assertEqual(prefer_capture(" T. gdigrab\n"), "gdigrab")
        self.assertEqual(prefer_capture(""), "gdigrab")
        outputs = [
            {"left": 0, "top": 0, "width": 1920, "height": 1080},
            {"left": 1920, "top": 0, "width": 1920, "height": 1080},
        ]
        self.assertEqual(match_output_index({"left": 1920, "top": 0}, outputs), 1)
        self.assertIsNone(match_output_index({"left": 5, "top": 5}, outputs))
        command = capture_input(
            "ddagrab", 60,
            {"left": 1920, "top": 0, "width": 1920, "height": 1080, "output": 1},
            0,
        )
        self.assertIn("output_idx=1", command[-1])
        self.assertIn("draw_mouse=1", command[-1])
        self.assertEqual(command[:3], ["-f", "lavfi", "-i"])

    def test_comando_com_som_do_pc(self):
        relay = "tcp://127.0.0.1:17961"
        command = build_command(
            "ffmpeg.exe", "gdigrab", "h264_amf", 30,
            {"left": 0, "top": 0, "width": 1920, "height": 1080},
            1, "rtmp://servidor/nick", True, relay=relay,
        )
        self.assertNotIn("pipe:0", command)
        self.assertNotIn("s16le", command)
        self.assertNotIn("aresample", command)
        self.assertNotIn("cfr", command)
        self.assertIn("passthrough", command)
        self.assertIn("-an", command)
        self.assertNotIn("-thread_queue_size", command)
        self.assertEqual(command[-1], relay)
        self.assertIn("-use_wallclock_as_timestamps", command)
        mux = build_mux_command("ffmpeg.exe", r"\\.\pipe\spartan-live-test", relay, 0.085, "rtmp://servidor/nick")
        self.assertIn("0.085000", mux)
        self.assertIn("aac", mux)
        self.assertIn("256k", mux)
        self.assertIn("copy", mux)
        self.assertNotIn("aresample", mux)
        self.assertNotIn("cfr", mux)
        self.assertEqual(mux[-1], "rtmp://servidor/nick")
        self.assertEqual(video_clock("Duration: N/A, start: 1791758504.670458, bitrate: 1"), 1791758504.670458)
        self.assertIsNone(video_clock("start: 0.000000"))
        self.assertEqual(wav_header()[:4], b"RIFF")

    def test_comando_com_som_e_microfone(self):
        command = build_command(
            "ffmpeg.exe", "gdigrab", "libx264", 30,
            {"left": 0, "top": 0, "width": 1920, "height": 1080},
            0, "rtmp://servidor/nick", True, relay="tcp://127.0.0.1:17962",
        )
        self.assertEqual(command.count("desktop"), 1)
        self.assertNotIn("pipe:0", command)
        mux = build_mux_command("ffmpeg.exe", r"\\.\pipe\spartan-live-test", "tcp://127.0.0.1:17962", 0.1, "rtmp://servidor/nick")
        self.assertIn("aac", mux)

    def test_som_padrao_segue_o_windows_e_nao_um_aparelho_fixo(self):
        devices = [
            "SteelSeries Sonar - Gaming [Loopback]",
            "Alto-falantes (Realtek) [Loopback]",
        ]
        speakers = devices[1]
        self.assertEqual(chosen_pc_audio(None, devices, speakers), speakers)
        self.assertEqual(chosen_pc_audio("", devices, speakers), "")
        self.assertEqual(chosen_pc_audio("Headset que não existe", devices, speakers), speakers)
        self.assertEqual(chosen_pc_audio(devices[0], devices, speakers), devices[0])
        self.assertNotIn("gaming", chosen_pc_audio(None, devices, speakers).lower())

    def test_captura_parada_so_depois_do_primeiro_quadro(self):
        now = 10.0
        self.assertFalse(capture_stalled(0, 0.0, now))
        self.assertFalse(capture_stalled(10, 8.0, now))
        self.assertTrue(capture_stalled(10, 4.0, now))

    def test_buffer_nao_apaga_o_som_acumulado(self):
        live = LiveAudio("pc", "")
        live.buf.extend(b"\x01\x00" * 30000)
        live._trim()
        self.assertGreater(len(live.buf), 3840 * 8)

    def test_96k_mantem_o_tom_e_corta_o_agudo(self):
        rate = 96000
        frames = rate // 10
        t = np.arange(frames, dtype=np.float32) / rate
        tone = np.sin(2 * np.pi * 1000 * t)
        high = np.sin(2 * np.pi * 40000 * t)
        rs = soxr.ResampleStream(rate, 48000, 2, dtype="float32", quality=soxr.VHQ)
        out = rs.resample_chunk(np.column_stack((tone, tone)).astype(np.float32), last=True)
        self.assertGreater(len(out), frames * 0.4)
        self.assertLess(len(out), frames * 0.6)
        self.assertGreater(float(np.max(np.abs(out))), 0.5)
        rs_high = soxr.ResampleStream(rate, 48000, 2, dtype="float32", quality=soxr.VHQ)
        aliased = rs_high.resample_chunk(np.column_stack((high, high)).astype(np.float32), last=True)
        steady = aliased[len(aliased) // 4: (3 * len(aliased)) // 4]
        self.assertLess(float(np.max(np.abs(steady))), 0.02)

    def test_downmix_inclui_o_canal_central(self):
        samples = array.array("h", [0, 0, 16384, 0, 0, 0, 0, 0])
        stereo = downmix_float(samples.tobytes(), 8, "int16")
        self.assertGreater(float(stereo[0, 0]), 0.2)
        self.assertGreater(float(stereo[0, 1]), 0.2)
        mono = array.array("h", [16000])
        both = downmix_float(mono.tobytes(), 1, "int16")
        self.assertAlmostEqual(float(both[0, 0]), float(both[0, 1]), places=3)

    def test_lista_de_som_nao_perde_o_auxiliar(self):
        names = merge_playback(["Gaming [Loopback]", "Aux [Loopback]", "Gaming [Loopback]", "Media [Loopback]"])
        self.assertEqual(names, ["Gaming [Loopback]", "Aux [Loopback]", "Media [Loopback]"])

    def test_falta_de_som_vira_silencio_e_nao_repete(self):
        held = bytearray(b"\x7f\x7f")
        self.assertEqual(next_chunk(held, 8), bytes(8))
        self.assertEqual(bytes(held), b"\x7f\x7f")
        ready = bytearray(b"\x01\x02\x03\x04")
        self.assertEqual(next_chunk(ready, 4), b"\x01\x02\x03\x04")
        self.assertEqual(len(ready), 0)

    def test_som_sai_na_ordem_e_nao_vira_silencio(self):
        frame = 3840
        buf = bytearray(b"\x01" * frame + b"\x02" * frame)
        silence, take = plan_audio(buf, frame * 10, frame)
        self.assertEqual((silence, take), (0, frame))
        self.assertEqual(bytes(buf), b"\x01" * frame + b"\x02" * frame)
        self.assertEqual(next_chunk(buf, frame), b"\x01" * frame)

    def test_excesso_grande_sai_e_buraco_vazio_e_silencio(self):
        frame = 3840
        quiet = bytearray()
        silence, take = plan_audio(quiet, frame * 10, frame)
        self.assertEqual((silence, take), (frame, 0))
        huge = bytearray((b"\x01" * frame) + (b"\x02" * (frame * 19)))
        silence, take = plan_audio(huge, frame * 10, frame)
        self.assertEqual((silence, take), (0, frame))
        self.assertLess(len(huge), frame * 10)
        self.assertTrue(bytes(huge).endswith(b"\x02" * frame))
        self.assertAlmostEqual(progress_seconds("out_time_us=1500000"), 1.5)
        self.assertAlmostEqual(progress_seconds("out_time=00:00:01.250000"), 1.25)
        self.assertIsNone(progress_seconds("frame=10"))

    def test_mistura_pc_e_microfone(self):
        live = LiveAudio("pc", "mic")
        live.queues = {
            "pc": np.array([[0.5, 0.0]], np.float32),
            "mic": np.array([[0.25, 0.0]], np.float32),
        }
        live._mix_ready()
        mixed = np.frombuffer(bytes(live.buf[:4]), dtype=np.int16)
        self.assertGreater(int(mixed[0]), 20000)
        self.assertEqual(len(live.queues["pc"]), 0)
        clipped = LiveAudio("pc", "mic")
        clipped.queues = {
            "pc": np.array([[1.0, 0.0]], np.float32),
            "mic": np.array([[1.0, 0.0]], np.float32),
        }
        clipped._mix_ready()
        limited = np.frombuffer(bytes(clipped.buf[:4]), dtype=np.int16)
        self.assertEqual(int(limited[0]), 32767)

    def test_abertura_nao_escreve_silencio_antes_da_captura(self):
        opened = []

        class Stream:
            def stop_stream(self):
                pass

            def close(self):
                pass

            def read(self, count, exception_on_overflow=False):
                time.sleep(0.05)
                return bytes(count * 4)

            def write(self, data):
                time.sleep(0.05)

        class Fake:
            def __init__(self):
                self.devices = [
                    {
                        "hostApi": 0, "name": "Speakers", "index": 1, "isLoopbackDevice": False,
                        "maxOutputChannels": 2, "maxInputChannels": 0, "defaultSampleRate": 48000,
                    },
                    {
                        "hostApi": 0, "name": "Speakers [Loopback]", "index": 2, "isLoopbackDevice": True,
                        "maxOutputChannels": 0, "maxInputChannels": 2, "defaultSampleRate": 48000,
                    },
                ]

            def get_host_api_info_by_type(self, _kind):
                return {"index": 0}

            def get_device_count(self):
                return len(self.devices)

            def get_device_info_by_index(self, index):
                return self.devices[index]

            def open(self, **kwargs):
                opened.append("out" if kwargs.get("output") else "in")
                return Stream()

            def terminate(self):
                pass

        live = LiveAudio("Speakers [Loopback]", "")
        live.audio = Fake()
        live._output_audio = Fake
        before = threading.active_count()
        live._open_devices()
        self.assertEqual(opened, ["out", "in"])
        self.assertEqual(threading.active_count(), before)
        live._start_pumps()
        self.assertGreater(threading.active_count(), before)
        live.close()

    def test_espera_do_som_tem_limite(self):
        with self.assertRaises(TimeoutError):
            run_with_timeout(lambda: time.sleep(1), 0.05)
        self.assertEqual(run_with_timeout(lambda: "ok", 1), "ok")

    def test_lista_da_interface_e_escura(self):
        Choice._ensure_app = None
        from spartan_live import _ensure_qt_app
        _ensure_qt_app()
        root = QWidget()
        try:
            variable = _QtVar("Alto-falantes")
            choice = Choice(root, variable, ["Alto-falantes", "Outro"], "#171717", "#1c1c1c", "#ececec", "#8d4545")
            choice.resize(300, 38)
            choice.redraw()
            self.assertEqual(choice.field.lower(), "#1c1c1c")
            choice.pick("Outro")
            self.assertEqual(variable.get(), "Outro")
            self.assertIsNone(choice.popup)
        finally:
            root.close()

    def test_janela_abre_no_centro_do_monitor_principal(self):
        self.assertEqual(center_on_workarea((0, 0, 1920, 1080), 560, 720), (680, 180))
        self.assertEqual(center_on_workarea((1920, 40, 3840, 1120), 560, 720), (2600, 220))
        self.assertEqual(center_on_workarea((10, 20, 100, 80), 560, 720), (10, 20))

    def test_bandeja_tira_o_botao_da_barra_e_a_janela_aberta_devolve(self):
        hidden = taskbar_exstyle(0x00040000, False)
        self.assertFalse(hidden & 0x00040000)
        self.assertTrue(hidden & 0x00000080)
        shown = taskbar_exstyle(hidden, True)
        self.assertTrue(shown & 0x00040000)
        self.assertFalse(shown & 0x00000080)

    def test_clique_na_bandeja_abre_mesmo_com_o_numero_do_icone(self):
        self.assertEqual(tray_action(0x0202), "open")
        self.assertEqual(tray_action(0x00010202), "open")
        self.assertEqual(tray_action(0x00010205), "menu")
        self.assertEqual(tray_action(0x0400), "open")
        self.assertEqual(tray_action(0), "")

    def test_o_desenho_do_icone_ignora_a_margem_vazia(self):
        pixels = bytearray(8 * 4 * 4)
        pixels[1 * 8 * 4 + 2 * 4 + 3] = 255
        pixels[2 * 8 * 4 + 5 * 4 + 3] = 255
        self.assertEqual(icon_content_box(8, 4, bytes(pixels)), (2, 1, 6, 3))

    def test_o_desenho_preenche_o_quadrado_da_bandeja(self):
        pixels = bytearray(10 * 10 * 4)
        for y in range(3, 7):
            for x in range(3, 7):
                index = (y * 10 + x) * 4
                pixels[index:index + 4] = bytes((16, 32, 48, 255))
        fitted = fit_icon_pixels(10, 10, bytes(pixels), 8)
        self.assertEqual(fitted[3], 255)
        self.assertEqual(fitted[(4 * 8 + 4) * 4 + 3], 255)
        self.assertEqual(fitted[(4 * 8 + 4) * 4 + 2], 48)

    def test_icone_da_bandeja_muda_quando_transmite(self):
        idle = presence_icon(False)
        live = presence_icon(True)
        self.assertTrue(os.path.basename(idle) == "Spartan-Live.ico")
        self.assertTrue(os.path.basename(live) == "Spartan-Live-ON.ico")
        self.assertNotEqual(os.path.normcase(idle), os.path.normcase(live))

    def test_icone_e_o_arquivo_pronto(self):
        path = os.path.join(os.path.dirname(__file__), "..", "assets", "Spartan-Live.ico")
        before = os.path.getmtime(path)
        with open(path, "rb") as handle:
            data = handle.read(6)
        reserved, kind = struct.unpack_from("<HH", data, 0)
        self.assertEqual((reserved, kind), (0, 1))
        self.assertEqual(os.path.getmtime(path), before)

    def test_ip_certo_nao_vira_erro_de_endereco(self):
        entrada = "Error opening input files: Invalid argument"
        self.assertNotIn("endereço do servidor", explain_error(entrada).lower())
        self.assertIn("aparelho de som", explain_error("Invalid audio channels").lower())
        self.assertIn("tela mudou", explain_error("[out#0/flv] Error closing file: Error number -10053 occurred").lower())

    def test_microfone_nao_pega_a_saida_com_o_mesmo_nome(self):
        devices = [
            {"hostApi": 0, "name": "Microfone", "index": 3, "isLoopbackDevice": False, "maxInputChannels": 0, "maxOutputChannels": 2},
            {"hostApi": 0, "name": "Microfone", "index": 9, "isLoopbackDevice": False, "maxInputChannels": 2, "maxOutputChannels": 0},
        ]
        live = LiveAudio("", "Microfone")
        found = live._find(devices, 0, "Microfone", loopback=False)
        self.assertEqual(found["index"], 9)

    def test_ffmpeg_grava_a_tela_com_o_ip_intacto(self):
        ffmpeg = os.path.join(os.path.dirname(__file__), "ffmpeg", "ffmpeg.exe")
        if not os.path.isfile(ffmpeg):
            self.skipTest("sem ffmpeg")
        encoders = usable_encoders(ffmpeg)
        from spartan_live import list_monitors
        monitors = list_monitors()
        monitor = next(item for item in monitors if item["left"] == 0 and item["top"] == 0)
        port = 20000 + (os.getpid() % 15000)
        relay = f"tcp://127.0.0.1:{port}"
        pipe = rf"\\.\pipe\spartan-live-test-{os.getpid()}"
        video = build_command(
            ffmpeg, "gdigrab", encoders[0], 30, monitor, monitors.index(monitor),
            "rtmp://203.0.113.10/diag", True, relay=relay,
        )
        mux = build_mux_command(ffmpeg, pipe, relay, 0.0, "rtmp://203.0.113.10/diag")
        self.assertIn("203.0.113.10", mux[-1])
        mux = mux[:-1] + ["-t", "1", "-f", "null", "-"]
        live = LiveAudio("", "")
        video_proc = None
        mux_proc = None
        try:
            live.open_pipe(pipe)
            video_proc = subprocess.Popen(
                video, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            clock = {}

            def watch():
                for line in video_proc.stderr:
                    found = video_clock(line)
                    if found is not None and "t" not in clock:
                        clock["t"] = found

            threading.Thread(target=watch, daemon=True).start()
            threading.Thread(target=video_proc.stdout.read, daemon=True).start()
            deadline = time.time() + 8
            while "t" not in clock and time.time() < deadline:
                if video_proc.poll() is not None:
                    break
                time.sleep(0.05)
            self.assertIn("t", clock)
            started_at = time.perf_counter()
            live.attach(lambda: time.perf_counter() - started_at)
            mux_proc = subprocess.Popen(
                mux, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
            )
            _out, err = mux_proc.communicate(timeout=20)
        finally:
            live.detach()
            for proc in (mux_proc, video_proc):
                if proc is None or proc.poll() is not None:
                    continue
                proc.kill()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
        self.assertEqual(mux_proc.returncode, 0, err[-800:])
        self.assertNotIn("Invalid argument", err)
        self.assertNotIn("Invalid audio channels", err)

    def test_media_com_microfone_abre(self):
        playback, capture = list_sound_devices()
        media = next((name for name in playback if "Sonar - Media" in name), "")
        mic = next((name for name in capture if "Sonar - Microphone" in name), "")
        if not media or not mic:
            self.skipTest("este PC não tem o Sonar")
        live = LiveAudio(media, mic)
        try:
            run_with_timeout(live.start, 5)
        except TimeoutError:
            live.close()
            self.fail("Media com microfone passou de 5 segundos")
        except Exception as error:
            live.close()
            self.fail(str(error))
        time.sleep(0.4)
        with live.lock:
            size = len(live.buf)
        live.close()
        self.assertGreater(size, 0)

    def test_som_padrao_do_windows_abre(self):
        name = system_default_playback()
        if not name:
            self.skipTest("este PC não tem loopback WASAPI")
        live = LiveAudio(name, "")
        try:
            run_with_timeout(live.start, 5)
        except TimeoutError:
            live.close()
            self.fail("a abertura do som passou de 5 segundos")
        time.sleep(0.5)
        with live.lock:
            size = len(live.buf)
        live.close()
        self.assertGreater(size, 0)

    def test_botao_transmitir_cabe_na_janela(self):
        app = App()
        try:
            app.geometry("560x720+-2400+-2400")
            app.update_idletasks()
            app.update()
            bottom = app.button.winfo_y() + app.button.winfo_height()
            self.assertGreater(app.button.winfo_height(), 30)
            self.assertLessEqual(app.content.winfo_reqheight(), 720 - 44)
            self.assertLessEqual(bottom, app.content.winfo_height())
            self.assertLess(app.windows_check.winfo_y() + app.windows_check.winfo_height(), app.button.winfo_y())
            self.assertEqual(app.button.label, "Transmitir")
            self.assertFalse(app.v_scroll.winfo_ismapped())
            self.assertFalse(app.h_scroll.winfo_ismapped())
            self.assertIn("480p30", app.quality_buttons)
            self.assertEqual(app.quality_buttons["480p30"].label, "480p 30")
            b480 = app.quality_buttons["480p30"]
            b720_60 = app.quality_buttons["720p60"]
            b720_30 = app.quality_buttons["720p30"]
            self.assertGreater(b480.winfo_y(), b720_60.winfo_y())
            self.assertGreaterEqual(b480.winfo_width(), b720_60.winfo_width() + b720_30.winfo_width())
        finally:
            app.destroy()

    def test_qualidade_480p30_usa_bitrate_baixo(self):
        self.assertEqual(parse_quality("480p30", 30), ("480p30", "480p 30", 854, 480, 30))
        args = encoder_args("libx264", 30, 480)
        self.assertIn("1500k", args)
        self.assertIn("3000k", args)
        self.assertIn("ultrafast", args)

    def test_janela_encolhida_mostra_barras_independentes_sem_esmagar_conteudo(self):
        self.assertEqual(scroll_bars_needed(560, 720, 558, 676), (False, False))
        self.assertEqual(scroll_bars_needed(560, 400, 558, 676), (False, True))
        self.assertEqual(scroll_bars_needed(350, 720, 558, 676), (True, False))
        self.assertEqual(scroll_bars_needed(300, 300, 558, 676), (True, True))
        self.assertEqual(resize_hit_test(2, 2, 560, 720), 13)
        self.assertEqual(resize_hit_test(558, 718, 560, 720), 17)
        self.assertEqual(resize_hit_test(280, 360, 560, 720), 0)
        app = App()
        try:
            app.geometry("300x300+-2400+-2400")
            app.update_idletasks()
            app.update()
            self.assertTrue(app.v_scroll.winfo_ismapped())
            self.assertTrue(app.h_scroll.winfo_ismapped())
            self.assertGreaterEqual(app.content.winfo_width(), 545)
            vbar = app.scroll_area.verticalScrollBar()
            hbar = app.scroll_area.horizontalScrollBar()
            self.assertEqual(vbar.value(), 0)
            self.assertEqual(hbar.value(), 0)
            from PySide6.QtCore import QPoint, QPointF, Qt
            from PySide6.QtGui import QWheelEvent
            ev_down = QWheelEvent(
                QPointF(100, 100), QPointF(100, 100), QPoint(0, 0), QPoint(0, -120),
                Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier, Qt.ScrollPhase.NoScrollPhase, False,
            )
            app.scroll_area.wheelEvent(ev_down)
            self.assertGreater(vbar.value(), 0)
            self.assertEqual(hbar.value(), 0)
            ev_shift = QWheelEvent(
                QPointF(100, 100), QPointF(100, 100), QPoint(0, 0), QPoint(0, -120),
                Qt.MouseButton.NoButton, Qt.KeyboardModifier.ShiftModifier, Qt.ScrollPhase.NoScrollPhase, False,
            )
            app.scroll_area.wheelEvent(ev_shift)
            self.assertGreater(hbar.value(), 0)
            app.geometry("600x400+-2400+-2400")
            app.update_idletasks()
            app.update()
            self.assertTrue(app.v_scroll.winfo_ismapped())
            self.assertFalse(app.h_scroll.winfo_ismapped())
            app.geometry("350x760+-2400+-2400")
            app.update_idletasks()
            app.update()
            self.assertFalse(app.v_scroll.winfo_ismapped())
            self.assertTrue(app.h_scroll.winfo_ismapped())
            app.geometry("560x720+-2400+-2400")
            app.update_idletasks()
            app.update()
            self.assertFalse(app.v_scroll.winfo_ismapped())
            self.assertFalse(app.h_scroll.winfo_ismapped())
        finally:
            app.destroy()

    def test_queda_do_video_no_jogo_nao_espera_5s_nem_manda_switch(self):
        class FakeProc:
            def __init__(self, code=None):
                self.code = code
                self.args = ["ffmpeg"]

            def poll(self):
                return self.code

            def wait(self, timeout=None):
                if self.code is None:
                    raise subprocess.TimeoutExpired(self.args, timeout)
                return self.code

        dummy = type("Dummy", (), {})()
        dummy.stopping = False
        dummy._switch_to = None
        dummy._switch_ready = False
        dummy._frame_seen = 120
        dummy._frame_at = time.perf_counter()
        dummy.video_proc = FakeProc(code=1)
        mux = FakeProc(code=None)
        killed = []
        dummy._kill_ffmpeg = lambda: (killed.append(True), setattr(mux, "code", 0))
        started = time.perf_counter()
        App._wait_proc(dummy, mux)
        elapsed = time.perf_counter() - started
        self.assertTrue(killed)
        self.assertLess(elapsed, 0.5)

    def test_volume_medidor_maximizar_e_aviso_de_rede(self):
        self.assertEqual(clamp_gain(-10), 0)
        self.assertEqual(clamp_gain(103), 105)
        self.assertEqual(clamp_gain(180), 150)
        mons = [{"left": 0, "top": 0, "width": 1920, "height": 1080}]
        self.assertIsNone(valid_saved_geom("560x720+-2400+-2400", mons))
        self.assertEqual(valid_saved_geom("560x720+100+100", mons), "560x720+100+100")
        self.assertAlmostEqual(progress_speed("speed=0.82x"), 0.82)
        self.assertIsNone(progress_speed("speed=N/A"))
        streak = 0
        for s in (0.80, 0.85, 0.79, 1.01, 0.82):
            streak = network_slow_streak(streak, s)
        self.assertEqual(streak, 1)
        stereo = np.array([[0.5, -0.25]], np.float32)
        self.assertGreater(peak_level(stereo), 0.5)
        live = LiveAudio("pc", "mic", pc_gain=1.2, mic_gain=0.5)
        self.assertAlmostEqual(live.pc_gain, 1.2, places=2)
        self.assertAlmostEqual(live.mic_gain, 0.5, places=2)
        live.set_gains(pc_gain=0.8, mic_gain=1.4, mic_muted=True)
        self.assertAlmostEqual(live.pc_gain, 0.8, places=2)
        self.assertAlmostEqual(live.mic_gain, 1.4, places=2)
        self.assertTrue(live.mic_muted)
        app = App()
        try:
            app.geometry("560x720+-2400+-2400")
            app.update_idletasks()
            app.update()
            self.assertIsNotNone(getattr(app, "max_button", None))
            self.assertIsNotNone(getattr(app, "pc_meter", None))
            self.assertIsNotNone(getattr(app, "mic_meter", None))
            app._toggle_maximize()
            app.update_idletasks()
            self.assertTrue(app._maximized)
            self.assertEqual(app.max_button.cget("text"), "❐")
            app._toggle_maximize()
            app.update_idletasks()
            self.assertFalse(app._maximized)
            self.assertEqual(app.max_button.cget("text"), "□")
            self.assertEqual(app.pc_meter.zero_btn.cget("text"), "0%")
            self.assertEqual(app.pc_meter.hundred_btn.cget("text"), "100%")
            app.pc_meter._set_exact(0)
            self.assertEqual(app.pc_volume.get(), 0)
            app.pc_meter._set_exact(100)
            self.assertEqual(app.pc_volume.get(), 100)
            ev_up = type("Ev", (), {"delta": 120})()
            ev_dn = type("Ev", (), {"delta": -120})()
            app.pc_meter._wheel(ev_up)
            self.assertEqual(app.pc_volume.get(), 105)
            app.pc_meter._wheel(ev_dn)
            self.assertEqual(app.pc_volume.get(), 100)
            app.running = True
            app.stopping = False
            app._live_quality = "1080p60"
            announced = []
            app._announce_switch = lambda ticket, kind="screen": announced.append((ticket, kind))
            app.quality.set("720p30")
            self.assertEqual(app._switch_quality, "720p30")
            self.assertIn("Trocando a qualidade para 720p 30", app.status.cget("text"))
            self.assertEqual(app._consume_quality_switch()[0], "720p30")
            self.assertIsNone(app._switch_quality)
        finally:
            app.destroy()


if __name__ == "__main__":
    unittest.main()
