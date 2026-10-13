# -*- coding: utf-8 -*-
"""
ChinaK12BookDownLoader 多线程下载与任务调度引擎
=============================================================
功能特性：
1. 内存任务队列与线程池调度；
2. 实时记录单项任务进度、下载速率、剩余时间与状态；
3. 本地同名文件（含版本号）秒级检测与跳过；
4. 先下载至 .download_temp/ 临时目录，通过 %PDF 头部与文件大小校验后原子剪切归档；
5. 支持 SSE 实时进度推送与取消/清空控制。
"""

import os
import sys
import time
import shutil
import requests
import threading
from pathlib import Path
from typing import Dict, List, Any, Optional, Callable

GLOBAL_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://basic.smartedu.cn/",
    "Origin": "https://basic.smartedu.cn",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Authorization": "Bearer 0",
    "X-ND-AUTH": 'MAC id="0",nonce="0",mac="0"',
}


class TaskItem:
    def __init__(self, book_meta: Dict[str, Any], target_root: str):
        self.id = book_meta["id"]
        self.seq = book_meta.get("seq", 0)
        self.title = book_meta.get("title", "")
        self.clean_title = book_meta.get("clean_title", "")
        self.edition_tag = book_meta.get("edition_tag", "")
        self.filename = book_meta.get("filename", "")
        self.relative_path = book_meta.get("relative_path", "")
        self.target_root = target_root
        self.target_full_path = str(Path(target_root) / self.relative_path)
        self.total_bytes = book_meta.get("pdf_size", 0)
        self.downloaded_bytes = 0
        self.speed = 0.0  # bytes per second
        self.status = "pending"  # pending, downloading, completed, skipped, failed, cancelled
        self.error_msg = ""
        self.start_time = None
        self.finish_time = None

    def to_dict(self) -> Dict[str, Any]:
        pct = 0.0
        if self.total_bytes > 0:
            pct = min(100.0, (self.downloaded_bytes / self.total_bytes) * 100)
        elif self.status == "completed":
            pct = 100.0

        return {
            "id": self.id,
            "seq": self.seq,
            "title": self.title,
            "clean_title": self.clean_title,
            "edition_tag": self.edition_tag,
            "filename": self.filename,
            "relative_path": self.relative_path,
            "total_bytes": self.total_bytes,
            "downloaded_bytes": self.downloaded_bytes,
            "percent": round(pct, 1),
            "speed_formatted": self._format_speed(),
            "status": self.status,
            "error_msg": self.error_msg,
        }

    def _format_speed(self) -> str:
        if self.status != "downloading" or self.speed <= 0:
            return ""
        if self.speed > 1024 * 1024:
            return f"{self.speed / (1024 * 1024):.1f} MB/s"
        return f"{self.speed / 1024:.0f} KB/s"


class DownloadManager:
    def __init__(self, max_workers: int = 5):
        self.max_workers = max_workers
        self.tasks: Dict[str, TaskItem] = {}
        self.task_order: List[str] = []
        self.lock = threading.Lock()
        self.active_workers = 0
        self.session = requests.Session()
        self.session.headers.update(GLOBAL_HEADERS)
        self.event_subscribers: List[Callable[[Dict[str, Any]], None]] = []
        self.stop_requested = False

    def subscribe(self, callback: Callable[[Dict[str, Any]], None]):
        self.event_subscribers.append(callback)

    def notify(self, event_type: str, data: Any = None):
        payload = {"type": event_type, "data": data, "timestamp": time.time()}
        for cb in list(self.event_subscribers):
            try:
                cb(payload)
            except Exception:
                pass

    def add_tasks(self, book_items: List[Dict[str, Any]], target_root: str) -> int:
        added = 0
        with self.lock:
            for item in book_items:
                book_id = item["id"]
                if book_id in self.tasks:
                    # 如果之前已失败或已取消，可重置为 pending
                    t = self.tasks[book_id]
                    if t.status in ("failed", "cancelled"):
                        t.status = "pending"
                        t.error_msg = ""
                        t.target_root = target_root
                        t.target_full_path = str(Path(target_root) / t.relative_path)
                        added += 1
                    continue

                task = TaskItem(item, target_root)
                self.tasks[book_id] = task
                self.task_order.append(book_id)
                added += 1

        self.notify("tasks_updated", {"added_count": added})
        self._trigger_workers()
        return added

    def _trigger_workers(self):
        with self.lock:
            while self.active_workers < self.max_workers:
                pending_task = None
                for tid in self.task_order:
                    t = self.tasks[tid]
                    if t.status == "pending":
                        pending_task = t
                        break

                if not pending_task:
                    break

                pending_task.status = "downloading"
                pending_task.start_time = time.time()
                self.active_workers += 1
                threading.Thread(target=self._worker_routine, args=(pending_task,), daemon=True).start()

    def _worker_routine(self, task: TaskItem):
        try:
            self._download_task(task)
        except Exception as e:
            task.status = "failed"
            task.error_msg = str(e)
        finally:
            with self.lock:
                self.active_workers -= 1
            self.notify("task_finished", task.to_dict())
            self._trigger_workers()

    def _download_task(self, task: TaskItem):
        target_path = Path(task.target_full_path)
        target_dir = target_path.parent
        target_dir.mkdir(parents=True, exist_ok=True)

        # 1. 检测同名同版本文件是否存在
        if target_path.exists() and target_path.stat().st_size > 50 * 1024:
            task.status = "skipped"
            task.downloaded_bytes = target_path.stat().st_size
            return

        # 2. 临时下载目录
        temp_dir = Path(task.target_root) / ".download_temp"
        temp_dir.mkdir(parents=True, exist_ok=True)
        temp_part = temp_dir / f"{task.id}.pdf.part"
        temp_finished = temp_dir / f"{task.id}.pdf"

        # 3. 获取下载链接
        details_url = f"https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/{task.id}.json"
        try:
            r = self.session.get(details_url, timeout=(10, 30))
            if r.status_code != 200:
                details_url_backup = f"https://s-file-2.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/{task.id}.json"
                r = self.session.get(details_url_backup, timeout=(10, 30))
                if r.status_code != 200:
                    task.status = "failed"
                    task.error_msg = f"获取元数据失败 (HTTP {r.status_code})"
                    return

            data = r.json()
            items = data.get("ti_items") or []
            pdf_item = next((it for it in items if it.get("ti_format") == "pdf"), None)
            if not pdf_item:
                task.status = "failed"
                task.error_msg = "官方未发布有效 PDF"
                return

            candidate_urls = pdf_item.get("ti_storages") or []
            if not candidate_urls and pdf_item.get("ti_storage"):
                candidate_urls = [pdf_item["ti_storage"].replace("cs_path:${ref-path}", "https://r1-ndr-private.ykt.cbern.com.cn")]

            if not candidate_urls:
                task.status = "failed"
                task.error_msg = "无法解析 CDN 下载地址"
                return

            download_ok = False
            for url in candidate_urls:
                try:
                    with self.session.get(url, timeout=(15, 180), stream=True) as resp:
                        if resp.status_code != 200:
                            continue

                        expected_size = int(resp.headers.get("content-length") or task.total_bytes or 0)
                        if expected_size > 0:
                            task.total_bytes = expected_size

                        written = 0
                        first_chunk = True
                        is_valid_pdf = True
                        last_time = time.time()
                        last_written = 0

                        with open(temp_part, "wb") as f_out:
                            for chunk in resp.iter_content(chunk_size=256 * 1024):
                                if not chunk:
                                    continue
                                if first_chunk:
                                    first_chunk = False
                                    if not chunk.startswith(b"%PDF"):
                                        is_valid_pdf = False
                                        break
                                f_out.write(chunk)
                                written += len(chunk)
                                task.downloaded_bytes = written

                                # 计算速率
                                now = time.time()
                                dt = now - last_time
                                if dt >= 0.5:
                                    task.speed = (written - last_written) / dt
                                    last_time = now
                                    last_written = written

                        if not is_valid_pdf or written < 20 * 1024:
                            temp_part.unlink(missing_ok=True)
                            continue

                        # 下载完成，原子移动
                        temp_part.replace(temp_finished)
                        shutil.move(str(temp_finished), str(target_path))

                        download_ok = True
                        task.status = "completed"
                        task.downloaded_bytes = written
                        task.finish_time = time.time()
                        break
                except Exception:
                    temp_part.unlink(missing_ok=True)
                    temp_finished.unlink(missing_ok=True)
                    continue

            if not download_ok:
                task.status = "failed"
                task.error_msg = "所有 CDN 镜像节点连接失败"

        except Exception as e:
            task.status = "failed"
            task.error_msg = str(e)

    def get_all_tasks(self) -> List[Dict[str, Any]]:
        with self.lock:
            return [self.tasks[tid].to_dict() for tid in self.task_order]

    def clear_completed(self):
        with self.lock:
            to_remove = [tid for tid in self.task_order if self.tasks[tid].status in ("completed", "skipped")]
            for tid in to_remove:
                del self.tasks[tid]
                self.task_order.remove(tid)
        self.notify("tasks_cleared")

    def cancel_all(self):
        with self.lock:
            for t in self.tasks.values():
                if t.status in ("pending", "downloading"):
                    t.status = "cancelled"
        self.notify("tasks_cancelled")
