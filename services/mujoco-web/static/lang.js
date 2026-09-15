// UI bilingual dictionary. Chinese is the default (proper nouns such as
// MuJoCo, ONNX and product/model identifiers stay in English); the English
// variant restores the original copy. Runtime strings live here too so
// setStatus()/openModel() stay in sync with the active language.

export const LANGUAGES = ["zh", "en"];

const STRINGS = {
  zh: {
    subtitle: "在浏览器里直接运行 MuJoCo 物理仿真，服务端计算、实时渲染。",
    liveSimulation: "实时仿真",
    connecting: "连接中",
    run: "▶ 运行",
    pause: "Ⅱ 暂停",
    step: "单步",
    reset: "重置",
    speed: "速度",
    model: "模型",
    actuators: "执行器",
    actuatorRange: "-1 … +1",
    loadingControls: "载入控制器…",
    loadingModel: "正在载入模型…",
    physicsTime: "物理时间",
    dof: "关节自由度",
    session: "会话",
    safetyNote: "仅运行内置与注册表受审模型 · 不执行上传的 XML、Python 或 shell 命令",
    footer: "MuJoCo 仿真演练场 · 适合教学、控制器原型和动力学快速验证",
    creatingSession: "创建会话…",
    ready: "就绪",
    resetDone: "已重置",
    modelSourceBuiltin: "平台内置模型",
    modelSourceRegistry: "部署方注册表 · 受审模型",
    registrySuffix: " · 部署方",
    cannotConnect: "无法连接 MuJoCo 服务",
    // Builtin model display names and descriptions (registry entries keep
    // their deployer-supplied strings in both languages).
    builtinModels: {
      cartpole: {
        name: "车摆（Cart-pole）",
        description: "可控小车与铰接摆杆。推动小车，观察耦合动力学。",
      },
      "double-pendulum": {
        name: "双摆（Double pendulum）",
        description: "混沌双连杆摆，两个关节均可施加力矩控制。",
      },
      originbot: {
        name: "OriginBot X5",
        description: "差速轮 OriginBot：底盘、双驱轮、万向轮、19 束前向激光与障碍场景。",
      },
    },
  },
  en: {
    subtitle: "Run MuJoCo physics in the browser — server-side simulation, live rendering.",
    liveSimulation: "LIVE SIMULATION",
    connecting: "Connecting",
    run: "▶ Run",
    pause: "Ⅱ Pause",
    step: "Step",
    reset: "Reset",
    speed: "Speed",
    model: "MODEL",
    actuators: "ACTUATORS",
    actuatorRange: "-1 … +1",
    loadingControls: "Loading actuators…",
    loadingModel: "Loading model…",
    physicsTime: "Physics time",
    dof: "Degrees of freedom",
    session: "Session",
    safetyNote: "Runs only built-in and registry-reviewed models · never executes uploaded XML, Python or shell commands",
    footer: "MuJoCo server playground · for teaching, controller prototyping and quick dynamics checks",
    creatingSession: "Creating session…",
    ready: "Ready",
    resetDone: "Reset",
    modelSourceBuiltin: "Platform built-in model",
    modelSourceRegistry: "Deployer registry · reviewed model",
    registrySuffix: " · deployer",
    cannotConnect: "Cannot reach the MuJoCo service",
    builtinModels: {
      cartpole: {
        name: "Cart-pole",
        description: "A controllable cart and hinged pole. Push the cart and watch the coupled dynamics.",
      },
      "double-pendulum": {
        name: "Double pendulum",
        description: "A chaotic two-link pendulum with torque control at both joints.",
      },
      originbot: {
        name: "OriginBot X5",
        description: "Differential-drive OriginBot: chassis, driven wheels, caster, 19-beam forward lidar and obstacles.",
      },
    },
  },
};

export const t = (lang, key) => (STRINGS[lang] || STRINGS.zh)[key];
export const builtinModelCopy = (lang, modelKey) => {
  const table = (STRINGS[lang] || STRINGS.zh).builtinModels;
  return table[modelKey] || null;
};
