// Hangar WebUI — 详情模态框：字段渲染 / 照片网格 / 上传删除 / 排序
import { $, api, esc, thumbUrl, tagBadges, gradeCell, toast, ovOpen, ovClose, LOGGED_IN, displayName } from "./core.js";
import { openLightbox } from "./lightbox.js";
import { loadList } from "./list.js";
import { createSession, runUpload } from "./upload.js";

const FIELD_LABELS = {
  id: "编号", name: "名称", category: "类别", grade: "级别", item_no: "官方货号",
  scale: "比例", main_color: "机体颜色", limited: "限定类型", origin: "来源", status: "状态",
  storage: "存放位置", display: "展示", owner: "归属", purchase_date: "购买日期",
  done_date: "完成日期",
  comment: "评价 / 备注", photos: "照片", tags: "标签",
};

let DETAIL_MODEL = null;
let UPLOAD = null; // 分块上传会话 {files, fi, done:Set, uploadId, ok, fail, paused}

export async function showDetail(id) {
  const m = await api("/api/v1/models/" + encodeURIComponent(id));
  DETAIL_MODEL = m;
  $("#detail-title").textContent = displayName(m);
  const box = $("#detail-body");
  box.innerHTML = "";
  Object.keys(FIELD_LABELS).forEach((k) => {
    if (k === "photos") return;
    const row = document.createElement("div");
    // 评价/备注：标题独立行，内容另起一行并保留换行
    row.className = k === "comment" ? "drow drow-block" : "drow";
    let v = m[k];
    if (k === "display") v = m.display ? "展示中" : "未展示";
    let html;
    if (k === "name") html = esc(displayName(m));  // 名称 = 机设番号 + 名称 拼接
    else if (k === "grade") html = gradeCell(v, m.origin);
    else if (k === "tags") html = tagBadges(v);
    else if (k === "comment") html = v ? esc(v) : "";
    else html = esc(v == null ? "" : v);
    row.innerHTML = `<span class="dk">${FIELD_LABELS[k]}</span><span class="dv">${html}</span>`;
    box.appendChild(row);
  });
  renderPhotos(m);
  $("#detail-modal").classList.remove("hidden");
  document.body.classList.add("modal-open");
  ovOpen(closeDetail);
}

export function closeDetail() {
  $("#detail-modal").classList.add("hidden");
  document.body.classList.remove("modal-open");
}

function renderPhotos(m) {
  DETAIL_MODEL = m;
  const photos = m.photos || [];
  $("#photos-tools").classList.toggle("hidden", !LOGGED_IN);
  $("#upload-status").textContent = "";
  const g = $("#photos-grid");
  g.innerHTML = "";
  if (!photos.length) {
    g.innerHTML = '<span class="muted">暂无照片。</span>';
    return;
  }
  g.classList.toggle("drag-sortable", LOGGED_IN && photos.length > 1);
  photos.forEach((p, i) => {
    const cell = document.createElement("div");
    cell.className = "photo-cell";
    cell.dataset.src = p;
    const img = document.createElement("img");
    img.src = thumbUrl(p);
    img.alt = m.name;
    img.loading = "lazy";
    img.draggable = false; // 禁用原生图片拖拽，避免与 Pointer 拖拽冲突
    img.onclick = () => openLightbox(p, photos, m.id);
    cell.appendChild(img);
    if (LOGGED_IN) {
      const del = document.createElement("button");
      del.className = "photo-del";
      del.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><path fill="currentColor" d="m19.61 18l4.86-4.86a1 1 0 0 0-1.41-1.41l-4.86 4.81l-4.89-4.89a1 1 0 0 0-1.41 1.41L16.78 18L12 22.72a1 1 0 1 0 1.41 1.41l4.77-4.77l4.74 4.74a1 1 0 0 0 1.41-1.41Z"/><path fill="currentColor" d="M18 34a16 16 0 1 1 16-16a16 16 0 0 1-16 16m0-30a14 14 0 1 0 14 14A14 14 0 0 0 18 4"/></svg>';
      del.title = "删除这张";
      del.onclick = () => deletePhoto(m.id, p);
      cell.appendChild(del);
      // 上移/下移（首尾禁用对应方向）
      const mv = document.createElement("div");
      mv.className = "photo-move";
      const up = document.createElement("button");
      up.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path stroke-linejoin="round" d="M15 13.5L12 10.5L9 13.5"/></g></svg>';
      up.title = "上移";
      up.disabled = i === 0;
      up.onclick = () => movePhoto(i, i - 1);
      const dn = document.createElement("button");
      dn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path stroke-linejoin="round" d="M15 10.5L12 13.5L9 10.5"/></g></svg>';
      dn.title = "下移";
      dn.disabled = i === photos.length - 1;
      dn.onclick = () => movePhoto(i, i + 1);
      mv.appendChild(up);
      mv.appendChild(dn);
      cell.appendChild(mv);
    }
    g.appendChild(cell);
  });
}

async function movePhoto(from, to) {
  const photos = (DETAIL_MODEL.photos || []).slice();
  if (to < 0 || to >= photos.length) return;
  const [moved] = photos.splice(from, 1);
  photos.splice(to, 0, moved);
  try {
    const updated = await api(`/api/v1/models/${encodeURIComponent(DETAIL_MODEL.id)}/photos/order`, {
      method: "PUT",
      body: JSON.stringify({ order: photos }),
    });
    renderPhotos(updated);
    loadList();
  } catch (e) { /* api() 已 toast */ }
}

async function deletePhoto(id, url) {
  const fn = url.split("/").pop();
  if (!confirm(`确认删除 ${fn}？`)) return;
  const updated = await api(
    `/api/v1/models/${encodeURIComponent(id)}/photos/${encodeURIComponent(fn)}`,
    { method: "DELETE" }
  );
  toast("已删除照片");
  renderPhotos(updated);
  loadList();
}

async function uploadPhotos(files) {
  UPLOAD = createSession(DETAIL_MODEL.id, files, true);
  await startDetailUpload();
}

// 详情页上传驱动：绑定按钮/状态文字，委托共享引擎执行
async function startDetailUpload() {
  const u = UPLOAD;
  const btn = $("#btn-upload");
  const status = $("#upload-status");
  btn.disabled = true;
  await runUpload(u, {
    onProgress: (p) => { status.textContent = p.text; },
    onFileComplete: (model) => {
      DETAIL_MODEL = model;
      renderPhotosKeepStatus(model);
    },
    onStateChange: (paused) => {
      u.paused = paused;
      btn.querySelector(".up-label").textContent = paused ? "继续" : "上传照片";
    },
    onDone: (s) => {
      btn.disabled = false;
      status.textContent = `完成：成功 ${s.ok}${s.fail ? "，失败 " + s.fail : ""}`;
      UPLOAD = null;
      loadList();
    },
  });
  // paused 提前返回时不走 onDone：保持按钮可用（文字已切"继续"）
  if (u.paused) {
    $("#upload-status").textContent = "已暂停（网络中断），点击上传按钮续传";
    $("#btn-upload").disabled = false;
  }
}

function renderPhotosKeepStatus(m) {
  const status = $("#upload-status").textContent;
  renderPhotos(m);
  $("#upload-status").textContent = status;
}

// ---------- 照片网格拖拽排序 ----------
// 鼠标：按下后移动超过阈值即进入拖拽。触屏：长按 500ms 进入拖拽并震动反馈，
// 长按计时期间明显移动视为滚动意图并取消。采用 Pointer Events + 事件委托，
// 网格容器在 renderPhotos 重建 innerHTML 时保持不变，故只绑定一次。

const DRAG_START_MOUSE = 6;   // 鼠标拖拽启动阈值（px）
const LONG_PRESS_MS = 500;    // 触屏长按判定（ms）
const TOUCH_SLOP = 10;        // 长按计时期间视为滚动的移动阈值（px）

let _dragBound = false;
let _suppressClick = false;

function initPhotoDrag() {
  if (_dragBound) return;
  _dragBound = true;
  const g = $("#photos-grid");
  g.addEventListener("pointerdown", onDragDown);
  // 触屏长按会触发浏览器上下文菜单，在可排序网格上拦截
  g.addEventListener("contextmenu", (e) => {
    if (g.classList.contains("drag-sortable")) e.preventDefault();
  });
  // 拖拽结束后浏览器仍会派发 click，捕获阶段拦截一次，避免误开 lightbox
  g.addEventListener("click", (e) => {
    if (_suppressClick) {
      _suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}

function onDragDown(e) {
  _suppressClick = false; // 新的按下序列，清除上次可能残留的拦截标记
  // 仅主键 / 触屏；登录态且可排序时才启用
  if (!LOGGED_IN) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const grid = $("#photos-grid");
  if (!grid.classList.contains("drag-sortable")) return;
  const cell = e.target.closest(".photo-cell");
  if (!cell || !grid.contains(cell)) return;
  // 角标按钮（删除/上下移）不作为拖拽起点
  if (e.target.closest(".photo-del, .photo-move")) return;

  const st = {
    grid, cell, id: e.pointerId, type: e.pointerType,
    startX: e.clientX, startY: e.clientY,
    active: false, longPressTimer: null, suppressClick: false,
  };

  if (st.type === "touch") {
    st.longPressTimer = setTimeout(() => beginDrag(st), LONG_PRESS_MS);
  }

  window.addEventListener("pointermove", st._move = (ev) => onDragMove(st, ev), { passive: false });
  window.addEventListener("pointerup", st._up = (ev) => endDragSession(st, ev), { passive: true });
  window.addEventListener("pointercancel", st._cancel = () => endDragSession(st, null), { passive: true });
}

function onDragMove(st, e) {
  if (st.active) {
    e.preventDefault(); // 拖拽中阻止滚动/选择
    positionGhost(st, e.clientX, e.clientY);
    reorderIfHit(st, e.clientX, e.clientY);
    autoScroll(st, e.clientY);
    return;
  }
  const dx = e.clientX - st.startX;
  const dy = e.clientY - st.startY;
  if (st.type === "mouse") {
    if (Math.hypot(dx, dy) >= DRAG_START_MOUSE) beginDrag(st);
  } else {
    // 触屏：长按计时期间明显移动 → 视为滚动，取消长按
    if (Math.abs(dy) > TOUCH_SLOP || Math.abs(dx) > TOUCH_SLOP) {
      clearTimeout(st.longPressTimer);
      st.longPressTimer = null;
    }
  }
}

function beginDrag(st) {
  st.active = true;
  st.suppressClick = true;
  if (st.type === "touch" && navigator.vibrate) navigator.vibrate(30);
  // iOS Safari 下 pointermove 的 preventDefault 不可靠，补一道 touchmove 拦截防止滚动
  if (st.type === "touch") {
    st._tmove = (ev) => { if (st.active) ev.preventDefault(); };
    window.addEventListener("touchmove", st._tmove, { passive: false });
  }
  st.grid.classList.add("dragging");
  st.cell.classList.add("drag-src");

  // 浮层 ghost：克隆当前 cell 的缩略图，固定定位跟随指针
  const r = st.cell.getBoundingClientRect();
  const ghost = st.cell.cloneNode(true);
  ghost.classList.remove("drag-src");
  ghost.classList.add("drag-ghost");
  ghost.querySelectorAll("button").forEach((b) => b.remove());
  ghost.style.width = r.width + "px";
  ghost.style.height = r.height + "px";
  document.body.appendChild(ghost);
  st.ghost = ghost;
  st.ghostW = r.width;
  st.ghostH = r.height;
  st.offX = st.startX - r.left;
  st.offY = st.startY - r.top;
  positionGhost(st, st.startX, st.startY);
}

function positionGhost(st, x, y) {
  st.ghost.style.transform = `translate(${x - st.offX}px, ${y - st.offY}px)`;
}

// 命中检测：指针需越过目标格中心（沿拖拽方向）才交换，避免边界处反复交换闪现
function reorderIfHit(st, x, y) {
  const cells = Array.from(st.grid.querySelectorAll(".photo-cell"));
  const srcIdx = cells.indexOf(st.cell);
  const sr = st.cell.getBoundingClientRect();
  for (let i = 0; i < cells.length; i++) {
    if (i === srcIdx) continue;
    const r = cells[i].getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (r.top > sr.top + 2) {
      if (y <= cy) continue;          // 下方行：越过垂直中心才交换
    } else if (r.top < sr.top - 2) {
      if (y >= cy) continue;          // 上方行
    } else {
      if (i > srcIdx ? x <= cx : x >= cx) continue; // 同行：越过水平中心
    }
    flipSwap(st, srcIdx, i, cells[i]);
    return;
  }
}

function flipSwap(st, srcIdx, tgtIdx, target) {
  const cells = Array.from(st.grid.querySelectorAll(".photo-cell"));
  // FLIP: 记录第一帧位置
  const first = new Map();
  cells.forEach((c) => first.set(c, c.getBoundingClientRect()));
  // DOM 重排：把拖拽源移到目标前/后
  if (srcIdx < tgtIdx) target.after(st.cell);
  else target.before(st.cell);
  // 播放反向位移
  const after = Array.from(st.grid.querySelectorAll(".photo-cell"));
  after.forEach((c) => {
    if (c === st.cell) return;
    const f = first.get(c);
    if (!f) return;
    const l = c.getBoundingClientRect();
    const dx = f.left - l.left;
    const dy = f.top - l.top;
    if (!dx && !dy) return;
    c.style.transition = "none";
    c.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      c.style.transition = "transform 160ms ease";
      c.style.transform = "";
    });
  });
}

let _autoScrollRaf = null;
function autoScroll(st, y) {
  const modal = $(".detail-scroll");
  if (!modal) return;
  const rect = modal.getBoundingClientRect();
  const EDGE = 48;
  let vy = 0;
  if (y < rect.top + EDGE) vy = -10;
  else if (y > rect.bottom - EDGE) vy = 10;
  if (_autoScrollRaf) { cancelAnimationFrame(_autoScrollRaf); _autoScrollRaf = null; }
  if (vy !== 0) {
    const step = () => {
      modal.scrollTop += vy;
      _autoScrollRaf = requestAnimationFrame(step);
    };
    _autoScrollRaf = requestAnimationFrame(step);
  }
}

function endDragSession(st, why) {
  const wasActive = st.active;
  st.active = false; // 先置位，阻止残留 touchmove/pointermove 继续拦截
  window.removeEventListener("pointermove", st._move);
  window.removeEventListener("pointerup", st._up);
  window.removeEventListener("pointercancel", st._cancel);
  if (st._tmove) {
    window.removeEventListener("touchmove", st._tmove);
    st._tmove = null;
  }
  if (st.longPressTimer) { clearTimeout(st.longPressTimer); st.longPressTimer = null; }
  if (_autoScrollRaf) { cancelAnimationFrame(_autoScrollRaf); _autoScrollRaf = null; }
  if (!wasActive) return; // 未真正进入拖拽，无需落库

  _suppressClick = true; // 拦截本次拖拽伴随的 click
  st.grid.classList.remove("dragging");
  st.cell.classList.remove("drag-src");
  if (st.ghost) st.ghost.remove();

  // 从 DOM 读取新顺序
  const cells = Array.from(st.grid.querySelectorAll(".photo-cell"));
  const order = cells.map((c) => c.dataset.src);
  const orig = (DETAIL_MODEL.photos || []);
  const changed = order.length === orig.length && order.some((v, i) => v !== orig[i]);
  if (changed) {
    commitOrder(order); // 成功后 renderPhotos 重建 DOM，自动清除 FLIP 内联 transform
  } else {
    // 净顺序未变：不会有重渲染，手动清除残留的 FLIP 内联样式
    cells.forEach((c) => { c.style.transition = ""; c.style.transform = ""; });
  }
}

async function commitOrder(order) {
  try {
    const updated = await api(`/api/v1/models/${encodeURIComponent(DETAIL_MODEL.id)}/photos/order`, {
      method: "PUT",
      body: JSON.stringify({ order }),
    });
    renderPhotos(updated);
    loadList();
  } catch (e) {
    renderPhotos(DETAIL_MODEL); // 失败回滚到服务端已知顺序
  }
}

// 详情模态框关闭交互（× / 点外部）
export function initDetail() {
  initPhotoDrag();
  $("#btn-detail-close").onclick = () => ovClose(closeDetail);
  $("#detail-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) ovClose(closeDetail);
  });
  $("#btn-upload").onclick = () => {
    if (UPLOAD && UPLOAD.paused) { startDetailUpload(); return; } // 续传
    $("#file-input").click();
  };
  $("#file-input").addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) uploadPhotos(files);
    e.target.value = "";
  });
}
