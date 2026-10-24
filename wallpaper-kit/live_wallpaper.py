# -*- coding: utf-8 -*-
"""
Живые обои для Windows 10/11: проигрывает видео по кругу ПОД иконками рабочего стола.

Запуск:   start.cmd            (или: pythonw live_wallpaper.py [путь_к_видео])
Остановка: stop.cmd            (создаёт файл stop.flag, скрипт его видит и выходит)

Видео: берётся аргумент командной строки, иначе wallpaper.mp4 рядом со скриптом,
иначе первый видеофайл (.mp4/.mkv/.webm/.avi/.mov/.gif) в этой папке.
"""
import ctypes
import ctypes.wintypes as wt
import glob
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
STOP_FLAG = os.path.join(HERE, "stop.flag")
LOG_FILE = os.path.join(HERE, "live_wallpaper.log")

# ---------- настройки ----------
FPS_LIMIT = 0          # 0 = как в видео; можно поставить 30, чтобы меньше грузить ПК
PAUSE_WHEN_FULLSCREEN = True   # пауза, когда открыта игра/видео на весь экран
# --------------------------------


def log(msg):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(time.strftime("%H:%M:%S ") + str(msg) + "\n")
    except OSError:
        pass


user32 = ctypes.windll.user32

# DPI: чтобы на масштабе 125-150% окно было на весь экран, а не на его часть
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    user32.SetProcessDPIAware()

import cv2       # noqa: E402  (после DPI)
import pygame    # noqa: E402

user32.FindWindowW.restype = wt.HWND
user32.FindWindowExW.restype = wt.HWND
user32.FindWindowExW.argtypes = [wt.HWND, wt.HWND, wt.LPCWSTR, wt.LPCWSTR]
user32.SetParent.restype = wt.HWND
user32.SetParent.argtypes = [wt.HWND, wt.HWND]
user32.GetForegroundWindow.restype = wt.HWND
user32.GetShellWindow.restype = wt.HWND
user32.GetWindowLongW.restype = ctypes.c_long
user32.SetWindowLongW.argtypes = [wt.HWND, ctypes.c_int, ctypes.c_long]
user32.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, ctypes.c_uint]

GWL_STYLE, GWL_EXSTYLE = -16, -20
WS_CHILD, WS_POPUP = 0x40000000, 0x80000000
WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_APPWINDOW = 0x80000, 0x80, 0x40000
LWA_ALPHA = 0x2
SWP_NOACTIVATE, SWP_SHOWWINDOW = 0x10, 0x40
SPI_GETDESKWALLPAPER, SPI_SETDESKWALLPAPER = 0x73, 0x14
SPIF_UPDATEINIFILE = 0x1


def find_video():
    if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
        return sys.argv[1]
    p = os.path.join(HERE, "wallpaper.mp4")
    if os.path.isfile(p):
        return p
    for ext in ("mp4", "mkv", "webm", "avi", "mov", "gif"):
        files = sorted(glob.glob(os.path.join(HERE, "*." + ext)))
        if files:
            return files[0]
    return None


def get_desktop_layer():
    """
    Возвращает (parent_hwnd, insert_after_hwnd).
    Старый Windows (10, 11 до 24H2): отдельное окно WorkerW позади иконок.
    Windows 11 24H2+: WorkerW стал дочерним у Progman, вставляемся в Progman под SHELLDLL_DefView.
    """
    progman = user32.FindWindowW("Progman", None)
    res = wt.DWORD()
    # Просим Progman создать WorkerW за иконками
    user32.SendMessageTimeoutW(progman, 0x052C, 0xD, 0x1, 0, 1000, ctypes.byref(res))
    user32.SendMessageTimeoutW(progman, 0x052C, 0, 0, 0, 1000, ctypes.byref(res))

    found = {"workerw": None, "defview": None}

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def enum_cb(hwnd, _):
        dv = user32.FindWindowExW(hwnd, None, "SHELLDLL_DefView", None)
        if dv:
            found["defview"] = dv
            found["workerw"] = user32.FindWindowExW(None, hwnd, "WorkerW", None)
        return True

    user32.EnumWindows(enum_cb, 0)

    if found["workerw"]:
        log("Режим: классический WorkerW")
        return found["workerw"], None

    # Windows 11 24H2
    defview = user32.FindWindowExW(progman, None, "SHELLDLL_DefView", None)
    log("Режим: Win11 24H2 (Progman)")
    return progman, defview


def is_fullscreen_app_active(sw, sh):
    fg = user32.GetForegroundWindow()
    if not fg or fg == user32.GetShellWindow():
        return False
    cls = ctypes.create_unicode_buffer(64)
    user32.GetClassNameW(fg, cls, 64)
    if cls.value in ("WorkerW", "Progman"):
        return False
    r = wt.RECT()
    user32.GetWindowRect(fg, ctypes.byref(r))
    return r.left <= 0 and r.top <= 0 and r.right >= sw and r.bottom >= sh


def restore_wallpaper():
    """Перерисовать обычные обои после выхода."""
    buf = ctypes.create_unicode_buffer(520)
    user32.SystemParametersInfoW(SPI_GETDESKWALLPAPER, 520, buf, 0)
    user32.SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, buf.value, SPIF_UPDATEINIFILE)


def main():
    if os.path.exists(STOP_FLAG):
        os.remove(STOP_FLAG)

    video = find_video()
    if not video:
        ctypes.windll.user32.MessageBoxW(
            None, "Положите видео (wallpaper.mp4 или .gif) рядом со скриптом.", "Live Wallpaper", 0x10)
        return
    log("Видео: " + video)

    sw, sh = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)       # основной монитор
    vx, vy = user32.GetSystemMetrics(76), user32.GetSystemMetrics(77)     # начало виртуального экрана

    os.environ["SDL_VIDEO_WINDOW_POS"] = "0,0"
    pygame.init()
    screen = pygame.display.set_mode((sw, sh), pygame.NOFRAME)
    pygame.display.set_caption("LiveWallpaper")
    hwnd = pygame.display.get_wm_info()["window"]

    parent, insert_after = get_desktop_layer()

    style = user32.GetWindowLongW(hwnd, GWL_STYLE)
    user32.SetWindowLongW(hwnd, GWL_STYLE, (style & ~WS_POPUP) | WS_CHILD)
    ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    ex = (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW
    if insert_after:  # 24H2 требует layered-окно
        ex |= WS_EX_LAYERED
    user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex)
    if insert_after:
        user32.SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA)

    user32.SetParent(hwnd, parent)
    # координаты внутри WorkerW считаются от левого-верхнего угла всех мониторов
    user32.SetWindowPos(hwnd, insert_after, -vx, -vy, sw, sh, SWP_NOACTIVATE | SWP_SHOWWINDOW)

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        log("Не удалось открыть видео")
        return
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    if FPS_LIMIT:
        fps = min(fps, FPS_LIMIT)
    frame_time = 1.0 / fps
    src_fps = cap.get(cv2.CAP_PROP_FPS) or fps
    skip = max(1, round(src_fps / fps))

    clock = pygame.time.Clock()
    last_check = 0
    paused = False
    try:
        while True:
            for e in pygame.event.get():
                if e.type == pygame.QUIT:
                    return

            now = time.time()
            if now - last_check > 1.0:
                last_check = now
                if os.path.exists(STOP_FLAG):
                    log("stop.flag -> выход")
                    return
                paused = PAUSE_WHEN_FULLSCREEN and is_fullscreen_app_active(sw, sh)

            if paused:
                time.sleep(0.25)
                continue

            for _ in range(skip):
                ok, frame = cap.read()
                if not ok:  # конец — начать заново
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    ok, frame = cap.read()
                    if not ok:
                        return

            if frame.shape[1] != sw or frame.shape[0] != sh:
                frame = cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_LINEAR)
            surf = pygame.image.frombuffer(frame.tobytes(), (sw, sh), "BGR")
            screen.blit(surf, (0, 0))
            pygame.display.flip()
            clock.tick(fps)
    finally:
        cap.release()
        pygame.quit()
        restore_wallpaper()
        if os.path.exists(STOP_FLAG):
            os.remove(STOP_FLAG)


if __name__ == "__main__":
    try:
        main()
    except Exception as ex:
        import traceback
        log(traceback.format_exc())
        restore_wallpaper()
