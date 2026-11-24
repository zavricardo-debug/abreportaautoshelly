// Form validation that never blocks silently.
//
// Browsers refuse to submit a form while any control fails its constraints (required, min/max, step, pattern) – and when
// that control is not visible (a hidden input of the other price mode) they do it WITHOUT any message ("An invalid form
// control is not focusable"), so the "Comparar" button appears dead. Both forms therefore carry `novalidate` and call
// `invalidControls()` on submit: controls that are disabled or inside a hidden container are ignored, the rest are checked
// with the browser's own constraint API and reported visibly (message box + native bubble on the first one).

/** @returns {{el: HTMLElement, label: string, message: string}[]} visible, enabled controls that fail their constraints */
export function invalidControls(form) {
  const out = [];
  for (const el of form.querySelectorAll('input, select, textarea')) {
    if (el.disabled || el.type === 'hidden' || el.closest('.hidden') || !el.willValidate) continue;
    if (el.checkValidity()) continue;
    out.push({ el, label: labelOf(el), message: el.validationMessage || '' });
  }
  return out;
}

/** Text of the <label> wrapping the control (first line, without the control's own value). */
export function labelOf(el) {
  const lab = el.closest('label') || (el.id && el.ownerDocument.querySelector(`label[for="${el.id}"]`));
  const text = (lab ? lab.textContent : '').replace(/\s+/g, ' ').trim();
  return text.split(/\s{2,}|\n/)[0].slice(0, 60) || el.name || el.id || 'campo';
}

/**
 * Validate `form`; when something is wrong, write the message into `box` (an element) and focus the first offending
 * control. @returns true when the form can be submitted.
 */
export function validateForm(form, box, lang = 'pt') {
  const bad = invalidControls(form);
  if (box) { box.classList.toggle('hidden', !bad.length); box.textContent = ''; }
  if (!bad.length) return true;
  const head = lang === 'es' ? 'No se puede comparar todavía – revise: ' : 'Ainda não é possível comparar – verifique: ';
  if (box) {
    box.textContent = head + bad.map((b) => `«${b.label}»${b.message ? ' (' + b.message + ')' : ''}`).join('; ') + '.';
  }
  try { bad[0].el.focus({ preventScroll: false }); bad[0].el.reportValidity?.(); } catch { /* jsdom */ }
  return false;
}
