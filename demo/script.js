const header = document.querySelector("[data-header]");
const nav = document.querySelector("[data-nav]");
const toggle = document.querySelector("[data-nav-toggle]");
const navClose = document.querySelector("[data-nav-close]");
const navBackdrop = document.querySelector("[data-nav-backdrop]");

class FrontsmithWebsitePreview extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    this.render();
  }

  async render() {
    const source = this.getAttribute("src") || "/website";
    const root = this.attachShadow({ mode: "open" });

    root.innerHTML = `
      <style>${previewShellCss()}</style>
      <div class="preview-state">Загрузка предпросмотра сайта</div>
    `;

    try {
      const url = new URL(source, window.location.href);
      const cssUrl = new URL(`${url.pathname.replace(/\/?$/, "/")}styles.css`, window.location.href);
      const [htmlResponse, cssResponse] = await Promise.all([
        fetch(url),
        fetch(cssUrl)
      ]);

      if (!htmlResponse.ok || !cssResponse.ok) {
        throw new Error("Не удалось загрузить исходники предпросмотра");
      }

      const [html, css] = await Promise.all([
        htmlResponse.text(),
        cssResponse.text()
      ]);
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const body = parsed.body.cloneNode(true);

      body.querySelectorAll("script").forEach((script) => script.remove());
      body.querySelectorAll("a[href]").forEach((anchor) => {
        const href = anchor.getAttribute("href") || "";

        if (href.startsWith("#")) return;

        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
      });

      root.innerHTML = `
        <style>${previewShellCss()}</style>
        <style>${scopeWebsiteCss(css)}</style>
        <style>${previewOverridesCss()}</style>
        <div class="preview-viewport" data-preview-viewport>
          <div class="site-preview-document" data-preview-document></div>
        </div>
      `;

      const documentMount = root.querySelector("[data-preview-document]");
      const viewport = root.querySelector("[data-preview-viewport]");
      documentMount.append(...body.childNodes);
      setupWebsitePreview(root, viewport, documentMount);
    } catch {
      root.innerHTML = `
        <style>${previewShellCss()}</style>
        <div class="preview-state">
          Предпросмотр сайта недоступен.
          <a href="${source}" target="_blank" rel="noopener noreferrer">Открыть сайт</a>
        </div>
      `;
    }
  }
}

function scopeWebsiteCss(css) {
  return css
    .replace(/(^|[\s,{]):root(?=[\s.{:#>+~[,])/gm, "$1:host")
    .replace(/(^|[\s,{])html(?=[\s.{:#>+~[,])/gm, "$1.site-preview-document")
    .replace(/(^|[\s,{])body(?=[\s.{:#>+~[,])/gm, "$1.site-preview-document");
}

function previewShellCss() {
  return `
    :host {
      background: #f7f6f0;
      color: #292a25;
      display: block;
      height: 100%;
      overflow: hidden;
    }

    .preview-viewport {
      height: 100%;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: auto;
      scrollbar-color: rgba(41, 42, 37, 0.34) transparent;
      scrollbar-width: thin;
      touch-action: pan-y;
      -webkit-overflow-scrolling: touch;
    }

    .preview-state {
      align-items: center;
      color: rgba(41, 42, 37, 0.72);
      display: flex;
      font: 700 14px/1.4 Arial, Helvetica, sans-serif;
      gap: 8px;
      height: 100%;
      justify-content: center;
      padding: 24px;
      text-align: center;
    }

    .preview-state a {
      color: #292a25;
    }
  `;
}

function previewOverridesCss() {
  return `
    .site-preview-document {
      min-height: 100%;
      min-width: 0;
      overflow: visible;
      position: relative;
      width: 100%;
    }

    .site-preview-document.nav-open {
      overflow: visible;
    }

    .site-preview-document .site-header {
      position: sticky;
      top: 0;
      z-index: 70;
    }

    .site-preview-document .header-spacer {
      display: none;
    }

    .site-preview-document .page-container,
    .site-preview-document .section-intro,
    .site-preview-document .service-card-grid,
    .site-preview-document .craft-layout,
    .site-preview-document .faq-layout,
    .site-preview-document .contact-layout,
    .site-preview-document .footer-inner,
    .site-preview-document .footer-bottom {
      width: min(100% - 32px, var(--max));
    }

    .site-preview-document .site-header-inner {
      display: flex;
      justify-content: space-between;
      padding: 0;
      width: min(100% - 32px, var(--max));
    }

    .site-preview-document .header-button {
      display: none;
    }

    .site-preview-document .brand-wordmark strong,
    .site-preview-document .brand-wordmark span {
      max-width: calc(100% - 72px);
    }

    .site-preview-document .site-header > .site-header-inner > .brand-mark .brand-wordmark strong {
      max-width: none;
      overflow: visible;
      width: auto;
    }

    .site-preview-document .hero-copy,
    .site-preview-document .hero-visual,
    .site-preview-document .service-card,
    .site-preview-document .craft-list article,
    .site-preview-document .faq-list,
    .site-preview-document .intake-form,
    .site-preview-document .contact-panel {
      max-width: 100%;
      min-width: 0;
    }

    .site-preview-document .hero h1,
    .site-preview-document .hero-subhead,
    .site-preview-document .hero-body,
    .site-preview-document .section-subhead {
      max-width: 100%;
      overflow-wrap: normal;
      white-space: normal;
    }

    .site-preview-document h1 {
      font-size: 42px;
      line-height: 1.02;
      white-space: normal;
    }

    .site-preview-document h2 {
      font-size: 32px;
      line-height: 1.08;
      overflow-wrap: normal;
      white-space: normal;
    }

    .site-preview-document .hero-subhead {
      font-size: 22px;
      white-space: normal;
    }

    .site-preview-document .section-subhead {
      font-size: 18px;
      white-space: normal;
    }

    .site-preview-document .hero-grid,
    .site-preview-document .craft-layout,
    .site-preview-document .faq-layout,
    .site-preview-document .contact-layout {
      grid-template-columns: 1fr;
    }

    .site-preview-document .nav-toggle {
      align-items: center;
      background: var(--off-white);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      color: var(--ink);
      display: inline-flex;
      flex-direction: column;
      height: 42px;
      justify-content: center;
      padding: 0;
      position: relative;
      width: 42px;
      z-index: 50;
    }

    .site-preview-document .nav-toggle span {
      background: currentColor;
      display: block;
      height: 2px;
      margin: 3px 0;
      transition: opacity 160ms ease, transform 160ms ease;
      width: 18px;
    }

    .site-preview-document.nav-active .nav-toggle span:nth-child(1) {
      transform: translateY(8px) rotate(45deg);
    }

    .site-preview-document.nav-active .nav-toggle span:nth-child(2) {
      opacity: 0;
    }

    .site-preview-document.nav-active .nav-toggle span:nth-child(3) {
      transform: translateY(-8px) rotate(-45deg);
    }

    .site-preview-document .site-nav {
      align-items: stretch;
      background: var(--off-white);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: 0 18px 44px rgba(41, 42, 37, 0.14);
      display: flex;
      flex-direction: column;
      gap: 0;
      height: auto;
      justify-content: flex-start;
      left: 14px;
      max-height: calc(var(--frontsmith-preview-height, 520px) - 94px);
      max-width: none;
      opacity: 0;
      overflow: hidden;
      padding: 0;
      pointer-events: none;
      position: absolute;
      right: 14px;
      top: 82px;
      transform: translateY(-8px);
      transition: opacity 160ms ease, transform 180ms ease;
      width: auto;
      z-index: 80;
    }

    .site-preview-document .site-nav.open {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }

    .site-preview-document .drawer-head {
      display: none;
    }

    .site-preview-document .drawer-close {
      align-items: center;
      background: rgba(255, 255, 255, 0.34);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      color: var(--ink);
      display: inline-flex;
      flex: 0 0 auto;
      height: 38px;
      justify-content: center;
      padding: 0;
      position: relative;
      width: 38px;
    }

    .site-preview-document .drawer-close span {
      background: currentColor;
      height: 2px;
      position: absolute;
      width: 18px;
    }

    .site-preview-document .drawer-close span:first-child {
      transform: rotate(45deg);
    }

    .site-preview-document .drawer-close span:last-child {
      transform: rotate(-45deg);
    }

    .site-preview-document .drawer-body {
      display: grid;
      gap: 14px;
      justify-content: stretch;
      min-height: 0;
      overflow-y: auto;
      padding: 14px;
    }

    .site-preview-document .drawer-group {
      display: grid;
      gap: 10px;
    }

    .site-preview-document .drawer-group p {
      color: var(--muted-light);
      display: block;
      font-size: 12px;
      font-weight: 780;
      letter-spacing: 0.08em;
      line-height: 1.2;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .site-preview-document .drawer-links {
      display: grid;
      gap: 6px;
    }

    .site-preview-document .site-nav a {
      align-items: center;
      border: 1px solid transparent;
      border-radius: var(--radius);
      display: flex;
      font-size: 15px;
      font-weight: 650;
      gap: 12px;
      justify-content: flex-start;
      min-height: 46px;
      padding: 0 12px;
      transition: background 160ms ease, border-color 160ms ease;
    }

    .site-preview-document .drawer-link-icon {
      align-items: center;
      background: rgba(255, 255, 255, 0.5);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      color: var(--ink);
      display: inline-flex;
      flex: 0 0 auto;
      height: 30px;
      justify-content: center;
      width: 30px;
    }

    .site-preview-document .drawer-link-icon svg {
      fill: none;
      height: 16px;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 2;
      width: 16px;
    }

    .site-preview-document .drawer-cta {
      display: grid;
      gap: 8px;
    }

    .site-preview-document .drawer-cta .button {
      justify-content: center;
      width: 100%;
    }

    .site-preview-document .nav-backdrop {
      background: transparent;
      border: 0;
      display: block;
      height: calc(var(--frontsmith-preview-height, 520px) - 70px);
      left: 0;
      opacity: 0;
      pointer-events: none;
      position: absolute;
      right: 0;
      top: 70px;
      transition: opacity 180ms ease;
      z-index: 55;
    }

    .site-preview-document.nav-open .nav-backdrop {
      opacity: 1;
      pointer-events: auto;
    }

    .site-preview-document.nav-open .site-header > .site-header-inner > .nav-toggle {
      opacity: 1;
      pointer-events: auto;
    }

    .site-preview-document .hero {
      min-height: 0;
      padding: 54px 0 56px;
    }

    .site-preview-document .hero-grid {
      gap: 40px;
    }

    .site-preview-document .hero-visual {
      display: grid;
      gap: 12px;
      min-height: 0;
    }

    .site-preview-document .hero-actions {
      display: grid;
      grid-template-columns: 1fr;
    }

    .site-preview-document .hero-actions .button {
      justify-content: center;
      width: 100%;
    }

    .site-preview-document .hero-photo {
      position: static;
      width: 100%;
    }

    .site-preview-document .hero-photo-main {
      aspect-ratio: 4 / 3;
      height: auto;
    }

    .site-preview-document .hero-photo-kitchen,
    .site-preview-document .hero-photo-bath,
    .site-preview-document .hero-note {
      display: none;
    }

    .site-preview-document .service-card-grid,
    .site-preview-document .craft-list,
    .site-preview-document .intake-form {
      grid-template-columns: 1fr;
    }

    .site-preview-document .footer-inner,
    .site-preview-document .footer-links {
      grid-template-columns: 1fr;
      gap: 32px;
    }

    .site-preview-document .footer-inner,
    .site-preview-document .footer-links,
    .site-preview-document .footer-bottom {
      justify-items: start;
      text-align: left;
    }

    .site-preview-document .footer-brand {
      justify-content: flex-start;
    }

    .site-preview-document .footer-links {
      justify-self: start;
    }

    .site-preview-document .craft-list article {
      min-height: 0;
      padding: 18px 20px;
    }

    .site-preview-document .box-heading h3 {
      white-space: normal;
    }

    .site-preview-document .craft-list p span {
      display: inline;
      white-space: normal;
    }

    .site-preview-document .service-card {
      grid-template-rows: 220px 1fr;
    }

    .site-preview-document .faq-layout {
      gap: 24px;
    }

    .site-preview-document .faq-intro {
      position: static;
    }

    .site-preview-document .faq-intro img {
      display: none;
    }

    .site-preview-document .faq-list {
      margin-top: 2px;
    }

    .site-preview-document .faq-item summary {
      min-height: 62px;
      white-space: normal;
    }

    @media (max-width: 620px) {
      .site-preview-document h1 {
        font-size: 36px;
      }

      .site-preview-document h2 {
        font-size: 28px;
      }

      .site-preview-document .hero-subhead {
        font-size: 20px;
      }

      .site-preview-document .section-subhead {
        font-size: 17px;
      }

      .site-preview-document .page-container,
      .site-preview-document .section-intro,
      .site-preview-document .service-card-grid,
      .site-preview-document .craft-layout,
      .site-preview-document .faq-layout,
      .site-preview-document .contact-layout,
      .site-preview-document .footer-inner,
      .site-preview-document .footer-bottom {
        width: min(100% - 28px, var(--max));
      }
    }
  `;
}

function setupWebsitePreview(root, viewport, documentMount) {
  const header = root.querySelector("[data-header]");
  const nav = root.querySelector("[data-nav]");
  const navToggle = root.querySelector("[data-nav-toggle]");
  const navClose = root.querySelector("[data-nav-close]");
  const navBackdrop = root.querySelector("[data-nav-backdrop]");
  const intakeForm = root.querySelector("[data-intake-form]");
  const intakeStatus = root.querySelector("[data-intake-status]");

  function syncPreviewHeight() {
    documentMount.style.setProperty("--frontsmith-preview-height", `${viewport.clientHeight}px`);
  }

  function closePreviewNav() {
    documentMount.classList.remove("nav-open", "nav-active");
    header?.classList.remove("nav-active");
    nav?.classList.remove("open");
    navToggle?.setAttribute("aria-expanded", "false");
    navToggle?.setAttribute("aria-label", "Открыть меню");
  }

  function previewTargetFromHash(hash) {
    if (!hash || hash === "#") return null;
    if (hash === "#top") return root.querySelector("#top");

    try {
      return root.getElementById(decodeURIComponent(hash.slice(1)));
    } catch {
      return root.getElementById(hash.slice(1));
    }
  }

  function scrollPreviewTo(target, behavior = "smooth") {
    if (!target) return;

    const scrollTarget = target === root.querySelector("#top")
      ? target
      : target.querySelector("h2, .section-intro, .craft-copy, .faq-intro, .contact-layout") || target;
    const headerOffset = Math.round(header?.getBoundingClientRect().height || 0);
    const viewportTop = viewport.getBoundingClientRect().top;
    const targetTop = target === root.querySelector("#top")
      ? 0
      : Math.max(0, Math.round(viewport.scrollTop + scrollTarget.getBoundingClientRect().top - viewportTop - headerOffset - 16));

    if (behavior === "smooth") {
      viewport.scrollTo({ top: targetTop, behavior });
    } else {
      viewport.scrollTop = targetTop;
    }
  }

  viewport.addEventListener("scroll", () => {
    header?.classList.toggle("scrolled", viewport.scrollTop > 16);
  }, { passive: true });

  window.addEventListener("scroll", closePreviewNav, { passive: true });
  window.addEventListener("resize", syncPreviewHeight, { passive: true });

  if ("ResizeObserver" in window) {
    new ResizeObserver(syncPreviewHeight).observe(viewport);
  }

  syncPreviewHeight();

  viewport.addEventListener("wheel", (event) => {
    if (!event.deltaY) return;

    const atTop = viewport.scrollTop <= 0;
    const atBottom = Math.ceil(viewport.scrollTop + viewport.clientHeight) >= viewport.scrollHeight;
    const shouldHandOff = (event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom);

    if (!shouldHandOff) return;

    event.preventDefault();
    closePreviewNav();
    getScrollRoot().scrollBy({ top: event.deltaY, behavior: "auto" });
  }, { passive: false });

  navToggle?.addEventListener("click", () => {
    const open = !nav?.classList.contains("open");

    nav?.classList.toggle("open", open);
    documentMount.classList.toggle("nav-open", open);
    documentMount.classList.toggle("nav-active", open);
    header?.classList.toggle("nav-active", open);
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "Закрыть меню" : "Открыть меню");
  });

  navClose?.addEventListener("click", closePreviewNav);
  navBackdrop?.addEventListener("click", closePreviewNav);

  root.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener("click", (event) => {
      const target = previewTargetFromHash(anchor.getAttribute("href") || "");
      if (!target) return;

      event.preventDefault();
      closePreviewNav();
      scrollPreviewTo(target, "auto");
    });
  });

  root.querySelectorAll("[data-custom-select]").forEach((select) => {
    const field = select.closest(".custom-select-field");
    const valueInput = field?.querySelector("[data-custom-select-value]");
    const label = select.querySelector("[data-custom-select-label]");
    const button = select.querySelector(".custom-select-button");
    const options = [...select.querySelectorAll(".custom-select-option")];

    button?.addEventListener("click", () => {
      const isOpen = select.classList.toggle("open");
      button.setAttribute("aria-expanded", String(isOpen));
    });

    options.forEach((option) => {
      option.addEventListener("click", () => {
        const value = option.dataset.value ?? option.textContent.trim();

        valueInput.value = value;
        label.textContent = option.textContent.trim();
        options.forEach((item) => item.setAttribute("aria-selected", String(item === option)));
        select.classList.remove("open");
        button?.setAttribute("aria-expanded", "false");
      });
    });
  });

  intakeForm?.addEventListener("submit", (event) => {
    event.preventDefault();

    if (!intakeStatus) return;

    intakeStatus.textContent = "Откройте полный сайт для отправки заявки";
    intakeStatus.hidden = false;
    intakeStatus.dataset.status = "notice";
  });
}

customElements.define("frontsmith-website-preview", FrontsmithWebsitePreview);

function getScrollRoot() {
  return document.scrollingElement || document.documentElement;
}

function getPageScrollTop() {
  return getScrollRoot().scrollTop;
}

function setupPanelMotion() {
  const list = document.querySelector(".panel-list");
  if (!list) return;

  const rows = [...list.querySelectorAll("a")];
  if (!rows.length) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let current = 0;
  let timer = 0;

  function setProgress(index) {
    current = index;

    rows.forEach((row, rowIndex) => {
      row.classList.toggle("is-active", rowIndex === current);
      row.classList.toggle("is-complete", rowIndex <= current);
    });

    const active = rows[current];
    const progressHeight = 86;
    const top = Math.max(20, active.offsetTop + (active.offsetHeight - progressHeight) / 2);
    list.style.setProperty("--panel-progress-top", `${Math.round(top)}px`);
  }

  function stop() {
    window.clearInterval(timer);
    timer = 0;
  }

  function start() {
    if (timer || reduceMotion) return;

    setProgress(current);
    timer = window.setInterval(() => {
      setProgress((current + 1) % rows.length);
    }, 820);
  }

  if (reduceMotion) {
    setProgress(rows.length - 1);
    return;
  }

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];

      if (entry?.isIntersecting) {
        start();
      } else {
        stop();
      }
    }, { threshold: 0.2 });

    observer.observe(list);
  } else {
    start();
  }

  window.addEventListener("resize", () => setProgress(current), { passive: true });
}

function setupWalkthroughVideo() {
  document.querySelectorAll("[data-video-shell]").forEach((shell) => {
    const video = shell.querySelector("[data-walkthrough-video]");
    const playButton = shell.querySelector("[data-video-play]");

    if (!(video instanceof HTMLVideoElement) || !(playButton instanceof HTMLButtonElement)) {
      return;
    }

    playButton.addEventListener("click", async () => {
      shell.classList.add("is-playing");
      video.setAttribute("controls", "");

      try {
        await video.play();
      } catch {
        shell.classList.remove("is-playing");
        video.removeAttribute("controls");
      }
    });

    video.addEventListener("ended", () => {
      shell.classList.remove("is-playing");
      video.removeAttribute("controls");
    });
  });
}

function syncHeader() {
  header.classList.toggle("scrolled", getPageScrollTop() > 16);
}

function closeNav() {
  document.body.classList.remove("nav-open");
  header.classList.remove("nav-active");
  nav.classList.remove("open");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Открыть меню");
}

function targetFromHash(hash) {
  if (!hash || hash === "#") return null;
  if (hash === "#top") return document.getElementById("top");

  try {
    return document.getElementById(decodeURIComponent(hash.slice(1)));
  } catch {
    return document.getElementById(hash.slice(1));
  }
}

function scrollToTarget(target, hash, behavior = "smooth") {
  const headerOffset = Math.round(header.getBoundingClientRect().height);
  const scrollRoot = getScrollRoot();
  const rootTop = scrollRoot === document.scrollingElement ? 0 : scrollRoot.getBoundingClientRect().top;
  const targetTop = target === document.getElementById("top")
    ? 0
    : Math.max(0, Math.round(scrollRoot.scrollTop + target.getBoundingClientRect().top - rootTop - headerOffset));

  scrollRoot.scrollTo({ top: targetTop, behavior });

  if (hash && window.location.hash !== hash) {
    history.pushState(null, "", hash);
  }
}

function scrollAfterNavClose(callback) {
  requestAnimationFrame(() => {
    requestAnimationFrame(callback);
  });
}

syncHeader();
setupPanelMotion();
setupWalkthroughVideo();
getScrollRoot().addEventListener("scroll", syncHeader, { passive: true });

toggle.addEventListener("click", () => {
  const open = nav.classList.toggle("open");
  document.body.classList.toggle("nav-open", open);
  header.classList.toggle("nav-active", open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", open ? "Закрыть меню" : "Открыть меню");
});

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;

  const anchor = event.target.closest('a[href^="#"]');
  if (!anchor) return;

  const target = targetFromHash(anchor.hash);
  if (!target) return;

  event.preventDefault();
  closeNav();

  scrollAfterNavClose(() => {
    scrollToTarget(target, anchor.hash);
  });
});

window.addEventListener("load", () => {
  if (!window.location.hash) return;

  const target = targetFromHash(window.location.hash);
  if (!target) return;

  requestAnimationFrame(() => {
    scrollToTarget(target, window.location.hash, "auto");
  });
});

navBackdrop.addEventListener("click", closeNav);
navClose.addEventListener("click", closeNav);
