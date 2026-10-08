import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function summarizeAudit(report, label) {
  const counts = report?.metadata?.vulnerabilities
  const levels = ['critical', 'high', 'moderate', 'low', 'info', 'total']
  if (report?.error || !counts || levels.some((level) => !Number.isSafeInteger(counts[level]) || counts[level] < 0)) {
    throw new Error(`${label}: audit unavailable or malformed; this is not a clean result`)
  }
  return `### ${label}\n\n${levels.map((level) => `${level}: ${counts[level]}`).join(' | ')}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const paths = process.argv.slice(2)
  if (paths.length !== 2) throw new Error('Expected full and production audit JSON paths')
  console.log('# Dependency audit (informational)\n')
  for (const [index, path] of paths.entries()) {
    const label = index === 0 ? 'Full dependency graph' : 'npm production graph'
    try {
      console.log(summarizeAudit(JSON.parse(readFileSync(path, 'utf8')), label))
    } catch (error) {
      console.log(`### ${label}\n\nAudit unavailable or malformed. See the step log and raw artifact; no clean result is claimed.\n`)
      console.error(error.message)
      process.exitCode = 1
    }
  }
  console.log('Counts are affected package entries, including inherited advisories, not independent vulnerabilities. npm production dependencies include Expo/Metro build tools; these counts do not establish production APK reachability. See docs/security/dependency-audit-2026-10-08.md and the raw audit artifacts.\n')
}
