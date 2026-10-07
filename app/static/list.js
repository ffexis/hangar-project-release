// Hangar WebUI — 列表视图：加载 / 筛选 / 卡片渲染
import { $, $$, api, esc, thumbUrl, tagBadges, gradeCell, LOGGED_IN, toast } from "./core.js";
import { showDetail } from "./detail.js";
import { openForm } from "./form.js";

export let VALUES = {};
export let SCALE_CACHE = [];

// 视图切换
export function showView(name) {
  $$("#view-list, #view-form").forEach((v) => v.classList.add("hidden"));
  $("#view-" + name).classList.remove("hidden");
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
  fillSelect($("#f-owner"), VALUES.owner, "归属：全部");
  fillSelect($("#f-tag"), VALUES.tag, "标签：全部");
  // 表单硬枚举
  fillSelect($('[name="category"]'), VALUES.category, null, true);
  fillSelect($('[name="status"]'), VALUES.status, null, true);
  // datalist 软枚举
  fillDatalist("dl-grade", VALUES.grade);
  fillDatalist("dl-limited", VALUES.limited);
  fillDatalist("dl-origin", VALUES.origin);
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
    "#f-status": "status", "#f-storage": "storage", "#f-grade": "grade",
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
    tr.innerHTML = `
      <td class="thumb" data-label="照片">${thumb}</td>
      <td data-label="编号">${esc(m.id)}</td>
      <td class="name" data-label="名称">${esc(m.name)}</td>
      <td data-label="类别">${esc(m.category)}</td>
      <td data-label="级别">${gradeCell(m.grade)}</td>
      <td data-label="比例">${esc(m.scale || "")}</td>
      <td data-label="限定">${esc(m.limited)}</td>
      <td data-label="来源">${esc(m.origin)}</td>
      <td data-label="状态"><span class="badge st-${statusClass(m.status)}">${esc(m.status)}</span></td>
      <td data-label="存放">${esc(m.storage)}</td>
      <td data-label="展示">${m.display ? "✅" : "—"}</td>
      <td data-label="归属">${esc(m.owner)}</td>
      <td data-label="完成日期">${esc(m.done_date || "")}</td>
      <td class="tags-cell" data-label="标签">${tagBadges(m.tags)}</td>
      <td class="ops" data-label=""></td>`;
    const ops = tr.querySelector(".ops");
    if (LOGGED_IN) {
      ops.append(
        linkBtn("编辑", (e) => { e.stopPropagation(); openForm(m); }),
        linkBtn("删除", (e) => { e.stopPropagation(); removeModel(m); })
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

function linkBtn(text, fn) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "link";
  b.textContent = text;
  b.onclick = fn;
  return b;
}

// ---------- 筛选抽屉（移动端） ----------

export function activeFilterCount() {
  return ["#f-status", "#f-storage", "#f-grade", "#f-category", "#f-owner", "#f-tag", "#f-display"]
    .filter((s) => $(s).value).length;
}

export function updateFilterCount() {
  const n = activeFilterCount();
  const c = $("#filter-count");
  c.textContent = n;
  c.classList.toggle("hidden", n === 0);
}

export function initFilterDrawer() {
  $("#btn-filter").onclick = () => $("#filters").classList.toggle("open");
  ["#f-status", "#f-storage", "#f-grade", "#f-category", "#f-owner", "#f-tag", "#f-display"]
    .forEach((s) => $(s).addEventListener("change", updateFilterCount));
  updateFilterCount();
}
