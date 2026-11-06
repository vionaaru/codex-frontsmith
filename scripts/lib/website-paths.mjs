import { realpath } from "node:fs/promises";

// Public filenames must remain unambiguous on the supported Windows installation,
// including when sources were prepared on a case-sensitive filesystem.
export function indexWebsitePaths(names) {
  const index = new Map();
  for (const name of names) {
    const key = name.toLowerCase();
    if (index.has(key)) throw new Error(`Коллизия имён файлов сайта: ${index.get(key)} и ${name}`);
    index.set(key, name);
  }
  return index;
}

// Use actual filesystem resolution, not process.platform: Windows directories can
// also be case-sensitive. Distinct paths on such a filesystem must remain distinct.
export async function existingPathAlias(first, second) {
  try { return await realpath(first) === await realpath(second); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
