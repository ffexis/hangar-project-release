"""SQLite 数据层：建表 + CRUD + 初始化配置（settings 单行 JSON）。"""
import json
import os
import re
import sqlite3
from datetime import datetime, timezone

# 硬枚举内置默认值（仅用于 setup 页预填建议与 env 引导模式，实际生效值存 settings）
CATEGORIES = ["GUNPLA", "手办", "乐高", "其他"]
STATUSES = ["未开封", "未拼装", "制作中", "拼装完工", "标识系统完工", "最终完工", "成品"]

# 软枚举字段名（setup 页可填充；内置默认仅用于 env 引导模式，保持老部署行为不变）
SOFT_DEFAULTS = {
    "grade": ["MEGASIZE", "PG Unleashed", "PG", "MGEX", "MG", "RG", "RE/100", "HG", "EG", "MGSD", "SDCS", "SDEX"],
    "limited": ["通贩", "PB网限", "魂限定", "会场限定", "其他"],
    "origin": ["官方", "KO", "其他"],
    "storage": ["Home A", "Home B", "仓库", "柜子"],
    "owner": ["主人", "崽", "其他"],
}
SOFT_FIELDS = list(SOFT_DEFAULTS)

SETTINGS_SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS geo_cache (
    key       TEXT PRIMARY KEY,
    address   TEXT NOT NULL,
    cached_at TEXT NOT NULL
);
"""

CONFIG_KEY = "***"

# 运行时配置缓存（init_db 加载，setup 完成后刷新）；token 明文存储，
# 便于用户忘记后从容器内 sqlite3 找回（内网部署前提）。
_config = None


def _default_config():
    return {
        "initialized": False,
        "token": "",
        "categories": list(CATEGORIES),
        "statuses": list(STATUSES),
        "soft_defaults": {f: [] for f in SOFT_FIELDS},
        "amap_key": "",
    }


def get_config():
    global _config
    if _config is None:
        init_db()
    return _config


def is_initialized():
    return bool(get_config().get("initialized"))


def _save_config(conn):
    """单行 JSON 原子写：全部配置一次落库，不存在半初始化。"""
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        (CONFIG_KEY, json.dumps(_config, ensure_ascii=False)),
    )
    conn.commit()


def _models_ddl(cfg):
    """按用户配置的硬 enum 动态生成 CHECK 约束（单引号转义）。"""
    def in_list(vals):
        return ", ".join("'" + str(v).replace("'", "''") + "'" for v in vals)
    return f"""
CREATE TABLE IF NOT EXISTS models (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    category      TEXT NOT NULL CHECK (category IN ({in_list(cfg["categories"])})),
    grade         TEXT,
    item_no       TEXT,
    scale         TEXT,
    limited       TEXT NOT NULL,
    origin        TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ({in_list(cfg["statuses"])})),
    storage       TEXT NOT NULL,
    display       INTEGER NOT NULL DEFAULT 0,
    owner         TEXT NOT NULL DEFAULT '',
    purchase_date TEXT,
    done_date     TEXT,
    updated_at    TEXT NOT NULL,
    comment       TEXT,
    photos        TEXT NOT NULL DEFAULT '[]',
    tags          TEXT NOT NULL DEFAULT '[]'
);
"""


def _ensure_models_table(conn):
    conn.executescript(_models_ddl(_config))
    conn.commit()
    # 迁移：老库补 tags / done_date 列
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(models)").fetchall()}
    if "tags" not in cols:
        conn.execute("ALTER TABLE models ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
    if "done_date" not in cols:
        conn.execute("ALTER TABLE models ADD COLUMN done_date TEXT")
    conn.commit()


def init_db():
    """启动时加载/引导配置。未初始化且存在 API_TOKEN 环境变量时走 env 引导
    （老部署升级镜像行为不变）；否则保持未初始化，等待 setup 页完成。"""
    global _config
    conn = _conn()
    conn.executescript(SETTINGS_SCHEMA)
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (CONFIG_KEY,)).fetchone()
    if row:
        _config = json.loads(row["value"])
    else:
        env_token = os.environ.get("API_TOKEN", "").strip()
        if env_token:
            _config = {
                "initialized": True,
                "token": env_token,
                "categories": list(CATEGORIES),
                "statuses": list(STATUSES),
                "soft_defaults": {f: list(v) for f, v in SOFT_DEFAULTS.items()},
                "amap_key": os.environ.get("AMAP_KEY", "").strip(),
            }
            _save_config(conn)
        else:
            _config = _default_config()
    if _config.get("initialized"):
        _ensure_models_table(conn)
    conn.close()


def _token_path():
    """token 明文备份文件，与数据库同目录（持久卷内），容器里 cat 即可找回。"""
    d = os.path.dirname(os.environ.get("DATA_FILE", "/data/models.db")) or "."
    return os.path.join(d, "token.txt")


def complete_setup(cfg):
    """setup 页提交：写入全部配置（单行原子）、建 models 表并落 token 明文文件。"""
    global _config
    _config = cfg
    conn = _conn()
    _save_config(conn)
    _ensure_models_table(conn)
    conn.close()
    with open(_token_path(), "w", encoding="utf-8") as f:
        f.write(cfg["token"])
    return _config

FIELDS = [
    "id", "name", "category", "grade", "item_no", "scale", "limited",
    "origin", "status", "storage", "display", "owner",
    "purchase_date", "done_date", "updated_at", "comment", "photos", "tags",
]
WRITABLE = [f for f in FIELDS if f not in ("id", "updated_at", "photos")]

MAX_TAGS = 3


def normalize_tags(tags):
    """清洗 tag 列表：去空、去重（保序）、每项截断、最多 MAX_TAGS 个。"""
    if tags is None:
        return []
    if isinstance(tags, str):
        tags = [tags]
    out, seen = [], set()
    for t in tags:
        t = str(t).strip()
        if not t or t in seen:
            continue
        seen.add(t)
        out.append(t[:32])
        if len(out) >= MAX_TAGS:
            break
    return out


def _conn():
    path = os.environ.get("DATA_FILE", "/data/models.db")
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _row_to_model(row):
    m = dict(row)
    m["display"] = bool(m["display"])
    try:
        m["photos"] = json.loads(m["photos"] or "[]")
    except (TypeError, ValueError):
        m["photos"] = []
    try:
        m["tags"] = json.loads(m.get("tags") or "[]")
    except (TypeError, ValueError):
        m["tags"] = []
    return m


def next_id(conn):
    """按现有最大编号 +1 自动生成 M001 格式编号。"""
    mx = 0
    for (iid,) in conn.execute("SELECT id FROM models").fetchall():
        m = re.fullmatch(r"M(\d+)", iid or "")
        if m:
            mx = max(mx, int(m.group(1)))
    return f"M{mx + 1:03d}"


def list_models(filters=None, q=None):
    conn = _conn()
    sql = "SELECT * FROM models"
    where, params = [], []
    if filters:
        for col in ("status", "storage", "grade", "category", "owner"):
            val = filters.get(col)
            if val:
                where.append(f"{col} = ?")
                params.append(val)
        disp = filters.get("display")
        if disp is not None and disp != "":
            where.append("display = ?")
            params.append(1 if str(disp).lower() in ("1", "true", "yes") else 0)
        tag = filters.get("tag")
        if tag:
            # tags 存 JSON 数组，用 json_each 精确匹配单个元素（避免 LIKE 子串误命中）
            where.append("EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)")
            params.append(tag)
    if q:
        where.append("name LIKE ?")
        params.append(f"%{q}%")
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id"
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [_row_to_model(r) for r in rows]


def get_model(model_id):
    conn = _conn()
    row = conn.execute("SELECT * FROM models WHERE id = ?", (model_id,)).fetchone()
    conn.close()
    return _row_to_model(row) if row else None


def field_values():
    """软枚举取值建议：用户配置 ∪ 库中 DISTINCT 值；硬枚举取配置。"""
    cfg = get_config()
    conn = _conn()
    result = {}
    for field in SOFT_FIELDS:
        vals = list(cfg["soft_defaults"].get(field) or [])
        rows = conn.execute(
            f"SELECT DISTINCT {field} AS v FROM models WHERE {field} IS NOT NULL AND {field} != ''"
        ).fetchall()
        for r in rows:
            if r["v"] not in vals:
                vals.append(r["v"])
        result[field] = vals
    conn.close()
    result["category"] = list(cfg["categories"])
    result["status"] = list(cfg["statuses"])
    # tag 无内置默认，备选项 = 库中已有全部 tag（去重、按出现排序）
    conn = _conn()
    tag_rows = conn.execute(
        "SELECT value AS v, COUNT(*) AS c FROM models, json_each(models.tags) GROUP BY v ORDER BY c DESC, v"
    ).fetchall()
    conn.close()
    result["tag"] = [r["v"] for r in tag_rows]
    return result


def create_model(data):
    conn = _conn()
    model_id = data.get("id") or next_id(conn)
    if conn.execute("SELECT 1 FROM models WHERE id = ?", (model_id,)).fetchone():
        conn.close()
        raise ValueError(f"id 已存在: {model_id}")
    payload = {f: data[f] for f in WRITABLE if f in data}
    payload.setdefault("owner", "")
    payload["display"] = 1 if payload.get("display") else 0
    payload["updated_at"] = now_iso()
    photos = data.get("photos") or []
    if isinstance(photos, str):
        photos = [photos]
    payload["photos"] = json.dumps(photos, ensure_ascii=False)
    payload["tags"] = json.dumps(normalize_tags(data.get("tags")), ensure_ascii=False)
    all_cols = ["id"] + list(payload.keys())
    all_vals = [model_id] + list(payload.values())
    conn.execute(
        f"INSERT INTO models ({', '.join(all_cols)}) VALUES ({', '.join('?' * len(all_cols))})",
        all_vals,
    )
    conn.commit()
    row = conn.execute("SELECT * FROM models WHERE id = ?", (model_id,)).fetchone()
    conn.close()
    return _row_to_model(row)


def update_model(model_id, data):
    conn = _conn()
    row = conn.execute("SELECT * FROM models WHERE id = ?", (model_id,)).fetchone()
    if not row:
        conn.close()
        return None
    payload = {}
    for f in WRITABLE:
        if f in data:
            payload[f] = data[f]
    if "photos" in data:
        payload["photos"] = json.dumps(data["photos"] or [], ensure_ascii=False)
    if "tags" in data:
        payload["tags"] = json.dumps(normalize_tags(data["tags"]), ensure_ascii=False)
    if "display" in payload:
        payload["display"] = 1 if payload["display"] else 0
    payload["updated_at"] = now_iso()
    sets = ", ".join(f"{k} = ?" for k in payload)
    conn.execute(f"UPDATE models SET {sets} WHERE id = ?", list(payload.values()) + [model_id])
    conn.commit()
    row = conn.execute("SELECT * FROM models WHERE id = ?", (model_id,)).fetchone()
    conn.close()
    return _row_to_model(row)


def delete_model(model_id):
    conn = _conn()
    cur = conn.execute("DELETE FROM models WHERE id = ?", (model_id,))
    conn.commit()
    conn.close()
    return cur.rowcount > 0


# ---------- 地理位置缓存（GCJ02 坐标 -> 地址），避免重复请求高德 ----------

def geo_cache_get(lat, lng):
    conn = _conn()
    row = conn.execute(
        "SELECT address FROM geo_cache WHERE key = ?", (_geo_key(lat, lng),)
    ).fetchone()
    conn.close()
    return row["address"] if row else None


def geo_cache_put(lat, lng, address):
    conn = _conn()
    conn.execute(
        "INSERT OR REPLACE INTO geo_cache (key, address, cached_at) VALUES (?, ?, ?)",
        (_geo_key(lat, lng), address, now_iso()),
    )
    conn.commit()
    conn.close()


def _geo_key(lat, lng):
    # 4 位小数约 11m 网格，同一地点的多张照片可共享缓存
    return f"{round(lat, 4):.4f},{round(lng, 4):.4f}"
