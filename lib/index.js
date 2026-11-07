import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const name = 'dictator-lieutenants';
export const inject = ['subagents', 'tools', 'workingDirectory'];

const PLUGIN_VERSION = '0.1.0';
const DEFAULT_PROVIDER = 'spawn';
const MAX_WORKSTREAMS = 8;
const MAX_TASKS = 6;
const MAX_RESULT_CHARS = 12000;
const MAX_TOOL_OUTPUT_CHARS = 48000;
const MAX_STORED_OUTPUT_CHARS = 200000;
const DEFAULT_AWAIT_MS = 60000;
const MAX_AWAIT_MS = 600000;
const DEFAULT_DELEGATE_TIMEOUT_MS = 0;
const MAX_DELEGATE_TIMEOUT_MS = 3600000;

const workflows = new Map();
const agentIndex = new Map();
let runtimeCtx = null;

export function apply(ctx) {
  runtimeCtx = ctx;
  const disposeTools = ctx.tools.register(dictatorTool);
  const disposeLieutenantDelegate = ctx.tools.register(lieutenantDelegateTool);
  const disposeLieutenantReport = ctx.tools.register(lieutenantReportTool);

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of [disposeTools, disposeLieutenantDelegate, disposeLieutenantReport]) {
        if (typeof dispose === 'function') {
          try { dispose(); } catch { /* already disposed */ }
        }
      }
      cleanupAll();
    });
  }
}

function cleanupAll() {
  for (const workflow of workflows.values()) {
    try { workflow.controller.abort(); } catch { /* ignore */ }
    for (const entry of [...workflow.lieutenants, ...workflow.contributors]) {
      if (entry.activation && typeof entry.activation.dispose === 'function') {
        entry.activation.dispose().catch(() => {});
      }
    }
  }
  workflows.clear();
  agentIndex.clear();
}

const dictatorTool = {
  name: 'dictator',
  description: [
    '主管（Dictator）/副主管（Lieutenant）分层多 agent 工作流，参考 Git 分布式工作流的“主管与副主管”模型。',
    '用 action=start 创建：把总使命拆成 1-8 个子系统，为每个子系统启动一个副主管；副主管会再派贡献者，提交结构化合并请求。',
    '用 action=status/await 查看或等待交付，用 action=steer 给某个副主管追加指令，用 action=stop 终止，用 action=finalize 产出最终集成报告。',
    '只有主管能 start/steer/stop/finalize；副主管和贡献者只能 status。',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'status', 'await', 'steer', 'stop', 'finalize', 'doctor'],
        description: '要执行的操作。',
      },
      mission: { type: 'string', description: 'action=start：总使命、最终目标和全局验收标准。' },
      workstreams: {
        type: 'array',
        description: 'action=start：1-8 个子系统，每个子系统会成为一个副主管的工作范围。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: '子系统名称，必须唯一。' },
            scope: { type: 'string', description: '该子系统负责的目录、模块、接口或问题边界。' },
            deliverables: { type: 'string', description: '该子系统必须交付的内容和验收标准。' },
            brief: { type: 'string', description: '额外背景、约束、已知风险或参考文件。' },
          },
          required: ['name', 'scope'],
        },
      },
      cwd: { type: 'string', description: 'action=start：工作目录；默认使用主管当前目录。' },
      provider: { type: 'string', description: `action=start：子 agent provider，默认 ${DEFAULT_PROVIDER}；必须支持 depthLimit。` },
      workflow_id: { type: 'string', description: '目标工作流 ID；省略时使用调用者当前关联的工作流。' },
      lieutenant: { type: 'string', description: 'action=steer/stop/await：副主管名称或子会话 ID；await 省略表示全部。' },
      message: { type: 'string', description: 'action=steer：发给副主管的追加指令。' },
      timeout_ms: { type: 'integer', description: 'action=await：最长等待毫秒数，默认 60000，上限 600000。' },
      integration: { type: 'string', description: 'action=finalize：主管对最终集成的说明、取舍和遗留风险。' },
      force: { type: 'boolean', description: 'action=finalize：仍有副主管运行时是否强制终止并定稿。' },
      save: { type: 'boolean', description: 'action=finalize：是否把报告写入 <cwd>/.dsh/dictator-workflows/<id>.md。' },
      verbose: { type: 'boolean', description: 'action=status/await：是否附带最近事件。' },
    },
    required: ['action'],
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  },
  timeoutMs: 3600000,
  async execute(args, exec) {
    switch (args.action) {
      case 'start':
        return startWorkflow(runtimeCtx, args, exec);
      case 'status': {
        const workflow = resolveWorkflow(exec, args.workflow_id);
        assertParticipant(workflow, exec);
        return renderStatus(workflow, Boolean(args.verbose));
      }
      case 'await':
        return awaitWorkflow(resolveWorkflow(exec, args.workflow_id), args, exec);
      case 'steer':
        return steerWorkflow(runtimeCtx, resolveWorkflow(exec, args.workflow_id), args, exec);
      case 'stop':
        return stopWorkflow(runtimeCtx, resolveWorkflow(exec, args.workflow_id), args, exec);
      case 'finalize':
        return finalizeWorkflow(runtimeCtx, resolveWorkflow(exec, args.workflow_id), args, exec);
      case 'doctor':
        return doctor(runtimeCtx);
      default:
        throw new Error(`未知 action: ${String(args.action)}`);
    }
  },
};

const lieutenantDelegateTool = {
  name: 'lieutenant_delegate',
  description: [
    '副主管专用：把自己的子系统拆成 1-6 个自包含的贡献者任务，并等待贡献者完成。',
    'action=spawn 会启动贡献者并等待（默认不设超时）；action=collect 用于收集之前超时后仍在运行的贡献者。',
    '只有已注册的副主管能调用；贡献者不能再委派。返回值包含每个贡献者的最终摘要，供副主管审查、集成。',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['spawn', 'collect'], description: '默认 spawn。' },
      tasks: {
        type: 'array',
        description: 'action=spawn：1-6 个贡献者任务。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: '短任务名。' },
            brief: { type: 'string', description: '自包含的任务说明：目标、允许修改的路径、验收标准。' },
            deliverables: { type: 'string', description: '期望贡献者返回的产物或证据。' },
          },
          required: ['title', 'brief'],
        },
      },
      task_ids: {
        type: 'array',
        description: 'action=collect：要等待的贡献者子会话 ID；省略表示该副主管全部未完成的贡献者。',
        items: { type: 'string' },
      },
      timeout_ms: {
        type: 'integer',
        description: '最长等待毫秒数；0 或省略表示一直等到完成。上限 3600000。',
      },
    },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  },
  timeoutMs: 3600000,
  async execute(args, exec) {
    return delegateForLieutenant(runtimeCtx, args, exec);
  },
};

const lieutenantReportTool = {
  name: 'lieutenant_report',
  description: [
    '副主管专用：提交结构化合并请求（Merge Request）。',
    '在完成子系统集成和验证后调用；status=ready 表示可被主管集成，status=blocked 表示存在无法自行解决的阻塞。',
    '不要用它粘贴大段代码；用它记录摘要、变更文件、验证命令/结果和风险。调用后结束回合。',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['ready', 'blocked'], description: 'ready=可集成；blocked=受阻。' },
      summary: { type: 'string', description: '完成了什么、关键决策、与总使命的关系。' },
      changes: {
        type: 'array',
        description: '变更文件列表。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: '文件或目录路径。' },
            description: { type: 'string', description: '该路径的变更说明。' },
          },
          required: ['path', 'description'],
        },
      },
      verification: {
        type: 'array',
        description: '验证命令与结果。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string', description: '执行的命令。' },
            result: { type: 'string', description: '结果；失败时写清错误。' },
          },
          required: ['command', 'result'],
        },
      },
      risks: { type: 'string', description: '遗留风险、未覆盖场景、需要主管决策的事项。' },
      notes: { type: 'string', description: '其他说明。' },
      branch: { type: 'string', description: '逻辑分支名或变更集标识；可选。' },
    },
    required: ['status', 'summary'],
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  },
  timeoutMs: 30000,
  async execute(args, exec) {
    const { workflow, lieutenant } = requireLieutenant(exec);
    if (typeof args.summary !== 'string' || !args.summary.trim()) {
      throw new Error('summary 不能为空。');
    }
    lieutenant.report = normalizeReport({ ...args, submittedAt: Date.now() });
    lieutenant.reportSource = 'tool';
    lieutenant.reportSubmittedAt = Date.now();
    log(workflow, 'lieutenant.report', `${lieutenant.name}: ${lieutenant.report.status}`);
    return [
      `已记录副主管「${lieutenant.name}」的合并请求：${reportStatusLabel(lieutenant.report.status)}。`,
      `工作流 ${workflow.id} 已收到该交付；主管可以用 dictator action=status/await 查看。`,
    ].join('\n');
  },
};

async function startWorkflow(ctx, args, exec) {
  if (!exec.agent) throw new Error('start 需要由 agent 调用。');
  const mission = requireText(args.mission, 'mission 不能为空。', 12000);
  const workstreams = normalizeWorkstreams(args.workstreams);
  const provider = (typeof args.provider === 'string' && args.provider.trim()) || DEFAULT_PROVIDER;
  if (!ctx.subagents.getProvider(provider)) {
    throw new Error(`subagent provider「${provider}」未注册；可用 provider: ${listProviders(ctx)}。`);
  }
  for (const workflow of workflows.values()) {
    if (workflow.dictatorId === exec.agent.id && workflow.status === 'running') {
      throw new Error(`当前主管已有运行中的工作流 ${workflow.id}；请先 finalize 或 stop。`);
    }
  }

  const cwd = await resolveCwd(ctx, args.cwd, exec);
  const dictatorDepth = delegationDepth(exec.agent);
  const maxDepth = dictatorDepth + 2;
  if (!Number.isSafeInteger(maxDepth)) throw new Error('主管层级过深，无法为副主管和贡献者预留两层深度。');
  const workflow = {
    id: `dl-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    mission,
    cwd,
    provider,
    maxDepth,
    dictatorId: exec.agent.id,
    status: 'running',
    createdAt: Date.now(),
    finalizedAt: null,
    integration: '',
    controller: new AbortController(),
    lieutenants: [],
    contributors: [],
    events: [],
  };
  workflows.set(workflow.id, workflow);
  log(workflow, 'workflow.started', `mission=${mission.slice(0, 120)}`);

  for (const workstream of workstreams) {
    const childId = randomUUID();
    const entry = {
      key: workstream.name,
      name: workstream.name,
      childId,
      status: 'starting',
      error: null,
      output: '',
      stopReason: null,
      report: null,
      reportSource: null,
      reportSubmittedAt: null,
      startedAt: Date.now(),
      finishedAt: null,
      activation: null,
      settled: null,
      workstream,
    };
    workflow.lieutenants.push(entry);
    agentIndex.set(childId, { workflowId: workflow.id, role: 'lieutenant', key: workstream.name });
    startLieutenant(ctx, workflow, entry, exec);
  }

  await Promise.all(workflow.lieutenants.map((entry) => entry.startPromise));
  const running = workflow.lieutenants.filter((entry) => entry.status === 'running');
  const failed = workflow.lieutenants.filter((entry) => entry.status === 'failed');
  if (!running.length) workflow.status = 'failed';

  const lines = [
    `已启动主管-副主管工作流 \`${workflow.id}\`。`,
    `- 工作目录：\`${workflow.cwd}\``,
    `- 子 agent provider：${workflow.provider}`,
    `- 副主管：${running.length} 运行中${failed.length ? `，${failed.length} 启动失败` : ''}`,
    '',
    '| 副主管 | 子会话 | 状态 |',
    '| --- | --- | --- |',
    ...workflow.lieutenants.map((entry) => `| ${tableCell(entry.name)} | \`${entry.childId}\` | ${statusLabel(entry.status)} |`),
    '',
    running.length
      ? '下一步：调用 `dictator` action=await 等待交付，或 action=status 查看进度。副主管会自动派贡献者并提交合并请求。'
      : '没有副主管成功启动；请检查 provider 和错误信息，修复后重新 start。',
  ];
  if (failed.length) {
    lines.push('', '启动失败：');
    for (const entry of failed) lines.push(`- ${entry.name}: ${entry.error ?? '未知错误'}`);
  }
  return lines.join('\n');
}

function startLieutenant(ctx, workflow, entry, exec) {
  entry.startPromise = (async () => {
    try {
      const activation = await ctx.subagents.startActivation({
        provider: workflow.provider,
        label: `${workflow.id}/${entry.name}`,
        childId: entry.childId,
        request: {
          cwd: workflow.cwd,
          prompt: [{ type: 'text', text: lieutenantPrompt(workflow, entry.workstream) }],
          parent: exec.agent,
          maxDepth: workflow.maxDepth,
        },
        signal: workflow.controller.signal,
        delivery: 'parent',
      });
      entry.activation = activation;
      entry.status = 'running';
      entry.settled = activation.result.then(
        (result) => {
          applyResult(entry, result);
          log(workflow, 'lieutenant.finished', `${entry.name}: ${entry.status}`);
          return entry;
        },
        (error) => {
          entry.status = 'failed';
          entry.error = errorMessage(error);
          entry.finishedAt = Date.now();
          log(workflow, 'lieutenant.failed', `${entry.name}: ${entry.error}`);
          return entry;
        },
      );
      log(workflow, 'lieutenant.started', `${entry.name} -> ${entry.childId}`);
    } catch (error) {
      entry.status = 'failed';
      entry.error = errorMessage(error);
      entry.finishedAt = Date.now();
      agentIndex.delete(entry.childId);
      log(workflow, 'lieutenant.start-failed', `${entry.name}: ${entry.error}`);
    }
  })();
  return entry.startPromise;
}

async function delegateForLieutenant(ctx, args, exec) {
  const { workflow, lieutenant } = requireLieutenant(exec);
  const action = args.action ?? 'spawn';
  if (action === 'collect') return collectContributors(ctx, workflow, lieutenant, args, exec);

  const tasks = normalizeTasks(args.tasks);
  const timeoutMs = normalizeTimeout(args.timeout_ms, DEFAULT_DELEGATE_TIMEOUT_MS, MAX_DELEGATE_TIMEOUT_MS);
  const entries = tasks.map((task) => {
    const childId = randomUUID();
    return {
      id: childId,
      childId,
      lieutenantKey: lieutenant.key,
      title: task.title,
      brief: task.brief,
      deliverables: task.deliverables,
      status: 'starting',
      error: null,
      output: '',
      stopReason: null,
      createdAt: Date.now(),
      finishedAt: null,
      activation: null,
      settled: null,
    };
  });
  workflow.contributors.push(...entries);
  for (const entry of entries) {
    agentIndex.set(entry.childId, { workflowId: workflow.id, role: 'contributor', key: entry.id });
  }
  log(workflow, 'contributors.requested', `${lieutenant.name}: ${entries.length}`);

  const delegateController = new AbortController();
  const onAbort = () => delegateController.abort(exec.signal?.reason);
  if (exec.signal?.aborted) delegateController.abort(exec.signal.reason);
  else exec.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await Promise.all(entries.map((entry) => startContributor(ctx, workflow, lieutenant, entry, delegateController.signal, exec)));
    const wait = await waitForEntries(entries, timeoutMs, exec.signal);
    return formatContributorResults(workflow, lieutenant, entries, wait);
  } finally {
    exec.signal?.removeEventListener('abort', onAbort);
  }
}

async function startContributor(ctx, workflow, lieutenant, entry, signal, exec) {
  try {
    const activation = await ctx.subagents.startActivation({
      provider: workflow.provider,
      label: `${workflow.id}/${lieutenant.name}/${entry.title}`,
      childId: entry.childId,
      request: {
        cwd: workflow.cwd,
        prompt: [{ type: 'text', text: contributorPrompt(workflow, lieutenant, entry) }],
        parent: exec.agent,
        maxDepth: workflow.maxDepth,
      },
      signal,
      delivery: 'parent',
    });
    entry.activation = activation;
    entry.status = 'running';
    entry.settled = activation.result.then(
      (result) => {
        applyResult(entry, result);
        log(workflow, 'contributor.finished', `${entry.title}: ${entry.status}`);
        return entry;
      },
      (error) => {
        entry.status = 'failed';
        entry.error = errorMessage(error);
        entry.finishedAt = Date.now();
        log(workflow, 'contributor.failed', `${entry.title}: ${entry.error}`);
        return entry;
      },
    );
    log(workflow, 'contributor.started', `${entry.title} -> ${entry.childId}`);
  } catch (error) {
    entry.status = 'failed';
    entry.error = errorMessage(error);
    entry.finishedAt = Date.now();
    agentIndex.delete(entry.childId);
    log(workflow, 'contributor.start-failed', `${entry.title}: ${entry.error}`);
  }
}

async function collectContributors(ctx, workflow, lieutenant, args, exec) {
  const all = workflow.contributors.filter((entry) => entry.lieutenantKey === lieutenant.key);
  const requested = Array.isArray(args.task_ids) && args.task_ids.length
    ? new Set(args.task_ids.map((value) => String(value)))
    : null;
  const entries = requested ? all.filter((entry) => requested.has(entry.childId) || requested.has(entry.id)) : all;
  if (!entries.length) throw new Error('没有找到该副主管的贡献者任务。');
  const timeoutMs = normalizeTimeout(args.timeout_ms, DEFAULT_DELEGATE_TIMEOUT_MS, MAX_DELEGATE_TIMEOUT_MS);
  const wait = await waitForEntries(entries, timeoutMs, exec.signal);
  return formatContributorResults(workflow, lieutenant, entries, wait);
}

function formatContributorResults(workflow, lieutenant, entries, wait) {
  const lines = [`## 贡献者交付（副主管：${lieutenant.name}）`];
  for (const [index, entry] of entries.entries()) {
    lines.push('', `### ${index + 1}. ${entry.title} — ${statusLabel(entry.status)}`);
    if (entry.status === 'starting' || entry.status === 'running') {
      lines.push(`贡献者仍在运行：\`${entry.childId}\`。可调用 \`lieutenant_delegate\` action=collect task_ids=["${entry.childId}"] 继续等待。`);
      continue;
    }
    if (entry.error) lines.push(`错误：${entry.error}`);
    const output = entry.output.trim();
    lines.push(output ? truncate(output, MAX_RESULT_CHARS) : '（贡献者没有返回最终文本）');
  }
  if (wait?.timedOut) {
    lines.push('', `等待超时；仍有 ${wait.pending.length} 个贡献者在运行。工作流 ${workflow.id} 未被终止，可继续 collect。`);
  }
  return truncate(lines.join('\n'), MAX_TOOL_OUTPUT_CHARS);
}

async function awaitWorkflow(workflow, args, exec) {
  requireDictator(workflow, exec);
  const timeoutMs = normalizeTimeout(args.timeout_ms, DEFAULT_AWAIT_MS, MAX_AWAIT_MS);
  const targets = args.lieutenant ? [findLieutenant(workflow, args.lieutenant)] : [...workflow.lieutenants];
  if (!targets.length) throw new Error('该工作流没有副主管。');
  const wait = await waitForEntries(targets, timeoutMs, exec.signal);
  const prefix = wait.timedOut
    ? `等待超时：仍有 ${wait.pending.length} 个副主管未完成。工作流继续运行。`
    : '等待完成：所有选中的副主管都已结束。';
  return `${prefix}\n\n${renderStatus(workflow, Boolean(args.verbose))}`;
}

async function steerWorkflow(ctx, workflow, args, exec) {
  requireDictator(workflow, exec);
  const lieutenant = findLieutenant(workflow, args.lieutenant);
  if (lieutenant.status !== 'running' && lieutenant.status !== 'starting') {
    throw new Error(`副主管「${lieutenant.name}」当前状态为 ${statusLabel(lieutenant.status)}，不能接收指令。`);
  }
  const message = requireText(args.message, 'action=steer 需要 message。', 12000);
  const messageId = await ctx.subagents.sendMessage(
    exec.agent,
    lieutenant.childId,
    [{ type: 'text', text: message }],
    { signal: exec.signal },
  );
  log(workflow, 'workflow.steer', `${lieutenant.name}: ${message.slice(0, 120)}`);
  return `已向副主管「${lieutenant.name}」（\`${lieutenant.childId}\`）发送指令。消息 ID: \`${messageId ?? 'unknown'}\``;
}

async function stopWorkflow(ctx, workflow, args, exec) {
  requireDictator(workflow, exec);
  const targets = args.lieutenant ? [findLieutenant(workflow, args.lieutenant)] : [...workflow.lieutenants];
  if (!targets.length) throw new Error('没有可停止的副主管。');
  if (!args.lieutenant) {
    workflow.status = 'stopped';
    workflow.finalizedAt = Date.now();
    try { workflow.controller.abort(); } catch { /* ignore */ }
  }
  const errors = await cancelEntries(ctx, workflow, targets, exec);
  if (args.lieutenant && workflow.lieutenants.every((entry) => isSettled(entry))) {
    workflow.status = 'stopped';
    workflow.finalizedAt = Date.now();
  }
  log(workflow, 'workflow.stopped', targets.map((entry) => entry.name).join(','));
  return [
    `已停止 ${targets.length} 个副主管及其贡献者。`,
    ...(errors.length ? ['', '清理时出现错误：', ...errors.map((error) => `- ${error}`)] : []),
  ].join('\n');
}

async function cancelEntries(ctx, workflow, lieutenants, exec) {
  const errors = [];
  for (const lieutenant of lieutenants) {
    for (const contributor of workflow.contributors.filter((entry) => entry.lieutenantKey === lieutenant.key)) {
      await cancelActivation(ctx, workflow, contributor, exec, errors);
    }
    await cancelActivation(ctx, workflow, lieutenant, exec, errors);
  }
  return errors;
}

async function cancelActivation(ctx, workflow, entry, exec, errors) {
  if (entry.activation && typeof entry.activation.dispose === 'function') {
    try { await entry.activation.dispose(); } catch (error) { errors.push(`${entry.title ?? entry.name}: ${errorMessage(error)}`); }
  }
  if (entry.childId && (entry.status === 'starting' || entry.status === 'running')) {
    try {
      await ctx.subagents.interrupt(entry.childId, { kind: 'ancestor', agent: exec.agent });
    } catch (error) {
      errors.push(`${entry.title ?? entry.name}: ${errorMessage(error)}`);
    }
  }
  if (!isSettled(entry)) {
    entry.status = 'stopped';
    entry.finishedAt = Date.now();
  }
}

async function finalizeWorkflow(ctx, workflow, args, exec) {
  requireDictator(workflow, exec);
  const active = workflow.lieutenants.filter((entry) => !isSettled(entry));
  if (active.length && !args.force) {
    throw new Error(`仍有 ${active.length} 个副主管在运行：${active.map((entry) => entry.name).join('、')}。使用 force=true 强制终止并定稿。`);
  }
  if (active.length) {
    workflow.controller.abort();
    await cancelEntries(ctx, workflow, active, exec);
  }
  workflow.status = 'finalized';
  workflow.finalizedAt = Date.now();
  workflow.integration = requireText(args.integration ?? '', '', 12000);
  const report = buildFinalReport(workflow);
  log(workflow, 'workflow.finalized', 'final report generated');
  if (args.save) {
    const path = join(workflow.cwd, '.dsh', 'dictator-workflows', `${workflow.id}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${report}\n`, 'utf8');
    return `${report}\n\n已保存：\`${path}\``;
  }
  return report;
}

function buildFinalReport(workflow) {
  const lines = [
    '# 主管-副主管协同报告',
    '',
    `- 工作流：\`${workflow.id}\``,
    `- 状态：${workflowStatusLabel(workflow.status)}`,
    `- 工作目录：\`${workflow.cwd}\``,
    `- 创建：${formatTime(workflow.createdAt)}`,
    `- 定稿：${workflow.finalizedAt ? formatTime(workflow.finalizedAt) : '—'}`,
    '',
    '## 总使命',
    '',
    workflow.mission,
    '',
    '## 副主管交付',
    '',
  ];
  if (!workflow.lieutenants.length) lines.push('（没有副主管）');
  for (const lieutenant of workflow.lieutenants) {
    lines.push(`### ${lieutenant.name} — ${statusLabel(lieutenant.status)}`, '');
    if (lieutenant.error) lines.push(`错误：${lieutenant.error}`, '');
    if (lieutenant.report) {
      lines.push(renderReport(lieutenant.report), '');
    } else {
      lines.push('未提交结构化合并请求。', '');
      if (lieutenant.output.trim()) lines.push(truncate(lieutenant.output.trim(), 4000), '');
    }
  }
  lines.push('## 主管集成说明', '', workflow.integration || '（未填写）', '');
  const events = workflow.events.slice(-20);
  if (events.length) {
    lines.push('## 最近事件', '');
    for (const event of events) lines.push(`- ${formatTime(event.at)} ${event.type}: ${event.message}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function renderStatus(workflow, verbose) {
  const lines = [
    '# 主管-副主管工作流',
    '',
    `- 工作流 ID：\`${workflow.id}\``,
    `- 状态：${workflowStatusLabel(workflow.status)}`,
    `- 使命：${workflow.mission}`,
    `- 工作目录：\`${workflow.cwd}\``,
    `- 子 agent provider：${workflow.provider}`,
    `- 层级预算：maxDepth ${workflow.maxDepth}`,
    `- 创建：${formatTime(workflow.createdAt)}`,
    '',
    '## 副主管',
    '',
    '| 副主管 | 状态 | 子会话 | 合并请求 |',
    '| --- | --- | --- | --- |',
  ];
  for (const lieutenant of workflow.lieutenants) {
    lines.push(`| ${tableCell(lieutenant.name)} | ${statusLabel(lieutenant.status)} | \`${lieutenant.childId}\` | ${lieutenant.report ? reportStatusLabel(lieutenant.report.status) : '未提交'} |`);
  }
  const contributors = workflow.contributors;
  if (contributors.length) {
    lines.push('', '## 贡献者', '', '| 贡献者 | 副主管 | 状态 | 子会话 |', '| --- | --- | --- | --- |');
    for (const contributor of contributors) {
      lines.push(`| ${tableCell(contributor.title)} | ${tableCell(contributor.lieutenantKey)} | ${statusLabel(contributor.status)} | \`${contributor.childId}\` |`);
    }
  }
  const reports = workflow.lieutenants.filter((lieutenant) => lieutenant.report);
  if (reports.length) {
    lines.push('', '## 合并请求', '');
    for (const lieutenant of reports) {
      lines.push(`### ${lieutenant.name} — ${reportStatusLabel(lieutenant.report.status)}`, '', renderReport(lieutenant.report), '');
    }
  }
  const errors = workflow.lieutenants.filter((lieutenant) => lieutenant.error);
  if (errors.length) {
    lines.push('', '## 错误', '');
    for (const lieutenant of errors) lines.push(`- ${lieutenant.name}: ${lieutenant.error}`);
  }
  if (workflow.integration) lines.push('', '## 主管集成说明', '', workflow.integration);
  if (verbose) {
    const events = workflow.events.slice(-20);
    if (events.length) {
      lines.push('', '## 最近事件', '');
      for (const event of events) lines.push(`- ${formatTime(event.at)} ${event.type}: ${event.message}`);
    }
  }
  return truncate(lines.join('\n'), MAX_TOOL_OUTPUT_CHARS);
}

function renderReport(report) {
  const lines = [report.summary || '（无摘要）'];
  if (report.changes?.length) {
    lines.push('', '变更：');
    for (const change of report.changes) lines.push(`- \`${change.path}\`：${change.description}`);
  }
  if (report.verification?.length) {
    lines.push('', '验证：');
    for (const check of report.verification) lines.push(`- \`${check.command}\` → ${check.result}`);
  }
  if (report.risks) lines.push('', `风险：${report.risks}`);
  if (report.notes) lines.push('', `备注：${report.notes}`);
  if (report.branch) lines.push('', `逻辑分支：\`${report.branch}\``);
  return lines.join('\n');
}

function normalizeWorkstreams(value) {
  if (!Array.isArray(value) || value.length < 1) throw new Error('workstreams 必须是非空数组。');
  if (value.length > MAX_WORKSTREAMS) throw new Error(`workstreams 最多 ${MAX_WORKSTREAMS} 个。`);
  const names = new Set();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`workstreams[${index}] 必须是对象。`);
    const name = requireText(raw.name, `workstreams[${index}].name 不能为空。`, 80);
    if (names.has(name)) throw new Error(`workstreams 名称重复：${name}`);
    names.add(name);
    return {
      name,
      scope: requireText(raw.scope, `workstreams[${index}].scope 不能为空。`, 4000),
      deliverables: requireText(raw.deliverables ?? '', '', 2000) || '完成该子系统并提交可审查的变更。',
      brief: requireText(raw.brief ?? '', '', 4000),
    };
  });
}

function normalizeTasks(value) {
  if (!Array.isArray(value) || value.length < 1) throw new Error('action=spawn 需要 1-6 个 tasks。');
  if (value.length > MAX_TASKS) throw new Error(`tasks 最多 ${MAX_TASKS} 个。`);
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`tasks[${index}] 必须是对象。`);
    return {
      title: requireText(raw.title, `tasks[${index}].title 不能为空。`, 100),
      brief: requireText(raw.brief, `tasks[${index}].brief 不能为空。`, 12000),
      deliverables: requireText(raw.deliverables ?? '', '', 4000),
    };
  });
}

function normalizeReport(input) {
  const report = {
    status: input.status === 'blocked' ? 'blocked' : 'ready',
    summary: requireText(input.summary ?? '', '', 20000),
    changes: Array.isArray(input.changes)
      ? input.changes.slice(0, 100).map((change) => ({
        path: requireText(change?.path ?? '', '', 1000),
        description: requireText(change?.description ?? '', '', 4000),
      })).filter((change) => change.path)
      : [],
    verification: Array.isArray(input.verification)
      ? input.verification.slice(0, 100).map((check) => ({
        command: requireText(check?.command ?? '', '', 2000),
        result: requireText(check?.result ?? '', '', 4000),
      })).filter((check) => check.command)
      : [],
    risks: requireText(input.risks ?? '', '', 8000),
    notes: requireText(input.notes ?? '', '', 8000),
    branch: requireText(input.branch ?? '', '', 200),
    submittedAt: Number.isFinite(input.submittedAt) ? input.submittedAt : Date.now(),
  };
  return report;
}

function extractReport(text, structured) {
  const fromStructured = parseReportValue(structured);
  if (fromStructured) return fromStructured;
  if (!text) return null;
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const report = parseReportValue(parsed);
      if (report) return report;
    } catch { /* try next candidate */ }
  }
  return null;
}

function parseReportValue(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return parseReportValue(JSON.parse(value)); } catch { return null; }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  if (!('status' in value) && !('summary' in value)) return null;
  return normalizeReport(value);
}

function applyResult(entry, result) {
  const text = resultText(result);
  const report = extractReport(text, result?.structured);
  entry.output = truncate(text, MAX_STORED_OUTPUT_CHARS);
  entry.stopReason = result?.stopReason ?? null;
  entry.status = result?.stopReason === 'completed'
    ? 'completed'
    : result?.stopReason === 'aborted'
      ? 'stopped'
      : 'failed';
  if (result?.diagnostic) entry.error = String(result.diagnostic);
  if (report && (!entry.report || entry.reportSource !== 'tool')) entry.report = report;
  entry.finishedAt = Date.now();
}

function resultText(result) {
  if (!result) return '';
  if (typeof result.output === 'string') return result.output;
  if (!Array.isArray(result.output)) return '';
  return result.output.map(blockText).filter(Boolean).join('\n\n');
}

function blockText(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text' || block.type === 'reasoning') {
    return typeof block.text === 'string' ? block.text : '';
  }
  if (block.type === 'tool-call') return `[tool-call ${block.name ?? ''}]`.trim();
  if (block.type === 'tool-result') return `[tool-result ${block.name ?? ''}]`.trim();
  if (block.type === 'image') return '[image]';
  if (block.type === 'file') return `[file ${block.name ?? ''}]`.trim();
  return `[${block.type ?? 'unknown'}]`;
}

function lieutenantPrompt(workflow, workstream) {
  return `你是 Git 分布式工作流中的「副主管」（Lieutenant）。主管（Dictator）把子系统「${workstream.name}」交给你。

## 总使命
${workflow.mission}

## 你的子系统
- 名称：${workstream.name}
- 范围：${workstream.scope}
- 交付物：${workstream.deliverables}
${workstream.brief ? `- 补充说明：${workstream.brief}` : ''}

## 工作方式（必须遵守）
1. 你只负责上述子系统。不要修改范围之外的文件；如果确实需要跨子系统变更，在合并请求的 risks 中说明，不要擅自越界。
2. 先调用 \`lieutenant_delegate\`，把子系统拆成 1-4 个自包含的贡献者任务。每个任务写清目标、允许修改的路径、验收标准。
3. \`lieutenant_delegate\` 会启动贡献者并等待其完成。收到结果后逐项审查：是否满足验收、是否越界、是否破坏接口。不合格就再派修复任务，或自己修正。
4. 集成所有合格贡献，运行实际验证命令。不要伪造或猜测验证结果。
5. 完成后必须调用 \`lieutenant_report\` 提交合并请求；status=ready 表示可被主管集成，status=blocked 表示存在无法自行解决的阻塞。提交后结束回合，最终回答只写一句摘要。

## 合并请求要求
- summary：完成了什么、关键决策、与总使命的关系。
- changes：变更文件路径与说明。
- verification：实际执行的命令与真实结果。
- risks：未覆盖场景、接口影响、需要主管决策的事项。
- branch：可选，逻辑变更集名称。

工作流 ID：${workflow.id}
副主管标识：${workstream.name}
`;
}

function contributorPrompt(workflow, lieutenant, task) {
  return `你是 Git 分布式工作流中的「贡献者」（Contributor）。你只执行一个自包含任务，完成后把结果交给副主管审查。

## 总使命
${workflow.mission}

## 所属子系统
- 副主管：${lieutenant.name}
- 子系统范围：${lieutenant.workstream.scope}

## 你的任务
- 标题：${task.title}
- 任务说明：${task.brief}
${task.deliverables ? `- 期望产物：${task.deliverables}` : ''}

## 规则
1. 只做本任务，不扩大范围，不修改任务说明之外的文件。
2. 不要再委派给其他 agent；你已经是层级中的最底层执行者。
3. 直接完成实际工作，运行必要的验证，不要只给计划。
4. 最终回答用简洁结构返回：完成内容、变更文件、验证命令与结果、风险/未完成项。不要粘贴大段代码。

工作流 ID：${workflow.id}
`;
}

function requireLieutenant(exec) {
  const binding = exec.agent ? agentIndex.get(exec.agent.id) : null;
  if (!binding || binding.role !== 'lieutenant') {
    throw new Error('该工具只能由已注册的副主管调用。主管请使用 dictator；贡献者不能再委派。');
  }
  const workflow = workflows.get(binding.workflowId);
  if (!workflow) throw new Error('副主管绑定的工作流已不存在。');
  const lieutenant = workflow.lieutenants.find((entry) => entry.key === binding.key);
  if (!lieutenant) throw new Error('副主管记录已不存在。');
  return { workflow, lieutenant };
}

function resolveWorkflow(exec, workflowId) {
  if (workflowId) {
    const workflow = workflows.get(workflowId);
    if (!workflow) throw new Error(`工作流不存在：${workflowId}`);
    return workflow;
  }
  if (exec.agent) {
    let latest = null;
    for (const workflow of workflows.values()) {
      if (workflow.dictatorId !== exec.agent.id) continue;
      if (workflow.status === 'running') return workflow;
      if (!latest || workflow.createdAt > latest.createdAt) latest = workflow;
    }
    if (latest) return latest;
    const binding = agentIndex.get(exec.agent.id);
    if (binding) {
      const workflow = workflows.get(binding.workflowId);
      if (workflow) return workflow;
    }
  }
  throw new Error('没有找到调用者关联的工作流；请传 workflow_id，或先调用 dictator action=start。');
}

function assertParticipant(workflow, exec) {
  if (workflow.dictatorId === exec.agent?.id) return;
  const binding = exec.agent ? agentIndex.get(exec.agent.id) : null;
  if (binding?.workflowId === workflow.id) return;
  throw new Error('只有该工作流的主管、副主管或贡献者可以查看。');
}

function requireDictator(workflow, exec) {
  if (workflow.dictatorId !== exec.agent?.id) {
    throw new Error('只有主管可以执行该操作。');
  }
}

function findLieutenant(workflow, value) {
  const key = requireText(value, '需要指定 lieutenant（副主管名称或子会话 ID）。', 200);
  const lieutenant = workflow.lieutenants.find((entry) => entry.name === key || entry.key === key || entry.childId === key);
  if (!lieutenant) {
    throw new Error(`未找到副主管「${key}」；可用：${workflow.lieutenants.map((entry) => entry.name).join('、') || '无'}`);
  }
  return lieutenant;
}

function delegationDepth(agent) {
  if (!agent) return 0;
  const headerDepth = agent.session?.header?.delegationDepth;
  const runtimeDepth = agent.options?.subagentDepth;
  const depth = Math.max(
    Number.isSafeInteger(headerDepth) && headerDepth >= 0 ? headerDepth : 0,
    Number.isSafeInteger(runtimeDepth) && runtimeDepth >= 0 ? runtimeDepth : 0,
  );
  return depth;
}

async function resolveCwd(ctx, requested, exec) {
  let base;
  try {
    base = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
  } catch {
    base = ctx.workingDirectory.defaultDirectory || process.cwd();
  }
  const cwd = requested ? resolve(base, requested) : base;
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new Error(`不是目录：${cwd}`);
  } catch (error) {
    throw new Error(`工作目录不可用：${cwd}（${errorMessage(error)}）`);
  }
  return cwd;
}

async function waitForEntries(entries, timeoutMs, signal) {
  const pending = entries.filter((entry) => entry.settled && !isSettled(entry));
  if (!pending.length) return { timedOut: false, pending: [] };
  let timedOut = false;
  const all = Promise.all(pending.map((entry) => entry.settled));
  if (timeoutMs > 0) {
    let timer;
    const timeout = new Promise((resolveTimeout) => {
      timer = setTimeout(() => { timedOut = true; resolveTimeout(); }, timeoutMs);
    });
    try {
      await Promise.race([abortable(all, signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } else {
    await abortable(all, signal);
  }
  const stillPending = pending.filter((entry) => !isSettled(entry));
  return { timedOut: timedOut && stillPending.length > 0, pending: stillPending };
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('操作已取消'));
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      rejectPromise(new Error('操作已取消'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolvePromise(value); },
      (error) => { signal.removeEventListener('abort', onAbort); rejectPromise(error); },
    );
  });
}

function normalizeTimeout(value, fallback, max) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.trunc(value), max);
}

function isSettled(entry) {
  return entry.status !== 'starting' && entry.status !== 'running';
}

function statusLabel(status) {
  return {
    starting: '启动中',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    stopped: '已停止',
  }[status] ?? String(status);
}

function reportStatusLabel(status) {
  return status === 'blocked' ? '受阻' : '已就绪';
}

function workflowStatusLabel(status) {
  return {
    running: '运行中',
    finalized: '已定稿',
    stopped: '已停止',
    failed: '失败',
  }[status] ?? String(status);
}

function tableCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatTime(timestamp) {
  if (!timestamp) return '—';
  try {
    return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(timestamp);
  }
}

function log(workflow, type, message) {
  workflow.events.push({ at: Date.now(), type, message: String(message) });
  if (workflow.events.length > 200) workflow.events.splice(0, workflow.events.length - 200);
}

function listProviders(ctx) {
  try {
    const providers = ctx.subagents.list();
    return providers.map((provider) => provider?.name ?? provider?.providerName ?? String(provider)).join(', ') || '无';
  } catch {
    return '未知';
  }
}

function doctor(ctx) {
  const provider = ctx.subagents.getProvider(DEFAULT_PROVIDER);
  const active = [...workflows.values()].filter((workflow) => workflow.status === 'running');
  return [
    `dsh-dictator-lieutenants ${PLUGIN_VERSION}`,
    `- ${DEFAULT_PROVIDER} provider：${provider ? '可用' : '缺失'}`,
    `- 已知 provider：${listProviders(ctx)}`,
    `- 运行中的工作流：${active.length}`,
    ...active.map((workflow) => `  - ${workflow.id}（${workflow.lieutenants.filter((entry) => !isSettled(entry)).length} 个副主管运行中）`),
    `- 可用工具：dictator, lieutenant_delegate, lieutenant_report`,
  ].join('\n');
}

function requireText(value, message, max) {
  if (typeof value !== 'string' || !value.trim()) {
    if (message) throw new Error(message);
    return '';
  }
  const text = value.trim();
  return max > 0 ? truncate(text, max) : text;
}

function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… [已截断 ${value.length - max} 字符]`;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
