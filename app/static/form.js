// Hangar WebUI — 新增/编辑表单：字段填充 / 标签编辑器 / 提交 / 日期输入
import { $, $$, api, toast, ovOpen, ovClose, LOGGED_IN, openLoginModal, esc, tagColorIndex } from "./core.js";
import { showView, closeForm, loadValues, loadList } from "./list.js";
import { openDialog } from "./dialog.js";
import { createSession, runUpload, abortSession } from "./upload.js";

let EDITING = null;      // 正在编辑的记录 id
let FORM_TAGS = [];
let INITIAL_SNAP = "";   // 打开表单时的内容快照，用于判断是否有改动
let FORM_UPLOAD = null;  // 保存后的分块上传会话（进行中可中断）

const SNAP_FIELDS = ["id", "name", "designation", "category", "grade", "item_no", "scale", "main_color", "limited",
  "origin", "status", "storage", "owner", "purchase_date", "done_date", "display", "comment"];

function formSnapshot() {
  const f = $("#model-form");
  const vals = SNAP_FIELDS.map((n) => {
    const el = f[n];
    return el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value;
  });
  vals.push(FORM_TAGS.join("\u0001"), $("#tag-text").value, $("#form-photos").files.length);
  return vals.join("\u0002");
}

export function openForm(m) {
  if (!LOGGED_IN) { openLoginModal(); return; }
  EDITING = m ? m.id : null;
  $("#form-title").textContent = m ? `编辑 ${m.id}` : "新增模型";
  // 编辑已有记录时隐藏照片上传入口（照片管理在详情模态框中进行）
  $("#form-photos-label").classList.toggle("hidden", !!m);
  $("#form-photo-preview").classList.add("hidden");
  const f = $("#model-form");
  f.reset();
  $("#form-photos").value = "";
  renderFormPreview();
  if (m) {
    f.id.value = m.id;
    f.id.disabled = !!m;
    FORM_TAGS = (m.tags || []).slice(0, 3);
    f.name.value = m.name || "";
    f.designation.value = m.designation || "";
    f.category.value = m.category || "";
    f.grade.value = m.grade || "";
    f.item_no.value = m.item_no || "";
    f.scale.value = m.scale || "";
    f.main_color.value = m.main_color || "";
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
  INITIAL_SNAP = formSnapshot();
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

export function initTagInput() {
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

export async function submitForm(e) {
  e.preventDefault();
  if (FORM_UPLOAD) return; // 上传进行中，忽略重复提交
  const f = $("#model-form");
  const pending = Array.from($("#form-photos").files || []);
  // 输入框里有未确认的文字，视为要添加的标签
  const typed = $("#tag-text").value.trim();
  if (typed && FORM_TAGS.length < 3 && !FORM_TAGS.includes(typed)) FORM_TAGS.push(typed);
  const body = {
    name: f.name.value.trim(),
    designation: f.designation.value.trim() || null,
    category: f.category.value,
    grade: f.grade.value.trim() || null,
    item_no: f.item_no.value.trim() || null,
    scale: f.scale.value.trim() || null,
    main_color: f.main_color.value.trim() || null,
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
  if (idVal) body.id = idVal;

  // 锁定两个按钮；保存按钮转圈。api() 失败会 toast 并抛错，catch 里解锁恢复
  const btnSave = $("#btn-save");
  const btnCancel = $("#btn-cancel");
  const origLabel = btnSave.textContent;
  const setBusy = (label) => {
    btnSave.disabled = true;
    btnCancel.disabled = true;
    btnSave.classList.add("busy");
    btnSave.innerHTML = `<span class="spinner"></span>${esc(label)}`;
  };
  const restoreBtns = () => {
    btnSave.disabled = false;
    btnCancel.disabled = false;
    btnSave.classList.remove("busy");
    btnSave.textContent = origLabel;
  };
  setBusy("保存中");
  let targetId;
  try {
    if (EDITING) {
      await api("/api/v1/models/" + encodeURIComponent(EDITING), {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      targetId = EDITING;
      toast("已更新 " + EDITING);
    } else {
      const created = await api("/api/v1/models", {
        method: "POST",
        body: JSON.stringify(body),
      });
      targetId = created.id;
      toast("已新增 " + created.id);
    }
  } catch (err) {
    restoreBtns();
    return; // api() 已 toast
  }

  if (!pending.length) {
    restoreBtns();
    await loadValues();
    await loadList();
    ovClose(closeForm);
    return;
  }

  // 记录已保存 → 进入分块上传（内嵌面板 + 可中断）
  await runFormUpload(targetId, pending, setBusy, restoreBtns);
  await loadValues();
  await loadList();
  ovClose(closeForm);
}

// 表单照片上传：内嵌进度面板，"中断"按钮走 abort（已传保留，可在详情页补传）
async function runFormUpload(modelId, files, setBusy, restoreBtns) {
  const panel = $("#form-upload-panel");
  const fill = $("#fu-fill");
  const text = $("#fu-text");
  const cancelBtn = $("#fu-cancel");
  panel.classList.remove("hidden");
  fill.style.width = "0%";
  text.textContent = "准备上传…";
  setBusy("上传中");
  const u = createSession(modelId, files, false); // pauseOnFail=false：单文件失败计失败继续
  FORM_UPLOAD = u;
  // 上传期间哨兵拦截系统返回/手势返回，避免离开表单（取消按钮已禁用，仅"中断"可退出流程）
  const guard = () => { if (FORM_UPLOAD) ovOpen(guard); };
  ovOpen(guard);
  cancelBtn.onclick = () => {
    cancelBtn.disabled = true;
    text.textContent = "正在中断…";
    abortSession(u);
  };
  await runUpload(u, {
    onProgress: (p) => { fill.style.width = p.pct + "%"; text.textContent = p.text; },
    onDone: (s) => {
      FORM_UPLOAD = null;
      ovClose(guard); // 移除返回哨兵
      panel.classList.add("hidden");
      cancelBtn.disabled = false;
      restoreBtns();
      if (s.aborted) {
        toast(`上传已中断：成功 ${s.ok} 张，可在该模型详情页继续上传`, true);
      } else if (s.fail) {
        toast(`照片：成功 ${s.ok}，失败 ${s.fail}`, true);
      } else {
        toast(`已上传 ${s.ok} 张照片`);
      }
    },
  });
}

// ---------- 日期输入（YYYY-MM-DD 自动格式化 + 输满跳下一个字段） ----------

export function initDateInputs() {
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

// 表单相关的全部事件绑定（入口只调这一个）
export function initForm() {
  $("#btn-cancel").onclick = tryCloseForm;
  $("#model-form").addEventListener("submit", submitForm);
  initDateInputs();
  initTagInput();
  $("#form-photos").addEventListener("change", renderFormPreview);
}

// 取消返回：内容有改动时先确认，避免误点丢失；无改动直接返回
async function tryCloseForm() {
  if (formSnapshot() === INITIAL_SNAP) { ovClose(closeForm); return; }
  const v = await openDialog({
    title: "放弃填写？",
    body: `<p class="muted">表单中已填入的信息将会丢失。</p>`,
    actions: [
      { label: "继续填写", value: "stay" },
      { label: "放弃", value: "discard", primary: true },
    ],
  });
  if (v === "discard") ovClose(closeForm);
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
