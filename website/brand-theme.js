// Theme controller shared by the public website and office. No business data.
(function () {
  "use strict";
  var key = "frontsmith-theme";
  var mode = "system";
  try { mode = localStorage.getItem(key) || "system"; } catch (_) { /* storage optional */ }
  if (!["light", "dark", "system"].includes(mode)) mode = "system";
  function apply() {
    document.documentElement.dataset.theme = mode;
    document.dispatchEvent(new CustomEvent("frontsmith-theme", { detail: mode }));
  }
  apply();
  document.addEventListener("DOMContentLoaded", function () {
    var control = document.createElement("select");
    control.className = "brand-theme-control";
    control.setAttribute("aria-label", "Цветовая тема");
    [["system", "Тема системы"], ["light", "Светлая тема"], ["dark", "Тёмная тема"]].forEach(function (item) {
      var option = document.createElement("option"); option.value = item[0]; option.textContent = item[1]; control.appendChild(option);
    });
    control.value = mode;
    control.addEventListener("change", function () { mode = control.value; try { localStorage.setItem(key, mode); } catch (_) {} apply(); });
    (document.querySelector(".sync") || document.querySelector(".site-header-inner") || document.body).appendChild(control);
    apply();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { if (mode === "system") apply(); });
})();
