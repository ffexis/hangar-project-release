// Hangar WebUI — 共享核心：DOM 助手 / 请求 / 主题 / 登录 / 浮层栈 / 通用渲染
export const $ = (s) => document.querySelector(s);
export const $$ = (s) => Array.from(document.querySelectorAll(s));

// 内联 SVG 图标（boxicons 24×24，fill=currentColor 自动跟随主题色）
export const ICON = {
  edit: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M5 21h14c1.1 0 2-.9 2-2v-7h-2v7H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2" /><path fill="currentColor" d="M7 13v3c0 .55.45 1 1 1h3c.27 0 .52-.11.71-.29l9-9a.996.996 0 0 0 0-1.41l-3-3a.996.996 0 0 0-1.41 0l-9.01 8.99A1 1 0 0 0 7 13m10-7.59L18.59 7L17.5 8.09L15.91 6.5zm-8 8l5.5-5.5l1.59 1.59l-5.5 5.5H9z" /></svg>',
  trash: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M17 6V4c0-1.1-.9-2-2-2H9c-1.1 0-2 .9-2 2v2H2v2h2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8h2V6zM9 4h6v2H9zM6 20V8h12v12z" /><path fill="currentColor" d="M9 10h2v8H9zm4 0h2v8h-2z" /></svg>',
};

// header 下拉菜单互斥：同一时刻最多开一个
const HEADER_MENUS = ["#filter-menu", "#search-menu", "#io-menu", "#theme-menu"];
export function closeHeaderMenus(except) {
  HEADER_MENUS.forEach((s) => {
    if (s !== except) $(s).classList.add("hidden");
  });
}

export const KEY_STORAGE = "hangar_api_key";
export const THEME_STORAGE = "hangar_theme";
export let LOGGED_IN = false;

// ---------- 基础请求 ----------

export function apiKey() {
  return localStorage.getItem(KEY_STORAGE) || "";
}

export async function api(path, opts = {}) {
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

export function toast(msg, isError) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 列表/网格小图走后端懒生成缩略图；大图 lightbox 仍用原图。
// ?v= 用于 bust 客户端 immutable 缓存：缩略图生成逻辑变更时递增。
export function thumbUrl(p) {
  return p && p.startsWith("/photos/") ? "/thumbs/" + p.slice("/photos/".length) + "?v=2" : p;
}

// uuid v4：crypto.randomUUID 仅安全上下文（HTTPS/localhost）可用，
// 内网 HTTP 部署下是 undefined，必须用 getRandomValues 兜底。
export function uuidv4() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------- 标签徽章 ----------
// 按 tag 文本哈希固定分配颜色，同名 tag 颜色恒定。

export const TAG_COLOR_COUNT = 8;

export function tagColorIndex(t) {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return h % TAG_COLOR_COUNT;
}

export function tagBadges(tags) {
  if (!tags || !tags.length) return "";
  return (
    `<span class="tags-wrap">` +
    tags.map((t) => `<span class="tag tag-c${tagColorIndex(t)}">${esc(t)}</span>`).join("") +
    `</span>`
  );
}

// ---------- 级别 logo ----------
// key = 级别名大写去符号后的规范化串；RE/100→RE100，PG 与 PG Unleashed 共用 PG logo。
// 值含扩展名（MEGASIZE / MGEX 为 webp，其余 png）。无对应 logo 的级别（用户自定义等）显示文字。

export const GRADE_LOGO_FILES = {
  PG: "PG.png", PGUNLEASHED: "PG.png",
  MG: "MG.png", MGEX: "MGEX.webp", MGSD: "MGSD.png",
  RG: "RG.png", HG: "HG.png", EG: "EG.png", FM: "FM.png",
  RE100: "RE100.png", SDCS: "SDCS.png", SDEX: "SDEX.png",
  MEGASIZE: "MEGA.webp",
};

export function gradeLogoUrl(grade) {
  if (!grade) return null;
  const key = String(grade).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const file = GRADE_LOGO_FILES[key];
  return file ? `/logo/${file}` : null;
}

// 深色主题下黑字 logo 对比度不足，垫浅色底板（主人实测：仅 PG 与 HG 需要）
const GRADE_LOGO_PLATE = new Set(["PG", "PGUNLEASHED", "HG"]);

export function gradeCell(grade, origin) {
  if (!grade) return "";
  const url = gradeLogoUrl(grade);
  const ko = origin === "KO";
  if (!url) return esc(grade);
  const key = String(grade).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const plate = GRADE_LOGO_PLATE.has(key) && !ko ? " grade-logo-plate" : "";
  const gray = ko ? " grade-ko" : "";
  return `<img class="grade-logo${plate}${gray}" src="${url}" alt="${esc(grade)}" title="${esc(grade)}" loading="lazy">`;
}

// 列表/详情统一用"机设番号 名称"作为展示名（番号可选，空则只显示名称）
export function displayName(m) {
  const d = (m.designation || "").trim();
  return d ? `${d} ${m.name}` : m.name;
}

// ---------- 主题 ----------

export const mql = matchMedia("(prefers-color-scheme: dark)");

export function currentThemeMode() {
  return localStorage.getItem(THEME_STORAGE) || "system";
}

export function applyTheme() {
  const mode = currentThemeMode();
  const dark = mode === "dark" || (mode === "system" && mql.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $$("#theme-menu button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode));
}

export function initTheme() {
  applyTheme();
  mql.addEventListener("change", () => {
    if (currentThemeMode() === "system") applyTheme();
  });
  const menu = $("#theme-menu");
  $("#theme-trigger").onclick = (e) => {
    e.stopPropagation();
    // trigger 的 click 已 stopPropagation，需手动收起其他 header 菜单
    closeHeaderMenus("#theme-menu");
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

// ---------- 登录状态 ----------

export function setLoggedIn(v) {
  LOGGED_IN = v;
  renderAuthState();
  renderReadonly();
}

export function renderAuthState() {
  const box = $("#auth-state");
  box.innerHTML = "";
  if (LOGGED_IN) {
    const chip = document.createElement("span");
    chip.className = "auth-chip";
    chip.textContent = "已登录";
    box.appendChild(chip);
  } else {
    // 未登录：与"已登录"共享同一 chip 位置，点击打开登录框
    const chip = document.createElement("button");
    chip.className = "auth-chip readonly";
    chip.type = "button";
    chip.textContent = "只读模式（点击以登录）";
    chip.onclick = openLoginModal;
    box.appendChild(chip);
  }
}

export function renderReadonly() {
  // FAB 只在列表视图且已登录时显示（与 list.js showView 逻辑一致）
  const onForm = !$("#view-form").classList.contains("hidden");
  $("#btn-add").classList.toggle("hidden", !LOGGED_IN || onForm);
}

export function openLoginModal() {
  $("#modal-mask").classList.remove("hidden");
  $("#login-error").classList.add("hidden");
  $("#login-token").value = "";
  $("#login-token").focus();
  ovOpen(closeLoginModal);
}

export function closeLoginModal() {
  $("#modal-mask").classList.add("hidden");
}

export async function doLogin() {
  const token = $("#login-token").value.trim();
  if (!token) return;
  const res = await fetch("/api/v1/auth/check", { headers: { "X-API-Key": token } });
  if (res.ok) {
    localStorage.setItem(KEY_STORAGE, token);
    setLoggedIn(true);
    ovClose(closeLoginModal);
    toast("登录成功");
    import("./main.js").then((m) => m.refreshAll());
  } else {
    $("#login-error").textContent = "Token 无效，请重试";
    $("#login-error").classList.remove("hidden");
  }
}

export async function checkAuthOnLoad() {
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

// ---------- 系统返回劫持（浮层栈 + pushState 哨兵） ----------
// 每打开一个浮层/视图压入一条 history 记录；浏览器返回（含移动端手势）
// 触发 popstate 时逐层关闭，而不是退出页面。

const ovStack = [];
let ovGuard = 0;

export function ovOpen(close) {
  ovStack.push(close);
  history.pushState({ hangarOv: ovStack.length }, "");
}

// 手动关闭（× / 点外部 / Esc / 按钮）：关浮层并移除自己的哨兵记录
export function ovClose(close) {
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
