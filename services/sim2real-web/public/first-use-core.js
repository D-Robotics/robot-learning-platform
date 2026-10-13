/**
 * Intent-based first-use guidance, shared by the classic browser script and
 * behavior tests. This module describes actions; it never runs, trains, or
 * deploys anything. Completion comes only from explicit evidence in `input`.
 *
 * `plan(input)` accepts intent (`experience`, `train`, `device`, or `model`), productId,
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

  function step(key, title, description, done, nextAction, actionEnabled = true, actionReason = '') {
    return {
      key,
      title,
      description,
      done: done === true,
      action: nextAction,
      actionEnabled: actionEnabled === true,
      actionReason,
    };
  }

  function experiencePlan(input) {
    const microduck = input.productId === 'microduck';
    const exampleReady = microduck && input.browserAvailable === true;
    const recorded = input.recordingReady === true;
    const reviewed = recorded && input.recordingReviewed === true;
    const begin = action('begin-experience', '打开参考仿真');
    const replay = action('replay-experience', reviewed ? '再次回放记录' : '回放采样数据');
    const install = action('simulator-help', '查看仿真安装指引');
    const unavailable = microduck && input.browserAvailable === false;
    const nextAction = unavailable ? install : !exampleReady ? begin : recorded ? replay : begin;

    return {
      title: reviewed
        ? '录制与数据回放已完成'
        : recorded
          ? '动作数据已采集'
          : '浏览器仿真',
      description: unavailable
        ? 'MicroDuck 浏览器示例暂时不可用。先按安装指引准备示例，再录制动作。'
        : reviewed
          ? '本次已完成录制与采样数据回放，可导出记录或继续配置模型训练。'
          : recorded
            ? '本次观测与动作数据已录制。打开记录，回放采样时间轴。'
            : '运行参考仿真，采集观测与动作数据，并回放采样记录。',
      note: microduck
        ? '无需设备或训练服务器。记录暂存在当前页面，刷新前可在示例中导出。'
        : '开始时会切换到 MicroDuck 示例。无需设备或训练服务器。',
      action: nextAction,
      secondaryAction: reviewed ? action('train-setup', '配置模型训练') : null,
      steps: [
        step(
          'simulate',
          '准备仿真场景',
          exampleReady
            ? 'MicroDuck 仿真资源可用，可打开参考场景进行操作。'
            : unavailable
              ? '先查看安装指引，准备可打开的 MicroDuck 浏览器示例。'
              : '选择 MicroDuck 示例机器人，检查浏览器示例是否可用。',
          exampleReady,
          unavailable ? install : action('begin-experience', '打开参考仿真'),
        ),
        step(
          'train',
          '采集动作数据',
          recorded
            ? '已保存本次仿真的观测与动作数据。'
            : '在仿真场景中启动录制，操作机器人，停止录制后保存数据。',
          recorded,
          action('begin-experience', recorded ? '继续采集数据' : '打开动作录制'),
        ),
        step(
          'evaluate',
          '回放采样数据',
          reviewed
            ? '已完整播放本次录制的采样时间轴。'
            : recorded
              ? '打开采样时间轴，回放本次记录；此处展示采样数据，不重演三维动作。'
              : '先保存采集记录，再回放同一份记录的采样时间轴。',
          reviewed,
          replay,
          recorded,
          recorded ? '' : '先采集并保存动作数据，再回放采样记录。',
        ),
        step(
          'deploy',
          '完成录制与回放',
          reviewed
            ? '已完成浏览器中的录制与数据回放。可导出记录或继续配置模型训练。'
            : '保存采集记录并完整播放同一份采样时间轴，完成本次仿真数据流程。',
          reviewed,
          recorded ? replay : begin,
        ),
      ],
    };
  }

  function trainPlan(input) {
    const imported = input.hasModel === true;
    const compatible = imported && input.contractValid === true;
    // A visited setup page is not a saved configuration or a submitted Run.
    const submitted = compatible && input.trainingSubmitted === true;
    const active = submitted && input.trainingActive === true;
    const failed = submitted && input.trainingFailed === true;
    const trained = submitted && !active && !failed && input.trainingReady === true;
    const evaluated = trained && input.evaluationReady === true;
    const importAction = action('model-import', '选择或登记模型');
    const checkAction = action('model-check', '检查模型兼容性');
    const setupAction = action('train-setup', submitted ? '查看训练配置' : '配置训练任务');
    const statusAction = action(
      'train-status',
      failed ? '查看训练错误' : active ? '查看训练进度' : trained ? '查看训练结果' : '查看原训练任务',
    );
    const evaluationAction = evaluated
      ? action('records', '查看训练与评测记录')
      : action('evaluate', '查看模型评测');
    const nextAction = !imported
      ? importAction
      : !compatible
        ? checkAction
        : !submitted
          ? setupAction
          : !trained
            ? statusAction
            : evaluationAction;

    return {
      title: !submitted
        ? '模型训练'
        : failed
          ? '训练任务失败'
          : active
            ? '训练任务排队或运行中'
            : !trained
              ? '训练状态待核对'
              : evaluated
                ? '已有训练与评测记录'
                : '训练结果已生成',
      description: !imported
        ? '先选择或登记模型，检查输入输出要求，再配置训练任务。'
        : !compatible
          ? '模型已选择。先检查模型与当前机器人是否匹配。'
          : !submitted
            ? '兼容性已检查。设置数据、引擎与训练参数，提交后保存任务记录。'
            : failed
              ? '查看原任务的错误和日志，修复问题后再决定是否重新提交。'
              : active
                ? '任务已保存。查看排队或运行进度与日志，等待实际训练结果。'
                : !trained
                  ? '已有任务记录，尚未确认训练结果。先查找原任务和日志，核对状态后再继续。'
                  : evaluated
                    ? '已有训练结果与评测记录，可查看模型表现和本次任务证据。'
                    : '已有实际训练结果。进入评测查看模型表现，评测完成后保存结果记录。',
      note: '训练和评测以保存的任务与结果为准。打开页面不会完成步骤；此流程不会部署或启动设备。',
      action: nextAction,
      steps: [
        step(
          'simulate',
          '选择模型',
          imported ? '已选择模型，可检查输入输出要求。' : '选择已有模型，或登记模型说明。',
          imported,
          importAction,
        ),
        step(
          'train',
          '配置训练',
          submitted
            ? '训练任务已保存，可查看任务使用的配置。'
            : compatible
              ? '配置数据、引擎与训练参数；提交并保存任务后，此步骤才完成。'
              : '先选择模型并检查兼容性，再配置训练任务。',
          submitted,
          !imported ? importAction : !compatible ? checkAction : setupAction,
        ),
        step(
          'evaluate',
          '提交与跟踪',
          trained
            ? '任务已完成并生成实际训练结果，可查看结果和日志。'
            : failed
              ? '任务失败。查看原任务错误和日志，修复后再决定是否重新提交。'
              : active
                ? '任务已排队或正在运行，查看进度与日志。'
                : submitted
                  ? '已有任务记录，训练状态待核对；先查看原任务，避免重复提交。'
                  : '先配置并提交训练任务，再跟踪进度与日志。',
          trained,
          statusAction,
          submitted,
          submitted ? '' : '先提交并保存训练任务，才能查看任务进度。',
        ),
        step(
          'deploy',
          '查看评测',
          evaluated
            ? '已有评测记录，可查看模型表现和对应训练任务。'
            : trained
              ? '已有训练结果，进入评测查看模型表现。'
              : '等待实际训练结果，再进入模型评测。',
          evaluated,
          evaluationAction,
          trained,
          trained ? '' : '需要实际训练结果，才能进入模型评测。',
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
      input.intent === 'device' || input.intent === 'model' || input.intent === 'train'
        ? input.intent
        : 'experience';
    const result =
      intent === 'device'
        ? devicePlan(input)
        : intent === 'model'
          ? modelPlan(input)
          : intent === 'train'
            ? trainPlan(input)
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
