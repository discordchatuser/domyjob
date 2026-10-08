import React, { useState } from 'react';

export function QuestionCard({ request, draft, onChange, onSubmit }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const values = draft || {};
  const complete = request.questions.every(question => values[question.id]?.trim());
  async function submit(event) {
    event.preventDefault();
    if (sending || !complete) return;
    setSending(true); setError('');
    try {
      await onSubmit(Object.fromEntries(request.questions.map(question => [question.id, { answers: [values[question.id].trim()] }])));
    } catch (error) { setError(error.message); setSending(false); }
  }
  return <form className="question-card" onSubmit={submit} onKeyDown={event => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (complete && !sending) event.currentTarget.requestSubmit(); }
  }}>
    <h3>◆ Input required</h3>
    {request.questions.map(question => {
      const chosenOption = question.options?.some(option => option.label === values[question.id]);
      return <fieldset key={question.id} disabled={sending}>
        <legend>{question.question}</legend>
        {(question.options || []).map((option, index) => <label className="question-option" key={index}>
          <input type="radio" name={`${request.requestId}-${question.id}`} value={option.label} checked={values[question.id] === option.label} onChange={() => onChange(question.id, option.label)} />
          <span><strong>{option.label}</strong><small>{option.description || ''}</small></span>
        </label>)}
        <input type={question.isSecret ? 'password' : 'text'} aria-label={`${question.question} — custom answer`} placeholder={question.options?.length ? 'Or write your own answer…' : 'Your answer…'} value={chosenOption ? '' : values[question.id] || ''} onChange={event => onChange(question.id, event.target.value)} />
      </fieldset>;
    })}
    <div className="question-error" role="alert">{error}</div>
    <button type="submit" disabled={sending || !complete}>{sending ? 'Sending…' : 'Send answers'}</button>
    <p className="question-hint">↑ ↓ choose · Tab next question · Enter send</p>
  </form>;
}

export function AnsweredQuestionCard({ request }) {
  return <section className="question-card answered-question">
    <h3>✓ Answers sent</h3>
    {request.questions.map(question => {
      const answer = request.answers[question.id].answers.join(', ');
      const option = question.options?.find(option => option.label === answer);
      return <div className="question-answer" key={question.id}><p>{question.question}</p><strong>{answer}</strong>{option?.description && <small>{option.description}</small>}</div>;
    })}
  </section>;
}
