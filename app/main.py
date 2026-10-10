"""Hangar Project：模玩管理 FastAPI 入口（REST API + 静态 WebUI）。"""
import io
import json
import logging
import mimetypes
import os
import re
import secrets
import shutil
import threading
import time
import uuid
import zipfile
from typing import Optional
from urllib.parse import quote

import pyzipper
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db, exif

logger = logging.getLogger("hangar")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
PHOTOS_DIR = os.environ.get("PHOTOS_DIR", os.path.join(os.path.dirname(__file__), "photos"))
os.makedirs(PHOTOS_DIR, exist_ok=True)

# 缩略图缓存目录：默认落在数据卷（与 DATA_FILE 同目录），重建容器不丢失。
DATA_DIR = os.path.dirname(os.environ.get("DATA_FILE", "/data/models.db")) or "."
THUMBS_DIR = os.environ.get("THUMBS_DIR", os.path.join(DATA_DIR, "thumbs"))
os.makedirs(THUMBS_DIR, exist_ok=True)
THUMB_SIZE = 400

# 分块上传临时目录：与缩略图同在数据卷，且不在 /photos 静态挂载路径内（防匿名下载残留块）。
UPLOADS_DIR = os.path.join(DATA_DIR, ".uploads")

MAX_PHOTO_BYTES = 20 * 1024 * 1024
CHUNK_MAX_BYTES = 2 * 1024 * 1024
UPLOADS_TTL = 24 * 3600  # 残留临时目录 24h 后清理
ALLOWED_EXTS = {"jpg": "jpg", "jpeg": "jpg", "png": "png", "webp": "webp", "gif": "gif"}
SAFE_NAME_RE = re.compile(r"[A-Za-z0-9_.-]+\Z")

# 部分环境 mimetypes 未内置 .webmanifest，注册以确保 manifest 以正确 MIME 提供（PWA 安装要求）
mimetypes.add_type("application/manifest+json", ".webmanifest")

app = FastAPI(title="Hangar Project", version="1.3.2")


@app.middleware("http")
async def no_cache_code_assets(request, call_next):
    """代码类静态资源（js/css/html/manifest）强制协商缓存：
    每次发 If-Modified-Since，未变返回 304。修复 v1.3.2 事故——
    无 Cache-Control 时浏览器启发式缓存旧 dialog.js，与新 importexport.js
    混用导致 setLocked 缺失、导出流程静默崩溃。"""
    response = await call_next(request)
    p = request.url.path
    if p.endswith((".js", ".css", ".html", ".webmanifest")) or p in ("/", "/setup"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def verify_api_key(x_api_key: Optional[str] = Header(None)):
    token = db.get_config().get("token", "")
    if not token or not secrets.compare_digest(x_api_key or "", token):
        raise HTTPException(status_code=401, detail="无效或缺失的 X-API-Key")
    return True


@app.on_event("startup")
def startup():
    db.init_db()
    if db.is_initialized():
        _startup_consistency_scan()


def _startup_consistency_scan():
    """启动一致性治理：清理过期 .uploads/.import_tmp 临时目录 + 记录孤儿照片文件（不自动删除）。"""
    n = _cleanup_uploads() + _cleanup_import_tmp() + _cleanup_export_tmp()
    if n:
        logger.info("启动清理过期上传/导入/导出临时文件 %d 个", n)
    referenced = set()
    for m in db.list_models():
        for p in m.get("photos") or []:
            fn = _photo_filename(p)
            if fn:
                referenced.add(fn)
    try:
        orphans = []
        for fn in os.listdir(PHOTOS_DIR):
            if not SAFE_NAME_RE.match(fn) or fn.startswith("."):
                continue
            if not os.path.isfile(os.path.join(PHOTOS_DIR, fn)):
                continue
            ext = fn.lower().rsplit(".", 1)[-1] if "." in fn else ""
            if ext in ALLOWED_EXTS and fn not in referenced:
                orphans.append(fn)
        if orphans:
            logger.warning("发现 %d 个孤儿照片文件（未被任何模型引用，不自动删除）: %s",
                           len(orphans), ", ".join(sorted(orphans)[:50]))
    except OSError as e:
        logger.warning("孤儿扫描失败: %s", e)


@app.middleware("http")
async def setup_guard(request: Request, call_next):
    """未初始化时：/api/v1/* 仅放行 status/setup，其余 403；页面入口重定向 /setup。
    静态资源（css/js/图标）必须放行，否则 setup 页自身样式脚本被挡白屏。"""
    path = request.url.path
    if not db.is_initialized():
        if path == "/" or path == "/index.html":
            return RedirectResponse("/setup")
        if path.startswith("/api/v1") and path not in ("/api/v1/status", "/api/v1/setup"):
            return JSONResponse(status_code=403, content={"detail": "系统未初始化"})
    return await call_next(request)


# ---------- 请求模型 ----------

class ModelCreate(BaseModel):
    id: Optional[str] = None
    name: str
    category: str
    grade: Optional[str] = None
    item_no: Optional[str] = None
    scale: Optional[str] = None
    limited: str
    origin: str
    status: str
    storage: str
    display: bool = False
    owner: str = ""
    purchase_date: Optional[str] = None
    done_date: Optional[str] = None
    comment: Optional[str] = None
    photos: Optional[list] = None
    tags: Optional[list] = None


class ModelPatch(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    grade: Optional[str] = None
    item_no: Optional[str] = None
    scale: Optional[str] = None
    limited: Optional[str] = None
    origin: Optional[str] = None
    status: Optional[str] = None
    storage: Optional[str] = None
    display: Optional[bool] = None
    owner: Optional[str] = None
    purchase_date: Optional[str] = None
    done_date: Optional[str] = None
    comment: Optional[str] = None
    photos: Optional[list] = None
    tags: Optional[list] = None


def _check_enums(data: dict, partial: bool = False):
    cfg = db.get_config()
    if not partial or "category" in data:
        if data.get("category") and data["category"] not in cfg["categories"]:
            raise HTTPException(status_code=422, detail=f"category 必须是 {cfg['categories']} 之一")
    if not partial or "status" in data:
        if data.get("status") and data["status"] not in cfg["statuses"]:
            raise HTTPException(status_code=422, detail=f"status 必须是 {cfg['statuses']} 之一")


def _photo_filename(url):
    """photos 条目归一化为文件名：接受 '/photos/x.jpg' 或裸文件名；非法返回 None。"""
    if not isinstance(url, str):
        return None
    fn = os.path.basename(url)
    if not fn or not SAFE_NAME_RE.match(fn) or fn.startswith("."):
        return None
    return fn


def _validate_photos(photos):
    """photos 数组写路径统一校验（POST 创建 / PATCH / 重排共用）：
    每条必须是合法 '/photos/<真实存在的文件>'，且无重复。返回归一化后的 URL 列表。"""
    if not isinstance(photos, list):
        raise HTTPException(status_code=400, detail="photos 必须是列表")
    urls, seen = [], set()
    for p in photos:
        fn = _photo_filename(p)
        if fn is None or not str(p).startswith("/photos/"):
            raise HTTPException(status_code=400, detail=f"非法照片条目: {p!r}")
        if not os.path.isfile(os.path.join(PHOTOS_DIR, fn)):
            raise HTTPException(status_code=400, detail=f"照片文件不存在: {fn}")
        url = f"/photos/{fn}"
        if url in seen:
            raise HTTPException(status_code=400, detail=f"照片条目重复: {fn}")
        seen.add(url)
        urls.append(url)
    return urls


# ---------- 初始化（setup） ----------

class SetupBody(BaseModel):
    token: str
    categories: list
    statuses: list
    soft_defaults: Optional[dict] = None
    amap_key: Optional[str] = None


def _clean_list(items, field, min_len=0):
    """去空、去重（保序）、每项截 32 字符；min_len 为最少项数。"""
    if not isinstance(items, list):
        raise HTTPException(status_code=422, detail=f"{field} 必须是列表")
    out, seen = [], set()
    for it in items:
        s = str(it).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s[:32])
    if len(out) < min_len:
        raise HTTPException(status_code=422, detail=f"{field} 至少需要 {min_len} 项")
    return out


@app.get("/api/v1/status")
def setup_status():
    return {"initialized": db.is_initialized(), "version": app.version}


@app.post("/api/v1/setup", status_code=201)
def setup(body: SetupBody):
    if db.is_initialized():
        raise HTTPException(status_code=403, detail="系统已初始化")
    token = body.token.strip()
    if not token:
        raise HTTPException(status_code=422, detail="token 不能为空")
    soft = body.soft_defaults or {}
    if not isinstance(soft, dict):
        raise HTTPException(status_code=422, detail="soft_defaults 必须是对象")
    cfg = {
        "initialized": True,
        "token": token,
        "categories": _clean_list(body.categories, "categories", min_len=1),
        "statuses": _clean_list(body.statuses, "statuses", min_len=1),
        "soft_defaults": {f: _clean_list(soft.get(f) or [], f) for f in db.SOFT_FIELDS},
        "amap_key": (body.amap_key or "").strip(),
    }
    db.complete_setup(cfg)
    return {"ok": True}


# ---------- API ----------

# GET 接口开放（WebUI 未登录只读浏览）；写操作仍需 X-API-Key

@app.get("/api/v1/auth/check", dependencies=[Depends(verify_api_key)])
def auth_check():
    return {"ok": True}


@app.get("/api/v1/models")
def list_models(
    status: Optional[str] = Query(None),
    storage: Optional[str] = Query(None),
    display: Optional[str] = Query(None),
    grade: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    owner: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
):
    filters = {"status": status, "storage": storage, "display": display,
               "grade": grade, "category": category, "owner": owner, "tag": tag}
    return db.list_models(filters, q)


@app.get("/api/v1/models/values")
def models_values():
    return db.field_values()


@app.get("/api/v1/models/{model_id}")
def get_model(model_id: str):
    m = db.get_model(model_id)
    if not m:
        raise HTTPException(status_code=404, detail="记录不存在")
    return m


@app.post("/api/v1/models", status_code=201, dependencies=[Depends(verify_api_key)])
def create_model(body: ModelCreate):
    data = body.model_dump(exclude_none=True)
    _check_enums(data)
    if "photos" in data:
        data["photos"] = _validate_photos(data["photos"])
    try:
        return db.create_model(data)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"写入失败: {e}")


@app.patch("/api/v1/models/{model_id}", dependencies=[Depends(verify_api_key)])
def patch_model(model_id: str, body: ModelPatch):
    data = body.model_dump(exclude_unset=True)
    _check_enums(data, partial=True)
    if "photos" in data and data["photos"] is not None:
        data["photos"] = _validate_photos(data["photos"])
    m = db.update_model(model_id, data)
    if not m:
        raise HTTPException(status_code=404, detail="记录不存在")
    return m


@app.delete("/api/v1/models/{model_id}", dependencies=[Depends(verify_api_key)])
def delete_model(model_id: str):
    if not db.delete_model(model_id):
        raise HTTPException(status_code=404, detail="记录不存在")
    return {"ok": True}


# ---------- 照片 ----------

def _next_photo_index(photos, model_id):
    mx = 0
    prefix = f"{model_id}_"
    for p in photos:
        fn = os.path.basename(p)
        if fn.startswith(prefix):
            stem = fn[len(prefix):].rsplit(".", 1)[0]
            if stem.isdigit():
                mx = max(mx, int(stem))
    return mx + 1


@app.post("/api/v1/models/{model_id}/photos", dependencies=[Depends(verify_api_key)])
async def upload_photos(model_id: str, file: list[UploadFile] = File(...)):
    m = db.get_model(model_id)
    if not m:
        raise HTTPException(status_code=404, detail="记录不存在")
    photos = list(m["photos"])
    saved = []
    try:
        for f in file:
            ext = (f.filename or "").lower().rsplit(".", 1)
            ext = ext[1] if len(ext) == 2 else ""
            if ext not in ALLOWED_EXTS:
                raise HTTPException(status_code=400,
                                    detail=f"不支持的文件类型: {f.filename}（仅 jpg/png/webp/gif）")
            data = await f.read()
            if len(data) > MAX_PHOTO_BYTES:
                raise HTTPException(status_code=400,
                                    detail=f"文件超过 20MB: {f.filename}")
            if not data:
                raise HTTPException(status_code=400, detail=f"空文件: {f.filename}")
            idx = _next_photo_index(photos + saved, model_id)
            fname = f"{model_id}_{idx}.{ALLOWED_EXTS[ext]}"
            with open(os.path.join(PHOTOS_DIR, fname), "wb") as out:
                out.write(data)
            saved.append(f"/photos/{fname}")
    except HTTPException:
        # 出错时回滚本次已落盘的文件，数组不更新
        for url in saved:
            try:
                os.remove(os.path.join(PHOTOS_DIR, os.path.basename(url)))
            except OSError:
                pass
        raise
    photos.extend(saved)
    return db.update_model(model_id, {"photos": photos})


# ---------- 分块断点续传（弱网并行路径；产出与整图上传一致） ----------

def _safe_upload_id(upload_id: str) -> str:
    if (not isinstance(upload_id, str) or not SAFE_NAME_RE.match(upload_id)
            or upload_id.startswith(".")):
        raise HTTPException(status_code=400, detail="非法 upload_id")
    return upload_id


def _upload_dir(upload_id: str) -> str:
    return os.path.join(UPLOADS_DIR, upload_id)


def _ext_from_filename(filename):
    ext = (filename or "").lower().rsplit(".", 1)
    ext = ext[1] if len(ext) == 2 else ""
    return ALLOWED_EXTS.get(ext)


def _cleanup_uploads(max_age=UPLOADS_TTL):
    """删除超过 max_age 的残留临时目录（崩溃/断电遗留）。返回删除数。"""
    if not os.path.isdir(UPLOADS_DIR):
        return 0
    now, removed = time.time(), 0
    for d in os.listdir(UPLOADS_DIR):
        p = os.path.join(UPLOADS_DIR, d)
        try:
            if os.path.isdir(p) and now - os.path.getmtime(p) > max_age:
                shutil.rmtree(p, ignore_errors=True)
                removed += 1
        except OSError:
            pass
    return removed


_last_uploads_cleanup = [None]  # [date_str] 每日首次 complete 时顺带清理


def _maybe_daily_cleanup():
    today = time.strftime("%Y-%m-%d")
    if _last_uploads_cleanup[0] != today:
        _last_uploads_cleanup[0] = today
        n = _cleanup_uploads() + _cleanup_import_tmp() + _cleanup_export_tmp()
        if n:
            logger.info("清理过期上传/导入/导出临时文件 %d 个", n)


@app.post("/api/v1/models/{model_id}/photos/chunk", dependencies=[Depends(verify_api_key)])
async def upload_photo_chunk(model_id: str,
                             upload_id: str = Form(...),
                             index: int = Form(...),
                             total: int = Form(...),
                             file: UploadFile = File(...)):
    if not db.get_model(model_id):
        raise HTTPException(status_code=404, detail="记录不存在")
    _safe_upload_id(upload_id)
    if total < 1 or total > 5000 or index < 0 or index >= total:
        raise HTTPException(status_code=400, detail="index/total 非法")
    ext = _ext_from_filename(file.filename)
    if ext is None:
        raise HTTPException(status_code=400,
                            detail=f"不支持的文件类型: {file.filename}（仅 jpg/png/webp/gif）")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail=f"空块: index={index}")
    if len(data) > CHUNK_MAX_BYTES:
        raise HTTPException(status_code=400, detail="块超过 2MB 上限")

    d = _upload_dir(upload_id)
    os.makedirs(d, exist_ok=True)
    meta_path = os.path.join(d, ".meta")
    # sidecar 记录归一化 ext 与 total（首个到达的块落盘；后续块校验一致性）
    meta = {"ext": ext, "total": total}
    if os.path.isfile(meta_path):
        try:
            with open(meta_path, encoding="utf-8") as f:
                old = json.load(f)
            if old.get("total") != total or old.get("ext") != ext:
                raise HTTPException(status_code=400, detail="同 upload_id 的 total/扩展名不一致")
        except (ValueError, KeyError):
            pass
    else:
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f)
    part = os.path.join(d, f"{index}.part")
    tmp = part + ".tmp"
    with open(tmp, "wb") as out:
        out.write(data)
    os.replace(tmp, part)  # 原子落盘，半截块不会伪装成成功
    return {"ok": True, "received": index}


class CompleteBody(BaseModel):
    upload_id: str
    filename: Optional[str] = None


@app.post("/api/v1/models/{model_id}/photos/complete", dependencies=[Depends(verify_api_key)])
def complete_photo_upload(model_id: str, body: CompleteBody):
    m = db.get_model(model_id)
    if not m:
        raise HTTPException(status_code=404, detail="记录不存在")
    _safe_upload_id(body.upload_id)
    _maybe_daily_cleanup()
    d = _upload_dir(body.upload_id)
    meta_path = os.path.join(d, ".meta")
    if not os.path.isdir(d) or not os.path.isfile(meta_path):
        raise HTTPException(status_code=400, detail="上传会话不存在或已被清理")
    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)
    total, ext = meta["total"], meta["ext"]

    parts = [os.path.join(d, f"{i}.part") for i in range(total)]
    missing = [i for i, p in enumerate(parts) if not os.path.isfile(p)]
    if missing:
        raise HTTPException(status_code=400,
                            detail={"error": "缺块", "total": total, "missing": missing,
                                    "received": [i for i in range(total) if i not in missing]})
    sizes = [os.path.getsize(p) for p in parts]
    if sum(sizes) > MAX_PHOTO_BYTES:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(status_code=400, detail="合并后超过 20MB 上限")

    photos = list(m["photos"])
    idx = _next_photo_index(photos, model_id)
    fname = f"{model_id}_{idx}.{ext}"
    final = os.path.join(PHOTOS_DIR, fname)
    tmp = final + ".merging.tmp"
    try:
        with open(tmp, "wb") as out:
            for p in parts:
                with open(p, "rb") as src:
                    shutil.copyfileobj(src, out)
        os.replace(tmp, final)
    except OSError as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise HTTPException(status_code=500, detail=f"合并写盘失败: {e}")
    shutil.rmtree(d, ignore_errors=True)
    photos.append(f"/photos/{fname}")
    return db.update_model(model_id, {"photos": photos})


class OrderBody(BaseModel):
    order: list


@app.put("/api/v1/models/{model_id}/photos/order", dependencies=[Depends(verify_api_key)])
def reorder_photos(model_id: str, body: OrderBody):
    """photos 重排：order 必须是当前数组的排列（多重集相等），且每条文件真实存在。
    条目接受裸文件名或完整 /photos/ URL，服务端归一化。"""
    m = db.get_model(model_id)
    if not m:
        raise HTTPException(status_code=404, detail="记录不存在")
    normalized = []
    for p in body.order:
        fn = _photo_filename(p) if isinstance(p, str) else None
        normalized.append(f"/photos/{fn}" if fn else p)
    urls = _validate_photos(normalized)
    current = [f"/photos/{os.path.basename(pp)}" for pp in m["photos"] if _photo_filename(pp)]
    if sorted(urls) != sorted(current) or len(urls) != len(m["photos"]):
        raise HTTPException(status_code=400, detail="order 必须是当前 photos 数组的排列（无增删/重复）")
    return db.update_model(model_id, {"photos": urls})


@app.delete("/api/v1/models/{model_id}/photos/{filename}", dependencies=[Depends(verify_api_key)])
def delete_photo(model_id: str, filename: str):
    if not SAFE_NAME_RE.match(filename) or filename.startswith("."):
        raise HTTPException(status_code=400, detail="非法文件名")
    m = db.get_model(model_id)
    if not m:
        raise HTTPException(status_code=404, detail="记录不存在")
    url = f"/photos/{filename}"
    if url not in m["photos"]:
        raise HTTPException(status_code=403, detail="该照片不属于此模型")
    try:
        os.remove(os.path.join(PHOTOS_DIR, filename))
    except FileNotFoundError:
        pass
    try:
        os.remove(_thumb_path(filename))
    except FileNotFoundError:
        pass
    photos = [p for p in m["photos"] if p != url]
    return db.update_model(model_id, {"photos": photos})


@app.get("/api/v1/models/{model_id}/photos/{filename}/meta")
async def photo_meta(model_id: str, filename: str):
    """照片 EXIF 元数据（无需鉴权，WebUI 浏览大图时调用）。"""
    if not SAFE_NAME_RE.match(filename) or filename.startswith("."):
        raise HTTPException(status_code=400, detail="非法文件名")
    m = db.get_model(model_id)
    if not m:
        raise HTTPException(status_code=404, detail="记录不存在")
    url = f"/photos/{filename}"
    if url not in m["photos"]:
        raise HTTPException(status_code=404, detail="该照片不属于此模型")
    path = os.path.join(PHOTOS_DIR, filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="照片文件不存在")
    meta = exif.read_exif(path)
    if meta.get("map"):
        gmap = meta["map"]
        cached = db.geo_cache_get(gmap["lat"], gmap["lng"])
        if cached is not None:
            meta["address"] = cached
        else:
            address = await exif.amap_regeo(gmap, db.get_config().get("amap_key", ""))
            if address:
                db.geo_cache_put(gmap["lat"], gmap["lng"], address)
            meta["address"] = address
    else:
        meta["address"] = None
    return meta


def _thumb_path(filename: str) -> str:
    # 后缀带版本号：生成逻辑变更时递增，旧缓存自动失效
    return os.path.join(THUMBS_DIR, filename + ".thumb-v2.jpg")


@app.get("/thumbs/{filename}")
def get_thumb(filename: str):
    """懒生成缩略图：命中缓存直接返回，未命中则从原图缩放后落盘。
    无需鉴权（与 /photos 静态挂载一致）；GIF 保留动画直接回原图。"""
    if not SAFE_NAME_RE.match(filename) or filename.startswith("."):
        raise HTTPException(status_code=400, detail="非法文件名")
    src = os.path.join(PHOTOS_DIR, filename)
    if not os.path.isfile(src):
        raise HTTPException(status_code=404, detail="照片文件不存在")
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if ext == "gif":
        return RedirectResponse(f"/photos/{filename}")

    thumb = _thumb_path(filename)
    # 缓存命中：缩略图不早于原图生成则复用
    if os.path.isfile(thumb) and os.path.getmtime(thumb) >= os.path.getmtime(src):
        return FileResponse(thumb, media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=31536000, immutable"})

    try:
        from PIL import Image, ImageOps
        with Image.open(src) as im:
            # 先按 EXIF Orientation 转正，再处理透明/缩放（否则缩略图方向错误）
            im = ImageOps.exif_transpose(im)
            # 透明背景铺白，统一转 JPEG
            if im.mode in ("RGBA", "LA", "P"):
                im = im.convert("RGBA")
                bg = Image.new("RGB", im.size, (255, 255, 255))
                bg.paste(im, mask=im.split()[-1])
                im = bg
            else:
                im = im.convert("RGB")
            im.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=80, optimize=True)
            data = buf.getvalue()
        tmp = thumb + ".tmp"
        with open(tmp, "wb") as out:
            out.write(data)
        os.replace(tmp, thumb)
    except Exception:
        # 生成失败回退原图，绝不让前端图片裂开
        return FileResponse(src)
    return FileResponse(thumb, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


# ---------- 导入导出（v1.3.0 数据迁移/备份） ----------

# 导入临时目录与照片/数据库同卷（数据卷），24h 清理；导出临时文件响应后即删。
IMPORT_TMP_DIR = os.path.join(DATA_DIR, ".import_tmp")
# 导入不设固定包大小上限（v1.3.2）：合并前按磁盘剩余空间把关。
# 数据卷峰值 ≈ 合并包 + 解包暂存 ≈ 包大小 ×2，另留 MARGIN 给系统/缩略图。
IMPORT_DISK_MARGIN = 500 * 1024 * 1024


def _disk_free(path):
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize


def _gb(n):
    return f"{n / (1024 ** 3):.1f}"


def _check_import_disk(total_bytes):
    """合并前磁盘检查：数据卷需容纳 包×2 + 余量；照片卷（若不同盘）需容纳 包 + 余量。"""
    free_data = _disk_free(DATA_DIR)
    need_data = total_bytes * 2 + IMPORT_DISK_MARGIN
    if need_data > free_data:
        raise HTTPException(
            status_code=400,
            detail=f"磁盘空间不足（数据盘需 {_gb(need_data)} GB，可用 {_gb(free_data)} GB）")
    if os.path.abspath(PHOTOS_DIR) != os.path.abspath(DATA_DIR):
        free_photos = _disk_free(PHOTOS_DIR)
        need_photos = total_bytes + IMPORT_DISK_MARGIN
        if need_photos > free_photos:
            raise HTTPException(
                status_code=400,
                detail=f"磁盘空间不足（照片盘需 {_gb(need_photos)} GB，可用 {_gb(free_photos)} GB）")


def _cleanup_import_tmp(max_age=UPLOADS_TTL):
    """删除过期导入临时会话（块目录 / 合并包 / 解包暂存）。返回删除数。"""
    if not os.path.isdir(IMPORT_TMP_DIR):
        return 0
    now, removed = time.time(), 0
    for d in os.listdir(IMPORT_TMP_DIR):
        p = os.path.join(IMPORT_TMP_DIR, d)
        try:
            if now - os.path.getmtime(p) > max_age:
                if os.path.isdir(p):
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    os.remove(p)
                removed += 1
        except OSError:
            pass
    return removed


def _valid_photo_name(fn):
    """ZIP 条目/磁盘文件名是否为合法照片名（zip-slip 防护：只认 basename + 白名单）。"""
    if not fn or fn != os.path.basename(fn) or not SAFE_NAME_RE.match(fn) or fn.startswith("."):
        return False
    ext = fn.lower().rsplit(".", 1)[-1] if "." in fn else ""
    return ext in ALLOWED_EXTS


# ---------- 导出（v1.3.2：后台任务打包 + 轮询进度） ----------

EXPORT_TMP_DIR = os.path.join(DATA_DIR, ".export_tmp")
EXPORT_TTL = 30 * 60  # 打包完成后 30min 未下载自动清理

_export_jobs = {}  # job_id -> 任务状态 dict（进程内；重启丢失由前端按 404 处理）
_export_jobs_lock = threading.Lock()


def _cleanup_export_tmp(max_age=EXPORT_TTL):
    """删除过期导出包（未下载/崩溃遗留），并回收注册表死条目。返回删除数。"""
    removed = 0
    if os.path.isdir(EXPORT_TMP_DIR):
        now = time.time()
        for fn in os.listdir(EXPORT_TMP_DIR):
            p = os.path.join(EXPORT_TMP_DIR, fn)
            try:
                if os.path.isfile(p) and now - os.path.getmtime(p) > max_age:
                    os.remove(p)
                    removed += 1
            except OSError:
                pass
    with _export_jobs_lock:
        for jid in [k for k, j in _export_jobs.items()
                    if j["status"] != "packing" and not os.path.isfile(j["path"])]:
            _export_jobs.pop(jid, None)
    return removed


class _CountingWriter(io.RawIOBase):
    """包装真实文件对象：委托 write/seek/tell 供 zipfile 使用，同时累计写入字节以报告进度。"""

    def __init__(self, f):
        self._f = f
        self.n = 0

    def writable(self):
        return True

    def seekable(self):
        return True

    def write(self, b):
        n = self._f.write(b)
        self.n += n
        return n

    def seek(self, *a):
        return self._f.seek(*a)

    def tell(self):
        return self._f.tell()

    def flush(self):
        self._f.flush()


def _export_inputs(include_photos):
    """待打包照片列表 [(文件名, 路径, 字节数)]。"""
    files = []
    if include_photos:
        for fn in sorted(os.listdir(PHOTOS_DIR)):
            if not _valid_photo_name(fn):
                continue
            src = os.path.join(PHOTOS_DIR, fn)
            if os.path.isfile(src):
                files.append((fn, src, os.path.getsize(src)))
    return files


def _build_export_zip(tmp_path, include_photos, include_amap, on_progress=None):
    """打包核心（同步端点与后台任务共用）。返回 (下载文件名, 加密降级提示或 None, json 字节数)。
    JPEG 原图已压缩，deflate 后输出≈输入，进度按已写字节 / 输入总字节估算，封顶 99% 直到完成。"""
    cfg = db.get_config()
    amap_empty = not (cfg.get("amap_key") or "").strip()
    encrypt = bool(include_amap) and not amap_empty
    note = "未配置 amap_key，已导出未加密包（不含 Key）" if (include_amap and amap_empty) else None
    payload = db.export_payload(app.version, include_amap=encrypt)
    ts = time.strftime("%Y%m%d_%H%M%S")
    seed_name = None
    if encrypt:
        seed_name = time.strftime("%Y%m%d%H%M%S") + ".seed"
        payload["seed"] = seed_name
    json_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    photos = _export_inputs(include_photos)
    total = sum(sz for _, _, sz in photos) + len(json_bytes) or 1
    with open(tmp_path, "wb") as raw:
        cw = _CountingWriter(raw)
        if encrypt:
            zf = pyzipper.AESZipFile(cw, "w", encryption=pyzipper.WZ_AES)
            zf.setpassword(db.generate_password_v2(seed_name).encode())
        else:
            zf = zipfile.ZipFile(cw, "w", zipfile.ZIP_DEFLATED, allowZip64=True)
        with zf:
            if seed_name:
                zf.writestr(seed_name, b"")
            zf.writestr("hangar-export.json", json_bytes)
            for fn, src, _sz in photos:
                zf.write(src, f"photos/{fn}")
                if on_progress:
                    on_progress(min(cw.n, total), total)
    return f"hangar-export-{ts}.zip", note, len(json_bytes)


@app.get("/api/v1/export", dependencies=[Depends(verify_api_key)])
def export_data(background_tasks: BackgroundTasks,
                include_photos: int = Query(1, ge=0, le=1),
                include_amap: int = Query(0, ge=0, le=1)):
    """同步导出 ZIP（保留给 smoke test / 脚本；WebUI 走 /export/jobs 任务流）。"""
    os.makedirs(EXPORT_TMP_DIR, exist_ok=True)
    tmp_path = os.path.join(EXPORT_TMP_DIR, f"hangar-export-{uuid.uuid4().hex}.zip")
    try:
        fname, note, _ = _build_export_zip(tmp_path, include_photos, include_amap)
    except Exception as e:
        _remove_quiet(tmp_path)
        raise HTTPException(status_code=500, detail=f"导出失败: {e}")
    headers = {"Content-Disposition": f'attachment; filename="{fname}"'}
    if note:
        # HTTP 头只允许 latin-1，中文提示按 RFC 5987 百分号编码，前端 decodeURIComponent 还原
        headers["X-Export-Note"] = quote(note)
    background_tasks.add_task(_remove_quiet, tmp_path)
    return FileResponse(tmp_path, media_type="application/zip", headers=headers)


@app.get("/api/v1/export/preview", dependencies=[Depends(verify_api_key)])
def export_preview():
    """导出前预估：照片数/字节 + JSON 字节（scandir 级，不打包）。"""
    photos = _export_inputs(1)
    payload = db.export_payload(app.version, include_amap=False)
    json_bytes = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    photo_bytes = sum(sz for _, _, sz in photos)
    return {"photo_count": len(photos), "photo_bytes": photo_bytes,
            "json_bytes": json_bytes, "total_bytes": photo_bytes + json_bytes}


class ExportJobBody(BaseModel):
    include_photos: int = 1
    include_amap: int = 0


_JOB_PUBLIC_KEYS = ("status", "progress", "bytes_done", "bytes_total",
                    "photo_count", "json_bytes", "filename", "note", "error")


@app.post("/api/v1/export/jobs", dependencies=[Depends(verify_api_key)])
def create_export_job(body: ExportJobBody):
    """创建后台打包任务（同一时刻最多 1 个；409 时 detail 带进行中的 job_id 供前端续轮询）。"""
    _cleanup_export_tmp()  # 机会性 TTL 清理：每日兜底最长要 24h 才生效，这里顺带回收过期包
    with _export_jobs_lock:
        for jid, j in _export_jobs.items():
            if j["status"] == "packing":
                raise HTTPException(status_code=409,
                                    detail={"error": "已有导出任务进行中", "job_id": jid})
        job_id = uuid.uuid4().hex
        photos = _export_inputs(body.include_photos)
        j = {"status": "packing", "progress": 0,
             "bytes_done": 0, "bytes_total": sum(sz for _, _, sz in photos),
             "photo_count": len(photos), "json_bytes": 0,
             "filename": None, "note": None, "error": None,
             "path": os.path.join(EXPORT_TMP_DIR, job_id + ".zip"),
             "include_photos": body.include_photos, "include_amap": body.include_amap}
        _export_jobs[job_id] = j
    os.makedirs(EXPORT_TMP_DIR, exist_ok=True)

    def worker():
        def on_prog(done, tot):
            with _export_jobs_lock:
                j["bytes_done"] = done
                j["bytes_total"] = tot
                j["progress"] = min(99, int(done * 100 / (tot or 1)))
        try:
            fname, note, json_len = _build_export_zip(
                j["path"], j["include_photos"], j["include_amap"], on_prog)
            size = os.path.getsize(j["path"])
            with _export_jobs_lock:
                j.update(status="ready", progress=100, filename=fname, note=note,
                         json_bytes=json_len, bytes_done=size, bytes_total=size)
        except Exception as e:
            _remove_quiet(j["path"])
            with _export_jobs_lock:
                j.update(status="error", error=str(e))

    threading.Thread(target=worker, daemon=True).start()
    return {"job_id": job_id}


@app.get("/api/v1/export/jobs/{job_id}", dependencies=[Depends(verify_api_key)])
def export_job_status(job_id: str):
    _safe_upload_id(job_id)
    with _export_jobs_lock:
        j = _export_jobs.get(job_id)
        if not j:
            raise HTTPException(status_code=404, detail="任务不存在或已失效（服务可能已重启）")
        return {k: j[k] for k in _JOB_PUBLIC_KEYS}


@app.get("/api/v1/export/jobs/{job_id}/download", dependencies=[Depends(verify_api_key)])
def export_job_download(job_id: str):
    _safe_upload_id(job_id)
    with _export_jobs_lock:
        j = _export_jobs.get(job_id)
        if not j:
            raise HTTPException(status_code=404, detail="任务不存在或已失效（服务可能已重启）")
        if j["status"] != "ready":
            raise HTTPException(status_code=409, detail="打包尚未完成")
        path, fname, note = j["path"], j["filename"], j["note"]
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="导出包已被清理，请重新导出")
    headers = {"Content-Disposition": f'attachment; filename="{fname}"'}
    if note:
        headers["X-Export-Note"] = quote(note)
    return FileResponse(path, media_type="application/zip", headers=headers)


@app.delete("/api/v1/export/jobs/{job_id}", dependencies=[Depends(verify_api_key)])
def export_job_delete(job_id: str):
    _safe_upload_id(job_id)
    with _export_jobs_lock:
        j = _export_jobs.pop(job_id, None)
    if j:
        _remove_quiet(j["path"])
    return {"ok": True}


def _remove_quiet(path):
    try:
        os.remove(path)
    except OSError:
        pass


@app.post("/api/v1/imports/chunk", dependencies=[Depends(verify_api_key)])
async def import_chunk(upload_id: str = Form(...),
                       index: int = Form(...),
                       total: int = Form(...),
                       file: UploadFile = File(...)):
    """导入包分块上传（与 photos/chunk 同构，仅接受 .zip）。"""
    _safe_upload_id(upload_id)
    if total < 1 or total > 5000 or index < 0 or index >= total:
        raise HTTPException(status_code=400, detail="index/total 非法")
    ext = (file.filename or "").lower().rsplit(".", 1)
    ext = ext[1] if len(ext) == 2 else ""
    if ext != "zip":
        raise HTTPException(status_code=400, detail=f"仅支持 .zip: {file.filename}")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail=f"空块: index={index}")
    if len(data) > CHUNK_MAX_BYTES:
        raise HTTPException(status_code=400, detail="块超过 2MB 上限")
    d = os.path.join(IMPORT_TMP_DIR, upload_id)
    os.makedirs(d, exist_ok=True)
    meta_path = os.path.join(d, ".meta")
    if os.path.isfile(meta_path):
        try:
            with open(meta_path, encoding="utf-8") as f:
                old = json.load(f)
            if old.get("total") != total:
                raise HTTPException(status_code=400, detail="同 upload_id 的 total 不一致")
        except ValueError:
            pass
    else:
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump({"ext": "zip", "total": total}, f)
    part = os.path.join(d, f"{index}.part")
    tmp = part + ".tmp"
    with open(tmp, "wb") as out:
        out.write(data)
    os.replace(tmp, part)
    return {"ok": True, "received": index}


class ImportCompleteBody(BaseModel):
    upload_id: str


@app.post("/api/v1/imports/complete", dependencies=[Depends(verify_api_key)])
def import_complete(body: ImportCompleteBody):
    """合并分块为临时 ZIP，返回 import_token。"""
    _safe_upload_id(body.upload_id)
    _maybe_daily_cleanup()
    d = os.path.join(IMPORT_TMP_DIR, body.upload_id)
    meta_path = os.path.join(d, ".meta")
    if not os.path.isdir(d) or not os.path.isfile(meta_path):
        raise HTTPException(status_code=400, detail="上传会话不存在或已被清理")
    with open(meta_path, encoding="utf-8") as f:
        total = json.load(f)["total"]
    parts = [os.path.join(d, f"{i}.part") for i in range(total)]
    missing = [i for i, p in enumerate(parts) if not os.path.isfile(p)]
    if missing:
        raise HTTPException(status_code=400,
                            detail={"error": "缺块", "total": total, "missing": missing,
                                    "received": [i for i in range(total) if i not in missing]})
    sizes = [os.path.getsize(p) for p in parts]
    _check_import_disk(sum(sizes))
    zip_path = os.path.join(IMPORT_TMP_DIR, body.upload_id + ".zip")
    tmp = zip_path + ".merging.tmp"
    try:
        with open(tmp, "wb") as out:
            for p in parts:
                with open(p, "rb") as src:
                    shutil.copyfileobj(src, out)
        os.replace(tmp, zip_path)
    except OSError as e:
        _remove_quiet(tmp)
        raise HTTPException(status_code=500, detail=f"合并写盘失败: {e}")
    shutil.rmtree(d, ignore_errors=True)
    return {"import_token": body.upload_id, "size": sum(sizes)}


class ImportBody(BaseModel):
    import_token: str
    mode: str = "replace"


@app.post("/api/v1/imports", dependencies=[Depends(verify_api_key)])
def run_import(body: ImportBody):
    """执行导入：校验（结构性错误整包 400 零副作用）→ 解包照片到暂存 →
    replace/merge 落库 → 照片拷贝 → 清理临时文件。"""
    if body.mode not in ("replace", "merge"):
        raise HTTPException(status_code=400, detail="mode 必须是 replace 或 merge")
    _safe_upload_id(body.import_token)
    zip_path = os.path.join(IMPORT_TMP_DIR, body.import_token + ".zip")
    if not os.path.isfile(zip_path):
        raise HTTPException(status_code=400, detail="导入会话不存在或已被清理")
    staging = os.path.join(IMPORT_TMP_DIR, body.import_token + ".photos")
    os.makedirs(staging, exist_ok=True)
    try:
        # 1. 打开包（明文/AES 统一走 pyzipper；种子文件名派生密码）
        try:
            with pyzipper.AESZipFile(zip_path) as zf:
                names = zf.namelist()
                seeds = [n for n in names if n.lower().endswith(".seed")]
                if seeds:
                    zf.setpassword(db.generate_password_v2(os.path.basename(seeds[0])).encode())
                try:
                    raw = zf.read("hangar-export.json")
                except (RuntimeError, zipfile.BadZipFile, ValueError) as e:
                    raise HTTPException(
                        status_code=400,
                        detail="无法解密，文件可能损坏或不是合法导出包") from e
                except KeyError:
                    raise HTTPException(status_code=400, detail="包内缺少 hangar-export.json")
                # 2. 解包照片（zip-slip 防护：仅 basename + 白名单扩展名）
                had_photo_entries = False
                for n in names:
                    if not n.startswith("photos/") or n.endswith("/"):
                        continue
                    had_photo_entries = True
                    fn = os.path.basename(n)
                    if not _valid_photo_name(fn):
                        continue
                    with zf.open(n) as src, open(os.path.join(staging, fn), "wb") as out:
                        shutil.copyfileobj(src, out, 1024 * 1024)
        except HTTPException:
            raise
        except (zipfile.BadZipFile, OSError) as e:
            raise HTTPException(status_code=400, detail=f"无法解密，文件可能损坏或不是合法导出包") from e
        staged = {fn for fn in os.listdir(staging) if _valid_photo_name(fn)}

        # 3. 解析 + 整体校验
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            raise HTTPException(status_code=400, detail=f"hangar-export.json 解析失败: {e}")
        errors = db.validate_payload(payload)
        if errors:
            raise HTTPException(status_code=400, detail=errors)

        # 4. 执行
        if body.mode == "replace":
            photos_missing = 0
            for m in payload["models"]:
                want = m.get("photos") or []
                kept = [p for p in want if os.path.basename(p) in staged]
                photos_missing += len(want) - len(kept)
                m["photos"] = kept
            imported = db.import_replace(payload)
            warnings = []
            if photos_missing:
                warnings.append(f"{photos_missing} 张照片在包内缺失，已从 photos 引用中剔除")
            report = {"mode": "replace", "imported": imported, "skipped": 0,
                      "photos_imported": len(staged), "photos_missing": photos_missing,
                      "enum_reset": True, "warnings": warnings}
        else:
            def photo_ok(url):
                fn = os.path.basename(url)
                return fn in staged or os.path.isfile(os.path.join(PHOTOS_DIR, fn))
            res = db.import_merge(payload, photo_ok)
            res["mode"] = "merge"
            res["photos_imported"] = len(staged)
            res["enum_reset"] = False
            report = res

        # 5. 照片落盘（暂存 → PHOTOS_DIR，同名覆盖）
        for fn in staged:
            shutil.copyfile(os.path.join(staging, fn), os.path.join(PHOTOS_DIR, fn))
        # 6. replace 且包内含照片条目时，清理不再被引用的旧照片
        if body.mode == "replace" and had_photo_entries:
            refs = set()
            for m in db.list_models():
                for p in m.get("photos") or []:
                    fn = _photo_filename(p)
                    if fn:
                        refs.add(fn)
            for fn in os.listdir(PHOTOS_DIR):
                if _valid_photo_name(fn) and fn not in refs and os.path.isfile(os.path.join(PHOTOS_DIR, fn)):
                    _remove_quiet(os.path.join(PHOTOS_DIR, fn))
                    _remove_quiet(_thumb_path(fn))
        return report
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        _remove_quiet(zip_path)


# ---------- WebUI 入口（无需鉴权，内网自用） ----------

@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/setup")
def setup_page():
    if db.is_initialized():
        return RedirectResponse("/")
    return FileResponse(os.path.join(STATIC_DIR, "setup.html"))


# 静态资源挂载（放在最后，避免覆盖 API 路由）
app.mount("/photos", StaticFiles(directory=PHOTOS_DIR), name="photos")
app.mount("/", StaticFiles(directory=STATIC_DIR), name="static")
