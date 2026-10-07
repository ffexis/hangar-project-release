// Hangar WebUI — 原生 JS
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const KEY_STORAGE = "hangar_api_key";
const THEME_STORAGE = "hangar_theme";
let VALUES = {};
let EDITING = null;      // 正在编辑的记录 id
let SCALE_CACHE = [];
let LOGGED_IN = false;
let FORM_TAGS = [];

const FIELD_LABELS = {
  id: "编号", name: "名称", category: "类别", grade: "级别", item_no: "官方货号",
  scale: "比例", limited: "限定类型", origin: "来源", status: "状态",
  storage: "存放位置", display: "展示", owner: "归属", purchase_date: "购买日期",
  done_date: "完成日期",
  updated_at: "更新时间", comment: "评价 / 备注", photos: "照片", tags: "标签",
};

// ---------- 标签徽章 ----------
// 按 tag 文本哈希固定分配颜色，同名 tag 颜色恒定。

const TAG_COLOR_COUNT = 8;

function tagColorIndex(t) {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return h % TAG_COLOR_COUNT;
}

function tagBadges(tags) {
  if (!tags || !tags.length) return "";
  return (
    `<span class="tags-wrap">` +
    tags.map((t) => `<span class="tag tag-c${tagColorIndex(t)}">${esc(t)}</span>`).join("") +
    `</span>`
  );
}

// ---------- 级别 logo ----------
// key = 级别名大写去符号后的规范化串；RE/100→RE100，PG 与 PG Unleashed 共用 PG logo。
// 无对应 logo 的级别（如 MEGASIZE、用户自定义）显示文字。

const GRADE_LOGO_FILES = {
  PG: "PG", PGUNLEASHED: "PG",
  MG: "MG", MGEX: "MGEX", MGSD: "MGSD",
  RG: "RG", HG: "HG", EG: "EG", FM: "FM",
  RE100: "RE100", SDCS: "SDCS", SDEX: "SDEX",
};

function gradeLogoUrl(grade) {
  if (!grade) return null;
  const key = String(grade).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const file = GRADE_LOGO_FILES[key];
  return file ? `/logo/${file}.png` : null;
}

function gradeCell(grade) {
  if (!grade) return "";
  const url = gradeLogoUrl(grade);
  return url
    ? `<img class="grade-logo" src="${url}" alt="${esc(grade)}" title="${esc(grade)}" loading="lazy">`
    : esc(grade);
}

// ---------- 主题 ----------

const mql = matchMedia("(prefers-color-scheme: dark)");

function currentThemeMode() {
  return localStorage.getItem(THEME_STORAGE) || "system";
}

function applyTheme() {
  const mode = currentThemeMode();
  const dark = mode === "dark" || (mode === "system" && mql.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $$("#theme-menu button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode));
}

function initTheme() {
  applyTheme();
  mql.addEventListener("change", () => {
    if (currentThemeMode() === "system") applyTheme();
  });
  const menu = $("#theme-menu");
  $("#theme-trigger").onclick = (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  };
  menu.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (!btn) return;
    localStorage.setItem(THEME_STORAGE, btn.dataset.mode);
    applyTheme();
    menu.classList.add("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#theme-picker")) menu.classList.add("hidden");
  });
}

// ---------- 基础请求 ----------

function apiKey() {
  return localStorage.getItem(KEY_STORAGE) || "";
}

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  const key = apiKey();
  if (key) headers["X-API-Key"] = key;
  if (opts.body && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    setLoggedIn(false);
    toast("需要登录（API Key 无效）", true);
    openLoginModal();
    throw new Error("401");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      if (j.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch (e) { /* ignore */ }
    toast("请求失败：" + msg, true);
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

function toast(msg, isError) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

// ---------- 登录状态 ----------

function setLoggedIn(v) {
  LOGGED_IN = v;
  renderAuthState();
  renderReadonly();
}

function renderAuthState() {
  const box = $("#auth-state");
  box.innerHTML = "";
  if (LOGGED_IN) {
    const chip = document.createElement("span");
    chip.className = "auth-chip";
    chip.textContent = "已登录";
    box.appendChild(chip);
  } else {
    const b = document.createElement("button");
    b.id = "btn-login";
    b.className = "btn-sm";
    b.textContent = "登录";
    b.onclick = openLoginModal;
    box.appendChild(b);
  }
}

function renderReadonly() {
  $("#btn-add").classList.toggle("hidden", !LOGGED_IN);
  $("#readonly-hint").classList.toggle("hidden", LOGGED_IN);
}

function openLoginModal() {
  $("#modal-mask").classList.remove("hidden");
  $("#login-error").classList.add("hidden");
  $("#login-token").value = "";
  $("#login-token").focus();
  ovOpen(closeLoginModal);
}

function closeLoginModal() {
  $("#modal-mask").classList.add("hidden");
}

async function doLogin() {
  const token = $("#login-token").value.trim();
  if (!token) return;
  const res = await fetch("/api/v1/auth/check", { headers: { "X-API-Key": token } });
  if (res.ok) {
    localStorage.setItem(KEY_STORAGE, token);
    setLoggedIn(true);
    ovClose(closeLoginModal);
    toast("登录成功");
    refreshAll();
  } else {
    $("#login-error").textContent = "Token 无效，请重试";
    $("#login-error").classList.remove("hidden");
  }
}

async function checkAuthOnLoad() {
  if (!apiKey()) {
    setLoggedIn(false);
    return;
  }
  try {
    const res = await fetch("/api/v1/auth/check", { headers: { "X-API-Key": apiKey() } });
    setLoggedIn(res.ok);
  } catch (e) {
    setLoggedIn(false);
  }
}

// ---------- 视图切换 ----------

function showView(name) {
  $$("#view-list, #view-form").forEach((v) => v.classList.add("hidden"));
  $("#view-" + name).classList.remove("hidden");
}

// ---------- 系统返回劫持（浮层栈 + pushState 哨兵） ----------
// 每打开一个浮层/视图压入一条 history 记录；浏览器返回（含移动端手势）
// 触发 popstate 时逐层关闭，而不是退出页面。

const ovStack = [];
let ovGuard = 0;

function ovOpen(close) {
  ovStack.push(close);
  history.pushState({ hangarOv: ovStack.length }, "");
}

// 手动关闭（× / 点外部 / Esc / 按钮）：关浮层并移除自己的哨兵记录
function ovClose(close) {
  const i = ovStack.indexOf(close);
  if (i !== -1) {
    ovStack.splice(i, 1);
    ovGuard++;
    history.back();
  }
  close();
}

window.addEventListener("popstate", () => {
  if (ovGuard > 0) { ovGuard--; return; }   // 自己 back() 引发的，忽略
  const close = ovStack.pop();              // 系统返回：关最上层
  if (close) close();
});

const closeForm = () => showView("list");

// ---------- 取值建议 ----------

async function loadValues() {
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

function fillDatalist(id, items) {
  const dl = document.getElementById(id);
  dl.innerHTML = "";
  (items || []).forEach((v) => {
    const o = document.createElement("option");
    o.value = v;
    dl.appendChild(o);
  });
}

// ---------- 列表 ----------

async function loadList() {
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
      ? `<img src="${esc(m.photos[0])}" alt="" loading="lazy" class="row-thumb">`
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

function linkBtn(text, fn) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "link";
  b.textContent = text;
  b.onclick = fn;
  return b;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function removeModel(m) {
  if (!confirm(`确认删除 ${m.id} ${m.name}？`)) return;
  await api("/api/v1/models/" + encodeURIComponent(m.id), { method: "DELETE" });
  toast("已删除 " + m.id);
  loadList();
}

// ---------- 表单 ----------

function openForm(m) {
  if (!LOGGED_IN) { openLoginModal(); return; }
  EDITING = m ? m.id : null;
  $("#form-title").textContent = m ? `编辑 ${m.id}` : "新增模型";
  const f = $("#model-form");
  f.reset();
  $("#form-photos").value = "";
  renderFormPreview();
  if (m) {
    f.id.value = m.id;
    f.id.disabled = !!m;
    FORM_TAGS = (m.tags || []).slice(0, 3);
    f.name.value = m.name || "";
    f.category.value = m.category || "";
    f.grade.value = m.grade || "";
    f.item_no.value = m.item_no || "";
    f.scale.value = m.scale || "";
    f.limited.value = m.limited || "";
    f.origin.value = m.origin || "";
    f.status.value = m.status || "";
    f.storage.value = m.storage || "";
    f.owner.value = m.owner || "主人";
    f.purchase_date.value = m.purchase_date || "";
    f.done_date.value = m.done_date || "";
    f.display.checked = !!m.display;
    f.comment.value = m.comment || "";
  } else {
    f.id.disabled = false;
    FORM_TAGS = [];
    f.owner.value = "主人";
    f.category.value = "GUNPLA";
    f.status.value = "未开封";
  }
  renderTagChips();
  showView("form");
  ovOpen(closeForm);
}

// ---------- 表单标签编辑器 ----------

function renderTagChips() {
  const box = $("#tag-input");
  box.querySelectorAll(".tag-chip").forEach((c) => c.remove());
  const input = $("#tag-text");
  FORM_TAGS.forEach((t, i) => {
    const chip = document.createElement("span");
    chip.className = `tag tag-c${tagColorIndex(t)} tag-chip`;
    chip.innerHTML = `${esc(t)}<button type="button" class="tag-x" aria-label="移除">×</button>`;
    chip.querySelector(".tag-x").onclick = () => {
      FORM_TAGS.splice(i, 1);
      renderTagChips();
    };
    box.insertBefore(chip, input);
  });
  input.style.display = FORM_TAGS.length >= 3 ? "none" : "";
  if (FORM_TAGS.length >= 3) input.value = "";
}

function addFormTag(raw) {
  const t = String(raw).trim().slice(0, 32);
  if (!t) return;
  if (FORM_TAGS.length >= 3) { toast("最多 3 个标签", true); return; }
  if (FORM_TAGS.includes(t)) { toast("标签已存在", true); return; }
  FORM_TAGS.push(t);
  $("#tag-text").value = "";
  renderTagChips();
}

function renderFormPreview() {
  const files = Array.from($("#form-photos").files || []);
  const box = $("#form-photo-preview");
  box.innerHTML = "";
  box.classList.toggle("hidden", files.length === 0);
  files.forEach((file) => {
    const cell = document.createElement("div");
    cell.className = "pv-cell";
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(img.src);
    cell.appendChild(img);
    const cap = document.createElement("span");
    cap.className = "pv-name";
    cap.textContent = file.name;
    cell.appendChild(cap);
    box.appendChild(cell);
  });
}

async function submitForm(e) {
  e.preventDefault();
  const f = $("#model-form");
  const pending = Array.from($("#form-photos").files || []);
  // 输入框里有未确认的文字，视为要添加的标签
  const typed = $("#tag-text").value.trim();
  if (typed && FORM_TAGS.length < 3 && !FORM_TAGS.includes(typed)) FORM_TAGS.push(typed);
  const body = {
    name: f.name.value.trim(),
    category: f.category.value,
    grade: f.grade.value.trim() || null,
    item_no: f.item_no.value.trim() || null,
    scale: f.scale.value.trim() || null,
    limited: f.limited.value.trim(),
    origin: f.origin.value.trim(),
    status: f.status.value,
    storage: f.storage.value.trim(),
    display: f.display.checked,
    owner: f.owner.value.trim() || "主人",
    purchase_date: f.purchase_date.value || null,
    done_date: f.done_date.value || null,
    comment: f.comment.value.trim() || null,
    tags: FORM_TAGS,
  };
  const idVal = f.id.value.trim();
  let targetId;
  if (EDITING) {
    await api("/api/v1/models/" + encodeURIComponent(EDITING), {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    targetId = EDITING;
    toast("已更新 " + EDITING);
  } else {
    if (idVal) body.id = idVal;
    const created = await api("/api/v1/models", {
      method: "POST",
      body: JSON.stringify(body),
    });
    targetId = created.id;
    toast("已新增 " + created.id);
  }
  // 保存成功后再上传待传照片（取消则不会走到这里，天然无副作用）
  if (pending.length) {
    let ok = 0, fail = 0;
    for (const file of pending) {
      const fd = new FormData();
      fd.append("file", file);
      try {
        await api(`/api/v1/models/${encodeURIComponent(targetId)}/photos`, {
          method: "POST",
          body: fd,
        });
        ok++;
      } catch (err) {
        fail++;
      }
    }
    if (fail) toast(`照片：成功 ${ok}，失败 ${fail}`, true);
    else toast(`已上传 ${ok} 张照片`);
  }
  await loadValues();
  await loadList();
  ovClose(closeForm);
}

// ---------- 日期输入（YYYY-MM-DD 自动格式化 + 输满跳下一个字段） ----------

function initDateInputs() {
  $$("#model-form .date-text").forEach((inp) => {
    inp.addEventListener("input", () => {
      const digits = inp.value.replace(/\D/g, "").slice(0, 8);
      let out = digits.slice(0, 4);
      if (digits.length > 4) out += "-" + digits.slice(4, 6);
      if (digits.length > 6) out += "-" + digits.slice(6, 8);
      inp.value = out;
      if (digits.length === 8) focusNextField(inp);
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); focusNextField(inp); }
    });
  });
}

function focusNextField(inp) {
  const fields = Array.from($$("#model-form input, #model-form select, #model-form textarea"))
    .filter((el) => !el.disabled && el.type !== "hidden" && el.type !== "file");
  const i = fields.indexOf(inp);
  if (i >= 0 && i < fields.length - 1) {
    fields[i + 1].focus();
    if (fields[i + 1].select) { try { fields[i + 1].select(); } catch (e) { /* noop */ } }
  }
}

// ---------- 详情 ----------

let DETAIL_MODEL = null;

async function showDetail(id) {
  const m = await api("/api/v1/models/" + encodeURIComponent(id));
  DETAIL_MODEL = m;
  $("#detail-title").textContent = m.name;
  const box = $("#detail-body");
  box.innerHTML = "";
  Object.keys(FIELD_LABELS).forEach((k) => {
    if (k === "photos") return;
    const row = document.createElement("div");
    row.className = "drow";
    let v = m[k];
    if (k === "display") v = m.display ? "展示中" : "未展示";
    let html;
    if (k === "grade") html = gradeCell(v);
    else if (k === "tags") html = tagBadges(v);
    else html = esc(v == null ? "" : v);
    row.innerHTML = `<span class="dk">${FIELD_LABELS[k]}</span><span class="dv">${html}</span>`;
    box.appendChild(row);
  });
  renderPhotos(m);
  $("#detail-modal").classList.remove("hidden");
  document.body.classList.add("modal-open");
  ovOpen(closeDetail);
}

function closeDetail() {
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
  photos.forEach((p) => {
    const cell = document.createElement("div");
    cell.className = "photo-cell";
    const img = document.createElement("img");
    img.src = p;
    img.alt = m.name;
    img.loading = "lazy";
    img.onclick = () => openLightbox(p, photos);
    cell.appendChild(img);
    if (LOGGED_IN) {
      const del = document.createElement("button");
      del.className = "photo-del";
      del.textContent = "×";
      del.title = "删除这张";
      del.onclick = () => deletePhoto(m.id, p);
      cell.appendChild(del);
    }
    g.appendChild(cell);
  });
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
  const id = DETAIL_MODEL.id;
  const btn = $("#btn-upload");
  const status = $("#upload-status");
  btn.disabled = true;
  let ok = 0, fail = 0;
  for (let i = 0; i < files.length; i++) {
    status.textContent = `上传中 ${i + 1}/${files.length}…`;
    const fd = new FormData();
    fd.append("file", files[i]);
    try {
      const updated = await api(`/api/v1/models/${encodeURIComponent(id)}/photos`, {
        method: "POST",
        body: fd,
      });
      DETAIL_MODEL = updated;
      renderPhotosKeepStatus(updated);
      ok++;
    } catch (e) {
      fail++;
    }
  }
  btn.disabled = false;
  status.textContent = `完成：成功 ${ok}${fail ? "，失败 " + fail : ""}`;
  loadList();
}

function renderPhotosKeepStatus(m) {
  const status = $("#upload-status").textContent;
  renderPhotos(m);
  $("#upload-status").textContent = status;
}

// ---------- Lightbox（翻页 + EXIF） ----------

let LB_LIST = [];
let LB_INDEX = 0;
let lbSeq = 0;

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

function openLightbox(src, list) {
  LB_LIST = list && list.length ? list : [src];
  LB_INDEX = Math.max(0, LB_LIST.indexOf(src));
  $("#lightbox").classList.remove("hidden");
  showLbPhoto();
  ovOpen(closeLightbox);
}

function showLbPhoto() {
  const src = LB_LIST[LB_INDEX];
  $("#lightbox-img").src = src;
  const multi = LB_LIST.length > 1;
  $("#lb-prev").classList.toggle("hidden", !multi);
  $("#lb-next").classList.toggle("hidden", !multi);
  const info = $("#lb-info");
  info.innerHTML = "";
  const seq = ++lbSeq;
  const counter = multi ? `${LB_INDEX + 1} / ${LB_LIST.length}` : "";
  if (!isLocalPhoto(src)) {
    info.textContent = counter ? `${counter}（外部链接）` : "外部链接";
    return;
  }
  const fn = src.split("/").pop();
  const id = DETAIL_MODEL ? DETAIL_MODEL.id : fn.split("_")[0];
  info.textContent = counter || "读取 EXIF…";
  fetch(`/api/v1/models/${encodeURIComponent(id)}/photos/${encodeURIComponent(fn)}/meta`)
    .then((r) => r.ok ? r.json() : null)
    .then((m) => {
      if (seq !== lbSeq) return;
      info.innerHTML = "";
      const add = (label, value, href) => {
        const s = document.createElement("span");
        s.className = "lb-item";
        if (href) {
          const a = document.createElement("a");
          a.href = href;
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = `${label}${value}`;
          s.appendChild(a);
        } else {
          s.textContent = `${label}${value}`;
        }
        info.appendChild(s);
      };
      if (counter) add("", counter);
      if (!m) {
        add("", "EXIF 读取失败");
        return;
      }
      const date = fmtTaken(m.taken_at);
      if (date) add("", date);
      if (m.device) add("", m.device);
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
          const mapUrl = `https://uri.amap.com/marker?position=${m.map.lng},${m.map.lat}`;
          add("位置 ", m.address || coord, m.address ? mapUrl : null);
          if (m.address) add("", "在地图查看", mapUrl);
          else add("坐标 ", coord, mapUrl);
        } else {
          add("坐标 ", coord);
        }
      }
      // 完全无 EXIF 且无翻页计数时不显示任何内容
    })
    .catch(() => {
      if (seq !== lbSeq) return;
      info.textContent = "EXIF 读取失败";
    });
}

function lbStep(d) {
  if (LB_LIST.length < 2) return;
  LB_INDEX = (LB_INDEX + d + LB_LIST.length) % LB_LIST.length;
  showLbPhoto();
}

function closeLightbox() {
  lbSeq++;
  $("#lightbox").classList.add("hidden");
}

// lightbox 左右滑动手势（触屏翻页）
(function () {
  let x0 = null, y0 = null;
  const lb = () => $("#lightbox");
  document.addEventListener("touchstart", (e) => {
    if (lb().classList.contains("hidden")) return;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (lb().classList.contains("hidden") || x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = y0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      lbStep(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
})();

// ---------- 筛选抽屉（移动端） ----------

function activeFilterCount() {
  return ["#f-status", "#f-storage", "#f-grade", "#f-category", "#f-owner", "#f-tag", "#f-display"]
    .filter((s) => $(s).value).length;
}

function updateFilterCount() {
  const n = activeFilterCount();
  const c = $("#filter-count");
  c.textContent = n;
  c.classList.toggle("hidden", n === 0);
}

function initFilterDrawer() {
  $("#btn-filter").onclick = () => $("#filters").classList.toggle("open");
  ["#f-status", "#f-storage", "#f-grade", "#f-category", "#f-owner", "#f-tag", "#f-display"]
    .forEach((s) => $(s).addEventListener("change", updateFilterCount));
  updateFilterCount();
}

// ---------- 初始化 ----------

async function init() {
  // 未初始化则跳转 setup 页（静态资源已在 setup 放行，此处兜底已加载的列表页）
  try {
    const r = await fetch("/api/v1/status");
    const j = await r.json();
    if (!j.initialized) { location.replace("/setup"); return; }
  } catch (e) { /* 状态查询失败不阻断，交由后续请求的 403 处理 */ }

  initTheme();
  renderAuthState();
  renderReadonly();

  $("#btn-login-cancel").onclick = () => ovClose(closeLoginModal);
  $("#btn-login-submit").onclick = doLogin;
  $("#login-token").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
  $("#modal-mask").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) ovClose(closeLoginModal);
  });

  $("#btn-refresh").onclick = refreshAll;
  $("#btn-add").onclick = () => openForm(null);
  $("#btn-cancel").onclick = () => ovClose(closeForm);
  $("#model-form").addEventListener("submit", submitForm);
  initDateInputs();
  $("#form-photos").addEventListener("change", renderFormPreview);
  $("#tag-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFormTag(e.target.value);
    } else if (e.key === "Backspace" && !e.target.value && FORM_TAGS.length) {
      FORM_TAGS.pop();
      renderTagChips();
    }
  });
  $("#tag-text").addEventListener("change", (e) => {
    if (e.target.value.trim()) addFormTag(e.target.value);
  });
  ["#f-status", "#f-storage", "#f-grade", "#f-category", "#f-owner", "#f-tag", "#f-display"].forEach(
    (s) => ($(s).onchange = loadList)
  );
  let qt;
  $("#f-q").addEventListener("input", () => {
    clearTimeout(qt);
    qt = setTimeout(loadList, 300);
  });

  // 照片上传 / lightbox
  $("#btn-upload").onclick = () => $("#file-input").click();
  $("#file-input").addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) uploadPhotos(files);
    e.target.value = "";
  });
  $("#lightbox").addEventListener("click", (e) => {
    if (e.target === e.currentTarget || e.target.id === "lightbox-img") ovClose(closeLightbox);
  });
  $("#lb-prev").onclick = (e) => { e.stopPropagation(); lbStep(-1); };
  $("#lb-next").onclick = (e) => { e.stopPropagation(); lbStep(1); };
  $("#lb-info").addEventListener("click", (e) => e.stopPropagation());

  // 详情模态框：× / 点外部关闭
  $("#btn-detail-close").onclick = () => ovClose(closeDetail);
  $("#detail-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) ovClose(closeDetail);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#lightbox").classList.contains("hidden")) { ovClose(closeLightbox); return; }
    if (!$("#detail-modal").classList.contains("hidden")) { ovClose(closeDetail); return; }
    if (!$("#modal-mask").classList.contains("hidden")) ovClose(closeLoginModal);
  });
  document.addEventListener("keydown", (e) => {
    if ($("#lightbox").classList.contains("hidden")) return;
    if (e.key === "ArrowLeft") lbStep(-1);
    else if (e.key === "ArrowRight") lbStep(1);
  });

  await checkAuthOnLoad();
  await refreshAll();
  initFilterDrawer();
}

async function refreshAll() {
  try {
    await loadValues();
    await loadList();
    updateFilterCount();
  } catch (e) {
    /* toast 已提示 */
  }
}

init();
