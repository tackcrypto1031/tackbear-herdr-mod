// What the chat box decides, with no Herdr calls: tested by test/chat-box.test.mjs.
import { t } from "./i18n.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

/** Windows limits a command line to 32767 characters; longer messages travel as a file. */
export const MAX_INLINE_MESSAGE = 30000;

export function extensionOf(path) {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function baseName(path) {
  return path.split(/[\\/]/).pop();
}

export function isImagePath(path) {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

/** Quotes a path the way Herdr's own terminal drop does, so agents treat it as a dropped file. */
export function quotePath(path) {
  if (path && /^[A-Za-z0-9/._\-+=,:@%~]+$/.test(path)) return path;
  return `'${path.replace(/'/g, "''")}'`;
}

/**
 * The text an agent receives. Paths go last on their own line: Claude Code then turns
 * image paths into attachments and keeps the words as the message.
 */
export function composeMessage(text, paths) {
  const words = text.trim();
  const files = paths.map(quotePath).join(" ");
  return words && files ? `${words}\n\n${files}` : words || files;
}

/**
 * A Textarea inserts its newline before it reports Enter, so the message is the value
 * from before the key. `current` and `previous` are the last two values seen by "change".
 */
export function textBeforeEnter(value, current, previous) {
  return value === current ? previous : current;
}

/** The core answers failures as `{"error":{"kind","message","hint"}}` on either stream. */
export function hcError(result) {
  for (const stream of [result.stdout, result.stderr]) {
    try {
      const error = JSON.parse(stream)?.error;
      if (error) return { kind: error.kind ?? "", message: error.message ?? String(error) };
    } catch {
      // Not JSON: the plain text below says what happened.
    }
  }
  if (result.code === 0) return null;
  return { kind: "", message: (result.stderr || result.stdout || `exit code ${result.code}`).trim() };
}

/** Says what a failed send means for the person holding the unsent draft. */
export function describeSendError(error) {
  const text = `${error.kind} ${error.message}`;
  if (/blocked/i.test(text)) return t("send.blocked");
  return t("send.failed", { why: error.message });
}

/** Lines from the clipboard reader: `image<TAB>path` or `file<TAB>path`. */
export function parseClipboard(stdout) {
  const items = [];
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const kind = line.slice(0, tab);
    const path = line.slice(tab + 1);
    if ((kind === "image" || kind === "file") && path) items.push({ kind, path });
  }
  return items;
}

/** A failed draft comes back in front of whatever was typed since. */
export function mergeDraftText(failed, typedSince) {
  if (!typedSince) return failed;
  return failed ? `${failed}\n${typedSince}` : typedSince;
}

/** The time stamped in a name this mod wrote (`paste-1793778443350.png`), or null. */
export function stampOf(name) {
  const match = /^(?:paste|preview|message)-(\d+)(?:-\d+)?\./.exec(name);
  return match ? Number(match[1]) : null;
}
