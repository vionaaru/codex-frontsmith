const RESEND_ENDPOINT = "https://api.resend.com/emails";
const REQUEST_WINDOW_MS = 60_000;
const REQUEST_LIMIT = 6;
const requestLog = new Map();

export async function POST(request) {
  try {
    const submission = normalizeSubmission(await readSubmission(request));
    const validation = validateSubmission(submission);

    if (!validation.ok) {
      return jsonResponse({ ok: false, error: validation.message }, 400);
    }

    if (submission.website) {
      return jsonResponse({ ok: true, skipped: true });
    }

    if (isRateLimited(request)) {
      return jsonResponse(
        { ok: false, error: "Слишком много заявок. Повторите попытку через несколько минут" },
        429
      );
    }

    const mode = (process.env.CONTACT_DELIVERY_MODE ?? "resend").toLowerCase();

    if (mode === "dry-run") {
      return jsonResponse({
        ok: true,
        id: "dry-run",
        message: "Заявка принята в тестовом режиме без отправки"
      });
    }

    if (mode === "disabled") {
      return jsonResponse(
        { ok: false, code: "contact_not_configured", error: "Отправка заявок не настроена" },
        503
      );
    }

    const config = readResendConfig();
    if (!config.ok) {
      return jsonResponse(
        { ok: false, code: "contact_not_configured", error: config.message },
        503
      );
    }

    const email = emailPayload(submission, config);
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(email)
    });

    const result = await safeJson(response);

    if (!response.ok) {
      console.error("Ошибка отправки заявки Frontsmith", {
        status: response.status,
        error: result?.message ?? result?.error ?? "Неизвестная ошибка Resend"
      });
      return jsonResponse(
        { ok: false, error: "Не удалось отправить заявку. Попробуйте позже" },
        502
      );
    }

    return jsonResponse({ ok: true, id: result?.id ?? null });
  } catch (error) {
    console.error("Ошибка обработки заявки Frontsmith", error);
    return jsonResponse({ ok: false, error: "Не удалось отправить заявку. Попробуйте позже" }, 500);
  }
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: responseHeaders()
  });
}

async function readSubmission(request) {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return await request.json();
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const formData = await request.formData();
    return Object.fromEntries(formData.entries());
  }

  return {};
}

function normalizeSubmission(input) {
  return {
    name: clean(input.name, 120),
    email: clean(input.email, 180),
    phone: clean(input.phone, 80),
    preferredContact: clean(input.preferred_contact, 40),
    projectType: clean(input.project_type, 120),
    projectLocation: clean(input.project_location, 180),
    idealTimeline: clean(input.ideal_timeline, 140),
    budgetComfort: clean(input.budget_comfort, 140),
    projectNotes: clean(input.project_notes, 1800),
    website: clean(input.website, 220)
  };
}

function validateSubmission(submission) {
  if (!submission.email && !submission.phone) {
    return { ok: false, message: "Укажите электронную почту или телефон, чтобы мы могли ответить" };
  }

  if (submission.email && !isEmail(submission.email)) {
    return { ok: false, message: "Укажите корректный адрес электронной почты" };
  }

  return { ok: true };
}

function readResendConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.CONTACT_TO_EMAIL;
  const fromEmail = process.env.CONTACT_FROM_EMAIL;

  if (!apiKey || !toEmail || !fromEmail) {
    return {
      ok: false,
      message: "Отправка заявок не настроена"
    };
  }

  return {
    ok: true,
    apiKey,
    toEmail,
    fromEmail,
    subjectPrefix: process.env.CONTACT_SUBJECT_PREFIX ?? "Заявка на проект с сайта",
    tenantId: process.env.FRONTSMITH_TENANT_ID ?? "frontsmith"
  };
}

function emailPayload(submission, config) {
  const subjectName = submission.name || displayOption(submission.projectType) || "Посетитель сайта";
  const subject = `${config.subjectPrefix}: ${subjectName}`;
  const text = emailText(submission);
  const html = emailHtml(submission);

  return {
    from: config.fromEmail,
    to: [config.toEmail],
    reply_to: submission.email ? [submission.email] : undefined,
    subject,
    text,
    html,
    tags: [
      { name: "source", value: "frontsmith_contact" },
      { name: "tenant_id", value: safeTag(config.tenantId) }
    ]
  };
}

function emailText(submission) {
  return [
    "Новая заявка на проект с сайта",
    "",
    line("Имя", submission.name),
    line("Электронная почта", submission.email),
    line("Телефон", submission.phone),
    line("Предпочтительный способ связи", displayOption(submission.preferredContact)),
    line("Тип проекта", displayOption(submission.projectType)),
    line("Адрес объекта", submission.projectLocation),
    line("Желаемые сроки", submission.idealTimeline),
    line("Бюджет", submission.budgetComfort),
    "",
    "Описание проекта",
    submission.projectNotes || "Не указано"
  ]
    .filter((item) => item !== null)
    .join("\n");
}

function emailHtml(submission) {
  const rows = [
    ["Имя", submission.name],
    ["Электронная почта", submission.email],
    ["Телефон", submission.phone],
    ["Предпочтительный способ связи", displayOption(submission.preferredContact)],
    ["Тип проекта", displayOption(submission.projectType)],
    ["Адрес объекта", submission.projectLocation],
    ["Желаемые сроки", submission.idealTimeline],
    ["Бюджет", submission.budgetComfort]
  ]
    .filter(([, value]) => value)
    .map(
      ([label, value]) =>
        `<tr><td style="padding:8px 12px;color:#6b6d66">${escapeHtml(label)}</td><td style="padding:8px 12px;color:#292a25">${escapeHtml(value)}</td></tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="ru">
  <body style="margin:0;padding:24px;background:#f7f6f0;font-family:Arial,sans-serif;color:#292a25">
    <div style="max-width:640px;margin:0 auto;background:#fffefa;border:1px solid #dcddd4;border-radius:8px;padding:24px">
      <h1 style="font-size:24px;line-height:1.2;margin:0 0 18px">Новая заявка на проект с сайта</h1>
      <table style="width:100%;border-collapse:collapse;margin:0 0 20px">${rows}</table>
      <h2 style="font-size:16px;line-height:1.3;margin:0 0 8px">Описание проекта</h2>
      <p style="white-space:pre-wrap;line-height:1.55;margin:0;color:#4f534d">${escapeHtml(submission.projectNotes || "Не указано")}</p>
    </div>
  </body>
</html>`;
}

function line(label, value) {
  return value ? `${label}: ${value}` : null;
}

function displayOption(value) {
  return {
    Email: "Электронная почта",
    Phone: "Телефон",
    "Kitchen remodeling": "Ремонт кухни",
    "Bathroom remodeling": "Ремонт ванной",
    "Living spaces": "Жилые помещения",
    Other: "Другое"
  }[value] || value;
}

function clean(value, maxLength) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isRateLimited(request) {
  const ip = requestIp(request);
  const now = Date.now();
  const recent = (requestLog.get(ip) ?? []).filter((time) => now - time < REQUEST_WINDOW_MS);

  recent.push(now);
  requestLog.set(ip, recent);

  for (const [key, times] of requestLog.entries()) {
    const active = times.filter((time) => now - time < REQUEST_WINDOW_MS);
    if (active.length) {
      requestLog.set(key, active);
    } else {
      requestLog.delete(key);
    }
  }

  return recent.length > REQUEST_LIMIT;
}

function requestIp(request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local"
  );
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function jsonResponse(body, status = 200) {
  return Response.json(body, {
    status,
    headers: responseHeaders()
  });
}

function responseHeaders() {
  return {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store"
  };
}

function safeTag(value) {
  const tag = String(value)
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 256);
  return tag || "frontsmith";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
