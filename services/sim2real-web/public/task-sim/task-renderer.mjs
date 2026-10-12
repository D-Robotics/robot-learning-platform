import { clamp, fitCameraBounds, lookAt, modelMatrix, multiply, perspective, primitive } from './task-sim-core.mjs';
import { composeDuckScene, duckCameraAzimuth, loadDuckAssets } from './duck-visual.mjs';

export function createRenderer(canvas, { duckAssetBase, onAppearance = () => {} } = {}) {
  const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
  if (!gl) throw new Error('浏览器无法创建 WebGL。请启用硬件加速后重试。');
  const shader = (type, source) => {
    const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `attribute vec3 position; attribute vec3 normal; uniform mat4 model; uniform mat4 viewProjection; varying vec3 worldPosition; varying vec3 worldNormal; void main(){ vec4 world = model * vec4(position, 1.0); worldPosition = world.xyz; worldNormal = mat3(model) * normal; gl_Position = viewProjection * world; }`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `precision mediump float; uniform vec4 color; uniform float floorGrid; uniform float linearColor; varying vec3 worldPosition; varying vec3 worldNormal; void main(){ float diffuse = max(dot(normalize(worldNormal), normalize(vec3(-0.35,-0.55,1.0))), 0.0); float tile = mod(floor(worldPosition.x*2.0)+floor(worldPosition.y*2.0),2.0); float grid = mix(1.0, mix(0.92,1.0,tile),floorGrid); vec3 lit=color.rgb*(0.44+diffuse*0.56)*grid; vec3 corrected=mix(1.055*pow(max(lit,vec3(0.0)),vec3(1.0/2.4))-0.055,lit*12.92,step(lit,vec3(0.0031308))); vec3 display=mix(lit,corrected,linearColor); float fog=clamp(length(worldPosition.xy)*0.006,0.0,0.12); gl_FragColor=vec4(mix(display,vec3(0.94,0.94,0.92),fog),color.a); }`));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program); gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const locations = Object.fromEntries(['model', 'viewProjection', 'color', 'floorGrid', 'linearColor'].map((name) => [name, gl.getUniformLocation(program, name)]));
  const position = gl.getAttribLocation(program, 'position'), normal = gl.getAttribLocation(program, 'normal');
  const meshes = new Map();
  let scene = null, prepared = null, drawItems = [], duckModel = null, azimuth = -1.1, elevation = .48, distance = 4, target = [0, 0, .4], stopped = false;
  let appearance = { phase: 'loading', model: 'procedural-mechanical-duck', posture: 'proxy-display-adapter', message: '正在加载 MicroDuck 外观；当前先显示机械鸭替代外观。' };
  const assetController = new AbortController();
  const reportAppearance = (next) => { appearance = next; try { onAppearance({ ...next }); } catch { /* Appearance text must not interrupt physical task controls. */ } };
  const prepareScene = () => { if (!scene) return; prepared = composeDuckScene(scene, duckModel); drawItems = [...prepared.geoms.map((geom) => ({ ...geom, key: `${geom.type}:${geom.size.join(',')}`, matrix: modelMatrix(geom) })), ...prepared.visuals].sort((a, b) => (b.rgba?.[3] ?? 1) - (a.rgba?.[3] ?? 1)); };
  let drag = null;
  let autoFit = true, fitAspect = 0;
  const fit = () => { if (!prepared) return; azimuth = duckCameraAzimuth(scene.robots); elevation = .48; fitAspect = Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight); ({ target, distance } = fitCameraBounds(prepared.bounds, fitAspect, azimuth, elevation)); autoFit = true; };
  const pointerDown = (event) => { autoFit = false; drag = [event.clientX, event.clientY]; canvas.setPointerCapture(event.pointerId); };
  const pointerMove = (event) => { if (!drag) return; azimuth -= (event.clientX - drag[0]) * .008; elevation = clamp(elevation + (event.clientY - drag[1]) * .006, .08, 1.48); drag = [event.clientX, event.clientY]; };
  const pointerUp = () => { drag = null; };
  const wheel = (event) => { event.preventDefault(); autoFit = false; distance = clamp(distance * Math.exp(event.deltaY * .001), .2, 100); };
  canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove); canvas.addEventListener('pointerup', pointerUp); canvas.addEventListener('pointercancel', pointerUp); canvas.addEventListener('wheel', wheel, { passive: false }); canvas.addEventListener('dblclick', fit);
  let animation;
  const draw = () => {
    if (stopped) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio)), height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height); gl.clearColor(.965, .961, .941, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (scene) {
      if (autoFit && Math.abs(width / height - fitAspect) > .001) { fitAspect = width / height; ({ target, distance } = fitCameraBounds(prepared.bounds, fitAspect, azimuth, elevation)); }
      const eye = [target[0] + distance * Math.cos(elevation) * Math.cos(azimuth), target[1] + distance * Math.cos(elevation) * Math.sin(azimuth), target[2] + distance * Math.sin(elevation)];
      gl.uniformMatrix4fv(locations.viewProjection, false, multiply(perspective(width / height), lookAt(eye, target)));
      for (const geom of drawItems) {
        if (geom.rgba?.[3] === 0) continue;
        const key = geom.key;
        let mesh = meshes.get(key);
        if (!mesh) {
          const vertices = geom.vertices || primitive(geom.type, geom.size); const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW); mesh = { buffer, count: vertices.length / 6 }; meshes.set(key, mesh);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer); gl.enableVertexAttribArray(position); gl.enableVertexAttribArray(normal); gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 24, 0); gl.vertexAttribPointer(normal, 3, gl.FLOAT, false, 24, 12);
        gl.uniformMatrix4fv(locations.model, false, geom.matrix); gl.uniform4fv(locations.color, geom.rgba || [.6, .6, .6, 1]); gl.uniform1f(locations.floorGrid, geom.type === 'plane' ? 1 : 0); gl.uniform1f(locations.linearColor, geom.linearColor ? 1 : 0); gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
      }
    }
    animation = requestAnimationFrame(draw);
  };
  draw();
  reportAppearance(appearance);
  const assetTimer = setTimeout(() => assetController.abort(), 10000);
  const assetBase = duckAssetBase || new URL('../mujoco/microduck/robot/mjlab/', document.baseURI).href;
  void loadDuckAssets(assetBase, location.origin, fetch, assetController.signal).then((model) => {
    if (stopped) return; duckModel = model; prepareScene(); if (autoFit) fit();
    reportAppearance({ phase: 'ready', model: 'microduck-glb', modelName: model.visual.name, posture: 'proxy-display-adapter', message: '已加载机器人本体外观；姿态为任务代理通道的显示适配。' });
  }).catch((error) => {
    if (!stopped) reportAppearance({ phase: 'fallback', model: 'procedural-mechanical-duck', posture: 'proxy-display-adapter', message: `MicroDuck 外观加载失败，正在显示机械鸭替代外观：${error.message}` });
  }).finally(() => clearTimeout(assetTimer));
  return {
    setScene(next, { resetCamera = false } = {}) { scene = next; prepareScene(); if (resetCamera) fit(); },
    getAppearance() { return { ...appearance }; },
    fit,
    destroy() { stopped = true; clearTimeout(assetTimer); assetController.abort(); cancelAnimationFrame(animation); canvas.removeEventListener('pointerdown', pointerDown); canvas.removeEventListener('pointermove', pointerMove); canvas.removeEventListener('pointerup', pointerUp); canvas.removeEventListener('pointercancel', pointerUp); canvas.removeEventListener('wheel', wheel); canvas.removeEventListener('dblclick', fit); for (const mesh of meshes.values()) gl.deleteBuffer(mesh.buffer); gl.deleteProgram(program); },
  };
}
