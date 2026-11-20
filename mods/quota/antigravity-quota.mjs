// Asks the running Antigravity app for its model quotas and prints `{ status, body }` as JSON,
// `{ offline: true }` when Antigravity isn't running, or `{ login: false }` when it isn't installed.
// Antigravity keeps no quota file: its language server holds the numbers and answers on 127.0.0.1,
// guarded by a CSRF token it is started with. The token is read from that process's command line,
// sent only to that local server and never printed. Run by the quota mod with node.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

const PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const BODY = JSON.stringify({ metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "en" } });
const windows = process.platform === "win32";

const installed = () => (windows
  ? existsSync(join(process.env.LOCALAPPDATA ?? "", "Programs", "Antigravity"))
  : existsSync("/Applications/Antigravity.app") || existsSync(join(homedir(), "Applications", "Antigravity.app")));

/** Each running Antigravity language server: its CSRF token and the ports it listens on. */
function servers() {
  if (windows) {
    const script = "$p = Get-CimInstance Win32_Process -Filter \"Name like 'language_server%'\" | ? { $_.CommandLine -match 'antigravity' -and $_.CommandLine -match 'csrf_token' };"
      + "@($p | % { [pscustomobject]@{ cmd = $_.CommandLine; ports = @(Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue | % LocalPort) } }) | ConvertTo-Json -Depth 3 -Compress";
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20000 }).trim();
    const list = out ? [JSON.parse(out)].flat() : [];
    return list.map((s) => ({ token: /--csrf_token[ =](\S+)/.exec(s.cmd)?.[1], ports: [s.ports].flat().filter(Boolean) }));
  }
  const ps = execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
  return ps.split("\n").filter((line) => /language_server/.test(line) && /antigravity/i.test(line) && /csrf_token/.test(line)).map((line) => {
    const pid = line.trim().split(/\s+/)[0];
    let ports = [];
    try {
      const lsof = execFileSync("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pid], { encoding: "utf8" });
      ports = [...lsof.matchAll(/127\.0\.0\.1:(\d+) \(LISTEN\)/g)].map((m) => Number(m[1]));
    } catch {
      // No ports to try.
    }
    return { token: /--csrf_token[ =](\S+)/.exec(line)?.[1], ports };
  });
}

const headers = (token) => ({ "Content-Type": "application/json", "Connect-Protocol-Version": "1", "X-Codeium-Csrf-Token": token });

async function askHttp(port, token) {
  const reply = await fetch(`http://127.0.0.1:${port}${PATH}`, { method: "POST", headers: headers(token), body: BODY, signal: AbortSignal.timeout(5000) });
  return { status: reply.status, body: await reply.text() };
}

// The server's https port uses its own self-signed certificate; it is only ever 127.0.0.1.
const askHttps = (port, token) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path: PATH, method: "POST", headers: headers(token), rejectUnauthorized: false, timeout: 5000 }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => resolve({ status: res.statusCode, body }));
  });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", reject);
  req.end(BODY);
});

/** Only what the sidebar shows: the reply also carries the account's name and email. */
const trim = (status) => ({
  plan: status.userTier?.name ?? status.planStatus?.planInfo?.planName ?? null,
  models: (status.cascadeModelConfigData?.clientModelConfigs ?? [])
    // The reply leaves out zero values: a pool with a reset but no fraction is used up, and a
    // model with neither has no quota of its own.
    .filter((m) => m.quotaInfo?.resetTime || typeof m.quotaInfo?.remainingFraction === "number")
    .map((m) => ({ label: m.label, remainingFraction: m.quotaInfo.remainingFraction ?? 0, resetTime: m.quotaInfo.resetTime ?? null })),
});

let found;
try {
  found = servers().filter((s) => s.token && s.ports.length);
} catch {
  found = [];
}

if (!found.length) {
  console.log(JSON.stringify(installed() ? { offline: true } : { login: false }));
} else {
  let answer = { failed: true };
  search: for (const { token, ports } of found) {
    for (const port of ports) {
      for (const ask of [askHttp, askHttps]) {
        try {
          const reply = await ask(port, token);
          const status = reply.status === 200 ? JSON.parse(reply.body)?.userStatus : null;
          if (status) {
            answer = { status: 200, body: JSON.stringify(trim(status)) };
            break search;
          }
        } catch {
          // Not this port or not this protocol.
        }
      }
    }
  }
  console.log(JSON.stringify(answer));
}
