/**
 * 组件渲染冒烟：通过 vite 的 SSR 加载真实编译 .vue 页面，
 * 验证生态流量台账与四个跨入口待办面板能无错渲染、关键内容齐全。
 */
import { renderToString } from '@vue/server-renderer'
import { createSSRApp } from 'vue'
import { createServer } from 'vite'

class LocalStorageStub {
  constructor() {
    this.map = new Map()
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null
  }
  setItem(k, v) {
    this.map.set(k, String(v))
  }
}
globalThis.localStorage = new LocalStorageStub()
globalThis.window = globalThis
globalThis.CustomEvent = class CustomEvent {
  constructor(type) {
    this.type = type
  }
}

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

try {
  const EcoFlowPage = (await vite.ssrLoadModule('/src/views/ecoflow/index.vue')).default
  const EcoLinkedTodos = (await vite.ssrLoadModule('/src/components/EcoLinkedTodos.vue')).default

  const app = createSSRApp({
    components: { EcoFlowPage, EcoLinkedTodos },
    template:
      '<div><EcoFlowPage /><EcoLinkedTodos variant="hydrology" /><EcoLinkedTodos variant="flood" /><EcoLinkedTodos variant="gate" /><EcoLinkedTodos variant="overhaul" /></div>',
  })
  const html = await renderToString(app)

  const needles = [
    ['生态流量下泄监管台账', '主台账标题'],
    ['全站唯一口径', '口径公示'],
    ['环审〔2018〕27号', '旧版批复文号'],
    ['环审〔2024〕12号', '新版批复文号'],
    ['生态流量达标判定', '水情待办面板'],
    ['下泄预警回写', '闸门待办面板'],
    ['预警处置结论待办', '检修待办面板'],
    ['可追溯操作日志', '审计日志'],
  ]
  let failed = 0
  for (const [needle, label] of needles) {
    if (!html.includes(needle)) {
      console.error(`✗ SSR 冒烟缺少：${label}（${needle}）`)
      failed += 1
    } else {
      console.log(`✓ ${label}`)
    }
  }
  console.log(`\nSSR HTML 长度：${html.length}`)
  process.exit(failed ? 1 : 0)
} finally {
  await vite.close()
}
