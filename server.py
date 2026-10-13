#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ChinaK12BookDownLoader 本地服务与 API 调度中心
=============================================================
提供现代化 RESTful API、SSE 实时事件流与静态前端资源托管。
"""

import os
import sys
import json
import time
import queue
import urllib.parse
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from typing import Dict, Any, List

CURRENT_DIR = Path(__file__).resolve().parent
WEB_DIR = CURRENT_DIR / "web"
CONFIG_FILE = Path.home() / ".chinak12_downloader_config.json"

sys.path.insert(0, str(CURRENT_DIR))
from core.catalog import load_catalog_data
from core.downloader import DownloadManager
from core.history_archiver import audit_and_archive_history

# 全局单例管理器
DOWNLOAD_MANAGER = DownloadManager(max_workers=5)
CATALOG_DATA = None


def get_stored_config() -> Dict[str, Any]:
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    # 默认建议路径
    default_dir = str(CURRENT_DIR.parent / "China12Books")
    return {"download_dir": default_dir}


def save_stored_config(cfg: Dict[str, Any]):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"⚠️ 保存配置失败: {e}")


class DownloaderHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def do_GET(self):
        url_parts = urllib.parse.urlsplit(self.path)
        path = url_parts.path

        if path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            with open(WEB_DIR / "index.html", "rb") as f:
                self.wfile.write(f.read())
            return

        if path == "/api/catalog":
            global CATALOG_DATA
            if CATALOG_DATA is None:
                CATALOG_DATA = load_catalog_data()
            self._send_json(CATALOG_DATA)
            return

        if path == "/api/config":
            cfg = get_stored_config()
            # 校验目录状态
            dpath = Path(cfg.get("download_dir", ""))
            cfg["exists"] = dpath.exists()
            cfg["is_dir"] = dpath.is_dir()
            self._send_json(cfg)
            return

        if path == "/api/tasks":
            tasks = DOWNLOAD_MANAGER.get_all_tasks()
            self._send_json({"tasks": tasks})
            return

        if path == "/api/events":
            self._handle_sse()
            return

        # 其他静态文件
        super().do_GET()

    def do_POST(self):
        url_parts = urllib.parse.urlsplit(self.path)
        path = url_parts.path
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length > 0 else b""
        payload = json.loads(body.decode("utf-8")) if body else {}

        if path == "/api/config":
            new_dir = payload.get("download_dir", "").strip()
            if not new_dir:
                self._send_json({"error": "下载目录不能为空"}, 400)
                return
            target_p = Path(new_dir)
            try:
                target_p.mkdir(parents=True, exist_ok=True)
            except Exception as e:
                self._send_json({"error": f"无法创建或访问该目录: {e}"}, 400)
                return
            save_stored_config({"download_dir": str(target_p.resolve())})
            self._send_json({"success": True, "download_dir": str(target_p.resolve())})
            return

        if path == "/api/download":
            cfg = get_stored_config()
            target_root = cfg.get("download_dir", "")
            if not target_root or not Path(target_root).exists():
                self._send_json({"error": "请先设置并确认有效的下载根目录！"}, 400)
                return

            book_ids = set(payload.get("book_ids", []))
            if not book_ids:
                self._send_json({"error": "未指定要下载的书籍 ID"}, 400)
                return

            global CATALOG_DATA
            if CATALOG_DATA is None:
                CATALOG_DATA = load_catalog_data()

            matched_books = [b for b in CATALOG_DATA["books"] if b["id"] in book_ids and b["has_pdf"]]
            added_count = DOWNLOAD_MANAGER.add_tasks(matched_books, target_root)
            self._send_json({"success": True, "added_count": added_count})
            return

        if path == "/api/tasks/clear":
            DOWNLOAD_MANAGER.clear_completed()
            self._send_json({"success": True})
            return

        if path == "/api/tasks/cancel":
            DOWNLOAD_MANAGER.cancel_all()
            self._send_json({"success": True})
            return

        if path == "/api/audit_history":
            cfg = get_stored_config()
            target_root = cfg.get("download_dir", "")
            if not target_root or not Path(target_root).exists():
                self._send_json({"error": "下载目录尚未设置或不存在"}, 400)
                return

            if CATALOG_DATA is None:
                CATALOG_DATA = load_catalog_data()

            # 当前官方平台有效教材的相对路径集合
            valid_rel_paths = {b["relative_path"] for b in CATALOG_DATA["books"] if b["has_pdf"]}
            result = audit_and_archive_history(target_root, valid_rel_paths)
            self._send_json(result)
            return

        self._send_json({"error": "Not Found"}, 404)

    def _send_json(self, data: Any, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_sse(self):
        """处理 Server-Sent Events 长连接推送"""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        q = queue.Queue(maxsize=100)

        def on_event(payload):
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass

        DOWNLOAD_MANAGER.subscribe(on_event)

        try:
            while True:
                # 定时发送心跳与任务全量刷新
                try:
                    event = q.get(timeout=1.0)
                    line = f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                    self.wfile.write(line.encode("utf-8"))
                    self.wfile.flush()
                except queue.Empty:
                    tasks = DOWNLOAD_MANAGER.get_all_tasks()
                    hb = {"type": "heartbeat", "tasks": tasks, "timestamp": time.time()}
                    line = f"data: {json.dumps(hb, ensure_ascii=False)}\n\n"
                    self.wfile.write(line.encode("utf-8"))
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def run_server(port: int = 8080):
    server_address = ("127.0.0.1", port)
    httpd = ThreadingHTTPServer(server_address, DownloaderHandler)
    print(f"🚀 ChinaK12BookDownLoader 界面已启动: http://127.0.0.1:{port}")
    httpd.serve_forever()


if __name__ == "__main__":
    port = 8080
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])
    run_server(port)
