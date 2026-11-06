// The same artificial HTML cases are checked by the contract and by a real browser.
const email = (extra = "") => `<input name="email" type="email" data-contact-email value="fixture@example.com" ${extra}>`;
const phone = (extra = "") => `<input name="phone" type="tel" data-contact-phone value="+79990000000" ${extra}>`;
const form = (body) => `<form id="intake" data-intake-form>${body}</form>`;
const both = { email: "fixture@example.com", phone: "+79990000000" };

export const contactFormCases = [
  { name: "email and tel", html: form(email() + phone()), accepted: true, payload: both },
  { name: "text defaults", html: form('<input name="email" data-contact-email value="fixture@example.com"><input name="phone" type="text" data-contact-phone value="+79990000000">'), accepted: true, payload: both },
  { name: "disabled fieldset", html: form(`<fieldset disabled>${email()}${phone()}</fieldset>`), accepted: false, payload: {} },
  { name: "outer disabled fieldset", html: form(`<fieldset disabled><fieldset>${email()}${phone()}</fieldset></fieldset>`), accepted: false, payload: {} },
  { name: "first legend exemption", html: form(`<fieldset disabled><legend>${email()}${phone()}</legend></fieldset>`), accepted: true, payload: both },
  { name: "second legend remains disabled", html: form(`<fieldset disabled><legend>First</legend><legend>${email()}${phone()}</legend></fieldset>`), accepted: false, payload: {} },
  { name: "nested disabled fieldset inside exempt legend", html: form(`<fieldset disabled><legend><fieldset disabled>${email()}${phone()}</fieldset></legend></fieldset>`), accepted: false, payload: {} },
  { name: "email checkbox unchecked", html: form(email().replace('type="email"', 'type="checkbox"') + phone()), accepted: false, payload: { phone: both.phone } },
  { name: "phone checkbox checked", html: form(email() + phone("checked").replace('type="tel"', 'type="checkbox"')), accepted: false, payload: both },
  { name: "email radio unchecked", html: form(email().replace('type="email"', 'type="radio"') + phone()), accepted: false, payload: { phone: both.phone } },
  { name: "phone hidden", html: form(email() + phone().replace('type="tel"', 'type="hidden"')), accepted: false, payload: both },
  { name: "email disabled individually", html: form(email("disabled") + phone()), accepted: false, payload: { phone: both.phone } },
  { name: "phone in disabled fieldset", html: form(email() + `<fieldset disabled>${phone()}</fieldset>`), accepted: false, payload: { email: both.email } },
  { name: "external associated fields", html: form("") + email('form="intake"') + phone('form="intake"'), accepted: true, payload: both }
];
