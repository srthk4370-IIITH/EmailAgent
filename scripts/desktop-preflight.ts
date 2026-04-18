import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

import { isLoopbackHost } from "../src/lib/hostUtils";
import { getRuntimeConfigSync } from "../src/lib/runtimeConfig";

type Severity = "PASS" | "WARN" | "FAIL";

type CheckResult = {
  name: string;
  severity: Severity;
  detail: string;
};

const REQUIRED_RUNTIME_KEYS = [
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REDIRECT_URI",
] as const;

const REQUIRED_SCRIPTS = [
  "dev",
  "build",
  "start",
  "worker",
  "desktop:preflight",
  "desktop:tauri:dev",
  "desktop:tauri:build",
  "desktop:runtime:prod",
  "desktop:qa:deep",
] as const;

function readPackageJsonScripts(): Record<string, string> {
  const packageJsonPath = path.join(process.cwd(), "package.json");
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
  return parsed.scripts ?? {};
}

function commandAvailable(command: string, args: string[] = ["--version"]): { ok: boolean; detail: string } {
  const executable = process.platform === "win32" && (command === "npm" || command === "npx") ? `${command}.cmd` : command;
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (result.error) {
    return { ok: false, detail: result.error.message };
  }

  if ((result.status ?? 1) !== 0) {
    const stderr = (result.stderr ?? "").trim();
    return { ok: false, detail: stderr.length > 0 ? stderr : `exit_code=${result.status ?? 1}` };
  }

  const stdout = (result.stdout ?? "").trim().split(/\r?\n/)[0] ?? "ok";
  return { ok: true, detail: stdout || "ok" };
}

function windowsMsvcSdkAvailable(): { ok: boolean; detail: string } {
  if (process.platform !== "win32") {
    return {
      ok: true,
      detail: "not required on non-windows",
    };
  }

  const vswhereCandidates = [
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
    "C:\\Program Files\\Microsoft Visual Studio\\Installer\\vswhere.exe",
  ];
  const vswherePath = vswhereCandidates.find((candidate) => fs.existsSync(candidate));

  if (!vswherePath) {
    return {
      ok: false,
      detail: "vswhere.exe not found (install Visual Studio Build Tools with MSVC + Windows SDK)",
    };
  }

  const commonArgs = ["-latest", "-products", "*"];

  const msvcResult = spawnSync(vswherePath, [...commonArgs, "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (msvcResult.error) {
    return {
      ok: false,
      detail: msvcResult.error.message,
    };
  }

  if ((msvcResult.status ?? 0) !== 0) {
    return {
      ok: false,
      detail: `vswhere exit_code=${msvcResult.status ?? 1}`,
    };
  }

  const msvcInstancePath = (msvcResult.stdout ?? "").trim();

  const anyVsInstanceResult = spawnSync(vswherePath, [...commonArgs, "-property", "installationPath"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  const anyVsInstancePath = (anyVsInstanceResult.stdout ?? "").trim();
  const llvmToolchainPaths = anyVsInstancePath
    ? [
        path.join(anyVsInstancePath, "VC", "Tools", "Llvm", "x64", "bin", "lld-link.exe"),
        path.join(anyVsInstancePath, "VC", "Tools", "Llvm", "x64", "bin", "clang-cl.exe"),
      ]
    : [];
  const hasLlvmToolchain = llvmToolchainPaths.some((candidate) => fs.existsSync(candidate));

  const hasMsvcComponent = msvcInstancePath.length > 0;

  const sdkComponents = [
    "Microsoft.VisualStudio.Component.Windows10SDK.19041",
    "Microsoft.VisualStudio.Component.Windows10SDK.20348",
    "Microsoft.VisualStudio.Component.Windows11SDK.22000",
    "Microsoft.VisualStudio.Component.Windows11SDK.22621",
  ];

  for (const sdkComponent of sdkComponents) {
    const sdkResult = spawnSync(vswherePath, [...commonArgs, "-requires", sdkComponent, "-property", "installationPath"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    if (sdkResult.error || (sdkResult.status ?? 0) !== 0) {
      continue;
    }

    if ((sdkResult.stdout ?? "").trim().length > 0) {
      return {
        ok: hasMsvcComponent || hasLlvmToolchain,
        detail: hasMsvcComponent
          ? `MSVC and ${sdkComponent} detected`
          : hasLlvmToolchain
            ? `LLVM toolchain and ${sdkComponent} detected`
            : `Windows SDK ${sdkComponent} detected, but no supported C/C++ toolchain found`,
      };
    }
  }

  // Fallback: some machines have a standalone Windows SDK installed and usable for builds,
  // but the corresponding Visual Studio component ID is not returned by vswhere.
  const windowsKitsIncludeRoot = "C:\\Program Files (x86)\\Windows Kits\\10\\Include";
  if (fs.existsSync(windowsKitsIncludeRoot)) {
    try {
      const sdkVersions = fs
        .readdirSync(windowsKitsIncludeRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((version) => fs.existsSync(path.join(windowsKitsIncludeRoot, version, "um", "Windows.h")))
        .sort();

      const latestVersion = sdkVersions[sdkVersions.length - 1];
      if (latestVersion) {
        return {
          ok: hasMsvcComponent || hasLlvmToolchain,
          detail: hasMsvcComponent
            ? `MSVC and Windows SDK include path detected (${latestVersion})`
            : hasLlvmToolchain
              ? `LLVM toolchain and Windows SDK include path detected (${latestVersion})`
              : `Windows SDK include path detected (${latestVersion}), but no supported C/C++ toolchain found`,
        };
      }
    } catch {
      // Ignore filesystem read errors and fall through to failure detail below.
    }
  }

  if (!hasMsvcComponent && !hasLlvmToolchain) {
    return {
      ok: false,
      detail: "MSVC component not found (install Visual Studio Build Tools C++ workload)",
    };
  }

  return {
    ok: false,
    detail: "Windows SDK component not found (install Windows 10/11 SDK in Build Tools)",
  };
}

function format(severity: Severity): string {
  return severity.padEnd(4, " ");
}

function addResult(results: CheckResult[], result: CheckResult): void {
  results.push(result);
  console.log(`${format(result.severity)} ${result.name} - ${result.detail}`);
}

function main(): void {
  const results: CheckResult[] = [];

  for (const key of REQUIRED_RUNTIME_KEYS) {
    const value = getRuntimeConfigSync(key);
    if (value && value.trim().length > 0) {
      addResult(results, {
        name: `runtime:${key}`,
        severity: "PASS",
        detail: "set",
      });
    } else {
      addResult(results, {
        name: `runtime:${key}`,
        severity: "FAIL",
        detail: "missing",
      });
    }
  }

  const redirectRaw = getRuntimeConfigSync("GMAIL_REDIRECT_URI");
  if (!redirectRaw) {
    addResult(results, {
      name: "oauth:redirect_uri",
      severity: "FAIL",
      detail: "GMAIL_REDIRECT_URI is not configured",
    });
  } else {
    try {
      const redirectUrl = new URL(redirectRaw);
      const loopback = isLoopbackHost(redirectUrl.hostname);
      const callbackPathOk = redirectUrl.pathname.endsWith("/api/auth/google/callback");

      addResult(results, {
        name: "oauth:redirect_uri_parse",
        severity: "PASS",
        detail: `${redirectUrl.protocol}//${redirectUrl.host}${redirectUrl.pathname}`,
      });

      addResult(results, {
        name: "oauth:redirect_uri_host",
        severity: loopback ? "PASS" : "WARN",
        detail: loopback
          ? "loopback host detected (desktop-friendly)"
          : "non-loopback host; desktop wrapper usually prefers localhost/127.0.0.1",
      });

      addResult(results, {
        name: "oauth:redirect_uri_path",
        severity: callbackPathOk ? "PASS" : "WARN",
        detail: callbackPathOk
          ? "callback path matches /api/auth/google/callback"
          : "callback path differs from /api/auth/google/callback",
      });

      const forcedSecure = (getRuntimeConfigSync("SESSION_COOKIE_SECURE") ?? "").trim().toLowerCase();
      if (loopback && forcedSecure === "true") {
        addResult(results, {
          name: "session_cookie_secure",
          severity: "WARN",
          detail: "forced true on loopback can block local desktop auth cookies",
        });
      } else {
        addResult(results, {
          name: "session_cookie_secure",
          severity: "PASS",
          detail: forcedSecure ? `override=${forcedSecure}` : "auto",
        });
      }
    } catch {
      addResult(results, {
        name: "oauth:redirect_uri",
        severity: "FAIL",
        detail: "invalid URL",
      });
    }
  }

  const scripts = readPackageJsonScripts();
  for (const script of REQUIRED_SCRIPTS) {
    if (scripts[script]) {
      addResult(results, {
        name: `npm_script:${script}`,
        severity: "PASS",
        detail: scripts[script],
      });
    } else {
      addResult(results, {
        name: `npm_script:${script}`,
        severity: "FAIL",
        detail: "missing",
      });
    }
  }

  const readinessFiles = [
    "src/lib/hostUtils.ts",
    "src/lib/sessionCookie.ts",
    "src/app/api/auth/google/route.ts",
    "src/app/api/auth/google/callback/route.ts",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "src-tauri/src/main.rs",
    "src-tauri/capabilities/default.json",
    "desktop/web-dist/index.html",
  ];

  for (const file of readinessFiles) {
    const absolute = path.join(process.cwd(), file);
    addResult(results, {
      name: `readiness_file:${file}`,
      severity: fs.existsSync(absolute) ? "PASS" : "FAIL",
      detail: fs.existsSync(absolute) ? "present" : "missing",
    });
  }

  const tauriConfigPath = path.join(process.cwd(), "src-tauri", "tauri.conf.json");
  if (fs.existsSync(tauriConfigPath)) {
    try {
      const configRaw = fs.readFileSync(tauriConfigPath, "utf8");
      const config = JSON.parse(configRaw) as {
        app?: { windows?: Array<{ url?: string | null }> };
        build?: { devUrl?: string | null };
      };

      const firstWindowUrl = config.app?.windows?.[0]?.url ?? null;
      const devUrl = config.build?.devUrl ?? null;
      const effectiveUrl = firstWindowUrl || devUrl;

      if (effectiveUrl) {
        let parsed: URL | null = null;
        try {
          parsed = new URL(effectiveUrl);
        } catch {
          parsed = null;
        }

        addResult(results, {
          name: "tauri:url_parse",
          severity: parsed ? "PASS" : "FAIL",
          detail: parsed ? `${parsed.protocol}//${parsed.host}${parsed.pathname}` : `invalid_url:${effectiveUrl}`,
        });

        addResult(results, {
          name: "tauri:url_host",
          severity: parsed && isLoopbackHost(parsed.hostname) ? "PASS" : "WARN",
          detail:
            parsed && isLoopbackHost(parsed.hostname)
              ? "loopback desktop URL configured"
              : "desktop URL is not loopback; confirm OAuth/session origin strategy",
        });
      } else {
        addResult(results, {
          name: "tauri:url",
          severity: "FAIL",
          detail: "no window.url or build.devUrl configured",
        });
      }
    } catch (error) {
      addResult(results, {
        name: "tauri:config_parse",
        severity: "FAIL",
        detail: error instanceof Error ? error.message : "invalid tauri.conf.json",
      });
    }
  }

  const rustc = commandAvailable("rustc", ["--version"]);
  addResult(results, {
    name: "tooling:rustc",
    severity: rustc.ok ? "PASS" : "FAIL",
    detail: rustc.detail,
  });

  const cargo = commandAvailable("cargo", ["--version"]);
  addResult(results, {
    name: "tooling:cargo",
    severity: cargo.ok ? "PASS" : "FAIL",
    detail: cargo.detail,
  });

  const tauriCliPackagePath = path.join(process.cwd(), "node_modules", "@tauri-apps", "cli", "package.json");
  if (fs.existsSync(tauriCliPackagePath)) {
    try {
      const raw = fs.readFileSync(tauriCliPackagePath, "utf8");
      const parsed = JSON.parse(raw) as { version?: string };
      addResult(results, {
        name: "tooling:tauri_cli",
        severity: "PASS",
        detail: parsed.version ? `@tauri-apps/cli@${parsed.version}` : "installed",
      });
    } catch (error) {
      addResult(results, {
        name: "tooling:tauri_cli",
        severity: "FAIL",
        detail: error instanceof Error ? error.message : "invalid package metadata",
      });
    }
  } else {
    addResult(results, {
      name: "tooling:tauri_cli",
      severity: "FAIL",
      detail: "@tauri-apps/cli not installed",
    });
  }

  const windowsMsvcSdk = windowsMsvcSdkAvailable();
  addResult(results, {
    name: "tooling:windows_msvc_sdk",
    severity: windowsMsvcSdk.ok ? "PASS" : "FAIL",
    detail: windowsMsvcSdk.detail,
  });

  const failCount = results.filter((result) => result.severity === "FAIL").length;
  const warnCount = results.filter((result) => result.severity === "WARN").length;
  const passCount = results.filter((result) => result.severity === "PASS").length;

  console.log("\nDesktop wrapper preflight summary");
  console.log(`PASS: ${passCount}`);
  console.log(`WARN: ${warnCount}`);
  console.log(`FAIL: ${failCount}`);

  if (failCount > 0) {
    process.exitCode = 1;
  }
}

main();
