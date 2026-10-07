// Hangar 初始化页逻辑
const $ = (s) => document.querySelector(s);

// 硬枚举预填内置默认值（与后端 db.py 常量一致，仅作为建议）
const DEFAULTS = {
  category: ["GUNPLA", "手办", "乐高", "其他"],
  status: ["未开封", "未拼装", "制作中", "拼装完工", "标识系统完工", "最终完工", "成品"],
};
// 软枚举完全不预设，由用户自行填充
const SOFT_FIELDS = ["grade", "limited", "origin", "storage", "owner"];

const state = {};  // field -> string[]

function makeChipEditor(field) {
  const box = $("#ci-" + field);
  const input = box.querySelector("input");
  state[field] = (DEFAULTS[field] || []).slice();

  function render() {
    box.querySelectorAll(".chip").forEach((c) => c.remove());
    state[field].forEach((v, i) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      const text = document.createElement("span");
      text.textContent = v;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "chip-x";
      x.textContent = "×";
      x.title = "删除";
      x.onclick = () => { state[field].splice(i, 1); render(); };
      chip.append(text, x);
      box.insertBefore(chip, input);
    });
  }

  function add(raw) {
    const v = (raw || "").trim().slice(0, 32);
    if (!v) return;
    if (state[field].includes(v)) { input.value = ""; return; }
    state[field].push(v);
    input.value = "";
    render();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add(input.value);
    } else if (e.key === "Backspace" && !input.value && state[field].length) {
      state[field].pop();
      render();
    }
  });
  input.addEventListener("change", () => { if (input.value.trim()) add(input.value); });
  box.addEventListener("click", (e) => { if (e.target === box) input.focus(); });
  render();
}

function genToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function init() {
  // 已初始化则回到主页
  try {
    const r = await fetch("/api/v1/status");
    const j = await r.json();
    if (j.initialized) { location.replace("/"); return; }
  } catch (e) { /* 忽略，允许继续填写 */ }

  makeChipEditor("category");
  makeChipEditor("status");
  SOFT_FIELDS.forEach((f) => makeChipEditor(f));

  const tokenInput = $("#token");
  $("#btn-gen").onclick = () => {
    tokenInput.value = genToken();
    tokenInput.type = "text";
  };
  $("#btn-show").onclick = () => {
    tokenInput.type = tokenInput.type === "password" ? "text" : "password";
  };

  $("#btn-submit").onclick = async () => {
    const err = $("#setup-error");
    err.textContent = "";
    const token = tokenInput.value.trim();
    if (!token) { err.textContent = "Token 不能为空"; return; }
    if (!state.category.length) { err.textContent = "类别至少需要 1 项"; return; }
    if (!state.status.length) { err.textContent = "状态至少需要 1 项"; return; }
    const body = {
      token,
      categories: state.category,
      statuses: state.status,
      soft_defaults: Object.fromEntries(SOFT_FIELDS.map((f) => [f, state[f]])),
      amap_key: $("#amap-key").value.trim(),
    };
    $("#btn-submit").disabled = true;
    try {
      const r = await fetch("/api/v1/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        let msg = r.statusText;
        try {
          const j = await r.json();
          if (j.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
        } catch (e) { /* ignore */ }
        err.textContent = "初始化失败：" + msg;
        return;
      }
      localStorage.setItem("hangar_api_key", token);
      location.replace("/");
    } catch (e) {
      err.textContent = "网络错误：" + e.message;
    } finally {
      $("#btn-submit").disabled = false;
    }
  };
}

init();
