import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createServerActionRegistry } from "../src/main/server-action-registry";
import { actions, captureUsageScreen, parseQuotaScreen } from "../extensions/recipes/antigravity-quota.template";

describe("Antigravity quota capture", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("preserves the quota shape for both weekly groups", () => {
    const parsed = parseQuotaScreen(`
      Models & Quota
      Antigravity (Google AI Pro)
      GEMINI MODELS
      Weekly Limit 100%
      CLAUDE AND GPT MODELS
      Weekly Limit 73.5%
    `);

    expect(parsed).toEqual({
      plan: "Google AI Pro",
      buckets: [
        {
          id: "gemini",
          label: "Gemini models",
          percentUsed: 0,
          percentRemaining: 100,
          windowLabel: "weekly",
        },
        {
          id: "claude-gpt",
          label: "Claude + GPT models",
          percentUsed: 26.5,
          percentRemaining: 73.5,
          windowLabel: "weekly",
        },
      ],
    });
  });

  it("uses only the final occurrence of each quota group after redraws", () => {
    const parsed = parseQuotaScreen(`
      Models & Quota
      GEMINI MODELS
      Weekly Limit 12%
      CLAUDE AND GPT MODELS
      Weekly Limit 34%
      Models & Quota
      GEMINI MODELS
      Weekly Limit 56%
      CLAUDE AND GPT MODELS
      Weekly Limit 78%
    `);

    expect(parsed.buckets.map((bucket) => [bucket.id, bucket.percentRemaining])).toEqual([
      ["gemini", 56],
      ["claude-gpt", 78],
    ]);
  });

  it("rejects an incomplete final group instead of crossing section boundaries", () => {
    const parsed = parseQuotaScreen(`
      GEMINI MODELS
      Weekly Limit 12%
      CLAUDE AND GPT MODELS
      Weekly Limit 34%
      GEMINI MODELS
      rendering
      CLAUDE AND GPT MODELS
      Weekly Limit 78%
    `);

    expect(parsed.buckets).toEqual([]);
  });

  it("rejects a partial final redraw instead of mixing it with the prior frame", () => {
    const partialGroups = parseQuotaScreen(`
      Models & Quota
      Antigravity (Google AI Pro)
      GEMINI MODELS
      Weekly Limit 12%
      CLAUDE AND GPT MODELS
      Weekly Limit 34%
      GEMINI MODELS
      Weekly Limit 56%
    `);
    const partialTitle = parseQuotaScreen(`
      Models & Quota
      Antigravity (Google AI Pro)
      GEMINI MODELS
      Weekly Limit 12%
      CLAUDE AND GPT MODELS
      Weekly Limit 34%
      Models & Quota
      Antigravity (Google AI Ultra)
    `);

    expect(partialGroups).toEqual({ plan: undefined, buckets: [] });
    expect(partialTitle).toEqual({ plan: undefined, buckets: [] });
  });

  it("rejects a final frame with duplicate weekly quota values", () => {
    const parsed = parseQuotaScreen(`
      Models & Quota
      Antigravity (Google AI Pro)
      GEMINI MODELS
      Weekly Limit 12%
      Weekly Limit 56%
      CLAUDE AND GPT MODELS
      Weekly Limit 78%
    `);

    expect(parsed).toEqual({ plan: undefined, buckets: [] });
  });

  it("rejects duplicate model group sections within the final titled frame", () => {
    const parsed = parseQuotaScreen(`
      Models & Quota
      Antigravity (Google AI Pro)
      GEMINI MODELS
      Weekly Limit 12%
      GEMINI MODELS
      Weekly Limit 56%
      CLAUDE AND GPT MODELS
      Weekly Limit 78%
    `);

    expect(parsed).toEqual({ plan: undefined, buckets: [] });
  });

  it("rejects out-of-order model groups within the final titled frame", () => {
    const parsed = parseQuotaScreen(`
      Models & Quota
      Antigravity (Google AI Pro)
      CLAUDE AND GPT MODELS
      Weekly Limit 78%
      GEMINI MODELS
      Weekly Limit 56%
    `);

    expect(parsed).toEqual({ plan: undefined, buckets: [] });
  });

  it("does not register the shipped recipe template as a live server action", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "baby-menu-antigravity-cache-"));
    tempDirs.push(cacheDir);
    const registry = createServerActionRegistry({
      rootDir: fileURLToPath(new URL("../", import.meta.url)),
      actionRoots: ["extensions/recipes"],
      cacheDir,
    });

    await expect(registry.list()).resolves.toEqual([]);
  });

  it("returns the same normalized action response for both quota groups", async () => {
    const fixture = await createAgyFixture(`
printf 'Models & Quota\\nAntigravity (Google AI Ultra)\\nGEMINI MODELS\\nWeekly Limit 91%%\\nCLAUDE AND GPT MODELS\\nWeekly Limit 64%%\\n'
`);
    const originalPath = process.env.PATH;
    const originalPidFile = process.env.AGY_PID_FILE;
    process.env.PATH = fixture.env.PATH;
    process.env.AGY_PID_FILE = fixture.pidFile;

    try {
      const result = await actions.getQuota();
      expect(result).toMatchObject({
        ok: true,
        data: {
          source: "agy /usage",
          plan: "Google AI Ultra",
          buckets: [
            { id: "gemini", percentUsed: 9, percentRemaining: 91, windowLabel: "weekly" },
            { id: "claude-gpt", percentUsed: 36, percentRemaining: 64, windowLabel: "weekly" },
          ],
        },
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPidFile === undefined) delete process.env.AGY_PID_FILE;
      else process.env.AGY_PID_FILE = originalPidFile;
    }
  }, 10_000);

  it("reports a missing agy executable distinctly", async () => {
    const result = await captureUsageScreen({
      env: { ...process.env, PATH: "/usr/bin:/bin" },
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    });

    expect(result).toEqual({
      ok: false,
      status: "missing-agy",
      error: "Antigravity CLI is unavailable",
    });
  });

  it("isolates the Python helper from inherited module search paths", async () => {
    const fixture = await createAgyFixture(`
printf 'Models & Quota\\nAntigravity (Google AI Pro)\\nGEMINI MODELS\\nWeekly Limit 91%%\\nCLAUDE AND GPT MODELS\\nWeekly Limit 64%%\\n'
`);
    const shadowMarker = join(fixture.directory, "shadow-imported");
    await writeFile(
      join(fixture.directory, "base64.py"),
      `from pathlib import Path\nPath(${JSON.stringify(shadowMarker)}).write_text("imported")\n`,
    );

    const result = await captureUsageScreen({
      env: { ...fixture.env, PYTHONPATH: fixture.directory },
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    });

    expect(result.ok).toBe(true);
    await expect(readFile(shadowMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs quota inspection from the neutral temporary directory", async () => {
    const fixture = await createAgyFixture("");
    const cwdFile = join(fixture.directory, "agy.cwd");
    await writeFile(
      join(fixture.directory, "agy"),
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.AGY_CWD_FILE, process.cwd() + "\\n" + process.env.PWD + "\\n");
process.stdout.write("Models & Quota\\nAntigravity (Google AI Pro)\\nGEMINI MODELS\\nWeekly Limit 91%\\nCLAUDE AND GPT MODELS\\nWeekly Limit 64%\\n");
`,
    );

    const result = await captureUsageScreen({
      env: { ...fixture.env, AGY_CWD_FILE: cwdFile },
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    });

    expect(result.ok).toBe(true);
    const [actualCwd, inheritedPwd] = (await readFile(cwdFile, "utf8")).trim().split("\n");
    expect(actualCwd).toBe(inheritedPwd);
    expect(actualCwd).toContain("baby-menu-antigravity-probe-");
    await expect(realpath(actualCwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts a new project so the neutral directory does not require trust", async () => {
    const fixture = await createAgyFixture(`
if [ "$1" != "--new-project" ]; then
  printf 'Do you trust the contents of this project?'
  while :; do sleep 0.02; done
fi
printf 'Models & Quota\nAntigravity (Google AI Pro)\nGEMINI MODELS\nWeekly Limit 91%%\nCLAUDE AND GPT MODELS\nWeekly Limit 64%%\n'
`);

    const result = await captureUsageScreen({
      env: fixture.env,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    });

    expect(result.ok).toBe(true);
  });

  it("reports project trust as required without accepting the prompt", async () => {
    const fixture = await createAgyFixture(`
printf 'Do you trust the contents of this project?'
if IFS= read -r reply; then
  printf '%s' "$reply" > "$AGY_CONSENT_FILE"
fi
while :; do sleep 0.02; done
`);
    const consentFile = join(fixture.directory, "consent.txt");

    const result = await captureUsageScreen({
      env: { ...fixture.env, AGY_CONSENT_FILE: consentFile },
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    });

    expect(result).toEqual({
      ok: false,
      status: "trust-required",
      error: "Antigravity requested project trust during quota inspection",
    });
    await expect(readFile(consentFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prefers a trust prompt received while settling a complete frame", async () => {
    const fixture = await createAgyFixture(`
printf 'Models & Quota\\nAntigravity (Google AI Pro)\\nGEMINI MODELS\\nWeekly Limit 91%%\\nCLAUDE AND GPT MODELS\\nWeekly Limit 64%%\\n'
sleep 0.2
printf 'Do you trust the contents of this project?'
while :; do sleep 0.02; done
`);

    const result = await captureUsageScreen({
      env: fixture.env,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    });

    expect(result).toEqual({
      ok: false,
      status: "trust-required",
      error: "Antigravity requested project trust during quota inspection",
    });
  });

  it("reports an unavailable quota source distinctly", async () => {
    const fixture = await createAgyFixture(`
printf 'Antigravity service unavailable\n'
exit 1
`);

    const result = await captureUsageScreen({
      env: fixture.env,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    });

    expect(result).toEqual({
      ok: false,
      status: "unavailable",
      error: "Antigravity quota is unavailable",
    });
  });

  it("reports an in-progress sign-in as a transient source state", async () => {
    const fixture = await createAgyFixture(`
printf 'You are currently not signed in. Signing in...\n'
while :; do sleep 0.02; done
`);

    const startedAt = Date.now();
    const result = await captureUsageScreen({
      env: fixture.env,
      internalCaptureTimeoutMs: 5_000,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    });

    expect(result).toEqual({
      ok: false,
      status: "sign-in-in-progress",
      transient: true,
      error: "Antigravity sign-in is in progress",
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("prefers a completed quota frame over an earlier sign-in transition", async () => {
    const fixture = await createAgyFixture(`
printf 'You are currently not signed in. Signing in...\n'
sleep 0.05
printf 'Models & Quota\nAntigravity (Google AI Pro)\nGEMINI MODELS\nWeekly Limit 91%%\nCLAUDE AND GPT MODELS\nWeekly Limit 64%%\n'
`);

    const result = await captureUsageScreen({ env: fixture.env, timeoutMs: 5_000, terminationGraceMs: 100 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(parseQuotaScreen(result.output).buckets.map((bucket) => bucket.percentRemaining)).toEqual([91, 64]);
  });

  it("reports unavailable when the source exits after a sign-in transition", async () => {
    const fixture = await createAgyFixture(`
printf 'You are currently not signed in. Signing in...\nAntigravity service unavailable\n'
exit 1
`);

    const result = await captureUsageScreen({ env: fixture.env, timeoutMs: 5_000, terminationGraceMs: 100 });

    expect(result).toEqual({
      ok: false,
      status: "unavailable",
      error: "Antigravity quota is unavailable",
    });
  });

  it.each([
    {
      name: "missing agy",
      body: undefined,
      expected: { ok: false, status: "missing-agy", error: "Antigravity CLI is unavailable" },
    },
    {
      name: "unavailable source",
      body: "printf 'Antigravity service unavailable\\n'\nexit 1",
      expected: { ok: false, status: "unavailable", error: "Antigravity quota is unavailable" },
    },
    {
      name: "source exiting after a sign-in transition",
      body: "printf 'You are currently not signed in. Signing in...\\nAntigravity service unavailable\\n'\nexit 1",
      expected: { ok: false, status: "unavailable", error: "Antigravity quota is unavailable" },
    },
    {
      name: "sign-in in progress",
      body: "printf 'You are currently not signed in. Signing in...\\n'\nwhile :; do sleep 0.02; done",
      expected: {
        ok: false,
        status: "sign-in-in-progress",
        transient: true,
        error: "Antigravity sign-in is in progress",
      },
    },
    {
      name: "project trust required",
      body: "printf 'Do you trust the contents of this project?'\nwhile :; do sleep 0.02; done",
      expected: {
        ok: false,
        status: "trust-required",
        error: "Antigravity requested project trust during quota inspection",
      },
    },
  ])(
    "preserves the $name status through getQuota",
    async ({ body, expected }) => {
      const fixture = body === undefined ? undefined : await createAgyFixture(body);
      const path = fixture?.env.PATH ?? "/usr/bin:/bin";
      const pidFile = fixture?.pidFile;

      await withProcessEnv({ PATH: path, AGY_PID_FILE: pidFile }, async () => {
        await expect(actions.getQuota()).resolves.toEqual(expected);
      });
    },
    10_000,
  );

  it("kills the complete helper process group after the timeout grace period", async () => {
    const fixture = await createAgyFixture(`
trap '' TERM
while :; do
  printf 'waiting for usage\\r'
  sleep 0.02
done
`);

    const result = await captureUsageScreen({
      env: fixture.env,
      timeoutMs: 1_000,
      terminationGraceMs: 100,
    });
    const agyPid = Number(await readFile(fixture.pidFile, "utf8"));

    expect(result).toEqual({
      ok: false,
      status: "timeout",
      error: "Antigravity quota capture timed out",
    });
    await expect(waitForProcessExit(agyPid)).resolves.toBeUndefined();
  });

  it("allows the configured grace period for direct-child cleanup", async () => {
    const fixture = await createAgyFixture(`
trap 'sleep 2.2; echo graceful > "$CLEANUP_FILE"; exit 0' TERM
printf 'Models & Quota\\nAntigravity (Google AI Pro)\\nGEMINI MODELS\\nWeekly Limit 91%%\\nCLAUDE AND GPT MODELS\\nWeekly Limit 64%%\\n'
while :; do sleep 0.02; done
`);
    const cleanupFile = join(fixture.directory, "cleanup.complete");

    const result = await captureUsageScreen({
      env: { ...fixture.env, CLEANUP_FILE: cleanupFile },
      timeoutMs: 8_000,
      terminationGraceMs: 2_500,
    });

    expect(result.ok).toBe(true);
    await expect(readFile(cleanupFile, "utf8")).resolves.toBe("graceful\n");
  }, 10_000);

  it("reports the internal capture deadline as a timeout", async () => {
    const fixture = await createAgyFixture(`
printf 'Models & Quota\\nAntigravity (Google AI Pro)\\nGEMINI MODELS\\nWeekly Limit 91%%\\n'
(
  trap '' TERM HUP
  while :; do sleep 0.02; done
) &
echo $! > "$DESCENDANT_PID_FILE"
trap 'exit 0' TERM
while :; do sleep 0.02; done
`);
    const descendantPidFile = join(fixture.directory, "descendant.pid");

    const capture = captureUsageScreen({
      env: { ...fixture.env, DESCENDANT_PID_FILE: descendantPidFile },
      internalCaptureTimeoutMs: 500,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    });
    const descendantPid = Number(await waitForFile(descendantPidFile));
    const result = await capture;

    try {
      expect(result).toEqual({
        ok: false,
        status: "timeout",
        error: "Antigravity quota capture timed out",
      });
      await expect(waitForProcessExit(descendantPid, 500)).resolves.toBeUndefined();
    } finally {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  });

  it("keeps the cleaned helper alive to anchor its process group until escalation", async () => {
    const fixture = await createAgyFixture(`
echo "$PPID" > "$HELPER_PID_FILE"
trap 'echo cleaned > "$CLEANUP_FILE"; exit 0' TERM
while :; do sleep 0.02; done
`);
    const helperPidFile = join(fixture.directory, "helper.pid");
    const cleanupFile = join(fixture.directory, "cleanup.complete");
    const capture = captureUsageScreen({
      env: { ...fixture.env, HELPER_PID_FILE: helperPidFile, CLEANUP_FILE: cleanupFile },
      timeoutMs: 2_000,
      terminationGraceMs: 1_000,
    });
    const helperPid = Number(await waitForFile(helperPidFile));
    const agyPid = Number(await readFile(fixture.pidFile, "utf8"));

    await waitForFile(cleanupFile);
    expect(isProcessAlive(helperPid)).toBe(true);

    await expect(capture).resolves.toEqual({
      ok: false,
      status: "timeout",
      error: "Antigravity quota capture timed out",
    });
    await expect(waitForProcessExit(helperPid)).resolves.toBeUndefined();
    await expect(waitForProcessExit(agyPid)).resolves.toBeUndefined();
  });

  it("cleans the complete helper process group after a successful capture", async () => {
    const fixture = await createAgyFixture(`
(
  trap '' TERM HUP
  while :; do sleep 0.02; done
) &
echo $! > "$DESCENDANT_PID_FILE"
printf 'Models & Quota\\nAntigravity (Google AI Pro)\\nGEMINI MODELS\\nWeekly Limit 91%%\\nCLAUDE AND GPT MODELS\\nWeekly Limit 64%%\\n'
`);
    const descendantPidFile = join(fixture.directory, "descendant.pid");
    const capture = captureUsageScreen({
      env: { ...fixture.env, DESCENDANT_PID_FILE: descendantPidFile },
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    });
    const descendantPid = Number(await waitForFile(descendantPidFile));
    const result = await capture;

    try {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(parseQuotaScreen(result.output).buckets.map((bucket) => bucket.percentRemaining)).toEqual([91, 64]);
      await expect(waitForProcessExit(descendantPid, 500)).resolves.toBeUndefined();
    } finally {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  });

  it("self-cleans the helper process group when the host exits", async () => {
    const fixture = await createAgyFixture(`
echo "$PPID" > "$HELPER_PID_FILE"
(
  trap '' TERM HUP
  while :; do sleep 0.02; done
) &
echo $! > "$DESCENDANT_PID_FILE"
trap '' TERM
while :; do sleep 0.02; done
`);
    const helperPidFile = join(fixture.directory, "helper.pid");
    const descendantPidFile = join(fixture.directory, "descendant.pid");
    const runner = join(fixture.directory, "capture-host.ts");
    await writeFile(
      runner,
      `import { captureUsageScreen } from ${JSON.stringify(fileURLToPath(new URL("../extensions/recipes/antigravity-quota.template.ts", import.meta.url)))};\nawait captureUsageScreen({ timeoutMs: 30_000, terminationGraceMs: 100 });\n`,
    );
    const host = spawn(process.execPath, ["--experimental-strip-types", runner], {
      env: { ...fixture.env, HELPER_PID_FILE: helperPidFile, DESCENDANT_PID_FILE: descendantPidFile },
      stdio: "ignore",
    });
    const helperPid = Number(await waitForFile(helperPidFile));
    const agyPid = Number(await waitForFile(fixture.pidFile));
    const descendantPid = Number(await waitForFile(descendantPidFile));

    try {
      host.kill("SIGKILL");
      await expect(waitForProcessExit(host.pid!)).resolves.toBeUndefined();
      await expect(waitForProcessExit(helperPid, 1_000)).resolves.toBeUndefined();
      await expect(waitForProcessExit(agyPid, 1_000)).resolves.toBeUndefined();
      await expect(waitForProcessExit(descendantPid, 1_000)).resolves.toBeUndefined();
    } finally {
      host.kill("SIGKILL");
      try {
        process.kill(-helperPid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  });

  it("self-cleans the helper process group when the host exits during outcome reporting", async () => {
    const fixture = await createAgyFixture(`
echo "$PPID" > "$HELPER_PID_FILE"
(
  trap '' TERM HUP
  while :; do sleep 0.02; done
) &
echo $! > "$DESCENDANT_PID_FILE"
trap 'echo cleaning > "$CLEANUP_FILE"; sleep 0.2; exit 0' TERM
printf 'Models & Quota\\nAntigravity (Google AI Pro)\\nGEMINI MODELS\\nWeekly Limit 91%%\\nCLAUDE AND GPT MODELS\\nWeekly Limit 64%%\\n'
while :; do sleep 0.02; done
`);
    const helperPidFile = join(fixture.directory, "helper.pid");
    const descendantPidFile = join(fixture.directory, "descendant.pid");
    const cleanupFile = join(fixture.directory, "cleanup.started");
    const runner = join(fixture.directory, "capture-host.ts");
    await writeFile(
      runner,
      `import { captureUsageScreen } from ${JSON.stringify(fileURLToPath(new URL("../extensions/recipes/antigravity-quota.template.ts", import.meta.url)))};\nawait captureUsageScreen({ timeoutMs: 30_000, terminationGraceMs: 500 });\n`,
    );
    const host = spawn(process.execPath, ["--experimental-strip-types", runner], {
      env: {
        ...fixture.env,
        HELPER_PID_FILE: helperPidFile,
        DESCENDANT_PID_FILE: descendantPidFile,
        CLEANUP_FILE: cleanupFile,
      },
      stdio: "ignore",
    });
    const helperPid = Number(await waitForFile(helperPidFile));
    const descendantPid = Number(await waitForFile(descendantPidFile));

    try {
      await waitForFile(cleanupFile);
      host.kill("SIGKILL");
      await expect(waitForProcessExit(host.pid!)).resolves.toBeUndefined();
      await expect(waitForProcessExit(helperPid, 2_000)).resolves.toBeUndefined();
      await expect(waitForProcessExit(descendantPid, 2_000)).resolves.toBeUndefined();
    } finally {
      host.kill("SIGKILL");
      try {
        process.kill(-helperPid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  });

  it("cleans the helper process group when the PTY peer exits before quota capture", async () => {
    const fixture = await createAgyFixture(`
(
  trap '' TERM HUP
  while :; do sleep 0.02; done
) </dev/null >/dev/null 2>&1 &
echo $! > "$DESCENDANT_PID_FILE"
printf '? for shortcuts\n'
# Exit before the helper can capture a quota screen. The surviving descendant
# remains in the helper's process group and must still be cleaned up.
exit 0
`);
    const descendantPidFile = join(fixture.directory, "descendant.pid");
    const capture = captureUsageScreen({
      env: { ...fixture.env, DESCENDANT_PID_FILE: descendantPidFile },
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    });
    const descendantPid = Number(await waitForFile(descendantPidFile));
    const result = await capture;

    try {
      expect(result).toEqual({
        ok: false,
        status: "unavailable",
        error: "Antigravity quota is unavailable",
      });
      await expect(waitForProcessExit(descendantPid, 500)).resolves.toBeUndefined();
    } finally {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  });

  it("keeps only the final rendered screen when a TUI redraws beyond the old byte cap", async () => {
    const fixture = await createAgyFixture(`
i=0
while [ "$i" -lt 5000 ]; do
  printf 'redrawing-antigravity-usage-screen-abcdefghijklmnopqrstuvwxyz0123456789\\r'
  i=$((i + 1))
done
printf '\\nModels & Quota\\nAntigravity (Google AI Pro)\\nGEMINI MODELS\\nWeekly Limit 100%%\\nCLAUDE AND GPT MODELS\\nWeekly Limit 88%%\\n'
`);

    const result = await captureUsageScreen({ env: fixture.env, timeoutMs: 5_000, terminationGraceMs: 100 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(128 * 1024);
    expect(parseQuotaScreen(result.output).buckets.map((bucket) => bucket.percentRemaining)).toEqual([100, 88]);
  });

  it("waits for a complete latest frame after a partial redraw", async () => {
    const fixture = await createAgyFixture(`
printf 'Models & Quota\\nAntigravity (Google AI Pro)\\nGEMINI MODELS\\nWeekly Limit 91%%\\nCLAUDE AND GPT MODELS\\nWeekly Limit 64%%\\n'
sleep 0.2
printf 'Models & Quota\\nAntigravity (Google AI Ultra)\\nGEMINI MODELS\\nWeekly Limit 77%%\\n'
sleep 1.2
printf 'CLAUDE AND GPT MODELS\\nWeekly Limit 42%%\\n'
`);

    const result = await captureUsageScreen({ env: fixture.env, timeoutMs: 5_000, terminationGraceMs: 100 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(parseQuotaScreen(result.output)).toMatchObject({
      plan: "Google AI Ultra",
      buckets: [
        { id: "gemini", percentRemaining: 77 },
        { id: "claude-gpt", percentRemaining: 42 },
      ],
    });
  });

  async function createAgyFixture(body: string) {
    const directory = await mkdtemp(join(tmpdir(), "baby-menu-antigravity-"));
    tempDirs.push(directory);
    const executable = join(directory, "agy");
    const pidFile = join(directory, "agy.pid");
    await writeFile(executable, `#!/bin/sh\necho $$ > "$AGY_PID_FILE"\n${body}`);
    await chmod(executable, 0o755);
    return {
      directory,
      pidFile,
      env: {
        ...process.env,
        AGY_PID_FILE: pidFile,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
      },
    };
  }

  async function withProcessEnv(
    values: Record<string, string | undefined>,
    callback: () => Promise<void>,
  ): Promise<void> {
    const originals = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await callback();
    } finally {
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`process ${pid} survived cleanup`);
  }

  async function waitForFile(filePath: string, timeoutMs = 3_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`file ${filePath} was not created`);
  }

  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }
});
