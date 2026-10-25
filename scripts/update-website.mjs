import { WebsiteEditedError, renderWebsite } from "./lib/render-website.mjs";

let result;
try {
  result = await renderWebsite({ force: process.argv.includes("--force") });
} catch (error) {
  if (!(error instanceof WebsiteEditedError)) throw error;
  console.error(`Сайт не обновлён: ${error.message}`);
  process.exit(1);
}

console.log(`Обновлён сайт: ${result.business.businessName}`);
console.log(`Сайт: ${result.websiteDir}`);
if (result.backupPath) console.log(`Прежний index.html сохранён: ${result.backupPath}`);
console.log(`Прайс: ${result.catalog.note}`);
console.log(`Материалы проверки: ${result.reviewDisplayPath}`);
console.log(`Запись действия: ${result.activityDisplayPath}`);
