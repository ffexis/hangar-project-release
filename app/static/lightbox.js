// Hangar WebUI — Lightbox：大图翻页 / EXIF 信息 / 跟手滑动手势
import { $, ovOpen, ovClose } from "./core.js";

let LB_LIST = [];
let LB_INDEX = 0;
let lbSeq = 0;
let LB_ID = null;

function isLocalPhoto(p) {
  return p.startsWith("/photos/");
}

// "2026:09:10 15:30:00" -> "2026年9月10日15:30:00"（月/日不补零）
function fmtTaken(s) {
  if (!s) return "";
  const m = String(s).match(/(\d{4})[:\-\/](\d{1,2})[:\-\/](\d{1,2})[ T](.+)/);
  if (!m) return String(s);
  return `${m[1]}年${+m[2]}月${+m[3]}日${m[4]}`;
}

// 拍照参数串：35mm · ƒ/1.8 · 1/500s · ISO 100（缺项跳过；ƒ 斜体）
function exifParams(meta) {
  const parts = [];
  if (meta.focal) parts.push(`${+meta.focal.toFixed(1)}mm`);
  if (meta.aperture) parts.push(`<i>ƒ</i>/${meta.aperture}`);
  if (meta.exposure) parts.push(meta.exposure);
  if (meta.iso) parts.push(`ISO ${meta.iso}`);
  return parts.join(" · ");
}

export function openLightbox(src, list, id) {
  LB_LIST = list && list.length ? list : [src];
  LB_INDEX = Math.max(0, LB_LIST.indexOf(src));
  LB_ID = id || null;
  $("#lightbox").classList.remove("hidden");
  showLbPhoto();
  ovOpen(closeLightbox);
}

export function lbStep(d) {
  const n = LB_INDEX + d;
  if (n < 0 || n >= LB_LIST.length) return;   // 首尾 clamp，不循环
  LB_INDEX = n;
  showLbPhoto();
}

function showLbPhoto() {
  const src = LB_LIST[LB_INDEX];
  const img = $("#lightbox-img");
  resetDragTransform();
  img.src = src;
  const multi = LB_LIST.length > 1;
  const prev = $("#lb-prev");
  const next = $("#lb-next");
  prev.classList.toggle("hidden", !multi);
  next.classList.toggle("hidden", !multi);
  // 到头/到尾：按钮置灰反馈（clamp 后不可再翻）
  prev.classList.toggle("lb-disabled", LB_INDEX === 0);
  next.classList.toggle("lb-disabled", LB_INDEX === LB_LIST.length - 1);
  preloadNeighbors();
  const info = $("#lb-info");
  info.innerHTML = "";
  const seq = ++lbSeq;
  const counter = multi ? `${LB_INDEX + 1} / ${LB_LIST.length}` : "";
  if (!isLocalPhoto(src)) {
    info.textContent = counter ? `${counter}（外部链接）` : "外部链接";
    return;
  }
  const fn = src.split("/").pop();
  const id = LB_ID || (src.match(/\/photos\/([^_/]+)_/) || [])[1] || fn.split("_")[0];
  info.textContent = counter || "读取 EXIF…";
  fetch(`/api/v1/models/${encodeURIComponent(id)}/photos/${encodeURIComponent(fn)}/meta`)
    .then((r) => r.ok ? r.json() : null)
    .then((m) => {
      if (seq !== lbSeq) return;
      info.innerHTML = "";
      const add = (value, href) => {
        const s = document.createElement("span");
        s.className = "lb-item";
        if (href) {
          const a = document.createElement("a");
          a.href = href;
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = value;
          s.appendChild(a);
        } else {
          s.textContent = value;
        }
        info.appendChild(s);
      };
      if (counter) add(counter);
      if (!m) {
        add("EXIF 读取失败");
        return;
      }
      const date = fmtTaken(m.taken_at);
      if (date) add(date);
      if (m.device) add(m.device);
      const params = exifParams(m);
      if (params) {
        const s = document.createElement("span");
        s.className = "lb-item";
        s.innerHTML = params;   // 仅含 <i> 与数字，安全
        info.appendChild(s);
      }
      if (m.gps) {
        const { lat, lng } = m.gps;
        const coord = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        if (m.map) {
          // 地址/坐标整体即链接，不再显示「位置」「在地图查看」文字
          const mapUrl = `https://uri.amap.com/marker?position=${m.map.lng},${m.map.lat}`;
          add(m.address || coord, mapUrl);
        } else {
          add(coord);
        }
      }
    })
    .catch(() => {
      if (seq !== lbSeq) return;
      info.textContent = "EXIF 读取失败";
    });
}

function preloadNeighbors() {
  [LB_INDEX - 1, LB_INDEX + 1].forEach((i) => {
    if (i < 0 || i >= LB_LIST.length) return;
    const im = new Image();
    im.src = LB_LIST[i];
  });
}

export function closeLightbox() {
  lbSeq++;
  $("#lightbox").classList.add("hidden");
}

function lightboxOpen() {
  return !$("#lightbox").classList.contains("hidden");
}

// ---------- 跟手滑动（小屏）+ 首尾橡皮筋 ----------
// 拖动时图片实时跟随手指；到首/尾继续外拉加阻尼，松手回弹。
// 位移或速度达标则翻页（clamp 到边界），否则回弹。
const RUBBER = 0.35;          // 越界阻尼系数
const SWIPE_DIST = 60;        // 翻页位移阈值 px
const SWIPE_VEL = 0.4;        // 翻页速度阈值 px/ms

let dragX0 = 0, dragY0 = 0, dragT0 = 0;
let dragging = false, dragDx = 0, justDragged = false, swapping = false;

function resetDragTransform() {
  const img = $("#lightbox-img");
  img.style.transition = "none";
  img.style.transform = "";
}

function setImgOffset(px, animate) {
  const img = $("#lightbox-img");
  img.style.transition = animate ? "transform .22s cubic-bezier(.2,.8,.3,1)" : "none";
  img.style.transform = px ? `translateX(${px}px)` : "";
}

function boundOffset(dx) {
  const atStart = LB_INDEX === 0 && dx > 0;
  const atEnd = LB_INDEX === LB_LIST.length - 1 && dx < 0;
  return (atStart || atEnd) ? dx * RUBBER : dx;
}

function initSwipe() {
  const lb = $("#lightbox");
  lb.addEventListener("touchstart", (e) => {
    if (!lightboxOpen() || e.touches.length !== 1) return;
    dragX0 = e.touches[0].clientX;
    dragY0 = e.touches[0].clientY;
    dragT0 = performance.now();
    dragging = false;
    dragDx = 0;
  }, { passive: true });

  lb.addEventListener("touchmove", (e) => {
    if (!lightboxOpen()) return;
    const dx = e.touches[0].clientX - dragX0;
    const dy = e.touches[0].clientY - dragY0;
    if (!dragging) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.2) return;  // 纵向意图：不劫持
      dragging = true;
    }
    dragDx = dx;
    setImgOffset(boundOffset(dx), false);
  }, { passive: true });

  lb.addEventListener("touchend", (e) => {
    if (!lightboxOpen()) return;
    if (!dragging) return;
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 300);
    const dt = Math.max(1, performance.now() - dragT0);
    const vel = dragDx / dt;
    let target = LB_INDEX;
    if ((Math.abs(dragDx) > SWIPE_DIST || Math.abs(vel) > SWIPE_VEL) && LB_LIST.length > 1) {
      target = dragDx < 0 ? LB_INDEX + 1 : LB_INDEX - 1;
      if (target < 0) target = 0;
      if (target >= LB_LIST.length) target = LB_LIST.length - 1;
    }
    if (target === LB_INDEX) {
      setImgOffset(0, true);            // 回弹（含越界橡皮筋回弹）
    } else if (!swapping) {
      // 滑出屏幕 → 换图 → 从对侧滑入
      const w = window.innerWidth;
      const dir = target > LB_INDEX ? -1 : 1;
      const img = $("#lightbox-img");
      img.style.transition = "transform .18s ease-out";
      img.style.transform = `translateX(${dir * w}px)`;
      const swap = () => {
        LB_INDEX = target;
        showLbPhoto();                   // 内部 resetDragTransform 清除 transform
        img.style.transition = "none";
        img.style.transform = `translateX(${-dir * w}px)`;
        void img.offsetWidth;            // 强制提交样式，否则过渡起点仍是滑出侧（方向反了）
        img.style.transition = "transform .2s ease-out";
        img.style.transform = "";
      };
      swapping = true;
      setTimeout(() => { swapping = false; swap(); }, 190);
    }
    dragging = false;
  }, { passive: true });

  // 点大图关闭：拖动后不触发
  lb.addEventListener("click", (e) => {
    if (justDragged) return;
    if (e.target === e.currentTarget || e.target.id === "lightbox-img") ovClose(closeLightbox);
  });
  $("#lb-prev").onclick = (e) => { e.stopPropagation(); lbStep(-1); };
  $("#lb-next").onclick = (e) => { e.stopPropagation(); lbStep(1); };
  $("#lb-info").addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("keydown", (e) => {
    if (!lightboxOpen()) return;
    if (e.key === "ArrowLeft") lbStep(-1);
    else if (e.key === "ArrowRight") lbStep(1);
  });
}

export { lightboxOpen };
initSwipe();
