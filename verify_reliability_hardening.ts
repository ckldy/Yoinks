import { Path, Script } from "scripting"
import { replaceValidatedUserscript, type UserscriptFileOperations } from "./services/browser-script"
import { removeTaskCookieFile } from "./services/platform-auth"

const root = Path.join(FileManager.temporaryDirectory, `yoinks-reliability-${Date.now()}`)
FileManager.createDirectorySync(root, true)
const target = Path.join(root, "Yoinks.user.js")
const staleTemp = Path.join(root, "stale.cookies.txt")
const indexSource = FileManager.readAsStringSync(Path.join(Script.directory, "index.tsx"))
const authSource = FileManager.readAsStringSync(Path.join(Script.directory, "services", "platform-auth.ts"))

let passed = 0
function check(name: string, condition: boolean) {
  if (!condition) throw new Error(`Reliability hardening check failed: ${name}`)
  passed += 1
}

async function main() {
try {
  FileManager.writeAsStringSync(target, "// old known-good userscript")
  let rejected = false
  try {
    await replaceValidatedUserscript(target, "const broken = ;", async () => false)
  } catch {
    rejected = true
  }
  check("validation failure is reported", rejected)
  check("validation failure preserves the old userscript", FileManager.readAsStringSync(target) === "// old known-good userscript")
  check("validation failure leaves no transaction files", !FileManager.readDirectorySync(root).some((name) => name.includes(".publishing-") || name.includes(".backup-")))

  let renameCount = 0
  const failingFiles: UserscriptFileOperations = {
    exists: (path) => FileManager.exists(path),
    write: (path, contents) => FileManager.writeAsString(path, contents),
    rename: async (path, newPath) => {
      renameCount += 1
      if (renameCount === 2) throw new Error("injected publish rename failure")
      await FileManager.rename(path, newPath)
    },
    remove: (path) => FileManager.remove(path),
  }
  let renameRejected = false
  try {
    await replaceValidatedUserscript(target, "const rejected = 1", async () => true, failingFiles)
  } catch {
    renameRejected = true
  }
  check("publish rename failure is reported", renameRejected)
  check("publish rename failure restores the old userscript", FileManager.readAsStringSync(target) === "// old known-good userscript")
  check("publish rename failure leaves no transaction files", !FileManager.readDirectorySync(root).some((name) => name.includes(".publishing-") || name.includes(".backup-")))

  await replaceValidatedUserscript(target, "const current = 1", async (path) => FileManager.readAsStringSync(path) === "const current = 1")
  check("successful transaction replaces the userscript", FileManager.readAsStringSync(target) === "const current = 1")
  check("successful transaction leaves no transaction files", !FileManager.readDirectorySync(root).some((name) => name.includes(".publishing-") || name.includes(".backup-")))

  FileManager.writeAsStringSync(staleTemp, "secret-cookie")
  check("cookie removal reports success", await removeTaskCookieFile(staleTemp))
  check("cookie removal deletes the file", !FileManager.existsSync(staleTemp))
  check("cookie removal is idempotent", await removeTaskCookieFile(staleTemp))

  check("single download tracks an owned cookie source", /let ownedCookieFile: string \| undefined[\s\S]*ownedCookieFile = await createTaskCookieFile\(session\)/.test(indexSource))
  check("single download removes its owned cookie source in finally", /finally \{[\s\S]{0,260}await removeTaskCookieFile\(ownedCookieFile\)/.test(indexSource))
  check("clearing imported cookies is awaited", /await clearImportedCookie\(\)/.test(indexSource))
  check("import replacement awaits old cookie cleanup", /await clearImportedCookie\(\)/.test(authSource))

  console.log(`Reliability hardening checks passed (${passed})`)
  Script.exit({ passed })
} finally {
  try { FileManager.removeSync(root) } catch {}
}
}

main().catch((error) => {
  console.error(error)
  Script.exit({ error: error instanceof Error ? error.message : String(error) })
})
