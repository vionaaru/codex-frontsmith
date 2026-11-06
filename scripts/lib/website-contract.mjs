// Validate the HTML hooks used by script.js and the FormData keys accepted by /api/contact.
// This is a structural contract for authored templates, not an HTML sanitizer.
function attributes(source) {
  const result = new Map();
  for (const match of source.matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s'"=<>`]+)))?/g)) {
    const name = match[1].toLowerCase();
    if (result.has(name)) throw new Error(`Клиентский шаблон: повторный атрибут ${name}`);
    result.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

export function assertIntakeFormContract(html) {
  const source = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const forms = [];
  const elements = [];
  let owner = null;
  for (const token of source.matchAll(/<\/?([a-z][\w:-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi)) {
    const tag = token[1].toLowerCase();
    if (token[0].startsWith("</")) { if (tag === "form") owner = null; continue; }
    const attrs = attributes(token[2]);
    if (tag === "form") {
      if (owner !== null) throw new Error("Клиентский шаблон: вложенные формы не поддерживаются");
      owner = forms.length;
      forms.push(attrs);
    }
    elements.push({ tag, attrs, owner });
  }
  const selected = forms.map((attrs, index) => ({ attrs, index })).filter(({ attrs }) => attrs.has("data-intake-form"));
  if (selected.length !== 1) throw new Error("Клиентский шаблон: нужна ровно одна форма data-intake-form");
  const form = selected[0];
  const formOwner = (element) => element.attrs.has("form")
    ? forms.findIndex((attrs) => attrs.has("id") && attrs.get("id") === element.attrs.get("form"))
    : element.owner;
  for (const name of ["email", "phone"]) {
    const fields = elements.filter((element) => element.attrs.has(`data-contact-${name}`));
    const field = fields[0];
    const named = elements.filter((element) => ["input", "textarea", "select"].includes(element.tag) && formOwner(element) === form.index && element.attrs.get("name") === name);
    if (fields.length !== 1 || field.tag !== "input" || field.attrs.get("name") !== name || field.attrs.has("disabled") || formOwner(field) !== form.index || named.length !== 1) {
      throw new Error(`Клиентский шаблон: поле data-contact-${name} должно быть единственным активным input name="${name}" формы data-intake-form`);
    }
  }
}
