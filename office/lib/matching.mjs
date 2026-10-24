// Сопоставление автомобиля из отчёта о работах по VIN, госномеру и телефону клиента.
// Только чтение. Решение «тот же автомобиль» принимает вызывающий: при verdict ≠ match
// или confidence = weak нужно уточнить у владельца, а не создавать дубль и не выбирать наугад.
// Телефона в офисной базе нет: его сверяет CustomerProvider, сюда приходят client_id
import { normalizePhone } from "../customers/contract.mjs";
import { OfficeValidationError, plateKey, vinKey } from "./domain.mjs";
import { customersWithVehicleCounts, vehicleMatchCandidates } from "./repositories.mjs";

// Телефон → client_id точным совпадением нормализованного номера в CustomerProvider
export async function matchVehicleWithCustomers(db, provider, { vin, plate, phone } = {}) {
  let phoneClientIds = null;
  if (phone) {
    let normalized;
    try {
      normalized = normalizePhone(phone);
    } catch {
      throw new OfficeValidationError("Телефон: нужно не меньше 10 цифр без букв");
    }
    const { items } = await provider.listCustomers({ q: normalized });
    phoneClientIds = items.filter((customer) => customer.phone === normalized).map((customer) => customer.id);
  }
  return matchVehicle(db, { vin, plate, phoneClientIds });
}

const weights = { vin: 8, plate: 4, vin_suffix: 2, phone: 1 };

// phoneClientIds: null — телефон не указан; [] — указан, но клиентов с ним нет
export function matchVehicle(db, { vin, plate, phoneClientIds = null } = {}) {
  const input = { vin: vinKey(vin), plate: plateKey(plate), phone: phoneClientIds !== null };
  let fullVin = null;
  let vinSuffix = null;
  if (input.vin) {
    if (/[^A-HJ-NPR-Z0-9]/.test(input.vin)) throw new OfficeValidationError("VIN: латинские буквы и цифры без I, O, Q");
    if (input.vin.length === 17) fullVin = input.vin;
    else if (input.vin.length >= 5 && input.vin.length < 17) vinSuffix = input.vin;
    else throw new OfficeValidationError("VIN: полный из 17 символов или последние 5–16 символов");
  }
  if (!fullVin && !vinSuffix && !input.plate && !input.phone) throw new OfficeValidationError("Укажите хотя бы VIN, госномер или телефон");

  const phoneIds = new Set(phoneClientIds ?? []);
  const candidates = vehicleMatchCandidates(db, { vin: fullVin, vinSuffix, plate: input.plate, phoneClientIds: [...phoneIds] })
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
      // Телефон всегда известен у клиента-владельца только провайдеру: несовпадение — конфликт
      compare(input.phone, true, phoneIds.has(row.customer_id), "phone");
      return { ...row, matchedBy, conflicts, score: matchedBy.reduce((sum, key) => sum + weights[key], 0) };
    })
    .sort((a, b) => b.score - a.score || String(b.last_order_at ?? "").localeCompare(String(a.last_order_at ?? "")));
  const customers = input.phone ? customersWithVehicleCounts(db, [...phoneIds]) : [];

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
