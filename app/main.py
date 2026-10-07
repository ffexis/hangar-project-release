"""Hangar Project：模玩管理 FastAPI 入口（REST API + 静态 WebUI）。"""
import io
import os
import re
import secrets
from typing import Optional

from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db, exif

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
PHOTOS_DIR = os.environ.get("PHOTOS_DIR", os.path.join(os.path.dirname(__file__), "photos"))
os.makedirs(PHOTOS_DIR, exist_ok=True)

# 缩略图缓存目录：默认落在数据卷（与 DATA_FILE 同目录），重建容器不丢失。
DATA_DIR = os.path.dirname(os.environ.get("DATA_FILE", "/data/models.db")) or "."
THUMBS_DIR = os.environ.get("THUMBS_DIR", os.path.join(DATA_DIR, "thumbs"))
os.makedirs(THUMBS_DIR, exist_ok=True)
THUMB_SIZE = 400

MAX_PHOTO_BYTES = 20 * 1024 * 1024
ALLOWED_EXTS = {"jpg": "jpg", "jpeg": "jpg", "png": "png", "webp": "webp", "gif": "gif"}
SAFE_NAME_RE = re.compile(r"[A-Za-z0-9_.-]+\Z")

app = FastAPI(title="Hangar Project", version="1.1.0")


def verify_api_key(x_api_key: Optional[str] = Header(None)):
    token = db.get_config().get("token", "")
    if not token or not secrets.compare_digest(x_api_key or "", token):
        raise HTTPException(status_code=401, detail="无效或缺失的 X-API-Key")
    return True


@app.on_event("startup")
def startup():
    db.init_db()


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
    return {"initialized": db.is_initialized()}


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
