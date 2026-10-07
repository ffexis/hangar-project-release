// Hangar WebUI — 新增/编辑表单：字段填充 / 标签编辑器 / 提交 / 日期输入
import { $, $$, api, toast, ovOpen, ovClose, LOGGED_IN, openLoginModal, esc, tagColorIndex } from "./core.js";
import { showView, closeForm, loadValues, loadList } from "./list.js";

let EDITING = null;      // 正在编辑的记录 id
let FORM_TAGS = [];

export function openForm(m) {
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
  $("#btn-cancel").onclick = () => ovClose(closeForm);
  $("#model-form").addEventListener("submit", submitForm);
  initDateInputs();
  initTagInput();
  $("#form-photos").addEventListener("change", renderFormPreview);
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
