"""Hangar MCP Server（v1.4.0）：FastMCP 薄封装现有 REST API。

设计约束（见 MCP spec）：
- 工具不直连 SQLite，一律 httpx 调本机 REST——校验/行为单一真源；
- API key 从进程内 settings 读（db.get_config()），自动注入，
  不作为工具参数、不出现在返回与错误信息（异常先脱敏）；
- /mcp 入口挂 X-API-Key 校验：生产 compose 映射 0.0.0.0:8333，
  局域网可达，MCP 代理持 key，无鉴权等于对全局域网开放匿名写入口。
"""
import json
import os
import secrets

import httpx
from fastmcp import FastMCP
from starlette.middleware import Middleware
from starlette.responses import JSONResponse

from . import db

mcp = FastMCP("hangar")

# 自调 REST 的基址。容器内恒为 127.0.0.1:8333（uvicorn 监听端口）；
# env 覆盖仅用于本地多实例测试，生产无需任何新环境变量。
BASE_URL = os.environ.get("HANGAR_BASE_URL", "http://127.0.0.1:8333")

# 精简返回的字段集（spec §2.1：不回 comment 大文本、photos 只回数量）
SLIM_KEYS = ("id", "name", "designation", "grade", "scale", "limited", "status",
             "storage", "owner", "purchase_date", "done_date", "tags")


def _headers():
    return {"X-API-Key": db.get_config().get("token", "")}


def _redact(text):
    token = db.get_config().get("token", "")
    if token:
        text = text.replace(token, "***")
    return text


def _fail(payload):
    """结构化错误统一出口：RuntimeError 携带脱敏 JSON 文本。"""
    raise RuntimeError(json.dumps(payload, ensure_ascii=False))


async def _call(method, path, **kw):
    async with httpx.AsyncClient(timeout=30) as client:
        return await client.request(method, f"{BASE_URL}{path}", headers=_headers(), **kw)


async def _json(method, path, *, not_found=None, **kw):
    """调 REST 并解包：404 且指定 not_found 上下文 → 结构化 not_found；
    其余 >=400 → 透传 REST detail（脱敏后原样抛出，不重试不纠正）。"""
    resp = await _call(method, path, **kw)
    if resp.status_code >= 400:
        if resp.status_code == 404 and not_found is not None:
            _fail({"error": "not_found", **not_found})
        try:
            detail = resp.json().get("detail")
        except ValueError:
            detail = resp.text
        _fail({"error": "rest_error", "status": resp.status_code,
               "detail": _redact(detail if detail is not None else resp.reason_phrase)})
    return resp.json()


def _slim(m):
    out = {k: m.get(k) for k in SLIM_KEYS}
    out["photos_count"] = len(m.get("photos") or [])
    return out


class RequireKeyMiddleware:
    """纯 ASGI：校验 /mcp 请求头 X-API-Key（与 REST 同一 token，常量时间比对）。
    非 http scope（lifespan 等）直接放行。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            supplied = ""
            for k, v in scope.get("headers", []):
                if k == b"x-api-key":
                    supplied = v.decode("latin-1")
                    break
            token = db.get_config().get("token", "")
            if not token or not secrets.compare_digest(supplied, token):
                resp = JSONResponse({"detail": "无效或缺失的 X-API-Key"}, status_code=401)
                await resp(scope, receive, send)
                return
        await self.app(scope, receive, send)


def build_http_app():
    """inner path 设为 '/'：客户端打 http://<host>:8333/mcp（避开 mount 双段 /mcp/mcp 坑）。"""
    return mcp.http_app(path="/", middleware=[Middleware(RequireKeyMiddleware)])


# ---------- 工具（spec §2；先读后写） ----------

@mcp.tool
async def hangar_status():
    """格纳库服务状态：版本号与是否已初始化。"""
    return await _json("GET", "/api/v1/status")


@mcp.tool
async def hangar_values():
    """软枚举/标签建议值（grade/limited/origin/storage/owner/main_color/tag + 硬枚举 category/status）。建档前先查。"""
    return await _json("GET", "/api/v1/models/values")


@mcp.tool
async def hangar_list_models(status: str = "", storage: str = "", display: str = "",
                             grade: str = "", category: str = "", owner: str = "",
                             main_color: str = "", tag: str = "", q: str = ""):
    """列出机体（精简字段，不含 comment；photos 只回数量）。
    筛选参数均可选：status/storage/display/grade/category/owner/main_color/tag 精确匹配，q 搜名称与机设番号。"""
    params = {k: v for k, v in {
        "status": status, "storage": storage, "display": display, "grade": grade,
        "category": category, "owner": owner, "main_color": main_color,
        "tag": tag, "q": q,
    }.items() if v}
    rows = await _json("GET", "/api/v1/models", params=params)
    return [_slim(m) for m in rows]


@mcp.tool
async def hangar_get_model(model_id: str):
    """读单台机体完整记录（含 comment 与 photos 全数组）。"""
    m = await _json("GET", f"/api/v1/models/{model_id}", not_found={"model_id": model_id})
    return m


@mcp.tool
async def hangar_search_models(q: str, limit: int = 20):
    """按名称/机设编号模糊搜索。返回精简数组，最多 limit 条（上限 100，防上下文炸）。"""
    rows = await _json("GET", "/api/v1/models", params={"q": q})
    return [_slim(m) for m in rows[:max(1, min(limit, 100))]]


@mcp.tool
async def hangar_create_model(name: str, category: str, status: str, storage: str,
                              limited: str, origin: str,
                              designation: str = "", grade: str = "", item_no: str = "",
                              scale: str = "", owner: str = "", purchase_date: str = "",
                              done_date: str = "", display: bool = False,
                              tags: list[str] = [], comment: str = "", main_color: str = "",
                              model_id: str = ""):
    """新建机体。必填 name/category/status/storage/limited/origin（category/status 为硬枚举，
    先查 hangar_values 取合法值；不合法 REST 会 400/422 原样抛出）。
    tags 由库层清洗（去空/去重/最多3个）。model_id 留空则自动按 M### 递增。"""
    body = {k: v for k, v in {
        "name": name, "category": category, "status": status, "storage": storage,
        "limited": limited, "origin": origin, "designation": designation, "grade": grade,
        "item_no": item_no, "scale": scale, "owner": owner, "purchase_date": purchase_date,
        "done_date": done_date, "display": display, "tags": tags, "comment": comment,
        "main_color": main_color, "id": model_id,
    }.items() if v not in ("", [], False) or k in ("name", "category", "status", "storage", "limited", "origin")}
    m = await _json("POST", "/api/v1/models", json=body)
    return {"ok": True, "model": _slim(m)}


@mcp.tool
async def hangar_update_model(model_id: str, name: str = "", designation: str = "",
                              category: str = "", grade: str = "", item_no: str = "",
                              scale: str = "", main_color: str = "", limited: str = "",
                              origin: str = "", status: str = "", storage: str = "",
                              owner: str = "", purchase_date: str = "", done_date: str = "",
                              comment: str = "", tags: list[str] = [],
                              display: bool | None = None):
    """更新机体：只传要改的字段（空字符串/空列表视为未传，不会覆盖；display 传 true/false 才改）。
    若因 photos 校验失败 REST 400 会原样抛出（含缺失文件名），不自动重试。"""
    data = {k: v for k, v in {
        "name": name, "designation": designation, "category": category, "grade": grade,
        "item_no": item_no, "scale": scale, "main_color": main_color, "limited": limited,
        "origin": origin, "status": status, "storage": storage, "owner": owner,
        "purchase_date": purchase_date, "done_date": done_date, "comment": comment,
        "tags": tags, "display": display,
    }.items() if v not in ("", [], None)}
    if not data:
        _fail({"error": "no_fields", "model_id": model_id,
               "detail": "没有要更新的字段"})
    m = await _json("PATCH", f"/api/v1/models/{model_id}", json=data,
                    not_found={"model_id": model_id})
    return {"ok": True, "model": _slim(m)}


@mcp.tool
async def hangar_delete_model(model_id: str):
    """删除机体。破坏性操作：会连带删除其 photos 数组记录；磁盘上的孤儿照片文件按现状只告警不删。"""
    return await _json("DELETE", f"/api/v1/models/{model_id}", not_found={"model_id": model_id})


@mcp.tool
async def hangar_list_photos(model_id: str, detail: bool = False):
    """列出某机体的照片。detail=False 只回文件名数组（快）；detail=True 逐张取 meta 摘要
    （taken_at/device/有无 GPS，逐张往返，照片多时慢）。"""
    m = await _json("GET", f"/api/v1/models/{model_id}", not_found={"model_id": model_id})
    names = [p.rsplit("/", 1)[-1] for p in m.get("photos") or []]
    if not detail:
        return {"model_id": model_id, "photos": names}
    out = []
    for fn in names:
        meta = await _json("GET", f"/api/v1/models/{model_id}/photos/{fn}/meta",
                           not_found={"model_id": model_id, "filename": fn})
        out.append({"filename": fn, "taken_at": meta.get("taken_at"),
                    "device": meta.get("device"), "has_gps": bool(meta.get("gps"))})
    return {"model_id": model_id, "photos": out}


@mcp.tool
async def hangar_upload_photo(model_id: str, filename: str, content_b64: str):
    """上传一张照片（base64 入参，仅适用 ≤5MB 小图；大图请走既有分块 curl 通路，MCP 不承诺）。
    服务端按 M###_N.ext 规则重命名并落 photos 数组。"""
    import base64
    try:
        data = base64.b64decode(content_b64, validate=True)
    except Exception:
        _fail({"error": "bad_base64", "detail": "content_b64 不是合法 base64"})
    if len(data) > 5 * 1024 * 1024:
        _fail({"error": "too_large", "bytes": len(data),
               "detail": "MCP 上传限 5MB，大图走分块上传 REST 通路"})
    m = await _json("POST", f"/api/v1/models/{model_id}/photos",
                    files={"file": (filename, data)},
                    not_found={"model_id": model_id})
    return {"ok": True, "photos": m.get("photos", [])}


@mcp.tool
async def hangar_reorder_photos(model_id: str, order: list[str]):
    """重排照片顺序。order 必须是当前 photos 数组的完整排列（无增删/重复，多重集相等），
    条目可传裸文件名或 /photos/ URL；不满足 REST 400 原样抛出。"""
    m = await _json("PUT", f"/api/v1/models/{model_id}/photos/order", json={"order": order},
                    not_found={"model_id": model_id})
    return {"ok": True, "photos": m.get("photos", [])}


@mcp.tool
async def hangar_delete_photo(model_id: str, filename: str):
    """删除某张照片（磁盘文件+缩略图缓存一并删除，photos 数组移除）。"""
    m = await _json("DELETE", f"/api/v1/models/{model_id}/photos/{filename}",
                    not_found={"model_id": model_id, "filename": filename})
    return {"ok": True, "photos": m.get("photos", [])}


@mcp.tool
async def hangar_photo_meta(model_id: str, filename: str):
    """读照片 EXIF 元数据：拍摄时间/机型（device 已归一，device_raw 为裸 EXIF Model 原值）/
    曝光参数/GPS 与高德地址（有缓存）。"""
    return await _json("GET", f"/api/v1/models/{model_id}/photos/{filename}/meta",
                       not_found={"model_id": model_id, "filename": filename})
