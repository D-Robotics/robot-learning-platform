import { LANGUAGES, t, builtinModelCopy } from "./lang.js";

const $ = (selector) => document.querySelector(selector);

let session = null;
let modelCatalog = [];
let running = false;
let frameBusy = false;
let controls = [];
let frameObjectUrl = null;
let pageUnloading = false;
let lang = "zh";

async function request(path, options = {}) {
  const response = await fetch(`./api/${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return response.json();
}

async function closeSession(id = session?.id) {
  if (!id) return;
  try {
    await request(`sessions/${id}`, { method: "DELETE" });
  } catch {
    // The server TTL remains the fallback when a tab is closed or a gateway
    // goes away before the explicit release reaches it.
  }
}

function setStatus(text, error = false) {
  $("#status").textContent = text;
  $("#status").style.color = error ? "#ff8e8e" : "var(--green)";
}

function applyLang() {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const value = t(lang, element.dataset.i18n);
    if (value !== undefined) element.textContent = value;
  });
  $("#run").textContent = running ? t(lang, "pause") : t(lang, "run");
  // Re-label the model picker and the open model's copy, then close the loop
  // for the live status area so a language flip never mixes scripts.
  renderModelOptions();
  if (session) renderModelCopy(session.model);
  if (!session && !$("#status").textContent) setStatus(t(lang, "connecting"));
}

function renderActuators(model) {
  controls = model.actuators.map(() => 0);
  const root = $("#actuators");
  root.replaceChildren();
  model.actuators.forEach((actuator, index) => {
    const row = document.createElement("div");
    row.className = "actuator-row";
    // Actuator names reach this page from deployer registry entries; they are
    // plain text here, never HTML (registry validation does not restrict the
    // character set, and the page is served without a CSP header).
    row.innerHTML = `<div class="actuator-label"><span></span><output>0.00</output></div>`;
    row.querySelector(".actuator-label span").textContent = actuator.name;
    const input = document.createElement("input");
    input.type = "range";
    input.min = actuator.min;
    input.max = actuator.max;
    input.step = "0.01";
    input.value = "0";
    input.addEventListener("input", () => {
      controls[index] = Number(input.value);
      row.querySelector("output").value = Number(input.value).toFixed(2);
      row.querySelector("output").textContent = Number(input.value).toFixed(2);
    });
    row.append(input);
    root.append(row);
  });
}

function updateReadouts(state) {
  const seconds = Number(state.time).toFixed(3);
  $("#sim-time").textContent = `t = ${seconds} s`;
  $("#readout-time").textContent = `${seconds} s`;
  $("#readout-dof").textContent = `${state.qpos.length} qpos / ${state.qvel.length} qvel`;
  $("#readout-session").textContent = state.id.slice(0, 8);
}

async function refreshFrame() {
  if (!session || frameBusy) return;
  frameBusy = true;
  try {
    const [state, image] = await Promise.all([
      request(`sessions/${session.id}/state`),
      fetch(`./api/sessions/${session.id}/frame.jpg?ts=${Date.now()}`),
    ]);
    if (!image.ok) throw new Error(`frame HTTP ${image.status}`);
    const nextObjectUrl = URL.createObjectURL(await image.blob());
    const previousObjectUrl = frameObjectUrl;
    frameObjectUrl = nextObjectUrl;
    $("#frame").src = nextObjectUrl;
    if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
    updateReadouts(state);
  } finally {
    frameBusy = false;
  }
}

async function tick() {
  if (!running || !session) return;
  try {
    await request(`sessions/${session.id}/step`, {
      method: "POST",
      body: JSON.stringify({ controls, steps: Number($("#speed").value) }),
    });
    await refreshFrame();
  } catch (error) {
    running = false;
    $("#run").classList.remove("running");
    $("#run").textContent = "▶ 运行";
    setStatus(error.message, true);
    return;
  }
  requestAnimationFrame(tick);
}

function renderModelCopy(model) {
  // Builtin model names/descriptions ship in English in the data layer;
  // map them per language here. Registry entries keep their deployer text.
  const builtin = model.source !== "registry" ? builtinModelCopy(lang, model.key) : null;
  $("#model-title").textContent = builtin ? builtin.name : model.name;
  $("#model-description").textContent = builtin ? builtin.description : model.description;
  $("#model-source").textContent =
    model.source === "registry" ? t(lang, "modelSourceRegistry") : t(lang, "modelSourceBuiltin");
  $("#model-source").classList.toggle("registry", model.source === "registry");
}

function renderModelOptions() {
  const select = $("#model-select");
  const previous = select.value;
  select.replaceChildren();
  modelCatalog.forEach((model) => {
    const option = document.createElement("option");
    option.value = model.key;
    const builtin = model.source !== "registry" ? builtinModelCopy(lang, model.key) : null;
    // Registry entries are deployer-supplied; marking them keeps the
    // provenance visible before a session is opened.
    option.textContent = builtin
      ? builtin.name
      : model.source === "registry"
        ? `${model.name}${t(lang, "registrySuffix")}`
        : model.name;
    select.append(option);
  });
  if (previous) select.value = previous;
}

async function openModel(key) {
  running = false;
  $("#run").classList.remove("running");
  $("#run").textContent = t(lang, "run");
  setStatus(t(lang, "creatingSession"));
  const previousSessionId = session?.id;
  session = null;
  if (previousSessionId) await closeSession(previousSessionId);
  session = await request("sessions", { method: "POST", body: JSON.stringify({ model: key }) });
  if (pageUnloading) {
    await closeSession(session.id);
    session = null;
    return;
  }
  renderModelCopy(session.model);
  renderActuators(session.model);
  updateReadouts(session);
  await refreshFrame();
  setStatus(t(lang, "ready"));
}

$("#run").addEventListener("click", () => {
  running = !running;
  $("#run").classList.toggle("running", running);
  $("#run").textContent = running ? t(lang, "pause") : t(lang, "run");
  if (running) tick();
});

$("#step").addEventListener("click", async () => {
  if (!session || running) return;
  await request(`sessions/${session.id}/step`, {
    method: "POST",
    body: JSON.stringify({ controls, steps: Number($("#speed").value) }),
  });
  await refreshFrame();
});

$("#reset").addEventListener("click", async () => {
  if (!session) return;
  await request(`sessions/${session.id}/reset`, { method: "POST" });
  await refreshFrame();
  setStatus(t(lang, "resetDone"));
});

$("#speed").addEventListener("input", () => { $("#speed-value").textContent = `${$("#speed").value}×`; });
$("#model-select").addEventListener("change", (event) => openModel(event.target.value).catch((error) => setStatus(error.message, true)));

$("#lang-select").addEventListener("change", (event) => {
  lang = event.target.value;
  localStorage.setItem("mujoco-web-lang", lang);
  applyLang();
});

async function boot() {
  const saved = localStorage.getItem("mujoco-web-lang");
  if (saved && LANGUAGES.includes(saved)) lang = saved;
  $("#lang-select").value = lang;
  applyLang();
  const [health, catalog] = await Promise.all([fetch("./healthz").then((response) => response.json()), request("models")]);
  $("#engine-version").textContent = `v${health.mujoco_version}`;
  modelCatalog = catalog.models;
  renderModelOptions();
  await openModel(modelCatalog[0].key);
}

boot().catch((error) => {
  setStatus(error.message, true);
  $("#model-title").textContent = t(lang, "cannotConnect");
});

window.addEventListener("beforeunload", () => {
  pageUnloading = true;
  if (frameObjectUrl) URL.revokeObjectURL(frameObjectUrl);
  frameObjectUrl = null;
  if (session?.id) {
    // keepalive lets the browser finish the small DELETE while unloading;
    // the server-side TTL still protects clients that cannot send it.
    fetch(`./api/sessions/${session.id}`, {
      method: "DELETE",
      keepalive: true,
      headers: { accept: "application/json" },
    }).catch(() => {});
  }
});
