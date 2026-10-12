// Hangar WebUI — 列表视图：加载 / 筛选 / 卡片渲染
import { $, $$, api, esc, thumbUrl, tagBadges, gradeCell, LOGGED_IN, toast, ICON, closeHeaderMenus, displayName } from "./core.js";
import { showDetail } from "./detail.js";
import { openForm } from "./form.js";

export let VALUES = {};
export let SCALE_CACHE = [];

// 视图切换
export function showView(name) {
  $$("#view-list, #view-form").forEach((v) => v.classList.add("hidden"));
  $("#view-" + name).classList.remove("hidden");
  // 新增 FAB 只在列表视图且已登录时显示
  $("#btn-add").classList.toggle("hidden", name !== "list" || !LOGGED_IN);
}

export const closeForm = () => showView("list");

// ---------- 取值建议 ----------

export async function loadValues() {
  VALUES = await api("/api/v1/models/values");
  // 筛选下拉
  fillSelect($("#f-status"), VALUES.status, "状态：全部");
  fillSelect($("#f-category"), VALUES.category, "类别：全部");
  fillSelect($("#f-storage"), VALUES.storage, "位置：全部");
  fillSelect($("#f-grade"), VALUES.grade, "级别：全部");
  fillSelect($("#f-color"), VALUES.main_color, "颜色：全部");
  fillSelect($("#f-owner"), VALUES.owner, "归属：全部");
  fillSelect($("#f-tag"), VALUES.tag, "标签：全部");
  // 表单硬枚举
  fillSelect($('[name="category"]'), VALUES.category, null, true);
  fillSelect($('[name="status"]'), VALUES.status, null, true);
  // datalist 软枚举
  fillDatalist("dl-grade", VALUES.grade);
  fillDatalist("dl-limited", VALUES.limited);
  fillDatalist("dl-origin", VALUES.origin);
  fillDatalist("dl-color", VALUES.main_color);
  fillDatalist("dl-storage", VALUES.storage);
  fillDatalist("dl-owner", VALUES.owner);
  fillDatalist("dl-tag", VALUES.tag);
  fillDatalist("dl-scale", SCALE_CACHE);
}

function fillSelect(sel, items, placeholder, keepSelection) {
  const cur = sel.value;
  sel.innerHTML = "";
  if (placeholder) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = placeholder;
    sel.appendChild(o);
  }
  (items || []).forEach((v) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    sel.appendChild(o);
  });
  if (keepSelection) sel.value = cur;
}

export function fillDatalist(id, items) {
  const dl = document.getElementById(id);
  dl.innerHTML = "";
  (items || []).forEach((v) => {
    const o = document.createElement("option");
    o.value = v;
    dl.appendChild(o);
  });
}

// ---------- 列表 ----------

export async function loadList() {
  const params = new URLSearchParams();
  const map = {
    "#f-status": "status", "#f-storage": "storage", "#f-grade": "grade", "#f-color": "main_color",
    "#f-category": "category", "#f-owner": "owner", "#f-tag": "tag", "#f-display": "display", "#f-q": "q",
  };
  Object.entries(map).forEach(([sel, key]) => {
    const v = $(sel).value.trim();
    if (v) params.set(key, v);
  });
  const rows = await api("/api/v1/models" + (params.toString() ? "?" + params : ""));
  const tbody = $("#models-table tbody");
  tbody.innerHTML = "";
  // 收集已有比例用于 datalist
  SCALE_CACHE = Array.from(new Set(rows.map((r) => r.scale).filter(Boolean)));
  fillDatalist("dl-scale", SCALE_CACHE);

  rows.forEach((m) => {
    const tr = document.createElement("tr");
    tr.className = "clickable";
    tr.onclick = () => showDetail(m.id);
    const thumb = (m.photos && m.photos.length)
      ? `<img src="${esc(thumbUrl(m.photos[0]))}" alt="" loading="lazy" class="row-thumb">`
      : `<span class="muted">—</span>`;
    const koBadge = m.origin === "KO"
      ? `<img src="/KO.png" alt="KO" title="KO（第三方开模）" class="ko-badge" loading="lazy">` : "";
    tr.innerHTML = `
      <td class="thumb" data-label="照片">${thumb}</td>
      <td data-label="编号">${esc(m.id)}</td>
      <td class="name" data-label="名称"><span class="name-cell">${esc(displayName(m))}${koBadge}</span></td>
      <td data-label="类别">${esc(m.category)}</td>
      <td data-label="级别">${gradeCell(m.grade, m.origin)}</td>
      <td data-label="比例">${esc(m.scale || "")}</td>
      <td data-label="限定">${esc(m.limited)}</td>
      <td data-label="状态"><span class="badge st-${statusClass(m.status)}">${esc(m.status)}</span></td>
      <td data-label="存放">${esc(m.storage)}</td>
      <td data-label="归属">${esc(m.owner)}</td>
      <td data-label="完成日期">${esc(m.done_date || "")}</td>
      <td class="tags-cell" data-label="标签">${tagBadges(m.tags)}</td>
      <td class="ops" data-label=""></td>`;
    const ops = tr.querySelector(".ops");
    if (LOGGED_IN) {
      ops.append(
        iconBtn("编辑", ICON.edit, (e) => { e.stopPropagation(); openForm(m); }),
        iconBtn("删除", ICON.trash, (e) => { e.stopPropagation(); removeModel(m); })
      );
    }
    // 移动端卡片：隐藏无值的字段行（照片/操作列除外；logo 是 img 无文字，按有值处理）
    tr.querySelectorAll("td[data-label]").forEach((td) => {
      if (td.classList.contains("thumb")) return;
      if (!td.textContent.trim() && !td.querySelector("img")) {
        td.classList.add("empty");
      }
    });
    tbody.appendChild(tr);
  });
  $("#list-empty").classList.toggle("hidden", rows.length > 0);
  $("#models-table").classList.toggle("hidden", rows.length === 0);
  updateCustomScrollbar();
}

// ---------- 自定义纵向滚动条 ----------
// 原生纵向条已隐藏（width:0），用覆盖层滑块实现：行程从表头下方开始，
// 不侵入表头；移动端表格不内部滚动时自动隐藏。

let _vsBound = false;

export function initCustomScrollbar() {
  if (_vsBound) return;
  _vsBound = true;
  const wrap = $(".table-wrap");
  const thumb = $("#vscroll-thumb");
  wrap.addEventListener("scroll", updateCustomScrollbar, { passive: true });
  window.addEventListener("resize", updateCustomScrollbar);
  let drag = null;
  thumb.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    thumb.setPointerCapture(e.pointerId);
    thumb.classList.add("dragging");
    drag = { y: e.clientY, top: wrap.scrollTop };
  });
  thumb.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const geo = _vsGeo();
    if (!geo) return;
    const travel = geo.trackH - geo.thumbH;
    if (travel <= 0) return;
    const ratio = travel / (geo.scrollH - geo.clientH);
    wrap.scrollTop = drag.top + (e.clientY - drag.y) / ratio;
  });
  const endDrag = () => { drag = null; thumb.classList.remove("dragging"); };
  thumb.addEventListener("pointerup", endDrag);
  thumb.addEventListener("pointercancel", endDrag);
}

function _vsGeo() {
  const wrap = $(".table-wrap");
  const clientH = wrap.clientHeight;
  const scrollH = wrap.scrollHeight;
  if (scrollH <= clientH + 1) return null; // 无纵向溢出，不显示
  const thead = $("#models-table thead");
  const theadH = thead ? thead.offsetHeight : 0;
  const trackH = Math.max(40, clientH - theadH);
  const thumbH = Math.max(30, (clientH / scrollH) * trackH);
  return { clientH, scrollH, theadH, trackH, thumbH };
}

export function updateCustomScrollbar() {
  const bar = $("#vscroll");
  const thumb = $("#vscroll-thumb");
  const wrap = $(".table-wrap");
  const geo = _vsGeo();
  if (!geo) {
    bar.classList.remove("active");
    return;
  }
  bar.classList.add("active");
  // 底部避开横向滚动条占位
  const hbar = wrap.offsetHeight - wrap.clientHeight - 2; // 减上下边框
  bar.style.bottom = Math.max(0, hbar) + "px";
  bar.style.top = geo.theadH + "px";
  bar.style.height = geo.trackH + "px";
  const travel = geo.trackH - geo.thumbH;
  const max = geo.scrollH - geo.clientH;
  const pos = max > 0 ? (wrap.scrollTop / max) * travel : 0;
  thumb.style.height = geo.thumbH + "px";
  thumb.style.top = pos + "px";
}

function statusClass(s) {
  if (s === "成品" || s === "最终完工") return "done";
  if (s === "制作中") return "wip";
  if (s === "未开封" || s === "未拼装") return "todo";
  return "mid";
}

export async function removeModel(m) {
  if (!confirm(`确认删除 ${m.id} ${m.name}？`)) return;
  await api("/api/v1/models/" + encodeURIComponent(m.id), { method: "DELETE" });
  toast("已删除 " + m.id);
  loadList();
}

function iconBtn(title, svg, fn) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "op-icon";
  b.title = title;
  b.innerHTML = svg;
  b.onclick = fn;
  return b;
}

// ---------- 筛选菜单（header 下拉） ----------

const FILTER_SELECTORS = ["#f-status", "#f-storage", "#f-grade", "#f-color", "#f-category", "#f-owner", "#f-tag", "#f-display"];

export function activeFilterCount() {
  return FILTER_SELECTORS.filter((s) => $(s).value).length;
}

export function updateFilterCount() {
  const n = activeFilterCount();
  const c = $("#filter-count");
  c.textContent = n;
  c.classList.toggle("hidden", n === 0);
}

export function initFilterDrawer() {
  const menu = $("#filter-menu");
  $("#btn-filter").onclick = (e) => {
    e.stopPropagation();
    closeHeaderMenus("#filter-menu");
    menu.classList.toggle("hidden");
  };
  // 选完收起：任一 select 变更即生效并关菜单
  FILTER_SELECTORS.forEach((s) => $(s).addEventListener("change", () => {
    updateFilterCount();
    menu.classList.add("hidden");
    loadList();
  }));
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#filter-picker")) menu.classList.add("hidden");
  });
  updateFilterCount();
}
