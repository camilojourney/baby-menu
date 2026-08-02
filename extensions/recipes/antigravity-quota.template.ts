import { spawn, type ChildProcess } from "node:child_process";

const CAPTURE_TIMEOUT_MS = 50_000;
const INTERNAL_CAPTURE_TIMEOUT_MS = 35_000;
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
  | {
      ok: false;
      status: CaptureFailureStatus;
      error: string;
      transient?: true;
    };

type CaptureFailureStatus =
  | "missing-agy"
  | "unavailable"
  | "sign-in-in-progress"
  | "timeout"
  | "malformed-output"
  | "python-unavailable"
  | "capture-failed";

type CaptureOptions = {
  env?: NodeJS.ProcessEnv;
  internalCaptureTimeoutMs?: number;
  timeoutMs?: number;
  terminationGraceMs?: number;
};

// Antigravity's /usage screen requires a real terminal. The helper stays in
// the detached process group created by Node, as does agy, so the host always
// has one group it can terminate even if the helper itself becomes stuck.
const PTY_CAPTURE_SCRIPT = String.raw`
import base64, fcntl, os, pty, re, select, signal, struct, subprocess, sys, termios, time

TAIL_BYTES = 128 * 1024
termination_requested = False
self_cleanup_grace = float(sys.argv[2])

def self_cleanup_group():
    try:
        os.killpg(os.getpgrp(), signal.SIGTERM)
    except ProcessLookupError:
        sys.exit(0)
    time.sleep(self_cleanup_grace)
    os.killpg(os.getpgrp(), signal.SIGKILL)

def host_is_alive(timeout):
    ready, _, _ = select.select([4], [], [], timeout)
    if ready and not os.read(4, 1):
        self_cleanup_group()

def anchor_group():
    while True:
        host_is_alive(0.25)

def stop(signum, frame):
    global termination_requested
    termination_requested = True

signal.signal(signal.SIGTERM, stop)

def latest_frame_complete(text):
    title = "Models & Quota"
    gemini_header = "GEMINI MODELS"
    claude_header = "CLAUDE AND GPT MODELS"
    frame_start = text.rfind(title)
    if frame_start < 0:
        return False
    frame = text[frame_start:]
    gemini_start = frame.find(gemini_header)
    claude_start = frame.find(claude_header)
    if gemini_start < 0 or claude_start <= gemini_start:
        return False
    if frame.find(gemini_header, gemini_start + len(gemini_header)) >= 0:
        return False
    if frame.find(claude_header, claude_start + len(claude_header)) >= 0:
        return False
    sections = (
        frame[gemini_start + len(gemini_header):claude_start],
        frame[claude_start + len(claude_header):],
    )
    for section in sections:
        if len(re.findall(r"Weekly Limit", section)) != 1:
            return False
        if len(re.findall(r"Weekly Limit[\s\S]*?(\d+(?:\.\d+)?)%", section)) != 1:
            return False
    return True

def sign_in_in_progress(text):
    patterns = (
        r"You are currently not signed in\. Signing in\.\.\.",
        r"(?:complete|continue|finish).{0,80}sign[- ]?in.{0,80}browser",
        r"waiting.{0,80}(?:authentication|sign[- ]?in|browser)",
        r"(?:authentication|sign[- ]?in).{0,80}(?:in progress|pending)",
    )
    return any(re.search(pattern, text, re.IGNORECASE | re.DOTALL) for pattern in patterns)

master, slave = pty.openpty()
proc = None
buffer = bytearray()
sent_usage = False
trusted = False
capture_timed_out = False
sign_in_detected = False
deadline = time.time() + float(sys.argv[1])

try:
    for fd in (master, slave):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 220, 0, 0))

    env = os.environ.copy()
    if env.get("TERM", "").lower() in ("", "dumb", "unknown"):
        env["TERM"] = "xterm-256color"

    try:
        proc = subprocess.Popen(
            ["agy"], stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True,
        )
    except FileNotFoundError:
        os.close(slave)
        slave = None
        os.write(3, b"missing-agy\n")
        anchor_group()
    except OSError:
        os.close(slave)
        slave = None
        os.write(3, b"unavailable\n")
        anchor_group()
    os.close(slave)
    slave = None

    while time.time() < deadline and not termination_requested:
        ready, _, _ = select.select([master, 4], [], [], 0.25)
        if 4 in ready:
            host_is_alive(0)
        if master in ready:
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
            if latest_frame_complete(text):
                host_is_alive(1)
                ready, _, _ = select.select([master, 4], [], [], 0.5)
                if 4 in ready:
                    host_is_alive(0)
                if master in ready:
                    try:
                        buffer.extend(os.read(master, 65536))
                        if len(buffer) > TAIL_BYTES:
                            del buffer[:-TAIL_BYTES]
                    except OSError:
                        pass
                text = buffer.decode("utf-8", errors="ignore")
                if latest_frame_complete(text):
                    break
            if sign_in_in_progress(text):
                host_is_alive(0.5)
                ready, _, _ = select.select([master, 4], [], [], 0.5)
                if 4 in ready:
                    host_is_alive(0)
                if master in ready:
                    try:
                        buffer.extend(os.read(master, 65536))
                        if len(buffer) > TAIL_BYTES:
                            del buffer[:-TAIL_BYTES]
                    except OSError:
                        pass
                if latest_frame_complete(buffer.decode("utf-8", errors="ignore")):
                    break
                if proc.poll() is not None:
                    break
                sign_in_detected = True
                break
    if time.time() >= deadline and not termination_requested:
        capture_timed_out = True
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

if termination_requested:
    anchor_group()

final_text = buffer.decode("utf-8", errors="ignore")
if not latest_frame_complete(final_text) and sign_in_detected:
    os.write(3, b"sign-in-in-progress\n")
    anchor_group()

if capture_timed_out:
    os.write(3, b"timeout\n")
    anchor_group()

if not latest_frame_complete(final_text):
    os.write(3, b"unavailable\n")
    anchor_group()

sys.stdout.write(base64.b64encode(bytes(buffer)).decode("ascii"))
sys.stdout.flush()
os.write(3, b"success\n")
anchor_group()
`;

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

const HELPER_FAILURES = {
  timeout: { ok: false, status: "timeout", error: "Antigravity quota capture timed out" },
  "missing-agy": { ok: false, status: "missing-agy", error: "Antigravity CLI is unavailable" },
  unavailable: { ok: false, status: "unavailable", error: "Antigravity quota is unavailable" },
  "sign-in-in-progress": {
    ok: false,
    status: "sign-in-in-progress",
    transient: true,
    error: "Antigravity sign-in is in progress",
  },
} as const;

type HelperFailureOutcome = keyof typeof HELPER_FAILURES;

function isHelperFailureOutcome(outcome: string): outcome is HelperFailureOutcome {
  return Object.hasOwn(HELPER_FAILURES, outcome);
}

export function captureUsageScreen(options: CaptureOptions = {}): Promise<CaptureResult> {
  const internalCaptureTimeoutMs = options.internalCaptureTimeoutMs ?? INTERNAL_CAPTURE_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const terminationGraceMs = options.terminationGraceMs ?? TERMINATION_GRACE_MS;

  return new Promise((resolve) => {
    const child = spawn(
      "python3",
      [
        "-c",
        PTY_CAPTURE_SCRIPT,
        String(internalCaptureTimeoutMs / 1_000),
        String(terminationGraceMs / 1_000),
      ],
      {
        detached: true,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    let settled = false;
    let stopping = false;
    let escalation: NodeJS.Timeout | undefined;
    let stoppedResult: CaptureResult | (() => CaptureResult) | undefined;
    let controlOutput = "";

    const finish = (result: CaptureResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      resolve(result);
    };

    const stopGroup = (result: CaptureResult | (() => CaptureResult)) => {
      if (stopping || settled) return;
      stopping = true;
      stoppedResult = result;
      signalProcessGroup(child, "SIGTERM");
      escalation = setTimeout(() => {
        signalProcessGroup(child, "SIGKILL");
      }, terminationGraceMs);
    };

    const successfulCapture = (): CaptureResult => {
      try {
        const encoded = Buffer.concat(chunks).toString("utf8").trim();
        return { ok: true, output: Buffer.from(encoded, "base64").toString("utf8") };
      } catch {
        return {
          ok: false,
          status: "malformed-output",
          error: "Antigravity quota response could not be decoded",
        };
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdio[3]?.on("data", (chunk: Buffer) => {
      controlOutput += chunk.toString("utf8");
      const newline = controlOutput.indexOf("\n");
      if (newline < 0) return;
      const outcome = controlOutput.slice(0, newline);
      if (outcome === "success") {
        stopGroup(successfulCapture);
      } else if (isHelperFailureOutcome(outcome)) {
        stopGroup(HELPER_FAILURES[outcome]);
      } else {
        stopGroup({ ok: false, status: "capture-failed", error: "Antigravity quota capture failed" });
      }
    });
    child.once("error", (error: Error & { code?: string }) => {
      finish({
        ok: false,
        status: error.code === "ENOENT" ? "python-unavailable" : "capture-failed",
        error: error.code === "ENOENT" ? "Python is unavailable for the Antigravity terminal" : "Antigravity quota capture could not start",
      });
    });
    child.once("close", (code) => {
      if (settled) return;
      if (stoppedResult !== undefined) {
        finish(typeof stoppedResult === "function" ? stoppedResult() : stoppedResult);
        return;
      }
      if (code !== 0) {
        finish({ ok: false, status: "capture-failed", error: "Antigravity quota capture failed" });
        return;
      }
      finish(successfulCapture());
    });

    const timeout = setTimeout(() => {
      stopGroup(HELPER_FAILURES.timeout);
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
  const title = "Models & Quota";
  const geminiHeader = "GEMINI MODELS";
  const claudeHeader = "CLAUDE AND GPT MODELS";
  const frameStart = text.lastIndexOf(title);
  if (frameStart < 0) return { plan: undefined, buckets: [] };
  const frame = text.slice(frameStart);
  const geminiStart = frame.indexOf(geminiHeader);
  const claudeStart = frame.indexOf(claudeHeader);
  const hasDuplicateHeader =
    frame.indexOf(geminiHeader, geminiStart + geminiHeader.length) >= 0 ||
    (claudeStart >= 0 && frame.indexOf(claudeHeader, claudeStart + claudeHeader.length) >= 0);
  if (geminiStart < 0 || claudeStart <= geminiStart || hasDuplicateHeader) {
    return { plan: undefined, buckets: [] };
  }
  const sections = [frame.slice(geminiStart + geminiHeader.length, claudeStart), frame.slice(claudeStart + claudeHeader.length)];
  const values = sections.map((section) => {
    const matches = [...section.matchAll(/Weekly Limit[\s\S]*?(\d+(?:\.\d+)?)%/g)];
    const weeklyLimits = [...section.matchAll(/Weekly Limit/g)];
    return matches.length === 1 && weeklyLimits.length === 1
      ? Math.max(0, Math.min(100, Number(matches[0][1])))
      : null;
  });
  if (!values.every((value): value is number => value !== null)) {
    return { plan: undefined, buckets: [] };
  }
  const plan = frame.slice(0, geminiStart).match(/\((Google AI [^)]+)\)/)?.[1];
  return {
    plan,
    buckets: [
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
    ],
  };
}

export const actions = {
  getQuota: async () => {
    const capture = await captureUsageScreen();
    if (!capture.ok) return capture;

    const parsed = parseQuotaScreen(capture.output);
    if (parsed.buckets.length !== 2) {
      return {
        ok: false as const,
        status: "malformed-output" as const,
        error: "Antigravity /usage did not report model quota",
      };
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
