# -*- coding: utf-8 -*-
"""
ChinaK12BookDownLoader 历史版本镜像归档引擎
=============================================================
功能说明：
当国家智慧教育平台改版、换代或移除某本旧版教材时，为避免本地目录新旧混杂，
本引擎会扫描下载根目录（如 China12Books），识别所有已不在官方当前最新清单中的历史文件，
安全将其剪切移动至根目录下的 History/ 镜像子目录中（若已存在同名历史文件则直接覆盖替换）。
"""

import os
import shutil
from pathlib import Path
from typing import Dict, List, Any, Set, Tuple


def archive_single_file_to_history(source_file: Path, root_path: Path) -> Path:
    """
    将单个旧版本文件安全剪切/移动至 History/ 对应镜像子目录。
    若 History 中已存在该文件，则直接覆盖替换！
    """
    rel_path = source_file.relative_to(root_path)
    history_target = root_path / "History" / rel_path
    history_target.parent.mkdir(parents=True, exist_ok=True)

    if history_target.exists():
        history_target.unlink()

    shutil.move(str(source_file), str(history_target))
    return history_target


def audit_and_archive_history(
    target_root: str,
    valid_relative_paths: Set[str],
) -> Dict[str, Any]:
    """
    扫描 target_root 目录，核对不在 valid_relative_paths 中的文件，
    将其安全移动至 target_root/History/... 镜像目录（已存在则直接覆盖替换）。
    """
    root_path = Path(target_root).resolve()
    if not root_path.exists():
        return {"error": "目标根目录不存在"}

    history_root = root_path / "History"
    history_root.mkdir(parents=True, exist_ok=True)

    archived_items = []
    ignored_dirs = {"History", ".download_temp", ".git", "__pycache__", "node_modules"}

    for dirpath, dirnames, filenames in os.walk(root_path):
        parts = Path(dirpath).relative_to(root_path).parts
        if any(part in ignored_dirs for part in parts):
            continue

        for fname in filenames:
            if not fname.lower().endswith(".pdf"):
                continue

            current_file = Path(dirpath) / fname
            rel_file_path = str(current_file.relative_to(root_path))

            # 核对是否在官方当前有效清单中
            if rel_file_path not in valid_relative_paths:
                try:
                    history_file = archive_single_file_to_history(current_file, root_path)
                    archived_items.append({
                        "filename": fname,
                        "source": rel_file_path,
                        "destination": f"History/{rel_file_path}",
                        "size": history_file.stat().st_size,
                    })
                except Exception as e:
                    print(f"⚠️ 移动历史文件失败: {rel_file_path} -> {e}")

    # 清理产生的空目录（排除 History 自身）
    for dirpath, dirnames, filenames in os.walk(root_path, topdown=False):
        p = Path(dirpath)
        if p == root_path or "History" in p.parts or ".git" in p.parts:
            continue
        try:
            if not any(p.iterdir()):
                p.rmdir()
        except Exception:
            pass

    return {
        "success": True,
        "archived_count": len(archived_items),
        "archived_items": archived_items,
    }
