// Mods can't read a clipboard image directly (Herdr keeps that for its feedback form) or
// copy files from outside their home, so Windows PowerShell does both. It takes a moment,
// and only runs after a paste that held no text or a dropped image. `-File` hands paths
// over as plain arguments, so a file named `a&b'c.png` stays a name.
import { appHome, exec } from "herdr";
import { parseClipboard } from "./logic.js";

async function powershell(script, args) {
  const file = `${appHome()}\\mods\\chat-box\\${script}`;
  const result = await exec("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", file, ...args,
  ]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `PowerShell exit code ${result.code}`);
  return result.stdout;
}

/** The clipboard's files or image as `{ kind, path }`; an image is saved to `outputPath`. */
export async function readClipboard(outputPath) {
  return parseClipboard(await powershell("clipboard.ps1", ["-Out", outputPath]));
}

export async function copyFile(from, to) {
  await powershell("copy.ps1", ["-From", from, "-To", to]);
}
