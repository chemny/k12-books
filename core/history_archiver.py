# -*- coding: utf-8 -*-
"""
ChinaK12BookDownLoader 历史版本镜像归档引擎
=============================================================
功能说明：
当国家智慧教育平台改版、换代或移除某本旧版教材时，为避免本地目录新旧混杂，
本引擎会扫描下载根目录（如 China12Books），识别所有已不在官方当前最新清单中的历史文件，
安全将其剪切移动至根目录下的 History/ 镜像子目录中，保持目录层级 100% 一致。
"""

import os
import shutil
from pathlib import Path
from typing import Dict, List, Any, Set, Tuple


def audit_and_archive_history(
    target_root: str,
    valid_relative_paths: Set[str],
) -> Dict[str, Any]:
    """
    扫描 target_root 目录，核对不在 valid_relative_paths 中的文件，
    将其安全移动至 target_root/History/... 镜像目录。
    """
    root_path = Path(target_root).resolve()
    if not root_path.exists():
        return {"error": "目标根目录不存在"}

    history_root = root_path / "History"
    history_root.mkdir(parents=True, exist_ok=True)

    archived_items = []
    ignored_dirs = {"History", ".download_temp", ".git", "__pycache__", "node_modules"}

    for dirpath, dirnames, filenames in os.walk(root_path):
        # 排除忽略目录
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
                # 不在官方最新清单中 -> 这是已被官方更新/移除的历史版本！
                history_target_file = history_root / rel_file_path
                history_target_file.parent.mkdir(parents=True, exist_ok=True)

                try:
                    # 剪切/移动至 History/
                    shutil.move(str(current_file), str(history_target_file))
                    archived_items.append({
                        "filename": fname,
                        "source": rel_file_path,
                        "destination": f"History/{rel_file_path}",
                        "size": history_target_file.stat().st_size,
                    })
                except Exception as e:
                    print(f"⚠️ 移动历史文件失败: {rel_file_path} -> {e}")

    # 清理可能产生的空目录（排除 History 自身）
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
