// The plugin's only output: a small JSON file with the rendered line.
// Something else puts it on Discord (automation/set-presence.js, an OpenClaw
// automation script payload calling the message tool's set-presence action).

import fs from "node:fs";
import path from "node:path";

/**
 * Write { text, items, updatedAt } atomically: a temp file in the same
 * directory, then rename, so a reader never sees half a file.
 */
export function writeStatusFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}
