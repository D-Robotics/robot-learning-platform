import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  composeDuckScene,
  DEFAULT_DUCK_POSE,
  duckForwardKinematics,
  duckCameraAzimuth,
  linearToSrgb,
  loadDuckAssets,
  parseDuckGlb,
  prepareDuckModel,
} from './public/task-sim/duck-visual.mjs';
import { createRenderer } from './public/task-sim/task-renderer.mjs';

function triangleGlb(index = 2) {
  const binary = Buffer.alloc(44);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, i) => binary.writeFloatLE(value, i * 4));
  [0, 1, index].forEach((value, i) => binary.writeUInt16LE(value, 36 + i * 2));
  const document = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 44 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [
      { name: 'triangle.stl', primitives: [{ mode: 4, attributes: { POSITION: 0 }, indices: 1 }] },
    ],
  };
  const json = Buffer.from(JSON.stringify(document)),
    padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
  json.copy(padded);
  const result = Buffer.alloc(12 + 8 + padded.length + 8 + binary.length);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + padded.length);
  result.writeUInt32LE(0x004e4942, 24 + padded.length);
  binary.copy(result, 28 + padded.length);
  return result;
}
const testKinematics = () => ({
  bodies: [
    {
      name: 'trunk_base',
      parent: null,
      pos: [0, 0, 0.12],
      quat: [1, 0, 0, 0],
      joint: null,
      geoms: [],
    },
    {
      name: 'child',
      parent: 'trunk_base',
      pos: [0.1, 0, 0],
      quat: [1, 0, 0, 0],
      joint: { type: 'hinge', axis: [0, 0, 1], pos: [0, 0, 0], range: [-2, 2], actuator_index: 0 },
      geoms: [
        {
          type: 'mesh',
          mesh: 'triangle.stl',
          pos: [0, 0, 0],
          quat: [1, 0, 0, 0],
          color: [1, 1, 1, 1],
        },
      ],
    },
  ],
});

test('GLB triangle indices expand POSITION into lit vertices without requiring NORMAL', () => {
  const mesh = parseDuckGlb(triangleGlb()).get('triangle.stl');
  assert.equal(mesh.vertices.length, 18);
  assert.deepEqual(
    Array.from(mesh.vertices),
    [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1],
  );
  assert.deepEqual(mesh.bounds, { low: [0, 0, 0], high: [1, 1, 0] });
  assert.throws(() => parseDuckGlb(triangleGlb(500)), /索引越界/);
  assert.throws(() => parseDuckGlb(Buffer.alloc(32)), /文件头/);
});

test('FK preserves root floor offset, physical base rotation and separate visual yaw calibration', () => {
  const kinematics = testKinematics(),
    model = prepareDuckModel(parseDuckGlb(triangleGlb()), kinematics);
  const robot = {
    xpos: [1, 2, 0.18],
    xmat: [0, -1, 0, 1, 0, 0, 0, 0, 1],
    footOffset: [0, 0, -0.18],
    visualYaw: Math.PI / 2,
    posture: [1, ...Array(13).fill(0)],
  };
  const matrices = duckForwardKinematics(model.kinematics, robot),
    root = matrices.get('trunk_base'),
    child = matrices.get('child');
  assert.ok(Math.abs(root[14] - 0.12) < 1e-6);
  assert.ok(Math.abs(root[12] - 1) < 1e-6);
  assert.ok(Math.abs(root[13] - 2) < 1e-6);
  assert.ok(Math.abs(child[12] - 0.9) < 1e-6);
  assert.ok(Math.abs(child[0] + Math.cos(0.35)) < 1e-6);
  assert.ok(Math.abs(child[1] + Math.sin(0.35)) < 1e-6);
  assert.throws(() => duckForwardKinematics(kinematics, { posture: [NaN] }), /有限数值/);
});

test('custom robot rig uses its own joint mapping, neutral pose, name and source palette', () => {
  const kinematics = testKinematics();
  kinematics.bodies[1].joint.actuator_index = 17;
  kinematics.bodies[1].geoms[0].color = [0.2, 0.4, 0.6, 1];
  kinematics.visualModel = {
    displayName: 'Our Duck',
    meshFile: 'our-duck.glb',
    palette: 'source',
    defaultPose: [...Array(17).fill(0), 0.25],
    postureMap: [...Array(17).fill(-1), 2],
    postureScale: 0.6,
  };
  const model = prepareDuckModel(parseDuckGlb(triangleGlb()), kinematics);
  const robot = { id: 'our-duck', proxyGeomIds: [], posture: [0, 0, 0.5] };
  const composed = composeDuckScene({ robots: [robot], geoms: [] }, model);
  assert.equal(composed.appearance.modelName, 'Our Duck');
  assert.deepEqual(composed.visuals[0].rgba, [0.2, 0.4, 0.6, 1]);
  assert.ok(Math.abs(composed.visuals[0].matrix[0] - Math.cos(0.55)) < 1e-6);
  assert.throws(
    () =>
      prepareDuckModel(model.meshes, {
        ...kinematics,
        visualModel: { ...kinematics.visualModel, defaultPose: [0] },
      }),
    /默认关节/,
  );
});

test('custom robot mesh remains in the reviewed same-origin directory', async () => {
  const urls = [],
    kinematics = testKinematics();
  kinematics.visualModel = { displayName: 'Own Duck', meshFile: 'own-duck.glb' };
  const fetchAsset = async (url, options) => {
    urls.push(url);
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => kinematics, arrayBuffer: async () => triangleGlb() };
  };
  await loadDuckAssets('/robot-visuals/own-duck/', 'https://platform.example', fetchAsset);
  assert.deepEqual(urls, [
    'https://platform.example/robot-visuals/own-duck/kinematics.json',
    'https://platform.example/robot-visuals/own-duck/own-duck.glb',
  ]);
  urls.length = 0;
  kinematics.visualModel.meshFile = '../private.glb';
  await assert.rejects(
    loadDuckAssets('/robot-visuals/own-duck/', 'https://platform.example', fetchAsset),
    /本目录/,
  );
  assert.equal(urls.length, 1);
});

test('mechanical duck fallback replaces only explicit proxy IDs and retains the physical football', () => {
  const scene = {
    geoms: [
      { id: 7, name: 'duck_body', type: 'sphere' },
      { id: 8, name: 'ball', type: 'sphere' },
      { id: 9, name: 'field', type: 'plane' },
    ],
    bounds: { low: [-0.1, -0.1, 0], high: [0.1, 0.1, 0.1] },
    robots: [
      {
        id: 'duck0',
        bodyId: 1,
        proxyGeomIds: [7],
        xpos: [0, 0, 0.18],
        xmat: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        footOffset: [0, 0, -0.18],
        team: 'blue',
        posture: null,
      },
    ],
  };
  const before = structuredClone(scene),
    composed = composeDuckScene(scene);
  assert.deepEqual(
    composed.geoms.map((geom) => geom.name),
    ['ball', 'field'],
  );
  assert.deepEqual(scene, before);
  for (const part of ['head', 'beak', 'eye--1', 'eye-1', 'leg--1', 'leg-1', 'foot--1', 'foot-1'])
    assert.ok(composed.visuals.some((visual) => visual.name.endsWith(`:${part}`)));
  assert.ok(
    composed.visuals
      .filter((visual) => visual.type === 'sphere')
      .every((visual) => /:eye-/.test(visual.name)),
  );
  assert.ok(composed.bounds.high[2] > 0.3);
  assert.equal(composed.appearance.model, 'procedural-mechanical-duck');
  assert.equal(composed.appearance.posture, 'proxy-display-adapter');
});

test('default camera follows a single duck visual calibration and linear orange is displayed as orange', () => {
  const yaw = Math.PI / 2,
    azimuth = duckCameraAzimuth([{ visualYaw: yaw }]);
  assert.ok(Math.abs(azimuth - (-1.1 + yaw)) < 1e-12);
  assert.ok(
    Math.cos(azimuth - yaw) > 0,
    'default camera must look from the forward side of the duck',
  );
  assert.equal(duckCameraAzimuth([{ visualYaw: 0 }]), -1.1);
  assert.equal(duckCameraAzimuth([{ visualYaw: yaw }, { visualYaw: yaw }]), -1.1);
  const orange = [1, 0.144, 0.008].map(linearToSrgb);
  assert.ok(orange[1] > 0.4 && orange[1] < 0.42);
  assert.ok(orange[2] > 0.08 && orange[2] < 0.09);
  assert.ok(Math.abs(linearToSrgb(0.002) - 0.02584) < 1e-12);
});

test('duck assets enforce same origin before either credentialed fetch', async () => {
  let calls = 0;
  await assert.rejects(
    loadDuckAssets('https://other.example/assets/', 'http://localhost', async () => {
      calls++;
    }),
    /同源/,
  );
  assert.equal(calls, 0);
  const model = await loadDuckAssets(
    '/mujoco/microduck/robot/mjlab/',
    'http://localhost',
    async (url, options) => {
      assert.equal(options.credentials, 'same-origin');
      return {
        ok: true,
        arrayBuffer: async () => triangleGlb(),
        json: async () => testKinematics(),
      };
    },
  );
  assert.equal(model.meshes.size, 1);
});

test('renderer keeps a visible mechanical duck and reports fallback when assets are unavailable', async () => {
  const globals = [
    'window',
    'document',
    'location',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'fetch',
  ];
  const previous = new Map(
    globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  let frame,
    draws = 0;
  const uploads = [],
    phases = [];
  const gl = new Proxy(
    {
      getShaderParameter: () => true,
      getProgramParameter: () => true,
      createShader: () => ({}),
      createProgram: () => ({}),
      createBuffer: () => ({}),
      getUniformLocation: (_program, name) => name,
      getAttribLocation: () => 0,
      bufferData: (_target, vertices) => uploads.push(vertices),
      drawArrays: () => {
        draws++;
      },
    },
    { get: (target, name) => target[name] ?? (() => {}) },
  );
  const canvas = {
    clientWidth: 640,
    clientHeight: 480,
    getContext: () => gl,
    addEventListener() {},
    removeEventListener() {},
  };
  Object.assign(globalThis, {
    window: { devicePixelRatio: 1 },
    document: { baseURI: 'http://localhost/task-sim/' },
    location: { origin: 'http://localhost' },
    requestAnimationFrame: (callback) => {
      frame = callback;
      return 1;
    },
    cancelAnimationFrame() {},
    fetch: async () => ({ ok: false }),
  });
  let renderer;
  try {
    renderer = createRenderer(canvas, { onAppearance: ({ phase }) => phases.push(phase) });
    renderer.setScene(
      {
        geoms: [
          { id: 1, type: 'sphere', size: [0.18, 0.18, 0.18], xpos: [0, 0, 0.18] },
          { id: 2, name: 'ball', type: 'sphere', size: [0.07, 0.07, 0.07], xpos: [0.3, 0, 0.07] },
        ],
        bounds: { low: [-0.18, -0.18, 0], high: [0.37, 0.18, 0.36] },
        robots: [{ id: 'duck', proxyGeomIds: [1], xpos: [0, 0, 0.18], footOffset: [0, 0, -0.18] }],
      },
      { resetCamera: true },
    );
    for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
    frame();
    assert.deepEqual(phases, ['loading', 'fallback']);
    assert.equal(renderer.getAppearance().model, 'procedural-mechanical-duck');
    assert.ok(draws > 10);
    const sphereExtents = uploads
      .filter((vertices) => vertices.length === 13824)
      .map((vertices) =>
        Math.max(...Array.from(vertices).filter((_value, index) => index % 6 === 0)),
      );
    assert.ok(sphereExtents.some((radius) => Math.abs(radius - 0.07) < 1e-6));
    assert.ok(
      sphereExtents.every((radius) => radius < 0.1),
      'hidden collider sphere must not enter a GPU buffer',
    );
  } finally {
    renderer?.destroy();
    for (const name of globals) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('actual reviewed MicroDuck asset assembles 38 meshes and 14 joints with feet at the API foot reference', async (t) => {
  const assetRoot = process.env.RDK_SIM2REAL_MICRODUCK_ROOT;
  if (!assetRoot) {
    t.skip('Set RDK_SIM2REAL_MICRODUCK_ROOT to test an installed MicroDuck release.');
    return;
  }
  const base = pathToFileURL(path.resolve(assetRoot, 'robot/mjlab') + path.sep);
  const [binary, kinematics] = await Promise.all([
    readFile(new URL('microduck.glb', base)),
    readFile(new URL('kinematics.json', base), 'utf8').then(JSON.parse),
  ]);
  const model = prepareDuckModel(parseDuckGlb(binary), kinematics);
  assert.equal(model.meshes.size, 38);
  assert.equal(kinematics.bodies.length, 15);
  assert.equal(kinematics.bodies.filter((body) => body.joint).length, 14);
  assert.equal(DEFAULT_DUCK_POSE.length, 14);
  const robot = {
    id: 'duck',
    proxyGeomIds: [1],
    xpos: [0, 0, 0.18],
    footOffset: [0, 0, -0.18],
    posture: null,
  };
  const composed = composeDuckScene(
    {
      geoms: [
        { id: 1, type: 'sphere' },
        { id: 2, name: 'ball', type: 'sphere' },
      ],
      robots: [robot],
    },
    model,
  );
  assert.ok(composed.visuals.length > 50);
  assert.deepEqual(
    composed.geoms.map((geom) => geom.id),
    [2],
  );
  let lowestFoot = Infinity;
  for (const visual of composed.visuals.filter((item) =>
    /:foot_(left|right)\.stl$/.test(item.name),
  ))
    for (let index = 0; index < visual.vertices.length; index += 6) {
      const matrix = visual.matrix,
        z =
          matrix[2] * visual.vertices[index] +
          matrix[6] * visual.vertices[index + 1] +
          matrix[10] * visual.vertices[index + 2] +
          matrix[14];
      lowestFoot = Math.min(lowestFoot, z);
    }
  assert.ok(
    lowestFoot >= -0.005 && lowestFoot <= 0.006,
    `feet must sit on the supplied reference, actual ${lowestFoot}`,
  );
  assert.ok(
    composed.visuals.every(
      (visual) =>
        Array.from(visual.vertices).every(Number.isFinite) &&
        Array.from(visual.matrix).every(Number.isFinite),
    ),
  );
});
