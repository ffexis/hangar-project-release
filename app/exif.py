"""照片 EXIF 解析 + GPS 坐标转换 + 高德反向地理编码。"""
import math
from fractions import Fraction

import httpx
from PIL import Image, UnidentifiedImageError

TAG_DATETIME = 306
TAG_DATETIME_ORIGINAL = 36867
TAG_MAKE = 271
TAG_MODEL = 272
TAG_EXPOSURE = 33434
TAG_FNUMBER = 33437
TAG_ISO = 34855
TAG_GPS = 34853
TAG_EXIF_IFD = 34665
TAG_FOCAL_LENGTH = 3734
TAG_FOCAL_LENGTH_35MM = 41989


def _num(v):
    """安全转 float：处理 0/0 等非法有理数（Pillow 版本不同会抛异常或返回 nan）。"""
    if isinstance(v, tuple) and len(v) == 2:
        try:
            return v[0] / v[1] if v[1] else None
        except (TypeError, ValueError, ZeroDivisionError):
            return None
    if isinstance(v, (int, float)):
        f = float(v)
    else:
        try:  # Pillow 的 IFDRational / Fraction 等可转 float 的有理数
            f = float(v)
        except (TypeError, ValueError, ZeroDivisionError):
            return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _fmt_exposure(sec):
    if sec is None or sec <= 0:
        return None
    if sec >= 1:
        return f"{sec:g}s"
    return f"1/{round(1 / sec)}s"


def _dms_to_deg(dms, ref):
    try:
        d, m, s = _num(dms[0]), _num(dms[1]), _num(dms[2])
        if d is None:
            return None
        deg = d + (m or 0) / 60 + (s or 0) / 3600
        if str(ref).upper() in ("S", "W"):
            deg = -deg
        return deg
    except (TypeError, IndexError, ValueError, ZeroDivisionError):
        return None


# ---------- WGS84 -> GCJ02（高德坐标系） ----------

_A = 6378245.0
_EE = 0.00669342162296594323


def _tlat(x, y):
    r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    r += (20 * math.sin(6 * x * math.pi) + 20 * math.sin(2 * x * math.pi)) * 2 / 3
    r += (20 * math.sin(y * math.pi) + 40 * math.sin(y / 3 * math.pi)) * 2 / 3
    r += (160 * math.sin(y / 12 * math.pi) + 320 * math.sin(y * math.pi / 30)) * 2 / 3
    return r


def _tlng(x, y):
    r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    r += (20 * math.sin(6 * x * math.pi) + 20 * math.sin(2 * x * math.pi)) * 2 / 3
    r += (20 * math.sin(x * math.pi) + 40 * math.sin(x / 3 * math.pi)) * 2 / 3
    r += (150 * math.sin(x / 12 * math.pi) + 300 * math.sin(x / 30 * math.pi)) * 2 / 3
    return r


def wgs84_to_gcj02(lat, lng):
    # 中国境外高德不偏移，直接返回原坐标
    if not (0.8293 < lat < 55.8271 and 72.004 < lng < 137.8347):
        return lat, lng
    dlat = _tlat(lng - 105, lat - 35)
    dlng = _tlng(lng - 105, lat - 35)
    radlat = lat / 180 * math.pi
    magic = 1 - _EE * math.sin(radlat) * math.sin(radlat)
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180) / ((_A * (1 - _EE)) / (magic * sqrtmagic) * math.pi)
    dlng = (dlng * 180) / (_A / sqrtmagic * math.cos(radlat) * math.pi)
    return lat + dlat, lng + dlng


def _is_hdr(path):
    """Ultra HDR 检测：JPEG 头部 XMP 段含 'GainMap'（DirectoryItemSemantic: Primary, GainMap）。
    读头 64KB 原始字节即可（XMP 在文件头，且不在 PIL 标准 EXIF 里）；异常一律 False。"""
    try:
        with open(path, "rb") as f:
            return b"GainMap" in f.read(65536)
    except OSError:
        return False


def read_exif(path):
    """读取照片元数据；无 EXIF / 损坏的字段返回 None，绝不抛异常。"""
    meta = {"taken_at": None, "device": None, "exposure": None,
            "aperture": None, "iso": None, "focal": None, "gps": None, "map": None,
            "hdr": _is_hdr(path)}
    try:
        with Image.open(path) as im:
            ex = im.getexif()
    except (UnidentifiedImageError, OSError):
        return meta
    if not ex:
        return meta
    try:
        sub = ex.get_ifd(TAG_EXIF_IFD)
    except Exception:
        sub = {}
    dt = sub.get(TAG_DATETIME_ORIGINAL) or ex.get(TAG_DATETIME)
    if dt:
        meta["taken_at"] = str(dt).strip()
    make = str(ex.get(TAG_MAKE, "") or "").strip()
    model = str(ex.get(TAG_MODEL, "") or "").strip()
    dev = " ".join(x for x in (make, model) if x)
    meta["device"] = dev or None
    meta["exposure"] = _fmt_exposure(_num(sub.get(TAG_EXPOSURE)))
    meta["aperture"] = _num(sub.get(TAG_FNUMBER))
    # 35mm 等效焦距优先，退回实际焦距
    focal = _num(sub.get(TAG_FOCAL_LENGTH_35MM)) or _num(sub.get(TAG_FOCAL_LENGTH))
    meta["focal"] = focal
    iso = sub.get(TAG_ISO)
    if isinstance(iso, (tuple, list)) and iso:
        iso = iso[0]
    try:
        meta["iso"] = int(iso) if iso else None
    except (TypeError, ValueError):
        meta["iso"] = None
    try:
        gps = ex.get_ifd(TAG_GPS)
    except Exception:
        gps = None
    if gps and 2 in gps and 4 in gps:
        lat = _dms_to_deg(gps[2], gps.get(1, "N"))
        lng = _dms_to_deg(gps[4], gps.get(3, "E"))
        # 相机定位失败时常写入 (0,0)，视为无有效坐标
        if lat is not None and lng is not None and (lat or lng):
            meta["gps"] = {"lat": round(lat, 6), "lng": round(lng, 6)}
            glat, glng = wgs84_to_gcj02(lat, lng)
            meta["map"] = {"lat": round(glat, 6), "lng": round(glng, 6)}
    return meta


async def amap_regeo(gmap, key):
    """高德反向地理编码（输入 GCJ-02 坐标），失败返回 None。key 由调用方从配置传入。"""
    if not key:
        return None
    try:
        async with httpx.AsyncClient(timeout=6) as c:
            r = await c.get("https://restapi.amap.com/v3/geocode/regeo",
                            params={"key": key,
                                    "location": f"{gmap['lng']},{gmap['lat']}"})
            j = r.json()
        if j.get("status") == "1":
            return j["regeocode"]["formatted_address"]
    except Exception:
        pass
    return None
