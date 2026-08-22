const path = require('node:path')
const { spawnSync } = require('node:child_process')

const cocTest = require.resolve('coc-test/bin/coc-test')
const result = spawnSync(process.execPath, [cocTest, ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname, '..'),
  env: {
    ...process.env,
    COC_JAVA_TEST_SERVER: 'virtual',
  },
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.signal) {
  process.kill(process.pid, result.signal)
} else {
  process.exitCode = result.status ?? 1
}
