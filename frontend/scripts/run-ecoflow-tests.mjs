/**
 * 生态流量领域规则验证启动器：
 * 选择与当前运行平台匹配的 esbuild 可执行文件，转译后运行（CI 里 node_modules 可能是在别的平台装的）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function pickEsbuildBinary() {
  const candidates = [
    join(root, 'node_modules/@esbuild/linux-arm64/bin/esbuild'),
    join(root, 'node_modules/@esbuild/linux-x64/bin/esbuild'),
    join(root, 'node_modules/@esbuild/darwin-arm64/bin/esbuild'),
    join(root, 'node_modules/@esbuild/darwin-x64/bin/esbuild'),
    join(root, 'node_modules/esbuild/bin/esbuild'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('未找到可用的 esbuild 可执行文件')
}

const outFile = join(root, 'node_modules/.cache/ecoflow-tests.mjs')
mkdirSync(dirname(outFile), { recursive: true })
const esbuild = pickEsbuildBinary()
execFileSync(
  esbuild,
  [
    join(root, 'src/domain/ecoflow/domain-tests.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${outFile}`,
  ],
  { stdio: 'inherit' },
)
execFileSync(process.execPath, [outFile], { stdio: 'inherit' })
