import { loadBrand } from "../../scripts/lib/brand.mjs";
import { publicWidgetConfig } from "../../scripts/lib/widget.mjs";
import { loadBusinessProfile } from "./business-context.mjs";
import { loadServiceCatalog } from "../../office/lib/catalog.mjs";

export const WIDGET_UI_TOOL = "show_widget_component";
export async function loadWidgetConfig() {
  const profile = await loadBusinessProfile();
  const catalog = await loadServiceCatalog(profile);
  return publicWidgetConfig(await loadBrand(), profile, catalog.services);
}
