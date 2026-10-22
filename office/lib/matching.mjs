// Сопоставление автомобиля из отчёта о работах по VIN, госномеру и телефону клиента.
// Только чтение. Решение «тот же автомобиль» принимает вызывающий: при verdict ≠ match
// или confidence = weak нужно уточнить у владельца, а не создавать дубль и не выбирать наугад
import { OfficeValidationError, phoneKey, plateKey, vinKey } from "./domain.mjs";
import { customersByPhoneKey, vehicleMatchCandidates } from "./repositories.mjs";

const weights = { vin: 8, plate: 4, vin_suffix: 2, phone: 1 };

export function matchVehicle(db, { vin, plate, phone } = {}) {
  const input = { vin: vinKey(vin), plate: plateKey(plate), phone: phoneKey(phone) };
  if (phone && !input.phone) throw new OfficeValidationError("Телефон: нужно не меньше 10 цифр без букв");
  let fullVin = null;
  let vinSuffix = null;
  if (input.vin) {
    if (/[^A-HJ-NPR-Z0-9]/.test(input.vin)) throw new OfficeValidationError("VIN: латинские буквы и цифры без I, O, Q");
    if (input.vin.length === 17) fullVin = input.vin;
    else if (input.vin.length >= 5 && input.vin.length < 17) vinSuffix = input.vin;
    else throw new OfficeValidationError("VIN: полный из 17 символов или последние 5–16 символов");
  }
  if (!fullVin && !vinSuffix && !input.plate && !input.phone) throw new OfficeValidationError("Укажите хотя бы VIN, госномер или телефон");

  const candidates = vehicleMatchCandidates(db, { vin: fullVin, vinSuffix, plate: input.plate, phone: input.phone })
    .map((row) => {
      const matchedBy = [];
      const conflicts = [];
      const compare = (given, stored, matches, key) => {
        if (!given) return;
        if (matches) matchedBy.push(key);
        else if (stored) conflicts.push(key === "vin_suffix" ? "vin" : key);
      };
      compare(fullVin, row.vin, row.vin === fullVin, "vin");
      compare(vinSuffix, row.vin, Boolean(row.vin?.endsWith(vinSuffix)), "vin_suffix");
      compare(input.plate, row.plate_key, row.plate_key === input.plate, "plate");
      compare(input.phone, row.phone_key, row.phone_key === input.phone, "phone");
      return { ...row, matchedBy, conflicts, score: matchedBy.reduce((sum, key) => sum + weights[key], 0) };
    })
    .sort((a, b) => b.score - a.score || String(b.last_order_at ?? "").localeCompare(String(a.last_order_at ?? "")));
  const customers = input.phone ? customersByPhoneKey(db, input.phone) : [];

  return { input: { vin: fullVin, vinSuffix, plate: input.plate, phone: input.phone }, ...verdict(candidates, customers), candidates, customers };
}

function verdict(candidates, customers) {
  if (!candidates.length) {
    if (!customers.length) return { verdict: "none", confidence: null, reason: "Автомобиль и клиент не найдены: это новый клиент или данные записаны иначе" };
    if (customers.length === 1) return { verdict: "customer_only", confidence: "weak", reason: "Клиент найден по телефону, автомобиль у него не найден" };
    return { verdict: "ambiguous", confidence: null, reason: "Телефон указан у нескольких клиентов, автомобиль не найден" };
  }
  const [top, next] = candidates;
  if (next && next.score === top.score) return { verdict: "ambiguous", confidence: null, reason: "Несколько автомобилей подходят одинаково" };
  if (top.conflicts.length) return { verdict: "ambiguous", confidence: null, reason: `Лучший кандидат расходится с отчётом: ${top.conflicts.join(", ")}` };
  const has = (key) => top.matchedBy.includes(key);
  const strong = has("vin") || (has("plate") && (has("phone") || has("vin_suffix")));
  return { verdict: "match", confidence: strong ? "strong" : "weak", reason: `Совпадение: ${top.matchedBy.join(", ")}` };
}
