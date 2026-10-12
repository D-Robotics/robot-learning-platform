/**
 * Intent-based first-use guidance, shared by the classic browser script and
 * behavior tests. This module describes actions; it never runs, trains, or
 * deploys anything. Completion comes only from explicit evidence in `input`.
 *
 * `plan(input)` accepts intent (`experience`, `device`, or `model`), productId,
 * productName, and boolean evidence fields. Only literal `true` counts as
 * evidence. An omitted browserAvailable is unknown; literal `false` means the
 * browser simulator was checked and is unavailable. The caller owns fetching,
 * persistence, escaping text, disabling actions while loading, and executing
 * action keys after a user click.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SimFirstUseCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  function action(key, label) {
    return { key, label };
  }

  function step(key, title, description, done, nextAction) {
    return { key, title, description, done: done === true, action: nextAction };
  }

  function experiencePlan(input) {
    const microduck = input.productId === 'microduck';
    const exampleReady = microduck && input.browserAvailable === true;
    const recorded = input.recordingReady === true;
    const reviewed = recorded && input.recordingReviewed === true;
    const productName =
      typeof input.productName === 'string' && input.productName.trim()
        ? input.productName.trim()
        : '当前机器人';
    const begin = action(
      'begin-experience',
      microduck ? '打开示例并录制动作' : '切换示例并开始体验',
    );
    const replay = action('replay-experience', reviewed ? '再次查看记录' : '回看这段记录');
    const install = action('simulator-help', '查看示例安装指引');
    const unavailable = microduck && input.browserAvailable === false;
    const nextAction = unavailable ? install : !exampleReady ? begin : recorded ? replay : begin;

    return {
      title: reviewed ? '已完成动作录制与记录检查' : '先体验：录下动作，再回看记录',
      description: unavailable
        ? 'MicroDuck 浏览器示例暂时不可用。先按安装指引准备示例，再录制动作。'
        : !microduck
          ? '当前选择的是' + productName + '。首次体验会切换到 MicroDuck 示例机器人。'
          : reviewed
            ? '你已经录下动作并检查了采样记录，可以再次查看记录或继续了解模型训练。'
            : '打开 MicroDuck 示例，操作机器人、录下动作，然后查看这段动作的采样时间轴。',
      note: '这段体验无需连接设备或准备训练服务器。记录暂存在当前页面，刷新前可在示例中导出。',
      action: nextAction,
      steps: [
        step(
          'simulate',
          '准备示例机器人',
          exampleReady
            ? 'MicroDuck 浏览器示例已可用，打开后即可开始操作。'
            : unavailable
              ? '先查看安装指引，准备可打开的 MicroDuck 浏览器示例。'
              : '选择 MicroDuck 示例机器人，检查浏览器示例是否可用。',
          exampleReady,
          unavailable ? install : action('begin-experience', '打开示例机器人'),
        ),
        step(
          'train',
          '录下一段动作',
          recorded
            ? '已保存本次体验录下的动作。'
            : '在示例中点击开始录制，操作机器人，再停止录制并保存。',
          recorded,
          action('begin-experience', recorded ? '再录一段动作' : '打开动作录制'),
        ),
        step(
          'evaluate',
          '回看动作记录',
          reviewed
            ? '已完整查看本次录制的采样时间轴。'
            : recorded
              ? '打开采样时间轴，检查这段记录；此处回看数据，不重演三维动作。'
              : '先保存一段录制，再查看同一段记录的采样时间轴。',
          reviewed,
          replay,
        ),
        step(
          'deploy',
          '完成体验',
          reviewed
            ? '已完成浏览器中的录制与记录检查。接下来可以了解如何用动作数据训练模型。'
            : '录下动作并完整播放记录的采样时间轴，就完成这次浏览器体验。',
          reviewed,
          recorded ? replay : begin,
        ),
      ],
    };
  }

  function devicePlan(input) {
    const hasDevice = input.hasDevice === true;
    const connected = input.deviceConnected === true;
    const compatible = input.contractValid === true;
    const checked = input.preflightReady === true;
    const deviceAction = action('device-setup', hasDevice ? '连接我的设备' : '查看如何添加设备');
    const modelAction =
      input.hasModel === true
        ? action('model-check', '检查模型兼容性')
        : action('model-import', '导入模型说明');
    const preflightAction = action('device-preflight', '检查设备使用条件');
    const recordsAction = action('records', '查看设备预检记录');
    const nextAction =
      !hasDevice || !connected
        ? deviceAction
        : !compatible
          ? modelAction
          : !checked
            ? preflightAction
            : recordsAction;

    return {
      title: checked ? '设备预检已通过' : '我有设备：先连接，再检查使用条件',
      description: !hasDevice
        ? '先查看设备接入方式，再添加你要使用的设备。'
        : !connected
          ? '设备已添加，连接成功后再检查模型能否使用。'
          : !compatible
            ? '设备已连接。接下来登记模型说明，检查模型与设备是否匹配。'
            : !checked
              ? '连接和模型兼容性已检查，可以继续完成设备预检。'
              : '已完成设备连接、模型兼容性与使用条件检查，可以查看检查记录。',
      note: '设备预检只检查使用条件，不会启动机器人。实际部署需要之后单独确认。',
      action: nextAction,
      steps: [
        step(
          'simulate',
          '查看我的设备',
          hasDevice ? '已有设备记录，可查看连接方式。' : '了解接入方式，添加你要使用的设备。',
          hasDevice,
          action('device-setup', '查看我的设备'),
        ),
        step(
          'train',
          '连接设备',
          connected ? '服务已确认设备连接成功。' : '按连接指引操作，等待平台确认设备在线。',
          connected,
          deviceAction,
        ),
        step(
          'evaluate',
          '检查模型兼容性',
          compatible ? '模型兼容性检查已通过。' : '登记模型说明，检查模型输入输出与设备是否匹配。',
          compatible,
          modelAction,
        ),
        step(
          'deploy',
          '完成设备预检',
          checked
            ? '只读设备预检已通过，可以查看检查记录。'
            : '检查连接和模型等条件，查看仍需准备的事项。',
          checked,
          checked ? recordsAction : preflightAction,
        ),
      ],
    };
  }

  function modelPlan(input) {
    const imported = input.hasModel === true;
    const compatible = input.contractValid === true;
    const trained = input.trainingReady === true;
    const evaluated = input.evaluationReady === true;
    const hasResult = trained || evaluated;
    const checked = input.preflightReady === true;
    const importAction = action('model-import', '导入模型说明');
    const checkAction = action('model-check', '检查模型兼容性');
    const resultAction = evaluated
      ? action('evaluate', '查看评测结果')
      : action('train-setup', trained ? '查看训练结果' : '了解训练步骤');
    const preflightAction = action('device-preflight', '查看设备预检条件');
    const recordsAction = action('records', '查看设备预检记录');
    const nextAction = !imported
      ? importAction
      : !compatible
        ? checkAction
        : !hasResult
          ? resultAction
          : !checked
            ? preflightAction
            : recordsAction;

    return {
      title: checked ? '模型的设备预检已通过' : '我有模型：导入后检查能否使用',
      description: !imported
        ? '先导入模型说明，登记输入、输出和设备要求，平台会检查是否能用于当前机器人。'
        : !compatible
          ? '模型已登记。先检查模型输入输出与当前机器人是否匹配。'
          : !hasResult
            ? '兼容性已检查。接下来了解训练步骤；有实际结果后再查看训练或评测记录。'
            : !checked
              ? '已有' +
                (evaluated ? '评测' : '训练') +
                '结果。连接设备后，可继续查看设备预检条件。'
              : '设备预检已通过，可以查看检查记录并了解之后的部署步骤。',
      note: '模型说明与模型文件分开登记。兼容性检查和设备预检都不会启动机器人；训练、评测和实际部署需分别操作。',
      action: nextAction,
      steps: [
        step(
          'simulate',
          '登记模型说明',
          imported ? '已登记你的模型说明。' : '导入模型说明文件，填写输入、输出和设备要求。',
          imported,
          importAction,
        ),
        step(
          'train',
          '检查兼容性',
          compatible ? '模型兼容性检查已通过。' : '检查模型输入输出是否与当前机器人匹配。',
          compatible,
          checkAction,
        ),
        step(
          'evaluate',
          '查看训练或评测结果',
          evaluated
            ? '已有评测结果，可以查看模型表现。'
            : trained
              ? '已有训练结果，尚未确认有评测结果。'
              : '目前没有训练或评测结果，先了解训练需要的条件。',
          hasResult,
          resultAction,
        ),
        step(
          'deploy',
          '完成设备预检',
          checked
            ? '只读设备预检已通过，可以查看检查记录。'
            : '连接设备后，检查模型能否在设备上使用，并查看待准备的条件。',
          checked,
          checked ? recordsAction : preflightAction,
        ),
      ],
    };
  }

  function plan(value) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const intent =
      input.intent === 'device' || input.intent === 'model' ? input.intent : 'experience';
    const result =
      intent === 'device'
        ? devicePlan(input)
        : intent === 'model'
          ? modelPlan(input)
          : experiencePlan(input);

    if (input.loading === true) {
      result.description = '正在检查服务与当前使用条件，请稍候。';
      result.action = action('refresh', '正在检查使用条件');
    } else if (input.serviceError === true) {
      result.description = '暂时无法读取服务状态。重新连接后，可以继续当前步骤。';
      result.action = action('refresh', '重新连接');
    } else if (intent !== 'experience' && input.authRequired === true) {
      result.description = '登录后可以查看你的模型和设备，并继续当前步骤。';
      result.action = action('login', '登录并继续');
    }

    return result;
  }

  return Object.freeze({ plan });
});
