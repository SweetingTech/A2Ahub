import fs from "node:fs";
import path from "node:path";

// Test-only clock skew for credential-expiry integration tests. The offset file
// must live inside the disposable data directory the test created, so a normal
// installation can never be time-shifted by a stray variable.
export function hubClock(dataDir, env = process.env) {
  const file = env.A2AHUB_TEST_CLOCK_FILE;
  if (!file) return () => Date.now();
  if (path.dirname(path.resolve(file)) !== path.resolve(dataDir))
    throw new Error("A2AHUB_TEST_CLOCK_FILE must be inside A2AHUB_DATA_DIR.");
  console.warn("A2Ahub test clock enabled; time follows", path.basename(file));
  return () => {
    let offset = 0;
    try {
      offset = Number(JSON.parse(fs.readFileSync(file, "utf8")).offsetMs) || 0;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return Date.now() + offset;
  };
}
