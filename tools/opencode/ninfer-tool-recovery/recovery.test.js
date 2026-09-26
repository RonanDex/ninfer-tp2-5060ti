import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecovery, ORIGIN, stopBlindRetry} from './recovery.js';

const wait = () => new Promise(resolve => setTimeout(resolve, 30));
const error = {name: 'APIError', data: {message: 'tool_call_parse_error: invalid tool call'}};

test('retry hook vetoes blind retries only for the explicit NInfer parse error', () => {
  const model = {providerID: 'ninfer', id: 'qwen3.8-27b-quasar-w4a4'};
  const event = {model, error: {type: 'provider.internal', message: 'tool_call_parse_error: invalid'},
    decision: {retry: true, delay: 1000}};
  stopBlindRetry(event); assert.deepEqual(event.decision, {retry: false});
  for (const other of [
    {...event, model: {...model, providerID: 'other'}},
    {...event, error: {message: 'connection refused'}},
  ]) {
    other.decision = {retry: true, delay: 1000}; stopBlindRetry(other);
    assert.deepEqual(other.decision, {retry: true, delay: 1000});
  }
});
function fixture(store = new Map()) {
  const info = {model: {providerID: 'ninfer', id: 'qwen3.8-27b-quasar-w4a4', variant: 'high'},
    location: {directory: '/test'}, outcome: 'failed'};
  const messages = [], sent = [], audit = [];
  const ctx = {location: {...info.location},
    storage: {get: async key => structuredClone(store.get(key)),
      set: async (key, value) => store.set(key, structuredClone(value))},
    session: {get: async () => ({data: info}), context: async () => ({data: messages}),
      synthetic: async prompt => { sent.push(prompt); return prompt; }}};
  const recovery = createRecovery(ctx, {delayMs: 5, audit: async event => audit.push(event)});
  const event = (type, extra = {}) => recovery.event({type, data: {sessionID: 'ses_test'}, ...extra});
  const fail = async (id, overrides = {}) => {
    messages.push({id, type: 'assistant', content: [], finish: 'error', error, ...overrides});
    await event('session.execution.failed'); await wait();
  };
  return {recovery, info, ctx, messages, sent, audit, event, fail, store};
}

test('explicit provider error resumes with a durable cap and deterministic deduplication', async () => {
  const f = fixture();
  await f.fail('msg_first');
  assert.equal(f.sent[0].resume, true);
  assert.equal(f.sent[0].metadata.attempt, 1);
  await f.event('session.execution.failed'); await wait();
  assert.equal(f.sent.length, 1);
  await f.recovery.prompt({sessionID: 'ses_test', metadata: {origin: ORIGIN}});
  await f.fail('msg_second');
  assert.equal(f.sent[1].metadata.attempt, 2);
  await f.fail('msg_third');
  assert.equal(f.sent[2].resume, false);
  assert.equal(f.sent[2].metadata.capped, true);
  await f.fail('msg_fourth'); assert.equal(f.sent.length, 3);
  assert.equal(f.info.model.variant, 'high');
  await f.recovery.close();
});

test('reload/tool progress preserve budget; genuine user prompt resets it', async () => {
  const f = fixture(); await f.fail('msg_one');
  await f.event('session.step.ended'); await f.recovery.close();
  const g = fixture(f.store); await g.fail('msg_two');
  assert.equal(g.sent[0].metadata.attempt, 2);
  await g.recovery.prompt({sessionID: 'ses_test'}); await g.fail('msg_three');
  assert.equal(g.sent[1].metadata.attempt, 1); await g.recovery.close();
});

test('normal answers, unrelated errors and completed tools never trigger recovery', async () => {
  const f = fixture();
  await f.fail('msg_normal', {finish: 'stop', error: undefined,
    content: [{type: 'text', text: 'tool_call_parse_error <tool_call><function=write>'}]});
  await f.fail('msg_network', {error: {message: 'connection refused'}});
  await f.fail('msg_tool', {content: [{type: 'tool', state: {status: 'completed'}}]});
  f.info.outcome = 'succeeded'; await f.fail('msg_stale_outcome');
  assert.equal(f.sent.length, 0); await f.recovery.close();
});

test('other models and locations do not resume', async () => {
  const f = fixture(); f.info.model.providerID = 'ollama'; await f.fail('msg_other');
  f.info.model.providerID = 'ninfer'; f.info.location.directory = '/other';
  await f.fail('msg_other_location');
  f.info.location = {directory: '/test'}; f.ctx.location = {directory: '/test'};
  await f.event('session.execution.failed', {location: {directory: '/different'}}); await wait();
  assert.equal(f.sent.length, 0); await f.recovery.close();
});

test('interruption cancels pending retry and blocks stale failure events', async () => {
  const f = fixture(); f.messages.push({id: 'msg_cancel', type: 'assistant', error});
  await f.event('session.execution.failed'); await f.event('session.execution.interrupted');
  await wait(); await f.event('session.execution.failed'); await wait();
  assert.equal(f.sent.length, 0); await f.recovery.close();
});

test('new user input and plugin shutdown revoke pending retry', async () => {
  const f = fixture(); f.messages.push({id: 'msg_old', type: 'assistant', error});
  await f.event('session.execution.failed');
  f.messages.push({id: 'msg_user', type: 'user'});
  await f.recovery.prompt({sessionID: 'ses_test'}); await wait();
  await f.event('session.execution.failed'); await wait();
  assert.equal(f.sent.length, 0);
  f.messages.push({id: 'msg_new', type: 'assistant', error});
  await f.event('session.execution.failed'); await f.recovery.close(); await wait();
  assert.equal(f.sent.length, 0);
});

test('failed admission cannot spend another attempt on reload', async () => {
  const f = fixture(); f.ctx.session.synthetic = async () => { throw new Error('offline'); };
  await f.fail('msg_one');
  assert.equal(f.store.get('ninfer-tool-v1:ses_test').blocked, true);
  assert.equal(f.audit.at(-1).action, 'admission-failed'); await f.recovery.close();
  const g = fixture(f.store); await g.fail('msg_two');
  assert.equal(g.sent.length, 0); await g.recovery.close();
});

test('storage failures do not block user prompts or issue unaccounted retries', async () => {
  const f = fixture(); f.ctx.storage.set = async () => { throw new Error('unavailable'); };
  await assert.doesNotReject(f.recovery.prompt({sessionID: 'ses_test'}));
  await f.fail('msg_one'); assert.equal(f.sent.length, 0); await f.recovery.close();
});
