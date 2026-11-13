/**
 * 真实 Electron 搜索面板序列回归：探测 → 延迟试搜A → Enter重入B被拒 → A返回 → 空结果 → 故障。
 * 仅供 e2e-isolated --desktop 启动的临时profile；页面fetch注入受控fixture避免访问外部搜索。
 * 验证的是渲染/请求竞态和状态语义，不是模型/真实搜索引擎质量。
 */
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
const CDP = process.env.CDP_HTTP
assert(CDP, '必须通过隔离 harness 传入 CDP_HTTP，禁止默认连接用户桌面')
const targets = await (await fetch(`${CDP}/json/list`)).json()
const target = targets.find((item) => item.type === 'page')
assert(target, 'Electron page 不存在')
const ws = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let id = 0
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data)
  if (!message.id || !pending.has(message.id)) return
  const pair = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) pair.reject(new Error(message.error.message))
  else pair.resolve(message.result)
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const current = ++id
    pending.set(current, { resolve, reject })
    ws.send(JSON.stringify({ id: current, method, params }))
  })
}
async function evaluate(expression) {
  const out = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text)
  return out.result.value
}
async function until(expression, label) {
  const startedAt = Date.now()
  for (;;) {
    if (await evaluate(expression)) return
    assert(Date.now() - startedAt < 20_000, `等待超时：${label}`)
    await sleep(25)
  }
}
const setInput = (value) => `(() => { const el=document.querySelector('[data-testid="search-test-input"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`
try {
  await evaluate(`location.href=location.origin+'/settings'; true`)
  await until(`!![...document.querySelectorAll('nav button')].find(b=>/联网搜索|Web search|ウェブ検索/.test(b.textContent))`, '设置导航')
  await evaluate(`(() => {
    window.__searchFixture={requests:[],resolve:null,mode:'pending'};
    window.__searchFetch=window.fetch;
    window.fetch=async (input,init) => {
      const url=String(input);
      if (url.includes('/api/search/status')) return new Response(JSON.stringify({checkedAt:Date.now(),elapsedMs:4,tavilyConfigured:false,network:'direct',engines:['tavily','bing','so','sogou','duckduckgo'].map(engine=>({engine,ok:engine==='bing',elapsedMs:4,detail:engine==='bing'?'fixture reachable':'fixture unavailable'}))}),{headers:{'Content-Type':'application/json'}});
      if (url.includes('/api/search/test')) {
        const body=JSON.parse(init.body); window.__searchFixture.requests.push(body);
        if(window.__searchFixture.mode==='pending') return new Promise(resolve=>{window.__searchFixture.resolve=resolve});
        const status=window.__searchFixture.mode;
        return new Response(JSON.stringify({query:body.query,status,elapsedMs:8,engine:null,hits:[],errors:status==='failed'?[{engine:'bing',code:'request_failed',error:'fixture HTTP 503'}]:[]}));
      }
      return window.__searchFetch(input,init);
    };
    [...document.querySelectorAll('nav button')].find(b=>/联网搜索|Web search|ウェブ検索/.test(b.textContent)).click();
  })()`)
  await until(`document.querySelectorAll('[data-testid="search-engine-row"]').length===5`, '五个真实接口状态行')
  assert.equal(await evaluate(`document.querySelectorAll('[data-ok="true"]').length`), 1)
  console.log('PASS 搜索面板使用接口状态，不写死全部可用')
  await evaluate(setInput('查询 A'))
  await evaluate(`document.querySelector('[data-testid="search-test-run"]').click()`)
  await until(`window.__searchFixture.requests.length===1`, '请求A发出')
  assert.equal(await evaluate(`document.querySelector('[data-testid="search-test-input"]').disabled`), true)
  await evaluate(setInput('查询 B'))
  await evaluate(`document.querySelector('[data-testid="search-test-input"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`)
  assert.equal(await evaluate(`window.__searchFixture.requests.length`), 1)
  console.log('PASS 延迟A期间Enter不能起并发B（旧实现此断言失败）')
  await evaluate(`window.__searchFixture.resolve(new Response(JSON.stringify({query:'查询 A',status:'success',elapsedMs:8,engine:'bing',hits:[{title:'A返回的协议fixture',url:'https://example.org/a',snippet:'fixture',engine:'bing'}],errors:[]})))`)
  await until(`document.querySelector('[data-testid="search-test-result"]')?.dataset.status==='success'`, 'A返回')
  assert((await evaluate(`document.querySelector('[data-testid="search-test-result"]').innerText`)).includes('查询 A'))
  console.log('PASS 结果标明原请求查询词，不误认当前输入B')
  await evaluate(`window.__searchFixture.mode='empty'`)
  await evaluate(setInput('真实零匹配语义'))
  await evaluate(`document.querySelector('[data-testid="search-test-run"]').click()`)
  await until(`document.querySelector('[data-testid="search-test-result"]')?.dataset.status==='empty'`, 'empty状态')
  const empty = await evaluate(`document.querySelector('[data-testid="search-test-result"]').innerText`)
  assert(!/全部引擎失败|All engines failed|全エンジン失敗/.test(empty))
  console.log('PASS 零匹配不显示全部故障')
  await evaluate(`window.__searchFixture.mode='failed'`)
  await evaluate(setInput('网络故障语义'))
  await evaluate(`document.querySelector('[data-testid="search-test-run"]').click()`)
  await until(`document.querySelector('[data-testid="search-test-result"]')?.dataset.status==='failed'`, 'failed状态')
  assert((await evaluate(`document.querySelector('[data-testid="search-test-result"]').innerText`)).includes('HTTP 503'))
  console.log('PASS 网络故障保留逐引擎失败原因')
} finally {
  await evaluate(`if(window.__searchFetch)window.fetch=window.__searchFetch;delete window.__searchFixture;true`).catch(() => {})
  ws.close()
}
console.log('5/5 搜索面板序列回归通过（受控fixture）')
