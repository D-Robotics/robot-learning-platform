/** Resolve the current learner's course assets without using another Run as a prerequisite. */
import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function same(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function selectionError(code, message, records) {
  return Object.assign(new Error(message), {
    platformCode: code,
    stopWorkflow: code === 'WORKSHOP_MODEL_CONTRACT_MISMATCH',
    nextAction:
      code === 'WORKSHOP_MODEL_CONTRACT_MISMATCH'
        ? '立即结束本轮训练流程并说明课程版本不匹配；不重复调用短训、查询文档、拼装manifest、登记替代模型或改用training_submit。'
        : '按名称询问用户选择一项，保留同一实验标识；不要默认选第一项。',
    details: {
      choices: records.map((r) => ({ id: r.id, name: r.name || r.manifest?.displayName || r.id })),
    },
  });
}
export async function selectCourseAssets(
  { manifest, modelId, computeResourceId, readModels },
  call,
) {
  const result = await (readModels ? readModels() : call('rdk_models_list', {}));
  if (!Array.isArray(result?.models))
    throw new Error('平台未返回明确的模型清单，不登记模型或提交训练。');
  const models = result.models;
  const courseModels = models.filter(
    (record) =>
      record.manifest?.modelId === manifest.modelId &&
      record.manifest?.version === manifest.version &&
      same(record.manifest.contract, manifest.contract) &&
      same(record.manifest.robot, manifest.robot) &&
      record.manifest.simulator?.backends?.includes('local'),
  );
  const conflicting = models.filter(
    (record) =>
      record.manifest?.modelId === manifest.modelId &&
      record.manifest?.version === manifest.version &&
      !courseModels.includes(record),
  );
  if (conflicting.length)
    throw selectionError(
      'WORKSHOP_MODEL_CONTRACT_MISMATCH',
      '课程材料与当前平台版本不一致，本次尚未提交训练。请课程维护者更新插件；学员无需修改模型或参数。',
      conflicting,
    );
  if (models.some((record) => !record.manifest && !record.builtin))
    throw new Error('模型清单缺少完整manifest，不能按ID猜测；请更新完整插件连接后重试。');
  let model;
  if (modelId) {
    model = courseModels.find((record) => record.id === modelId);
    if (!model) throw new Error('所选模型不属于当前账号可见且契约匹配的OriginMan课程模型。');
  } else if (courseModels.length > 1) {
    throw selectionError(
      'WORKSHOP_MODEL_SELECTION_REQUIRED',
      '发现多个课程模型，请选择本轮使用的模型。',
      courseModels,
    );
  } else model = courseModels[0];

  const resourceList = await call('rdk_compute_resources_list', {});
  if (!Array.isArray(resourceList?.computeResources))
    throw new Error('平台未返回明确的资源清单，不登记模型或提交训练。');
  const resources = resourceList.computeResources;
  if (!computeResourceId)
    throw selectionError(
      'WORKSHOP_RESOURCE_SELECTION_REQUIRED',
      '请选择本轮使用的算力机。可以先说“查看我的开发机”。',
      resources,
    );
  const resource = resources.find((record) => record.id === computeResourceId);
  if (!resource) throw new Error('所选执行资源当前账号不可见；不会换用其他资源。');
  return { model, resource };
}
export async function registerCourseModel(manifest, call) {
  const digest = createHash('sha256')
    .update(JSON.stringify(canonical(manifest)))
    .digest('hex');
  const registered = await call('rdk_model_register', {
    manifest,
    idempotencyKey: 'originman-course-' + digest,
  });
  if (!registered?.id || registered.contractId !== manifest.contract.id)
    throw new Error('平台未返回明确的课程模型与契约；不提交训练，也不更换登记键重试。');
  return registered;
}
