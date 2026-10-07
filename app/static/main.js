// Hangar WebUI — 入口：初始化 / 全局事件绑定
import {
  $, initTheme, renderAuthState, renderReadonly, checkAuthOnLoad,
  ovClose, closeLoginModal, doLogin,
} from "./core.js";
import {
  loadValues, loadList, updateFilterCount, initFilterDrawer,
} from "./list.js";
import { openForm, initForm } from "./form.js";
import { closeDetail, initDetail } from "./detail.js";
import { closeLightbox, lightboxOpen } from "./lightbox.js";

export async function refreshAll() {
  try {
    await loadValues();
    await loadList();
    updateFilterCount();
  } catch (e) {
    /* toast 已提示 */
  }
}

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
  initForm();

  ["#f-status", "#f-storage", "#f-grade", "#f-category", "#f-owner", "#f-tag", "#f-display"].forEach(
    (s) => ($(s).onchange = loadList)
  );
  let qt;
  $("#f-q").addEventListener("input", () => {
    clearTimeout(qt);
    qt = setTimeout(loadList, 300);
  });

  initDetail();

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (lightboxOpen()) { ovClose(closeLightbox); return; }
    if (!$("#detail-modal").classList.contains("hidden")) { ovClose(closeDetail); return; }
    if (!$("#modal-mask").classList.contains("hidden")) ovClose(closeLoginModal);
  });

  await checkAuthOnLoad();
  await refreshAll();
  initFilterDrawer();
}

init();
