const $ = (selector) => document.querySelector(selector);

let session = null;
let modelCatalog = [];
let running = false;
let frameBusy = false;
let controls = [];
let frameObjectUrl = null;

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

function setStatus(text, error = false) {
  $("#status").textContent = text;
  $("#status").style.color = error ? "#ff8e8e" : "var(--green)";
}

function renderActuators(model) {
  controls = model.actuators.map(() => 0);
  const root = $("#actuators");
  root.replaceChildren();
  model.actuators.forEach((actuator, index) => {
    const row = document.createElement("div");
    row.className = "actuator-row";
    row.innerHTML = `<div class="actuator-label"><span>${actuator.name}</span><output>0.00</output></div>`;
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

async function openModel(key) {
  running = false;
  $("#run").classList.remove("running");
  $("#run").textContent = "▶ 运行";
  setStatus("创建会话…");
  session = await request("sessions", { method: "POST", body: JSON.stringify({ model: key }) });
  $("#model-title").textContent = session.model.name;
  $("#model-description").textContent = session.model.description;
  renderActuators(session.model);
  updateReadouts(session);
  await refreshFrame();
  setStatus("就绪");
}

$("#run").addEventListener("click", () => {
  running = !running;
  $("#run").classList.toggle("running", running);
  $("#run").textContent = running ? "Ⅱ 暂停" : "▶ 运行";
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
  setStatus("已重置");
});

$("#speed").addEventListener("input", () => { $("#speed-value").textContent = `${$("#speed").value}×`; });
$("#model-select").addEventListener("change", (event) => openModel(event.target.value).catch((error) => setStatus(error.message, true)));

async function boot() {
  const [health, catalog] = await Promise.all([fetch("./healthz").then((response) => response.json()), request("models")]);
  $("#engine-version").textContent = `v${health.mujoco_version}`;
  modelCatalog = catalog.models;
  const select = $("#model-select");
  modelCatalog.forEach((model) => {
    const option = document.createElement("option");
    option.value = model.key;
    option.textContent = model.name;
    select.append(option);
  });
  await openModel(modelCatalog[0].key);
}

boot().catch((error) => {
  setStatus(error.message, true);
  $("#model-title").textContent = "无法连接 MuJoCo 服务";
});

window.addEventListener("beforeunload", () => {
  if (frameObjectUrl) URL.revokeObjectURL(frameObjectUrl);
  frameObjectUrl = null;
});
