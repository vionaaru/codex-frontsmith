// Public presentation only. The model selects catalog IDs, never HTML or contact fields.
const asset = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:png|jpe?g|webp)$/i;
const id = /^[a-z][a-z0-9-]{0,39}$/;
export const widgetToneIds = ["brand", "darker", "lighter", "warmer", "cooler"];
const hex = /^#[0-9a-f]{6}$/i;
const rgb = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
const color = channels => "#" + channels.map(n => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0")).join("");
function luminance(value) {
  const c = rgb(value).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}
function ratio(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
function compileTones(brand, tones) {
  // Legacy configs receive a small, deterministic family at build time, never from the LLM.
  const base = brand.light.accent, channels = rgb(base);
  tones ??= { brand: base, darker: color(channels.map(n => n * .84)), lighter: color(channels.map(n => n + (255 - n) * .13)), warmer: color([channels[0] + 12, channels[1] + 3, channels[2] - 7]), cooler: color([channels[0] - 7, channels[1] + 3, channels[2] + 12]) };
  return widgetToneIds.map(id => {
    const value = tones[id];
    const result = { id, color: value };
    for (const mode of ["light", "dark"]) {
      // Preserve the exact source in the decorative seam. Controls retain an accessible accent.
      const accent = ratio(value, brand[mode].surface) >= 3 ? value : brand[mode].accent;
      result[mode] = { accent, onAccent: ratio(accent, "#ffffff") >= 4.5 ? "#ffffff" : "#000000" };
    }
    return result;
  });
}
function text(value, max, label) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error(`brand.json: widget.${label} — непустой текст до ${max} символов`);
  return value.trim();
}
export function validateWidget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("brand.json: widget должен быть объектом");
  const result = { question: text(value.question, 160, "question"), surface: value.surface ?? "plain", components: [] };
  result.geometry = value.geometry ?? "soft";
  if (!["soft", "folded", "layered"].includes(result.geometry)) throw new Error("brand.json: widget.geometry — soft, folded или layered");
  if (value.tones !== undefined) {
    if (!value.tones || typeof value.tones !== "object" || Array.isArray(value.tones) || widgetToneIds.some(key => typeof value.tones[key] !== "string" || !hex.test(value.tones[key]))) throw new Error("brand.json: widget.tones — пять цветов #RRGGBB: brand, darker, lighter, warmer, cooler");
    result.tones = Object.fromEntries(widgetToneIds.map(key => [key, value.tones[key]]));
    if (new Set(Object.values(result.tones).map(value => value.toLowerCase())).size !== 5) throw new Error("brand.json: widget.tones — пять различных близких цветов");
    if (luminance(result.tones.darker) >= luminance(result.tones.brand) || luminance(result.tones.lighter) <= luminance(result.tones.brand)) throw new Error("brand.json: darker должен быть темнее brand, lighter — светлее");
  }
  if (!["plain", "woven", "layered"].includes(result.surface)) throw new Error("brand.json: widget.surface — plain, woven или layered");
  if (value.objectBackground !== undefined) {
    if (typeof value.objectBackground !== "string" || !/^#[0-9a-f]{6}$/i.test(value.objectBackground)) throw new Error("brand.json: widget.objectBackground — #RRGGBB");
    result.objectBackground = value.objectBackground;
  }
  for (const key of ["object", "surfaceImage"]) if (value[key] !== undefined) {
    if (typeof value[key] !== "string" || !asset.test(value[key])) throw new Error(`brand.json: widget.${key} — имя картинки из public/`);
    result[key] = value[key];
  }
  if (!Array.isArray(value.components) || !value.components.length || value.components.length > 8) throw new Error("brand.json: widget.components — от 1 до 8 компонентов");
  const seen = new Set();
  for (const item of value.components) {
    if (!item || typeof item.id !== "string" || !id.test(item.id) || seen.has(item.id)) throw new Error("brand.json: widget — уникальные id компонентов");
    seen.add(item.id);
    if (!["choices", "services"].includes(item.type)) throw new Error("brand.json: widget.type — choices или services");
    const component = { id: item.id, type: item.type, title: text(item.title, 160, "title"), shell: item.shell ?? "question" };
    if (!["question", "conversation"].includes(component.shell)) throw new Error("brand.json: widget.component.shell — question или conversation");
    if (item.type === "choices") {
      if (!Array.isArray(item.options) || !item.options.length || item.options.length > 6) throw new Error("brand.json: widget.options — от 1 до 6 вариантов");
      component.options = item.options.map(option => ({ label: text(option.label, 70, "label"), message: text(option.message, 300, "message") }));
    }
    result.components.push(component);
  }
  result.start = value.start ?? result.components[0].id;
  if (!seen.has(result.start)) throw new Error("brand.json: widget.start должен ссылаться на компонент");
  return result;
}

export function publicWidgetConfig(brand, profile, services = profile.services ?? []) {
  if (!brand?.widget) return null;
  const widget = validateWidget(brand.widget);
  const object = widget.object ?? brand.logo;
  return {
    version: 1, question: widget.question, surface: widget.surface, start: widget.start, objectBackground: widget.objectBackground ?? brand.light.surface,
    geometry: widget.geometry, tones: compileTones(brand, widget.tones),
    ...(object ? { object: `/brand-assets/${object}` } : {}),
    ...(widget.surfaceImage ? { surfaceImage: `/brand-assets/${widget.surfaceImage}` } : {}),
    components: widget.components.map(component => component.type === "services" ? {
      ...component, options: services.filter(service => service?.name).slice(0, 6).map(service => ({ label: String(service.name).slice(0, 70), message: `Расскажите об услуге «${String(service.name).slice(0, 160)}»` }))
    } : component)
  };
}
