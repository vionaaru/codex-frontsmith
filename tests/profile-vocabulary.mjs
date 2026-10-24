// Словари бизнес-профилей: generic-service — нейтральные подписи, auto-service — прежние.
// Машинные ключи и переходы статусов одинаковы во всех профилях: старые записи не ломаются
import assert from "node:assert/strict";
import { vocabulary } from "../office/lib/domain.mjs";
import { vocabularyFor } from "../scripts/lib/blueprints.mjs";

const AUTO_LABELS = /заказ|Ремонт|Диагностика|Обслуживание|в сервис|приехал/;
const generic = vocabularyFor({ blueprint: "generic-service" });
const auto = vocabularyFor({ blueprint: "auto-service" });
let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
};

check("generic-service: нейтральные статусы, источники и категории", () => {
  assert.equal(generic.inquiry.converted.label, "Оформлено");
  assert.equal(generic.inquiry.closed.label, "Закрыто");
  assert.equal(generic.inquirySources.walk_in, "Личный визит");
  assert.deepEqual(Object.keys(generic.serviceCategories), ["consultation", "service", "project", "support", "other"]);
  assert.doesNotMatch(JSON.stringify(generic), AUTO_LABELS);
});

check("auto-service: прежние подписи и категории", () => {
  assert.equal(auto.inquiry.converted.label, "Оформлен заказ");
  assert.equal(auto.inquiry.closed.label, "Закрыто без заказа");
  assert.equal(auto.appointment.arrived.label, "Клиент приехал");
  assert.equal(auto.inquirySources.walk_in, "Пришёл в сервис");
  assert.deepEqual(auto.serviceCategories, { diagnostics: "Диагностика", maintenance: "Обслуживание", repair: "Ремонт", other: "Другое" });
});

check("машинные ключи и переходы совпадают во всех профилях", () => {
  for (const name of Object.keys(vocabulary).filter((key) => key !== "serviceCategories")) {
    assert.deepEqual(Object.keys(generic[name]), Object.keys(vocabulary[name]), name);
    assert.deepEqual(Object.keys(auto[name]), Object.keys(vocabulary[name]), name);
    for (const [key, value] of Object.entries(vocabulary[name])) {
      if (typeof value === "object") {
        assert.deepEqual(generic[name][key].transitions, value.transitions, `${name}.${key}`);
        assert.deepEqual(auto[name][key].transitions, value.transitions, `${name}.${key}`);
      }
    }
  }
});

check("профиль без поля blueprint — прежний автосервис; неизвестный — нейтральная база", () => {
  assert.equal(vocabularyFor({}).inquiry.converted.label, "Оформлен заказ");
  assert.equal(vocabularyFor({ blueprint: "missing-profile" }).inquiry.converted.label, "Оформлено");
  assert.equal(vocabularyFor({ blueprint: "missing-profile" }).serviceCategories.other, "Другое");
});

check("переопределение не затрагивает базовый словарь ядра", () => {
  vocabularyFor({ blueprint: "auto-service" }).inquiry.converted.label = "изменено";
  assert.equal(vocabulary.inquiry.converted.label, "Оформлено");
  assert.equal(vocabularyFor({ blueprint: "auto-service" }).inquiry.converted.label, "Оформлен заказ");
});

console.log(`Profile vocabulary: ${passed} проверок пройдено`);
