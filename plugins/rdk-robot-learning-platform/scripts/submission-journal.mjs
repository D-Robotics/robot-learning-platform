/** Reserve a logical submission before sending it, so an unknown network outcome cannot cause a second POST. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const MAX_RECEIPT_BYTES = 4 * 1024;
// Progress accumulates round evidence. Historical production records already exceed the receipt budget.
const MAX_GOAL_PROGRESS_BYTES = 2 * 1024 * 1024;

function privatePath(file, directory = false, maxBytes = MAX_RECEIPT_BYTES) {
  const stat = fs.lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    !(directory ? stat.isDirectory() : stat.isFile()) ||
    (process.platform !== 'win32' &&
      (stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())))
  )
    throw Error('提交记录必须保存在当前用户的私有常规路径。');
  if (!directory && stat.size > maxBytes) throw Error('提交记录超出读取预算。');
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
export function bindTrainingGoal({
  account,
  audience,
  contextId,
  goalDigest,
  directory = defaultDirectory(),
}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  privatePath(directory, true);
  const stem = createHash('sha256')
    .update(JSON.stringify([account, audience, contextId]))
    .digest('hex');
  const file = path.join(directory, stem + '.goal.sha256');
  try {
    fs.writeFileSync(file, goalDigest, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    privatePath(file);
    if (fs.readFileSync(file, 'utf8') !== goalDigest)
      throw Error('这个实验标识已绑定另一份目标或预算。请按原参数继续。');
  }
}

export function openTrainingGoalJournal({
  account,
  audience,
  contextId,
  directory = defaultDirectory(),
}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  privatePath(directory, true);
  const key = createHash('sha256')
    .update(JSON.stringify([account, audience, contextId]))
    .digest('hex');
  const draft = path.join(directory, key + '.goal-plan.json');
  const progress = path.join(directory, key + '.goal-progress.json');
  const read = (file) => {
    if (!fs.existsSync(file)) return null;
    privatePath(file, false, file === progress ? MAX_GOAL_PROGRESS_BYTES : MAX_RECEIPT_BYTES);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const write = (file, value, exclusive) => {
    const contents = JSON.stringify(value);
    const maxBytes = file === progress ? MAX_GOAL_PROGRESS_BYTES : MAX_RECEIPT_BYTES;
    if (Buffer.byteLength(contents) > maxBytes) throw Error('提交记录超出写入预算。');
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, contents, { flag: 'wx', mode: 0o600 });
      if (exclusive) {
        try {
          fs.linkSync(temp, file);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      } else fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  };
  return {
    register(args) {
      write(draft, args, true);
      return read(draft);
    },
    plan: () => read(draft),
    progress: () => read(progress),
    continueAfter(runId, { automatic = false } = {}) {
      const previous = read(progress);
      const continuedAfter = previous?.continuedAfter ?? [];
      if (continuedAfter.includes(runId))
        return !automatic || previous.automaticAfter === runId ? 'reused' : 'conflict';
      const last = previous?.rounds.at(-1);
      if (
        previous?.state !== 'budget-exhausted' ||
        last?.runId !== runId ||
        last.state !== 'failed'
      )
        return 'conflict';
      write(
        progress,
        {
          ...previous,
          state: 'waiting',
          reason: automatic ? '已开启自动续跑，正在准备下一轮。' : '正在准备下一轮训练。',
          continuedAfter: [...continuedAfter, runId],
          ...(automatic && { automaticAfter: runId }),
        },
        false,
      );
      return 'started';
    },
    save(value, revision = 0) {
      const previous = read(progress);
      const continuedAfter = previous?.continuedAfter ?? [];
      if (
        previous &&
        (previous.state !== 'waiting' ||
          previous.spentSteps > value.spentSteps ||
          continuedAfter.length !== revision)
      )
        return previous;
      const next = {
        ...value,
        ...(continuedAfter.length && { continuedAfter }),
        ...(previous?.automaticAfter && { automaticAfter: previous.automaticAfter }),
      };
      write(progress, next, false);
      return next;
    },
  };
}

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
          phase,
          reason: error.code ?? 'reference-not-saved',
        },
      },
    );
  }
}
