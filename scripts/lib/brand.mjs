// Private brand source; only explicit, validated presentation data becomes public.
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { businessPath } from "./paths.mjs";

export const colorRoles = ["page", "surface", "surfaceMuted", "text", "textMuted", "border", "accent", "onAccent", "accentSoft", "focus", "success", "warning", "error"];
export const defaultBrand = {
  version: 1, font: "Arial, sans-serif", radius: 8,
  light: { page: "#f5f2eb", surface: "#fffdf8", surfaceMuted: "#e8edf2", text: "#111820", textMuted: "#5f676f", border: "#858b91", accent: "#8a4b00", onAccent: "#ffffff", accentSoft: "#fff1dc", focus: "#8a4b00", success: "#1f6f43", warning: "#885000", error: "#b3261e" },
  dark: { page: "#12171c", surface: "#1b232b", surfaceMuted: "#26323e", text: "#f5f2eb", textMuted: "#b7c0c9", border: "#7d8994", accent: "#ffbd70", onAccent: "#111820", accentSoft: "#49331b", focus: "#ffbd70", success: "#8bd4a7", warning: "#ffd28a", error: "#ffb4ab" }
};

export function validateBrand(input) {
  if (!input || input.version !== 1) throw new Error("brand.json: version должна быть 1");
  if (typeof input.font !== "string" || !/^[\p{L}\p{N} ,'-]{1,160}$/u.test(input.font)) throw new Error("brand.json: недопустимый font");
  if (!Number.isFinite(input.radius) || input.radius < 0 || input.radius > 32) throw new Error("brand.json: radius должен быть от 0 до 32");
  const result = { version: 1, font: input.font, radius: input.radius };
  if (input.logo !== undefined) {
    if (typeof input.logo !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:png|jpe?g|webp)$/i.test(input.logo)) throw new Error("brand.json: logo — имя картинки из design/public/");
    result.logo = input.logo;
  }
  if (input.fontFace !== undefined) {
    const face = input.fontFace;
    if (!face || typeof face.family !== "string" || !/^[\p{L}\p{N} -]{1,80}$/u.test(face.family) || typeof face.file !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.woff2$/i.test(face.file)) throw new Error("brand.json: fontFace требует family и файл .woff2 из public/");
    result.fontFace = { family: face.family, file: face.file };
  }
  for (const mode of ["light", "dark"]) {
    result[mode] = {};
    for (const role of colorRoles) {
      const value = input[mode]?.[role];
      if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`brand.json: ${mode}.${role} должен быть #RRGGBB`);
      result[mode][role] = value;
    }
    for (const [fg, bg] of [["text", "page"], ["text", "surface"], ["textMuted", "surface"], ["onAccent", "accent"]]) {
      if (contrast(result[mode][fg], result[mode][bg]) < 4.5) throw new Error(`brand.json: контраст ${mode}.${fg}/${bg} ниже 4.5:1`);
    }
  }
  return result;
}

export function contrast(a, b) {
  function lum(hex) {
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  }
  const [x, y] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (x + .05) / (y + .05);
}

export async function loadBrand() {
  try { return validateBrand(JSON.parse(await readFile(businessPath("design", "brand.json"), "utf8"))); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function brandCss(brand) {
  const block = (mode) => {
    const t = brand[mode];
    return `color-scheme:${mode};${colorRoles.map((r) => `--brand-${r.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${t[r]};`).join("")}--brand-font:${brand.font};--brand-radius:${brand.radius}px;`;
  };
  const face = brand.fontFace ? `@font-face{font-family:'${brand.fontFace.family}';src:url('/brand-assets/${brand.fontFace.file}') format('woff2');font-display:swap}\n` : "";
  return `${face}:root{${block("light")}}\n@media(prefers-color-scheme:dark){:root:not([data-theme=light]){${block("dark")}}}\n:root[data-theme=dark]{${block("dark")}}\n:root[data-theme=light]{${block("light")}}\n`;
}

// A fixed allowlist below design/public. Never serve inputs, specs or state files.
export async function brandAsset(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:png|jpg|jpeg|webp|woff2)$/i.test(name)) throw new Error("Недопустимый файл бренда");
  const root = await realpath(businessPath("design", "public"));
  const file = await realpath(path.join(root, name));
  if (path.dirname(file).toLowerCase() !== root.toLowerCase()) throw new Error("Файл бренда вне public");
  return file;
}
