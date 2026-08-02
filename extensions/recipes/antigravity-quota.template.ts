import { spawn, type ChildProcess } from "node:child_process";

const CAPTURE_TIMEOUT_MS = 50_000;
const TERMINATION_GRACE_MS = 3_000;

type QuotaBucket = {
  id: "gemini" | "claude-gpt";
  label: string;
  percentUsed: number;
  percentRemaining: number;
  windowLabel: "weekly";
};

type CaptureResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

type CaptureOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  terminationGraceMs?: number;
};

// Antigravity's /usage screen requires a real terminal. The helper stays in
// the detached process group created by Node, as does agy, so the host always
// has one group it can terminate even if the helper itself becomes stuck.
const PTY_CAPTURE_SCRIPT = String.raw`
import base64, fcntl, os, pty, select, signal, struct, subprocess, sys, termios, time

TAIL_BYTES = 128 * 1024
termination_requested = False
cleanup_complete = False

def anchor_group():
    while True:
        signal.pause()

def stop(signum, frame):
    global termination_requested
    termination_requested = True
    if cleanup_complete:
        anchor_group()

signal.signal(signal.SIGTERM, stop)

master, slave = pty.openpty()
proc = None
buffer = bytearray()
sent_usage = False
trusted = False
deadline = time.time() + 35

try:
    for fd in (master, slave):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 220, 0, 0))

    env = os.environ.copy()
    if env.get("TERM", "").lower() in ("", "dumb", "unknown"):
        env["TERM"] = "xterm-256color"

    proc = subprocess.Popen(
        ["agy"], stdin=slave, stdout=slave, stderr=slave, env=env,
    )
    os.close(slave)
    slave = None

    while time.time() < deadline and not termination_requested:
        ready, _, _ = select.select([master], [], [], 0.25)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            buffer.extend(chunk)
            if len(buffer) > TAIL_BYTES:
                del buffer[:-TAIL_BYTES]
            text = buffer.decode("utf-8", errors="ignore")
            if not trusted and "Do you trust the contents of this project?" in text:
                os.write(master, b"\r")
                trusted = True
            if not sent_usage and "? for shortcuts" in text:
                os.write(master, b"/usage\r")
                sent_usage = True
            if "Models & Quota" in text and text.count("Weekly Limit") >= 2:
                time.sleep(1)
                ready, _, _ = select.select([master], [], [], 0.5)
                if ready:
                    try:
                        buffer.extend(os.read(master, 65536))
                        if len(buffer) > TAIL_BYTES:
                            del buffer[:-TAIL_BYTES]
                    except OSError:
                        pass
                break
finally:
    if slave is not None:
        try:
            os.close(slave)
        except Exception:
            pass
    if proc is not None:
        try:
            proc.terminate()
        except Exception:
            pass
        try:
            proc.wait(timeout=2)
        except Exception:
            try:
                proc.kill()
                proc.wait(timeout=2)
            except Exception:
                pass

# A termination request comes from Node's process-group timeout path. Keep the
# group leader alive after agy is reaped so its PGID cannot be recycled before
# Node's grace timer safely escalates to SIGKILL.
cleanup_complete = True
if termination_requested:
    anchor_group()

sys.stdout.write(base64.b64encode(bytes(buffer)).decode("ascii"))
`;

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export function captureUsageScreen(options: CaptureOptions = {}): Promise<CaptureResult> {
  const timeoutMs = options.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const terminationGraceMs = options.terminationGraceMs ?? TERMINATION_GRACE_MS;

  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", PTY_CAPTURE_SCRIPT], {
      detached: true,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let settled = false;
    let stopping = false;
    let escalation: NodeJS.Timeout | undefined;

    const finish = (result: CaptureResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      resolve(result);
    };

    const stopGroup = (result: CaptureResult) => {
      if (stopping || settled) return;
      stopping = true;
      signalProcessGroup(child, "SIGTERM");
      escalation = setTimeout(() => {
        signalProcessGroup(child, "SIGKILL");
        finish(result);
      }, terminationGraceMs);
    };

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", (error: Error & { code?: string }) => {
      finish({
        ok: false,
        error: error.code === "ENOENT" ? "Python is unavailable for the Antigravity terminal" : "Antigravity quota capture could not start",
      });
    });
    child.once("close", (code) => {
      if (settled || stopping) return;
      if (code !== 0) {
        finish({ ok: false, error: "Antigravity quota capture failed" });
        return;
      }
      try {
        const encoded = Buffer.concat(chunks).toString("utf8").trim();
        finish({ ok: true, output: Buffer.from(encoded, "base64").toString("utf8") });
      } catch {
        finish({ ok: false, error: "Antigravity quota response could not be decoded" });
      }
    });

    const timeout = setTimeout(() => {
      stopGroup({ ok: false, error: "Antigravity quota capture timed out" });
    }, timeoutMs);
  });
}

function cleanTerminal(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function parseQuotaScreen(raw: string): { plan?: string; buckets: QuotaBucket[] } {
  const text = cleanTerminal(raw);
  const geminiHeader = "GEMINI MODELS";
  const claudeHeader = "CLAUDE AND GPT MODELS";
  const geminiStart = text.lastIndexOf(geminiHeader);
  const latestTitleStart = text.lastIndexOf("Models & Quota");
  if (geminiStart < 0 || latestTitleStart > geminiStart) return { plan: undefined, buckets: [] };
  const priorGeminiStart = text.lastIndexOf(geminiHeader, geminiStart - 1);
  const priorClaudeStart = text.lastIndexOf(claudeHeader, geminiStart - 1);
  const framePreludeStart = Math.max(priorGeminiStart, priorClaudeStart);
  const frameStart = latestTitleStart >= 0 ? latestTitleStart : geminiStart;
  const frame = text.slice(frameStart);
  const frameGeminiStart = frame.indexOf(geminiHeader);
  const claudeStart = frame.indexOf(claudeHeader);
  const framePrelude = latestTitleStart >= 0
    ? frame.slice(0, frameGeminiStart)
    : text.slice(framePreludeStart < 0 ? 0 : framePreludeStart, geminiStart);
  const planMatch = framePrelude.match(/\((Google AI [^)]+)\)/);
  const hasDuplicateHeader =
    frame.indexOf(geminiHeader, frameGeminiStart + geminiHeader.length) >= 0 ||
    (claudeStart >= 0 && frame.indexOf(claudeHeader, claudeStart + claudeHeader.length) >= 0);
  const sections =
    frameGeminiStart >= 0 && claudeStart > frameGeminiStart && !hasDuplicateHeader
      ? [frame.slice(frameGeminiStart + geminiHeader.length, claudeStart), frame.slice(claudeStart + claudeHeader.length)]
      : [];
  const values = sections.map((section) => {
    const matches = [...section.matchAll(/Weekly Limit[\s\S]*?(\d+(?:\.\d+)?)%/g)];
    const weeklyLimits = [...section.matchAll(/Weekly Limit/g)];
    return matches.length === 1 && weeklyLimits.length === 1
      ? Math.max(0, Math.min(100, Number(matches[0][1])))
      : null;
  });
  const buckets: QuotaBucket[] = values.length === 2 && values.every((value): value is number => value !== null)
    ? [
        {
          id: "gemini",
          label: "Gemini models",
          percentUsed: 100 - values[0],
          percentRemaining: values[0],
          windowLabel: "weekly",
        },
        {
          id: "claude-gpt",
          label: "Claude + GPT models",
          percentUsed: 100 - values[1],
          percentRemaining: values[1],
          windowLabel: "weekly",
        },
      ]
    : [];

  return { plan: sections.length === 2 ? planMatch?.[1] : undefined, buckets };
}

export const actions = {
  getQuota: async () => {
    const capture = await captureUsageScreen();
    if (!capture.ok) return capture;

    const parsed = parseQuotaScreen(capture.output);
    if (parsed.buckets.length !== 2) {
      return { ok: false as const, error: "Antigravity /usage did not report model quota" };
    }

    return {
      ok: true as const,
      data: {
        source: "agy /usage" as const,
        plan: parsed.plan,
        buckets: parsed.buckets,
        checkedAt: new Date().toISOString(),
      },
    };
  },
};
