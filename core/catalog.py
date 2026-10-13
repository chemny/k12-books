# -*- coding: utf-8 -*-
"""
ChinaK12BookDownLoader 核心目录分类、版本标注与最新在用优选引擎
=============================================================
负责加载与解析平台 3565 本教材，提取规范的学段、学科、出版社、年级、版本标签，
并自动对同名同分类的多版本（如 #101 与 #3528）进行时间比对，智能优选官方当前最新在用版！
"""

import os
import re
import json
from pathlib import Path
from typing import Dict, List, Any, Tuple, Optional

# 出版社标准名称映射表（对齐 ChinaTextbook 标准）
PUBLISHER_MAPPING = {
    "人教版": "人教版-人民教育出版社",
    "统编版": "统编版-人民教育出版社",
    "部编版": "统编版-人民教育出版社",
    "北师大版": "北师大版-北京师范大学出版社",
    "苏教版": "苏教版-江苏凤凰教育出版社",
    "苏科版": "苏科版-江苏凤凰科学技术出版社",
    "冀教版": "冀教版-河北教育出版社",
    "鲁教版": "鲁教版-山东教育出版社",
    "鲁人版": "鲁人版-山东人民出版社",
    "鲁科版": "鲁科版-山东科学技术出版社",
    "北京版": "北京版-北京出版社",
    "京版": "北京版-北京出版社",
    "华东师大版": "华东师范大学版-华东师范大学出版社",
    "沪科版": "沪科技版-上海科学技术出版社",
    "沪科技版": "沪科技版-上海科学技术出版社",
    "沪教版": "沪教版-上海教育出版社",
    "浙教版": "浙教版-浙江教育出版社",
    "湘教版": "湘教版-湖南教育出版社",
    "青岛版": "青岛版-青岛出版社",
    "教科版": "教科版-教育科学出版社",
    "科粤版": "科粤版-广东科技出版社/科学出版社",
    "粤教版": "粤教版-广东教育出版社",
    "中图版": "中图版-中国地图出版社",
    "外研版": "外研版-外语教学与研究出版社",
    "仁爱版": "仁爱版-北京仁爱教育研究所",
    "译林版": "译林版-译林出版社",
    "接力版": "接力版-接力出版社",
    "商务印书馆": "商务印书馆版-商务印书馆",
}

CACHE_INDEX_PATH = Path.home() / "Library/Caches/textbook-downloader/web_index.json"
ASSET_INDEX_PATH = Path.home() / "Library/Caches/textbook-downloader/asset_index.json"


def extract_edition_tag(title: str, book_meta: Optional[Dict[str, Any]] = None) -> str:
    """提取标准化版本号，如 '2024修订版', '2022修订版', '2019课标版', '第4版'"""
    m = re.search(r"根据(20\d\d)年(?:版)?课程标准(?:修订)?", title)
    if m:
        return f"{m.group(1)}修订版"

    m = re.search(r"(20\d\d)年(?:教育部)?审定", title)
    if m:
        return f"{m.group(1)}审定版"

    m = re.search(r"(20\d\d)年[秋春]季?", title)
    if m:
        return f"{m.group(1)}秋季版"

    m = re.search(r"第([0-9一二三四五六七八九十]+)版", title)
    if m:
        return f"第{m.group(1)}版"

    m = re.search(r"(20\d\d)年版", title)
    if m:
        return f"{m.group(1)}版"

    if "普通高中教科书" in title or "高中" in title:
        return "2019课标版"

    if "义务教育教科书" in title:
        return "2012课标版"

    if book_meta:
        update_time = str(book_meta.get("update_time") or "")
        if len(update_time) >= 4 and update_time[:4] in ("2023", "2024", "2025", "2026"):
            return f"{update_time[:4]}最新版"

    return "标准审定版"


def clean_book_title(title: str) -> str:
    """清理书名中冗余前缀与长括号"""
    clean = re.sub(r"^[（(][^）)]+[）)]", "", title)
    clean = re.sub(r"统编版[（(][^）)]+[）)]", "统编版·", clean)
    clean = clean.replace("··", "·").strip()
    return clean


def load_update_time_map() -> Dict[str, str]:
    """从 asset_index.json 加载每本书精确的 update_time"""
    time_map = {}
    if ASSET_INDEX_PATH.exists():
        try:
            with open(ASSET_INDEX_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                for b in data.get("books", []):
                    if b.get("id"):
                        time_map[b["id"]] = b.get("update_time", "")
        except Exception:
            pass
    return time_map


def resolve_book_item(book: Dict[str, Any], time_map: Dict[str, str]) -> Dict[str, Any]:
    """解析单本书的规范化分类、版本与时间戳"""
    raw_stage = (book.get("stage") or ["未标注"])[0]
    raw_subject = (book.get("subject") or ["未标注"])[0]
    raw_version = (book.get("version") or ["未标注"])[0]
    raw_grade = (book.get("grade") or ["全一册"])[0]
    raw_volume = (book.get("volume") or [""])[0]
    title = book.get("title", "")
    book_id = book.get("id", "")

    # 学段规范化
    stage = raw_stage
    if "五•四" in stage or "五四" in stage:
        if "初中" in stage:
            stage = "初中（五•四学制）"
        elif "小学" in stage:
            stage = "小学（五•四学制）"

    # 学科规范化
    subject = raw_subject.replace("/", "、")

    # 版本-出版社规范化
    if raw_version in PUBLISHER_MAPPING:
        publisher_dir = PUBLISHER_MAPPING[raw_version]
    elif raw_version != "未标注":
        publisher_dir = f"{raw_version}版"
    else:
        guessed = None
        for v, pub in PUBLISHER_MAPPING.items():
            if v in title or pub.split("-")[-1] in title:
                guessed = pub
                break
        publisher_dir = guessed or "通用版"

    # 年级规范化
    grade_dir = raw_grade
    if raw_grade in ("未标注", "全一册") and raw_volume:
        grade_dir = raw_volume

    # 获取更新时间戳
    update_time = time_map.get(book_id) or book.get("update_time", "")

    # 版本号提取
    edition_tag = extract_edition_tag(title, {"update_time": update_time})

    # 规范化文件名 (带版本标签)
    base_name = clean_book_title(title)
    if base_name.endswith(".pdf"):
        base_name = base_name[:-4]

    if f"[{edition_tag}]" not in base_name:
        clean_filename = f"{base_name} [{edition_tag}].pdf"
    else:
        clean_filename = f"{base_name}.pdf"

    clean_filename = re.sub(r'[/\\:*?"<>|]', "_", clean_filename)
    rel_path = f"{stage}/{subject}/{publisher_dir}/{grade_dir}/{clean_filename}"

    formats = book.get("formats") or {}
    pdf_size = formats.get("pdf", 0)

    return {
        "id": book_id,
        "seq": book.get("seq", 0),
        "title": title,
        "clean_title": base_name,
        "stage": stage,
        "subject": subject,
        "version": raw_version,
        "publisher_dir": publisher_dir,
        "grade": grade_dir,
        "volume": raw_volume,
        "edition_tag": edition_tag,
        "filename": clean_filename,
        "relative_path": rel_path,
        "kind": book.get("kind", "downloadable"),
        "has_pdf": "pdf" in formats,
        "pdf_size": pdf_size,
        "has_pptx": "pptx" in formats,
        "pptx_size": formats.get("pptx", 0),
        "update_time": update_time,
        "formats": formats,
        "is_active": True,  # 默认在用，后续去重逻辑计算
        "is_latest_official": True,
    }


def deduplicate_and_pick_latest(books: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    针对同年级、同学科、同版本、同名的重复课本（164对记录）：
    比对 update_time / seq，智能选出官网当前在用的最新一本标记为 is_active = True，
    较老的副本标记为 is_active = False，并在界面与下载队列中以最新为准！
    """
    groups: Dict[Tuple[str, str, str, str, str], List[Dict[str, Any]]] = {}
    for b in books:
        if not b["has_pdf"]:
            continue
        # 分组标识: (学段, 学科, 出版社, 年级, 规范化书名)
        key = (b["stage"], b["subject"], b["publisher_dir"], b["grade"], b["clean_title"])
        groups.setdefault(key, []).append(b)

    for key, items in groups.items():
        if len(items) <= 1:
            continue

        # 存在多版本！按更新时间排序（若无更新时间则按序号 seq，序号大的是 catalog 4 后期录入的最新版）
        items.sort(key=lambda x: (x.get("update_time") or "", x.get("seq", 0)), reverse=True)

        # 最新的为当前官方在用
        latest_item = items[0]
        latest_item["is_active"] = True
        latest_item["is_latest_official"] = True

        # 其他旧版本标记为已被替代
        for older in items[1:]:
            older["is_active"] = False
            older["is_latest_official"] = False
            older["superseded_by"] = latest_item["id"]

    return books


def load_catalog_data() -> Dict[str, Any]:
    """加载全部教材数据并构建过滤树选项（智能优选最新在用版）"""
    raw_books = []
    if CACHE_INDEX_PATH.exists():
        try:
            with open(CACHE_INDEX_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                raw_books = data.get("books", [])
        except Exception as e:
            print(f"⚠️ 读取缓存失败: {e}")

    time_map = load_update_time_map()
    resolved_books = [resolve_book_item(b, time_map) for b in raw_books]
    resolved_books = deduplicate_and_pick_latest(resolved_books)

    # 统计数据
    active_pdf_books = [b for b in resolved_books if b["has_pdf"] and b["is_active"]]

    stages = set()
    subjects = set()
    versions = set()
    grades = set()
    volumes = set()

    for item in active_pdf_books:
        stages.add(item["stage"])
        subjects.add(item["subject"])
        if item["version"] != "未标注":
            versions.add(item["version"])
        if item["grade"] != "未标注":
            grades.add(item["grade"])
        if item["volume"]:
            volumes.add(item["volume"])

    stats = {
        "total": len(resolved_books),
        "downloadable_pdf": len(active_pdf_books),
        "duplicates_filtered": len([b for b in resolved_books if b["has_pdf"] and not b["is_active"]]),
    }

    return {
        "books": resolved_books,
        "stats": stats,
        "dimensions": {
            "stages": sorted(list(stages)),
            "subjects": sorted(list(subjects)),
            "versions": sorted(list(versions)),
            "grades": sorted(list(grades)),
            "volumes": sorted(list(volumes)),
        },
    }
