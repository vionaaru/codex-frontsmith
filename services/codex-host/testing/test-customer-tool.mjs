// Тестовый application-owned инструмент: заменяет будущий доступ к CRM.
// Читает синтетический fixture в доверенной части Host. Codex не получает путь
// к файлу и не имеет к нему доступа: workspace агента — отдельный каталог.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_PRIVATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fixture-private.txt");

export function getTestCustomerTool(file = FIXTURE_PRIVATE) {
  return {
    name: "get_test_customer",
    description: "Возвращает карточку тестового клиента из CRM Frontsmith.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => (await readFile(file, "utf8")).trim()
  };
}
