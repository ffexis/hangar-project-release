// Hangar WebUI — 详情模态框：字段渲染 / 照片网格 / 上传删除
import { $, api, esc, thumbUrl, tagBadges, gradeCell, toast, ovOpen, ovClose, LOGGED_IN } from "./core.js";
import { openLightbox } from "./lightbox.js";
import { loadList } from "./list.js";

const FIELD_LABELS = {
  id: "编号", name: "名称", category: "类别", grade: "级别", item_no: "官方货号",
  scale: "比例", limited: "限定类型", origin: "来源", status: "状态",
  storage: "存放位置", display: "展示", owner: "归属", purchase_date: "购买日期",
  done_date: "完成日期",
  comment: "评价 / 备注", photos: "照片", tags: "标签",
};

let DETAIL_MODEL = null;

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
  photos.forEach((p) => {
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

export async function uploadPhotos(files) {
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

// 详情模态框关闭交互（× / 点外部）
export function initDetail() {
  $("#btn-detail-close").onclick = () => ovClose(closeDetail);
  $("#detail-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) ovClose(closeDetail);
  });
  $("#btn-upload").onclick = () => $("#file-input").click();
  $("#file-input").addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) uploadPhotos(files);
    e.target.value = "";
  });
}
