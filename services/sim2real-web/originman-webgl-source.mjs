import * as THREE from 'three';
import { PoseBuffer } from './originman-pose-buffer.mjs';

function unpack(value, Type) {
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  return new Type(bytes.buffer);
}
function quaternion(target, values, offset = 0) {
  return target.set(values[offset + 1], values[offset + 2], values[offset + 3], values[offset]);
}
export function create(canvas, description, onStats, onError, onDisplay = () => {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5));
  renderer.setSize(960, 540, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.78, 0.83, 0.86);
  const camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.01, 20);
  camera.up.set(0, 0, 1);
  let azimuth = 15,
    elevation = -20,
    distance = 0.82,
    dirty = true;
  function setCamera(values = {}) {
    azimuth = values.azimuth ?? azimuth;
    elevation = values.elevation ?? elevation;
    distance = values.distance ?? distance;
    const a = (azimuth * Math.PI) / 180,
      e = (-elevation * Math.PI) / 180;
    camera.position.set(
      distance * Math.cos(e) * Math.cos(a),
      distance * Math.cos(e) * Math.sin(a),
      0.18 + distance * Math.sin(e),
    );
    camera.lookAt(0, 0, 0.18);
    dirty = true;
  }
  setCamera();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x647482, 2.3));
  const key = new THREE.DirectionalLight(0xfff4e5, 3);
  key.position.set(0.5, -0.6, 2);
  key.castShadow = true;
  Object.assign(key.shadow.camera, {
    left: -0.8,
    right: 0.8,
    top: 0.8,
    bottom: -0.8,
    near: 0.1,
    far: 4,
  });
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.normalBias = 0.002;
  key.shadow.bias = -0.0001;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xd9efff, 1.3);
  fill.position.set(-1, 0.5, 1);
  scene.add(fill);
  const bodies = Array.from({ length: description.bodyCount }, () => new THREE.Group());
  bodies.forEach((body) => scene.add(body));
  const geometries = new Map();
  for (const [id, mesh] of Object.entries(description.meshes)) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(unpack(mesh.vertices, Float32Array), 3),
    );
    geometry.setIndex(new THREE.BufferAttribute(unpack(mesh.faces, Uint32Array), 1));
    geometry.computeVertexNormals();
    geometries.set(id, geometry);
  }
  const materials = [];
  for (const geom of description.geoms) {
    let geometry;
    if (geom.type === 7) geometry = geometries.get(String(geom.mesh));
    else if (geom.type === 6) geometry = new THREE.BoxGeometry(...geom.size.map((v) => v * 2));
    else geometry = new THREE.PlaneGeometry(4, 4);
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(...geom.rgba.slice(0, 3)),
      roughness: 0.68,
      metalness: 0.12,
    });
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.fromArray(geom.position);
    quaternion(mesh.quaternion, geom.quaternion);
    mesh.castShadow = geom.type !== 0;
    mesh.receiveShadow = true;
    bodies[geom.body].add(mesh);
  }
  const grid = new THREE.GridHelper(1.6, 16, 0x6b929c, 0xa2b3bc);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = 0.001;
  scene.add(grid);
  const arrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(),
    0.18,
    0xef8b24,
    0.045,
    0.025,
  );
  arrow.visible = false;
  scene.add(arrow);
  const buffer = new PoseBuffer();
  const qa = new THREE.Quaternion(),
    qb = new THREE.Quaternion();
  const va = new THREE.Vector3(),
    vb = new THREE.Vector3(),
    force = new THREE.Vector3();
  let replaySample = null;
  let running = false,
    disposed = false,
    handle,
    previousTime = null,
    moved = 0,
    count = 0,
    measuredAt = performance.now(),
    receivedAt = performance.now();
  canvas.dataset.presentation = 'workshop-webgl-v3';
  canvas.dataset.renderer = 'webgl';
  const contextLost = (event) => {
    event.preventDefault();
    onError('浏览器图形上下文丢失，请重新装载仿真。');
  };
  canvas.addEventListener('webglcontextlost', contextLost);
  function animate(now) {
    if (disposed) return;
    try {
      const sample = replaySample || buffer.sample(now, running);
      if (sample && (running || dirty)) {
        const { a, b, alpha } = sample;
        bodies.forEach((body, index) => {
          const offset = index * 7;
          body.position
            .copy(va.fromArray(a.bodies, offset))
            .lerp(vb.fromArray(b.bodies, offset), alpha);
          quaternion(qa, a.bodies, offset + 3);
          quaternion(qb, b.bodies, offset + 3);
          body.quaternion.copy(qa).slerp(qb, alpha);
        });
        const f = alpha >= 1 ? b : a;
        force.fromArray(f.force);
        arrow.visible = force.lengthSq() > 0.001;
        if (arrow.visible) {
          // Force acts on the floating base; its arrow points toward the torso.
          va.fromArray(f.bodies, 7);
          va.z += 0.12;
          arrow.setDirection(force.normalize());
          arrow.position.copy(va).addScaledVector(force, -0.22);
        }
        onDisplay({ ...f, time: sample.time });
        renderer.render(scene, camera);
        dirty = false;
        count++;
        if (previousTime !== null && sample.time > previousTime + 0.00001) moved++;
        previousTime = sample.time;
        if (now - measuredAt >= 500) {
          const fps = (count * 1000) / (now - measuredAt),
            motionFps = (moved * 1000) / (now - measuredAt);
          const stats = {
            fps,
            motionFps,
            lagMs: sample.lag * 1000,
            stateAgeMs: now - receivedAt,
            stalled: running && now - receivedAt > 500,
          };
          canvas.dataset.renderFps = fps.toFixed(1);
          canvas.dataset.motionFps = motionFps.toFixed(1);
          canvas.dataset.stateAgeMs = stats.stateAgeMs.toFixed(0);
          canvas.dataset.bufferMs = stats.lagMs.toFixed(0);
          onStats(stats);
          count = 0;
          moved = 0;
          measuredAt = now;
        }
      }
    } catch (error) {
      onError(error.message);
      return;
    }
    handle = globalThis.requestAnimationFrame(animate);
  }
  handle = globalThis.requestAnimationFrame(animate);
  return {
    ingest(state, snap = false) {
      buffer.add(state.visuals?.length ? state.visuals : [state.visual], snap);
      receivedAt = performance.now();
      dirty = true;
    },
    setRunning(value) {
      if (running !== value) dirty = true;
      running = value;
      if (!value) {
        buffer.started = false;
      }
    },
    setCamera,
    showFrame(a, b, alpha) {
      replaySample = { a, b, alpha, time: a.time + (b.time - a.time) * alpha, lag: 0 };
      dirty = true;
    },
    clearReplay() {
      replaySample = null;
      dirty = true;
    },
    dispose() {
      disposed = true;
      globalThis.cancelAnimationFrame(handle);
      canvas.removeEventListener('webglcontextlost', contextLost);
      const all = new Set();
      scene.traverse((obj) => {
        if (obj.geometry) all.add(obj.geometry);
      });
      all.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      arrow.line.material.dispose();
      arrow.cone.material.dispose();
      grid.material.dispose();
      renderer.dispose();
    },
  };
}
// Probe with a separate canvas: requesting a 2D context first would lock the live canvas.
export function supported() {
  try {
    const c = globalThis.document.createElement('canvas'),
      gl = c.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}
