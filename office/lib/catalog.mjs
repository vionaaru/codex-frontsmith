// Общий источник прайса для сайта и панели.
// Есть база офиса с каталогом — читаем её; базы ещё нет — совместимый файловый режим из business.json
import { existsSync } from "node:fs";
import { businessPath } from "../../scripts/lib/paths.mjs";

export async function loadServiceCatalog(profile, { dbFile = businessPath("office.sqlite") } = {}) {
  const fileServices = Array.isArray(profile.services) ? profile.services : [];
  if (!existsSync(dbFile)) {
    return { source: "file", services: fileServices, note: "База офиса не создана: прайс из business.json" };
  }

  const { openOfficeDb } = await import("./db.mjs");
  const db = openOfficeDb({ file: dbFile, readonly: true });
  try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'services'").get();
    const rows = hasTable ? db.prepare("SELECT * FROM services WHERE is_active = 1 ORDER BY sort_order, name").all() : [];
    if (!rows.length) {
      return { source: "file", services: fileServices, note: "Каталог в базе пуст: прайс из business.json. Выполните npm run office:import" };
    }
    const presentation = new Map(fileServices.map((service) => [service.id, service]));
    return {
      source: "db",
      dbFile,
      note: `Прайс из базы офиса (${rows.length} активных услуг); цены в business.json больше не используются для сайта`,
      services: rows.map((row) => {
        const extra = presentation.get(row.code) ?? {};
        return {
          ...extra,
          id: row.code,
          name: row.name,
          category: row.category,
          description: row.description ?? "",
          priceFrom: row.base_price_kopecks === null ? null : row.base_price_kopecks / 100,
          durationMinutes: row.duration_minutes,
          demoPrice: row.is_demo_price === 1
        };
      })
    };
  } finally {
    db.close();
  }
}
