// Hangar WebUI — 共享核心：DOM 助手 / 请求 / 主题 / 登录 / 浮层栈 / 通用渲染
export const $ = (s) => document.querySelector(s);
export const $$ = (s) => Array.from(document.querySelectorAll(s));

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
// 无对应 logo 的级别（如 MEGASIZE、用户自定义）显示文字。

export const GRADE_LOGO_FILES = {
  PG: "PG", PGUNLEASHED: "PG",
  MG: "MG", MGEX: "MGEX", MGSD: "MGSD",
  RG: "RG", HG: "HG", EG: "EG", FM: "FM",
  RE100: "RE100", SDCS: "SDCS", SDEX: "SDEX",
};

export function gradeLogoUrl(grade) {
  if (!grade) return null;
  const key = String(grade).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const file = GRADE_LOGO_FILES[key];
  return file ? `/logo/${file}.png` : null;
}

export function gradeCell(grade) {
  if (!grade) return "";
  const url = gradeLogoUrl(grade);
  return url
    ? `<img class="grade-logo" src="${url}" alt="${esc(grade)}" title="${esc(grade)}" loading="lazy">`
    : esc(grade);
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
    const b = document.createElement("button");
    b.id = "btn-login";
    b.className = "btn-sm";
    b.textContent = "登录";
    b.onclick = openLoginModal;
    box.appendChild(b);
  }
}

export function renderReadonly() {
  $("#btn-add").classList.toggle("hidden", !LOGGED_IN);
  $("#readonly-hint").classList.toggle("hidden", LOGGED_IN);
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
