import { assessProjectFilesHost, inspectProjectFilesHost } from '../project-files/preflight.js'

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--data-root' || !args[1]) {
  console.error('Usage: node --import tsx server/src/scripts/project-files-preflight.ts --data-root <existing-directory>')
  process.exitCode = 2
} else {
  const snapshot = inspectProjectFilesHost(args[1])
  const assessment = assessProjectFilesHost(snapshot)
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), snapshot, ...assessment }, null, 2))
  // A successful diagnostic process is not a certification for production use.
  process.exitCode = assessment.prototypeEligible ? 0 : 1
}
