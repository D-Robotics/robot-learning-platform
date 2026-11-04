/** Reserve a logical submission before sending it, so an unknown network outcome cannot cause a second POST. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

function privatePath(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    !(directory ? stat.isDirectory() : stat.isFile()) ||
    (process.platform !== 'win32' &&
      (stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())))
  )
    throw Error('提交记录必须保存在当前用户的私有常规路径。');
  if (!directory && stat.size > 4096) throw Error('提交记录超出读取预算。');
}
function readReceipt(file) {
  if (!fs.existsSync(file)) return null;
  privatePath(file);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    value.version !== 1 ||
    typeof value.runId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value.runId)
  )
    throw Error('提交回执格式无效；不会重交。');
  return value.runId;
}
function pathsFor(scope, contextId, phase, directory) {
  const stem = createHash('sha256')
    .update(JSON.stringify([scope, contextId, phase]))
    .digest('hex');
  return {
    attempt: path.join(directory, stem + '.attempt.json'),
    receipt: path.join(directory, stem + '.receipt.json'),
  };
}
const defaultDirectory = () =>
  path.join(os.homedir(), '.config', 'rdk-robot-learning-platform', 'experiments');
export async function recoverSubmission({
  scope,
  contextId,
  phase,
  directory = defaultDirectory(),
  remember,
}) {
  if (!fs.existsSync(directory)) return null;
  privatePath(directory, true);
  const { attempt, receipt } = pathsFor(scope, contextId, phase, directory);
  if (!fs.existsSync(attempt)) return null;
  privatePath(attempt);
  const runId = readReceipt(receipt);
  if (runId)
    return {
      alreadySubmitted: true,
      recoveredReceipt: true,
      submission: { runId },
      experiment: await remember(runId),
    };
  throw Object.assign(
    new Error(
      '上次提交结果尚待确认；请保留本实验标识，先查询原任务。不会因断线、超时或重复点击而再次提交。',
    ),
    {
      platformCode: 'SUBMISSION_RESULT_UNKNOWN',
      details: {
        contextId,
        idempotencyKey: contextId + (phase === 'train' ? '-train' : '-eval'),
        submitted: 'unknown',
        nextAction: '按本组标识查询平台原Run；确认前不要换键重交。',
      },
    },
  );
}
export async function submitOnce({
  scope,
  contextId,
  phase,
  directory = defaultDirectory(),
  submit,
  remember,
}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  privatePath(directory, true);
  const key = contextId + (phase === 'train' ? '-train' : '-eval');
  const { attempt, receipt } = pathsFor(scope, contextId, phase, directory);
  let duplicate = false;
  try {
    fs.writeFileSync(attempt, JSON.stringify({ version: 1, idempotencyKey: key }), {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    privatePath(attempt);
    duplicate = true;
  }
  if (duplicate) return recoverSubmission({ scope, contextId, phase, directory, remember });
  let submission;
  try {
    submission = await submit();
  } catch (error) {
    error.details = {
      ...error.details,
      contextId,
      idempotencyKey: key,
      submissionAttempted: true,
      nextAction: '保留原错误和本实验标识；提交结果未知时先查询原任务，不重复发送。',
    };
    throw error;
  }
  if (
    typeof submission?.runId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(submission.runId)
  )
    throw Object.assign(new Error('平台未返回明确Run ID，提交结果尚待确认；不会重交。'), {
      platformCode: 'SUBMISSION_RESULT_UNKNOWN',
      details: { contextId, idempotencyKey: key },
    });
  try {
    fs.writeFileSync(receipt, JSON.stringify({ version: 1, runId: submission.runId }), {
      mode: 0o600,
      flag: 'wx',
    });
    return { submission, experiment: await remember(submission.runId) };
  } catch (error) {
    throw Object.assign(
      new Error('Run已提交，但本地引用保存未完成；请按返回的Run ID查询并恢复引用，不要重新提交。'),
      {
        platformCode: 'SUBMISSION_REFERENCE_SAVE_FAILED',
        details: {
          contextId,
          runId: submission.runId,
          submitted: true,
          reason: error.code ?? 'reference-not-saved',
        },
      },
    );
  }
}
