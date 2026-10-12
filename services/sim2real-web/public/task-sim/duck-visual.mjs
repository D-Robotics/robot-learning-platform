import { clamp, identity, modelMatrix, multiply } from './task-sim-core.mjs';

const finiteVector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
const normalize = (value) => { const length = Math.hypot(...value); if (!length) throw new Error('MicroDuck 旋转轴或四元数无效。'); return value.map((n) => n / length); };
const translate = (position) => { const matrix = identity(); matrix.set(position, 12); return matrix; };
// Audited MicroDuck mjlab default pose; proxy channels only add display offsets.
export const DEFAULT_DUCK_POSE = Object.freeze([0, -.08726646259971647, -.457924, -.004940, .452984, .3490658503988659, .3490658503988659, 0, 0, 0, .08726646259971647, .457924, .004940, -.452984]);

function visualSettings(kinematics) {
  const settings = kinematics.visualModel || {};
  const joints = kinematics.bodies.filter((body) => body.joint).map((body) => body.joint.actuator_index);
  const count = joints.length ? Math.max(...joints) + 1 : 0;
  if (count > 256 || joints.some((index) => !Number.isInteger(index) || index < 0) || new Set(joints).size !== joints.length) throw new Error('机器人可视关节索引无效。');
  const custom = Boolean(kinematics.visualModel);
  const defaults = settings.defaultPose ?? Array.from({ length: count }, (_, index) => custom ? 0 : DEFAULT_DUCK_POSE[index] || 0);
  const scale = settings.postureScale ?? .35;
  const mapping = settings.postureMap ?? Array.from({ length: count }, (_, index) => index);
  if (!finiteVector(defaults, count) || defaults.some((value) => Math.abs(value) > Math.PI * 2)) throw new Error('机器人默认关节姿态无效。');
  if (!(Number.isFinite(scale) && Math.abs(scale) <= Math.PI * 2) && !(finiteVector(scale, count) && scale.every((value) => Math.abs(value) <= Math.PI * 2))) throw new Error('机器人姿态缩放无效。');
  if (!Array.isArray(mapping) || mapping.length !== count || mapping.some((index) => !Number.isInteger(index) || index < -1 || index > 255)) throw new Error('机器人姿态映射无效。');
  const name = settings.displayName ?? (custom ? '自定义机器人' : 'MicroDuck');
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || [...name].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)) throw new Error('机器人外观名称无效。');
  const meshFile = settings.meshFile ?? 'microduck.glb';
  if (typeof meshFile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.glb$/.test(meshFile) || meshFile.includes('..')) throw new Error('机器人网格文件必须是本目录内的 GLB 文件。');
  const palette = settings.palette ?? (custom ? 'source' : 'microduck-classic');
  if (!['source', 'microduck-classic'].includes(palette)) throw new Error('机器人配色模式无效。');
  return { defaults, scale, mapping, name: name.trim(), meshFile, palette };
}
export const duckCameraAzimuth = (robots = []) => -1.1 + (robots.length === 1 && Number.isFinite(robots[0].visualYaw) ? robots[0].visualYaw : 0);
export const linearToSrgb = (value) => value <= .0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - .055;

export function quaternionMatrix(quaternion = [1, 0, 0, 0], position = [0, 0, 0]) {
  if (!finiteVector(quaternion, 4) || !finiteVector(position, 3)) throw new Error('MicroDuck 局部姿态无效。');
  const [w, x, y, z] = normalize(quaternion), matrix = identity();
  matrix.set([1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)], 0);
  matrix.set([2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)], 4);
  matrix.set([2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)], 8);
  matrix.set(position, 12); return matrix;
}

function readAccessor(document, binary, index) {
  const accessor = document.accessors?.[index], view = document.bufferViews?.[accessor?.bufferView];
  const dimensions = { SCALAR: 1, VEC3: 3 }, components = { 5121: [1, 'getUint8'], 5123: [2, 'getUint16'], 5125: [4, 'getUint32'], 5126: [4, 'getFloat32'] };
  if (!accessor || !view || view.buffer !== 0 || accessor.sparse || accessor.normalized || !dimensions[accessor.type] || !components[accessor.componentType] || !Number.isInteger(accessor.count) || accessor.count < 1 || accessor.count > 1e6) throw new Error('MicroDuck GLB 顶点格式不受支持。');
  const width = dimensions[accessor.type], [bytes, method] = components[accessor.componentType], stride = view.byteStride || width * bytes;
  const offset = (view.byteOffset || 0) + (accessor.byteOffset || 0), length = (accessor.count - 1) * stride + width * bytes;
  if (!Number.isInteger(stride) || stride < width * bytes || offset < 0 || offset + length > binary.byteLength || (accessor.byteOffset || 0) + length > view.byteLength) throw new Error('MicroDuck GLB 顶点越界。');
  const reader = new DataView(binary.buffer, binary.byteOffset, binary.byteLength), result = new Array(accessor.count * width);
  for (let row = 0; row < accessor.count; row++) for (let col = 0; col < width; col++) result[row * width + col] = reader[method](offset + row * stride + col * bytes, true);
  if (!result.every(Number.isFinite)) throw new Error('MicroDuck GLB 顶点含非有限数值。');
  return { values: result, type: accessor.type, componentType: accessor.componentType };
}

export function parseDuckGlb(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteLength < 20 || bytes.byteLength > 8 * 1024 * 1024) throw new Error('MicroDuck GLB 文件长度无效。');
  const reader = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (reader.getUint32(0, true) !== 0x46546c67 || reader.getUint32(4, true) !== 2 || reader.getUint32(8, true) !== bytes.byteLength) throw new Error('MicroDuck GLB 文件头无效。');
  let document, binary;
  for (let offset = 12; offset < bytes.byteLength;) {
    if (offset + 8 > bytes.byteLength) throw new Error('MicroDuck GLB 数据块不完整。');
    const length = reader.getUint32(offset, true), type = reader.getUint32(offset + 4, true); offset += 8;
    if (length % 4 || offset + length > bytes.byteLength) throw new Error('MicroDuck GLB 数据块越界。');
    if (type === 0x4e4f534a) document = JSON.parse(new TextDecoder().decode(bytes.subarray(offset, offset + length)));
    if (type === 0x004e4942) binary = bytes.subarray(offset, offset + length);
    offset += length;
  }
  if (!document || !binary || document.extensionsRequired?.length || document.buffers?.length !== 1 || document.buffers[0].uri) throw new Error('MicroDuck GLB 必须使用内嵌、无扩展的几何。');
  const meshes = new Map();
  for (const mesh of document.meshes || []) {
    if (!mesh.name || meshes.has(mesh.name)) throw new Error('MicroDuck GLB 网格名缺失或重复。');
    const vertices = [], low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (const primitive of mesh.primitives || []) {
      if ((primitive.mode ?? 4) !== 4 || primitive.extensions) throw new Error('MicroDuck GLB 必须使用普通三角面。');
      const positions = readAccessor(document, binary, primitive.attributes?.POSITION), indices = readAccessor(document, binary, primitive.indices);
      if (positions.type !== 'VEC3' || positions.componentType !== 5126 || indices.type !== 'SCALAR' || ![5121, 5123, 5125].includes(indices.componentType) || indices.values.length % 3) throw new Error('MicroDuck GLB 三角索引格式无效。');
      for (let index = 0; index < indices.values.length; index += 3) {
        const triangle = indices.values.slice(index, index + 3).map((vertex) => { if (vertex * 3 + 2 >= positions.values.length) throw new Error('MicroDuck GLB 三角索引越界。'); return positions.values.slice(vertex * 3, vertex * 3 + 3); });
        const [a, b, c] = triangle, ab = b.map((n, i) => n - a[i]), ac = c.map((n, i) => n - a[i]);
        const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]], norm = Math.hypot(...cross);
        const normal = norm > 1e-12 ? cross.map((n) => n / norm) : [0, 0, 1];
        for (const point of triangle) { vertices.push(...point, ...normal); point.forEach((n, i) => { low[i] = Math.min(low[i], n); high[i] = Math.max(high[i], n); }); }
      }
    }
    if (!vertices.length) throw new Error('MicroDuck GLB 网格为空。');
    meshes.set(mesh.name, { name: mesh.name, vertices: Float32Array.from(vertices), bounds: { low, high } });
  }
  if (!meshes.size) throw new Error('MicroDuck GLB 没有可显示的网格。');
  return meshes;
}

export function prepareDuckModel(meshes, kinematics) {
  if (!(meshes instanceof Map) || !Array.isArray(kinematics?.bodies) || !kinematics.bodies.length || kinematics.bodies.length > 100) throw new Error('MicroDuck 运动学文件无效。');
  const names = new Set();
  for (const body of kinematics.bodies) {
    if (!body.name || names.has(body.name)) throw new Error('MicroDuck 本体名称缺失或重复。'); names.add(body.name);
    quaternionMatrix(body.quat, body.pos);
    if (!Array.isArray(body.geoms)) throw new Error('MicroDuck 本体几何缺失。');
    for (const geom of body.geoms) { if (geom.type !== 'mesh' || !meshes.has(geom.mesh) || !finiteVector(geom.color, 4)) throw new Error(`MicroDuck 网格缺失：${geom.mesh || body.name}`); quaternionMatrix(geom.quat, geom.pos); }
    if (body.joint && (body.joint.type !== 'hinge' || !finiteVector(body.joint.axis, 3) || !finiteVector(body.joint.pos, 3) || !finiteVector(body.joint.range, 2) || body.joint.range[0] > body.joint.range[1] || !Number.isInteger(body.joint.actuator_index) || body.joint.actuator_index < 0 || body.joint.actuator_index >= 256)) throw new Error('机器人可视关节契约无效。');
  }
  const model = { meshes, kinematics, visual: visualSettings(kinematics) }; duckForwardKinematics(kinematics); return model;
}

export function duckForwardKinematics(kinematics, robot = {}, settings = visualSettings(kinematics)) {
  const base = modelMatrix({ xpos: robot.xpos || [0, 0, 0], xmat: robot.xmat }), offset = robot.footOffset || [0, 0, 0];
  if (!finiteVector(offset, 3) || !Array.from(base).every(Number.isFinite)) throw new Error('MicroDuck 基座姿态无效。');
  if (robot.posture != null && (!Array.isArray(robot.posture) || robot.posture.length > 256 || !robot.posture.every(Number.isFinite))) throw new Error('机器人显示姿态必须包含有限数值且不超过 256 维。');
  const visualYaw = robot.visualYaw || 0; if (!Number.isFinite(visualYaw)) throw new Error('MicroDuck 外观标定角无效。');
  const origin = multiply(multiply(base, translate(offset)), quaternionMatrix([Math.cos(visualYaw / 2), 0, 0, Math.sin(visualYaw / 2)])), bodies = new Map(kinematics.bodies.map((body) => [body.name, body])), matrices = new Map(), pending = new Set();
  const resolve = (name) => {
    if (matrices.has(name)) return matrices.get(name);
    const body = bodies.get(name); if (!body || pending.has(name)) throw new Error('MicroDuck 运动学父子层级无效。'); pending.add(name);
    let local = quaternionMatrix(body.quat, body.pos);
    if (body.joint) {
      const joint = body.joint, axis = normalize(joint.axis);
      // Proxy posture channels are display adapters, not measured joint angles.
      const index = joint.actuator_index, scale = Array.isArray(settings.scale) ? settings.scale[index] : settings.scale;
      const angle = clamp(settings.defaults[index] + (robot.posture?.[settings.mapping[index]] || 0) * scale, joint.range[0], joint.range[1]);
      const half = angle / 2, rotation = quaternionMatrix([Math.cos(half), ...axis.map((n) => n * Math.sin(half))]);
      local = multiply(local, multiply(translate(joint.pos), multiply(rotation, translate(joint.pos.map((n) => -n)))));
    }
    const matrix = multiply(body.parent == null ? origin : resolve(body.parent), local); matrices.set(name, matrix); pending.delete(name); return matrix;
  };
  for (const name of bodies.keys()) resolve(name); return matrices;
}

function transformedBounds(bounds, matrix) {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const x of [bounds.low[0], bounds.high[0]]) for (const y of [bounds.low[1], bounds.high[1]]) for (const z of [bounds.low[2], bounds.high[2]]) for (let row = 0; row < 3; row++) {
    const value = matrix[row] * x + matrix[4 + row] * y + matrix[8 + row] * z + matrix[12 + row]; low[row] = Math.min(low[row], value); high[row] = Math.max(high[row], value);
  }
  return { low, high };
}

const WHITE = [.91, .93, .94, 1], DARK = [.19, .22, .25, 1], ORANGE = [1, .46, .06, 1];
function meshColor(name, fallback) {
  // Classic palette from the reviewed MicroDuck release, in linear RGB.
  if (/^(top_head_shell|trunk_base|left_shell|right_shell|upper_leg_left|upper_leg_right)\.stl$/.test(name)) return [.888, .86, .798, 1];
  if (name === 'face_part.stl') return [.328, .312, .283, 1];
  if (/^(bottom_head_shell|jaw|foot_left|foot_right|ankle_left|ankle_right)\.stl$/.test(name)) return [1, .144, .008, 1];
  if (/^(soft_mouth_top|jaw_soft|noenoeil)\.stl$/.test(name)) return [1, .413, .007, 1];
  if (/^sole_(left|right)\.stl$/.test(name)) return [1, .608, .021, 1];
  if (name === 'lens.stl') return [.01, .012, .02, 1];
  if (/^(xl330|yaw2roll|bearing_roll|np_f970|m12_lens_holder|.*pcb.*)\.stl$/.test(name)) return [.012, .012, .014, 1];
  return fallback;
}
function fallbackParts() {
  const parts = [
    ['trunk', 'box', [.065, .045, .05], [0, 0, .145], DARK],
    ['neck', 'box', [.025, .024, .045], [.04, 0, .22], WHITE],
    ['head', 'ellipsoid', [.055, .052, .048], [.075, 0, .275], WHITE],
    ['beak', 'box', [.041, .035, .011], [.134, 0, .26], ORANGE],
    ['wing-left', 'box', [.048, .012, .035], [0, .057, .14], WHITE],
    ['wing-right', 'box', [.048, .012, .035], [0, -.057, .14], WHITE],
  ];
  for (const side of [-1, 1]) {
    parts.push([`eye-${side}`, 'sphere', [.009, .009, .009], [.096, side * .046, .287], [.03, .04, .05, 1]]);
    parts.push([`leg-${side}`, 'box', [.014, .014, .05], [0, side * .032, .073], WHITE]);
    parts.push([`foot-${side}`, 'box', [.046, .025, .013], [.026, side * .032, .014], WHITE]);
    parts.push([`knee-${side}`, 'cylinder', [.021, .016, 0], [0, side * .032, .08], DARK]);
  }
  return parts;
}

export function composeDuckScene(scene, model = null) {
  const robots = scene.robots || [], hidden = new Set(robots.flatMap((robot) => robot.proxyGeomIds || [])), visuals = [];
  for (const robot of robots) {
    const teamColor = robot.team === 'blue' ? [.12, .42, .86, 1] : robot.team === 'red' ? [.87, .2, .2, 1] : null;
    if (model) {
      const matrices = duckForwardKinematics(model.kinematics, robot, model.visual);
      for (const body of model.kinematics.bodies) for (const geom of body.geoms) {
        const mesh = model.meshes.get(geom.mesh), matrix = multiply(matrices.get(body.name), quaternionMatrix(geom.quat, geom.pos));
        visuals.push({ key: `duck-mesh:${geom.mesh}`, type: 'mesh', name: `${robot.id}:${body.name}:${geom.mesh}`, vertices: mesh.vertices, matrix, linearColor: true, rgba: teamColor && /^(trunk_base|left_shell|right_shell)\.stl$/.test(geom.mesh) ? teamColor : model.visual.palette === 'source' ? geom.color : meshColor(geom.mesh, geom.color), bounds: transformedBounds(mesh.bounds, matrix) });
      }
    } else {
      const yaw = robot.visualYaw || 0;
      const base = multiply(multiply(modelMatrix({ xpos: robot.xpos, xmat: robot.xmat }), translate(robot.footOffset || [0, 0, 0])), quaternionMatrix([Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)]));
      for (const [name, type, size, position, color] of fallbackParts()) {
        const matrix = multiply(base, translate(position)), half = type === 'cylinder' ? [size[0], size[0], size[1]] : size;
        visuals.push({ key: `duck-fallback:${type}:${size.join(',')}`, name: `${robot.id}:${name}`, type, size, matrix, rgba: name === 'trunk' && teamColor ? teamColor : color, bounds: transformedBounds({ low: half.map((n) => -n), high: half }, matrix) });
      }
    }
  }
  const boundsList = [...(scene.bounds?.low && scene.bounds?.high ? [scene.bounds] : []), ...visuals.map((visual) => visual.bounds)];
  let bounds = scene.bounds;
  if (boundsList.length) {
    const low = [0, 1, 2].map((i) => Math.min(...boundsList.map((entry) => entry.low[i]))), high = [0, 1, 2].map((i) => Math.max(...boundsList.map((entry) => entry.high[i])));
    bounds = { low, high, center: low.map((n, i) => (n + high[i]) / 2), radius: Math.hypot(...low.map((n, i) => high[i] - n)) / 2 };
  }
  return { geoms: scene.geoms.filter((geom) => !hidden.has(geom.id)), visuals, bounds, appearance: { phase: model ? 'ready' : 'fallback', model: model ? 'microduck-glb' : 'procedural-mechanical-duck', modelName: model?.visual.name, posture: 'proxy-display-adapter', robotCount: robots.length } };
}

export async function loadDuckAssets(base, origin, fetchAsset = fetch, signal) {
  const url = new URL(base, origin); if (url.origin !== new URL(origin).origin || !/^https?:$/.test(url.protocol)) throw new Error('MicroDuck 外观资源必须与工作台同源。');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  const rigResponse = await fetchAsset(new URL('kinematics.json', url).href, { credentials: 'same-origin', redirect: 'error', signal });
  if (!rigResponse.ok) throw new Error('机器人外观资源未安装，正在使用机械鸭替代外观。');
  const kinematics = await rigResponse.json(), settings = visualSettings(kinematics);
  const meshResponse = await fetchAsset(new URL(settings.meshFile, url).href, { credentials: 'same-origin', redirect: 'error', signal });
  if (!meshResponse.ok) throw new Error('机器人网格资源未安装，正在使用机械鸭替代外观。');
  const binary = await meshResponse.arrayBuffer();
  return prepareDuckModel(parseDuckGlb(binary), kinematics);
}
