// Hangar WebUI — 详情模态框：字段渲染 / 照片网格 / 上传删除 / 排序
import { $, api, apiKey, esc, thumbUrl, tagBadges, gradeCell, toast, ovOpen, ovClose, LOGGED_IN, uuidv4 } from "./core.js";
import { openLightbox } from "./lightbox.js";
import { loadList } from "./list.js";

const FIELD_LABELS = {
  id: "编号", name: "名称", category: "类别", grade: "级别", item_no: "官方货号",
  scale: "比例", limited: "限定类型", origin: "来源", status: "状态",
  storage: "存放位置", display: "展示", owner: "归属", purchase_date: "购买日期",
  done_date: "完成日期",
  comment: "评价 / 备注", photos: "照片", tags: "标签",
};

// 分块大小 2MB（服务端上限同为 2MB）；弱网可调小，块越小单次失败重传代价越小
const CHUNK_SIZE = 2 * 1024 * 1024;

let DETAIL_MODEL = null;
let UPLOAD = null; // 分块上传会话 {files, fi, ci, uploadId, ok, fail}

export async function showDetail(id) {
  const m = await api("/api/v1/models/" + encodeURIComponent(id));
  DETAIL_MODEL = m;
  $("#detail-title").textContent = m.name;
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
    if (k === "grade") html = gradeCell(v);
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
  photos.forEach((p, i) => {
    const cell = document.createElement("div");
    cell.className = "photo-cell";
    const img = document.createElement("img");
    img.src = thumbUrl(p);
    img.alt = m.name;
    img.loading = "lazy";
    img.onclick = () => openLightbox(p, photos, m.id);
    cell.appendChild(img);
    if (LOGGED_IN) {
      const del = document.createElement("button");
      del.className = "photo-del";
      del.textContent = "×";
      del.title = "删除这张";
      del.onclick = () => deletePhoto(m.id, p);
      cell.appendChild(del);
      // 上移/下移（首尾禁用对应方向）
      const mv = document.createElement("div");
      mv.className = "photo-move";
      const up = document.createElement("button");
      up.textContent = "↑";
      up.title = "上移";
      up.disabled = i === 0;
      up.onclick = () => movePhoto(i, i - 1);
      const dn = document.createElement("button");
      dn.textContent = "↓";
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
  UPLOAD = { files: Array.from(files), fi: 0, ci: 0, uploadId: null, ok: 0, fail: 0, paused: false };
  await runUpload();
}

// 原始请求（分块循环需要拿到 400 的 detail 对象做续传，不能走 api() 的 toast 路径）
async function rawReq(path, opts) {
  const headers = Object.assign({}, opts.headers || {});
  const key = apiKey();
  if (key) headers["X-API-Key"] = key;
  if (opts.body && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  let json = null;
  try { json = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function progressText() {
  const u = UPLOAD;
  const file = u.files[u.fi];
  const chunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
  const totalBytes = u.files.reduce((s, f) => s + f.size, 0) || 1;
  const doneBytes = u.files.slice(0, u.fi).reduce((s, f) => s + f.size, 0) + u.ci * CHUNK_SIZE;
  const pct = Math.min(99, Math.round((doneBytes / totalBytes) * 100));
  return `上传中 ${u.fi + 1}/${u.files.length} 张 · 块 ${u.ci + 1}/${chunks}（${pct}%）`;
}

function setPaused(pause) {
  UPLOAD.paused = pause;
  const btn = $("#btn-upload");
  btn.querySelector(".up-label").textContent = pause ? "继续" : "上传照片";
}

async function runUpload() {
  const u = UPLOAD;
  const btn = $("#btn-upload");
  const status = $("#upload-status");
  btn.disabled = true;
  setPaused(false);
  while (u.fi < u.files.length) {
    const file = u.files[u.fi];
    if (!u.uploadId) u.uploadId = uuidv4();
    const chunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
    const id = encodeURIComponent(DETAIL_MODEL.id);
    let paused = false;
    while (u.ci < chunks) {
      const blob = file.slice(u.ci * CHUNK_SIZE, Math.min((u.ci + 1) * CHUNK_SIZE, file.size));
      let sent = false, authFail = false;
      for (let attempt = 0; attempt < 4 && !sent; attempt++) {
        if (attempt) await sleep(1000 * 2 ** (attempt - 1)); // 退避 1s/2s/4s
        status.textContent = progressText();
        const fd = new FormData();
        fd.append("upload_id", u.uploadId);
        fd.append("index", String(u.ci));
        fd.append("total", String(chunks));
        fd.append("file", blob, file.name);
        const r = await rawReq(`/api/v1/models/${id}/photos/chunk`, { method: "POST", body: fd });
        if (r.status === 200) sent = true;
        else if (r.status === 401) { authFail = true; break; }
      }
      if (authFail) { u.fail++; u.fi++; u.ci = 0; u.uploadId = null; break; }
      if (!sent) { paused = true; break; }
      u.ci++;
    }
    if (paused) {
      status.textContent = "已暂停（网络中断），点击上传按钮续传";
      setPaused(true);
      btn.disabled = false;
      return;
    }
    if (u.fi >= u.files.length) break; // 401 跳完剩余文件
    // 全部块就绪 → complete；若服务端报缺块则补传缺失块后重试一次
    let done = await tryComplete(u, id);
    if (!done.ok && done.missing) {
      for (const i of done.missing) await sendOneChunk(u, id, i, chunks, file);
      done = await tryComplete(u, id);
    }
    if (done.ok && done.model) {
      DETAIL_MODEL = done.model;
      renderPhotosKeepStatus(done.model);
      u.ok++;
    } else {
      u.fail++;
    }
    u.fi++; u.ci = 0; u.uploadId = null;
  }
  btn.disabled = false;
  setPaused(false);
  status.textContent = `完成：成功 ${u.ok}${u.fail ? "，失败 " + u.fail : ""}`;
  UPLOAD = null;
  loadList();
}

async function tryComplete(u, id) {
  const r = await rawReq(`/api/v1/models/${id}/photos/complete`, {
    method: "POST",
    body: JSON.stringify({ upload_id: u.uploadId, filename: u.files[u.fi].name }),
  });
  if (r.status === 200) return { ok: true, model: r.json };
  const d = r.json && r.json.detail;
  if (d && Array.isArray(d.missing)) return { ok: false, missing: d.missing };
  return { ok: false };
}

async function sendOneChunk(u, id, i, chunks, file) {
  const blob = file.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, file.size));
  const fd = new FormData();
  fd.append("upload_id", u.uploadId);
  fd.append("index", String(i));
  fd.append("total", String(chunks));
  fd.append("file", blob, file.name);
  await rawReq(`/api/v1/models/${id}/photos/chunk`, { method: "POST", body: fd });
}

function renderPhotosKeepStatus(m) {
  const status = $("#upload-status").textContent;
  renderPhotos(m);
  $("#upload-status").textContent = status;
}

// 详情模态框关闭交互（× / 点外部）
export function initDetail() {
  $("#btn-detail-close").onclick = () => ovClose(closeDetail);
  $("#detail-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) ovClose(closeDetail);
  });
  $("#btn-upload").onclick = () => {
    if (UPLOAD && UPLOAD.paused) { runUpload(); return; } // 续传
    $("#file-input").click();
  };
  $("#file-input").addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) uploadPhotos(files);
    e.target.value = "";
  });
}
