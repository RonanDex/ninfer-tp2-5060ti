export const ORIGIN = 'local.ninfer-tool-recovery';
export const supported = model => model?.providerID === 'ninfer' &&
  model.id === 'qwen3.8-27b-quasar-w4a4';
const fresh = () => ({version: 1, used: 0, handled: null, blocked: false});
const parseError = error => (error?.message ?? error?.data?.message ?? '')
  .startsWith('tool_call_parse_error:');

// A repeated identical request has no corrective context. Veto the built-in
// transport retry only for this explicit error; the durable controller owns recovery.
export function stopBlindRetry(event) {
  if (supported(event.model) && parseError(event.error)) event.decision = {retry: false};
}

// Match the provider's explicit failure, never assistant text or reasoning.
export const isToolParseError = message => message?.type === 'assistant' &&
  !!message.error && parseError(message.error) &&
  !(message.content ?? []).some(part => part.type === 'tool');

export function createRecovery(ctx, {limit = 2, delayMs = 250, audit = async () => {}} = {}) {
  const locks = new Map(), timers = new Map(), epochs = new Map();
  let closed = false;
  const key = sid => `ninfer-tool-v1:${sid}`;
  const read = async sid => (await ctx.storage.get(key(sid))) ?? fresh();
  const save = (sid, state) => ctx.storage.set(key(sid), state);
  const log = async (sid, action, state, extra = {}) => {
    try { await audit({time: new Date().toISOString(), sessionID: sid, action,
      used: state.used, limit, ...extra}); } catch {}
  };
  const serial = (sid, fn) => {
    const next = (locks.get(sid) ?? Promise.resolve()).catch(() => {}).then(fn);
    locks.set(sid, next);
    next.finally(() => { if (locks.get(sid) === next) locks.delete(sid); }).catch(() => {});
    return next;
  };
  const cancel = sid => {
    epochs.set(sid, (epochs.get(sid) ?? 0) + 1);
    clearTimeout(timers.get(sid)); timers.delete(sid);
  };
  const current = async sid => {
    const result = await ctx.session.get({sessionID: sid});
    const info = result?.data ?? result;
    return supported(info.model) && info.location?.directory === ctx.location.directory ? info : null;
  };
  async function recover(sid, epoch) {
    if (closed || (epochs.get(sid) ?? 0) !== epoch) return;
    const info = await current(sid);
    if (!info || info.outcome !== 'failed') return;
    const result = await ctx.session.context({sessionID: sid});
    const messages = result?.data ?? result;
    const last = [...messages].reverse().find(m => m.type === 'assistant');
    if (!isToolParseError(last)) return;
    const index = messages.indexOf(last);
    if (messages.slice(index + 1).some(m => m.type === 'user')) return;
    const state = await read(sid);
    if (state.blocked || state.handled === last.id) return;
    if (closed || (epochs.get(sid) ?? 0) !== epoch) return;
    const capped = state.used >= limit;
    state.handled = last.id;
    if (capped) state.blocked = true;
    else state.used++;
    // Durable reservation + deterministic message ID prevent duplicate admission on reload.
    await save(sid, state);
    if (closed || (epochs.get(sid) ?? 0) !== epoch) return;
    const text = capped
      ? `NInfer 工具调用格式连续失败，本条任务已用完 ${limit} 次自动恢复，现已停止自动续跑。请检查任务；已完成的文件和工具结果保留。`
      : `NInfer 返回 tool_call_parse_error：上一轮工具调用格式不完整，该回复中的工具均未执行。这是本条任务第 ${state.used}/${limit} 次自动恢复。先核对磁盘和之前已完成的工具结果，避免重复操作；然后用实际工具重新执行尚未完成的一步，必要时拆小写入，确保调用结构完整并检查工具返回。不要把回复中的代码视为已落盘。继续原任务，保持已选模型、xhigh 等推理和采样设置；若已完成就正常总结并停止。`;
    try {
      await ctx.session.synthetic({sessionID: sid,
        id: `msg_ninfer_${last.id.slice(4)}_${capped ? 'cap' : state.used}`,
        text, description: capped ? 'NInfer 工具异常：已达恢复上限' : `NInfer 工具异常：恢复 ${state.used}/${limit}`,
        metadata: {origin: ORIGIN, sourceMessageID: last.id, attempt: state.used, limit, capped},
        delivery: 'queue', resume: !capped});
      await log(sid, capped ? 'capped' : 'continued', state, {sourceMessageID: last.id});
    } catch {
      state.blocked = true; await save(sid, state);
      await log(sid, 'admission-failed', state, {sourceMessageID: last.id});
    }
  }
  return {
    async prompt(event) {
      if (event.metadata?.origin === ORIGIN) return;
      cancel(event.sessionID);
      return serial(event.sessionID, async () => {
        if (!await current(event.sessionID)) return;
        await save(event.sessionID, fresh());
        await log(event.sessionID, 'user-reset', fresh());
      }).catch(() => {});
    },
    async event(event) {
      const sid = event.data?.sessionID;
      if (closed || !sid) return;
      if (event.location?.directory && event.location.directory !== ctx.location.directory) return;
      if (event.type === 'session.execution.interrupted') {
        cancel(sid);
        return serial(sid, async () => {
          if (!await current(sid)) return;
          const state = await read(sid); state.blocked = true; await save(sid, state);
          await log(sid, 'interrupted', state);
        }).catch(() => {});
      }
      if (event.type !== 'session.execution.failed') return;
      clearTimeout(timers.get(sid));
      const epoch = epochs.get(sid) ?? 0;
      timers.set(sid, setTimeout(() => {
        timers.delete(sid);
        serial(sid, () => recover(sid, epoch)).catch(async () => {
          await log(sid, 'handler-failed', fresh());
        });
      }, delayMs));
    },
    async close() {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear(); await Promise.allSettled([...locks.values()]);
    },
  };
}
