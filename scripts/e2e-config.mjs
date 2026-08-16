/**
 * 配置单一来源 E2E：
 *  1. 未配置用户 GET → keyStatus=default（.env 默认密钥生效），apiKey 掩码
 *  2. PUT 自定义配置（baseUrl/model/proxy/systemPrompt，apiKey 用测试占位值）→ 200
 *  3. GET → keyStatus=custom，apiKey 为掩码（长度 8，非完整密钥）
 *  4. PUT apiKey 留空 → 已有密钥保留（再 GET keyStatus 仍 custom 且掩码不变）
 *  5. 掩码不泄露：所有响应中不出现完整测试密钥
 */
import { strict as assert } from 'node:assert'

const BRAIN = 'http://localhost:3002'
const TEST_KEY = 'sk-test-config-key-abc123'
const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// 独立测试用户，避免污染已有数据
const uidRes = await fetch(`${BRAIN}/api/users/resolve`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: `config-e2e-${Date.now()}` })
})
const userId = (await uidRes.json()).userId
console.log(`测试用户: ${userId}`)

try {
  // 1. 未配置 → default
  const g0 = await (await fetch(`${BRAIN}/api/config/${userId}`)).json()
  report('未配置用户 keyStatus=default', g0.keyStatus === 'default', JSON.stringify(g0))
  assert.ok(!g0.config.provider.apiKey.includes('sk-test'), '掩码不含明文密钥')

  // 2. PUT 自定义
  const put1 = await fetch(`${BRAIN}/api/config/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: {
        provider: { baseUrl: 'https://custom.example/v1', apiKey: TEST_KEY, model: 'test-model-x', proxy: 'http://127.0.0.1:7890' },
        systemPrompt: '自定义人格测试',
        outputLanguage: 'ja'
      }
    })
  })
  const p1 = await put1.json()
  report('PUT 自定义配置 200', put1.ok && p1.config.provider.model === 'test-model-x')
  assert.ok(!JSON.stringify(p1).includes(TEST_KEY), 'PUT 响应泄露完整密钥')

  // 3. GET → custom + 掩码
  const g1 = await (await fetch(`${BRAIN}/api/config/${userId}`)).json()
  report('GET keyStatus=custom', g1.keyStatus === 'custom')
  const masked = g1.config.provider.apiKey
  report('GET apiKey 为掩码（9 字符：前4+…+尾4，非明文）', masked.length === 9 && !masked.includes('abc123'), masked)
  report('GET 其余字段生效（baseUrl/model/proxy/systemPrompt/outputLanguage）',
    g1.config.provider.baseUrl === 'https://custom.example/v1' &&
    g1.config.provider.model === 'test-model-x' &&
    g1.config.provider.proxy === 'http://127.0.0.1:7890' &&
    g1.config.systemPrompt === '自定义人格测试' &&
    g1.config.outputLanguage === 'ja')

  // 4. PUT apiKey 留空 → 保留
  await fetch(`${BRAIN}/api/config/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { provider: { apiKey: '' } } })
  })
  const g2 = await (await fetch(`${BRAIN}/api/config/${userId}`)).json()
  report('PUT apiKey 留空 → 已有密钥保留（掩码不变）', g2.keyStatus === 'custom' && g2.config.provider.apiKey === masked)

  // 5. 部分更新不破坏其他字段
  const g3 = await (await fetch(`${BRAIN}/api/config/${userId}`)).json()
  report('留空更新未破坏其他字段', g3.config.provider.model === 'test-model-x' && g3.config.systemPrompt === '自定义人格测试')

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 汇总: ${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length > 0) process.exitCode = 1
} catch (error) {
  console.error('断言失败：', error.message)
  process.exitCode = 1
}
