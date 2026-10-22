const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(require.resolve('../web/app.js'), 'utf8');
const helpers = source.slice(source.indexOf('async function checkedTaskFetch'), source.indexOf('// 6. 触发批量下载'));
function page(fetch) {
  const messages = [];
  const context = vm.createContext({ fetch, showToast: text => messages.push(text) });
  vm.runInContext(helpers, context);
  return { context, messages };
}
test('task feedback never announces success for HTTP errors, rejected operations, no-ops or broken connections', async () => {
  for (const fetch of [
    async () => new Response(JSON.stringify({ success: true }), { status: 500 }),
    async () => new Response(JSON.stringify({ success: false, error: '保存失败' })),
    async () => new Response(JSON.stringify({ success: true, count: 0 })),
    async () => new Response('bad JSON'),
    async () => { throw new Error('连接失败'); },
  ]) {
    const { context, messages } = page(fetch);
    await vm.runInContext(`taskAction(async () => { await checkedTaskFetch('/test', {}); showToast('操作成功'); })({})`, context);
    assert.equal(messages.length, 1); assert.match(messages[0], /操作未完成/);
    assert.ok(!messages.includes('操作成功'));
  }
  const { context, messages } = page(async () => new Response(JSON.stringify({ success: true, count: 1 })));
  await vm.runInContext(`taskAction(async () => { await checkedTaskFetch('/test', {}); showToast('操作成功'); })({})`, context);
  assert.deepEqual(messages, ['操作成功']);
});
