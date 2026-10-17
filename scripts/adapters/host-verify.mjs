import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function codexHost(pid = 0) {
  if (process.platform !== "win32") {
    if (!pid || !alive(pid))
      throw new Error(
        "Provide --host-pid for the owning, already-running Codex process.",
      );
    return { pid };
  }
  const start = pid || process.ppid;
  const code = `$ancestorId = ${start}; for ($n = 0; $n -lt ${pid ? 1 : 12}; $n++) { $proc = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $ancestorId); if (-not $proc) { break }; if ($proc.Name -ieq 'codex.exe') { [Console]::Write((@{pid=[int]$proc.ProcessId; created=$proc.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress)); break }; $ancestorId = [int]$proc.ParentProcessId }`;
  const result = await exec(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", code],
    { windowsHide: true, timeout: 10000, maxBuffer: 4096 },
  );
  if (!result.stdout.trim())
    throw new Error(
      "Could not identify the owning Codex process. Run attach inside that conversation, or supply its verified --host-pid.",
    );
  return JSON.parse(result.stdout);
}

export async function owningHost(config) {
  if (config.harness === "codex") return codexHost(config.hostPid);
  if (config.harness !== "hermes") return null;
  if (!config.hostPid || !alive(config.hostPid))
    throw new Error(
      "Provide --host-pid for the already-running Hermes Desktop application.",
    );
  if (process.platform !== "win32")
    throw new Error(
      "Hermes Desktop owner-process verification is currently supported on Windows.",
    );
  const result = await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$proc = Get-CimInstance Win32_Process -Filter 'ProcessId = ${config.hostPid}'; if ($proc.Name -ieq 'Hermes.exe') { [Console]::Write((@{pid=[int]$proc.ProcessId; created=$proc.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress)) }`,
    ],
    { windowsHide: true, timeout: 10000, maxBuffer: 4096 },
  );
  if (!result.stdout.trim())
    throw new Error(
      "The selected Hermes Desktop process is no longer running.",
    );
  return JSON.parse(result.stdout);
}

export { alive };
