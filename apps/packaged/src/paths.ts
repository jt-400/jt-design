import { join } from "node:path";

import { APP_KEYS, normalizeNamespace } from "@open-design/sidecar-proto";

import type { PackagedConfig } from "./config.js";

export type PackagedNamespacePaths = {
  cacheRoot: string;
  desktopIdentityPath: string;
  desktopLogPath: string;
  dataRoot: string;
  desktopLogsRoot: string;
  electronSessionDataRoot: string;
  electronUserDataRoot: string;
  headlessIdentityPath: string;
  installerObservationRoot: string;
  logsRoot: string;
  namespaceRoot: string;
  resourceRoot: string;
  runtimeRoot: string;
  updateRoot: string;
  webIdentityPath: string;
};

export function resolvePackagedNamespacePaths(
  config: PackagedConfig,
  namespace = config.namespace,
): PackagedNamespacePaths {
  const normalizedNamespace = normalizeNamespace(namespace);
  const namespaceRoot = join(config.namespaceBaseRoot, normalizedNamespace);
  const dataRoot = join(namespaceRoot, "data");

  return {
    cacheRoot: join(namespaceRoot, "cache"),
    desktopIdentityPath: join(namespaceRoot, "runtime", "desktop-root.json"),
    desktopLogPath: join(namespaceRoot, "logs", APP_KEYS.DESKTOP, "latest.log"),
    dataRoot,
    desktopLogsRoot: join(namespaceRoot, "logs", APP_KEYS.DESKTOP),
    electronSessionDataRoot: join(namespaceRoot, "user-data", "session"),
    electronUserDataRoot: join(namespaceRoot, "user-data"),
    headlessIdentityPath: join(namespaceRoot, "runtime", "headless-root.json"),
    installerObservationRoot: join(dataRoot, "observations", "installer"),
    logsRoot: join(namespaceRoot, "logs"),
    namespaceRoot,
    resourceRoot: config.resourceRoot,
    runtimeRoot: join(namespaceRoot, "runtime"),
    updateRoot: join(namespaceRoot, "updates"),
    webIdentityPath: join(namespaceRoot, "runtime", "web-root.json"),
  };
}
