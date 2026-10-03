import type { ChildProcess } from "child_process";
import * as os from "os";

export function killProcessGroup(child: ChildProcess): void {
  try {
    if (!child.pid) return;
    if (os.platform() !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (e) {
        console.warn(`Failed to kill process group for child ${child.pid}:`, e);
        child.kill("SIGKILL");
      }
    } else {
      child.kill("SIGKILL");
    }
  } catch (e) {
    console.warn(`Fallback kill failed for child ${child.pid}:`, e);
  }
}
