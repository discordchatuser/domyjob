// Keep choices outside the DOM so stream updates and thread switches preserve them.
const drafts = new Map();
export function questionCard(request, submit) {
  let state = drafts.get(request.requestId);
  if (!state) { state = { values: Object.create(null), sending: false }; drafts.set(request.requestId, state); }
  const form = document.createElement('form'); form.className = 'question-card';
  const title = document.createElement('h3'); title.textContent = '◆ Input required'; form.append(title);
  const controls = [];
  for (const question of request.questions) {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend'); legend.textContent = question.question; fieldset.append(legend);
    for (const option of question.options || []) {
      const label = document.createElement('label'); label.className = 'question-option';
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = question.id; radio.id = request.requestId + '-' + question.id + '-' + (question.options || []).indexOf(option); radio.value = option.label;
      radio.checked = state.values[question.id] === option.label;
      radio.onchange = () => { state.values[question.id] = option.label; update(); };
      const text = document.createElement('span'); const strong = document.createElement('strong'); strong.textContent = option.label;
      const description = document.createElement('small'); description.textContent = option.description || '';
      text.append(strong, description); label.append(radio, text); fieldset.append(label); controls.push(radio);
    }
    const custom = document.createElement('input'); custom.type = question.isSecret ? 'password' : 'text';
    custom.id = request.requestId + '-' + question.id + '-custom';
    custom.placeholder = question.options?.length ? 'Or write your own answer…' : 'Your answer…';
    custom.setAttribute('aria-label', question.question + ' — custom answer');
    custom.value = state.values[question.id] && !question.options?.some(o => o.label === state.values[question.id]) ? state.values[question.id] : '';
    custom.oninput = () => {
      state.values[question.id] = custom.value;
      fieldset.querySelectorAll('input[type=radio]').forEach(radio => { radio.checked = false; }); update();
    };
    fieldset.append(custom); controls.push(custom); form.append(fieldset);
  }
  const feedback = document.createElement('div'); feedback.className = 'question-error'; feedback.setAttribute('role', 'alert');
  const button = document.createElement('button'); button.type = 'submit';
  function update() {
    button.textContent = state.sending ? 'Sending…' : 'Send answers';
    button.disabled = state.sending || !request.questions.every(q => state.values[q.id]?.trim());
    controls.forEach(control => { control.disabled = state.sending; });
  }
  form.onsubmit = async event => {
    event.preventDefault(); if (button.disabled) return;
    state.sending = true; update(); feedback.textContent = '';
    const answers = Object.fromEntries(request.questions.map(q => [q.id, { answers: [state.values[q.id].trim()] }]));
    try { await submit(answers); drafts.delete(request.requestId); }
    catch (error) { state.sending = false; feedback.textContent = error.message; update(); }
  };
  const hint = document.createElement('p'); hint.className = 'question-hint'; hint.textContent = '↑ ↓ choose · Tab next question · Enter send';
  form.onkeydown = event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); if (!button.disabled) form.requestSubmit(); }
  };
  form.append(feedback, button, hint); update(); return form;
}
