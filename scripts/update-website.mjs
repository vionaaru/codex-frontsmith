import { renderWebsite } from "./lib/render-website.mjs";

const result = await renderWebsite();

console.log(`Обновлён сайт: ${result.business.businessName}`);
console.log(`Сайт: ${result.websiteDir}`);
console.log(`Прайс: ${result.catalog.note}`);
console.log(`Материалы проверки: ${result.reviewDisplayPath}`);
console.log(`Запись действия: ${result.activityDisplayPath}`);
