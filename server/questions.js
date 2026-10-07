export const askUserTool = {
  type: 'function', name: 'ask_user',
  description: 'Ask the user to choose options or supply details. Waits for their answer in the chat UI.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['questions'],
    properties: { questions: { type: 'array', minItems: 1, maxItems: 3, items: {
      type: 'object', additionalProperties: false, required: ['id', 'header', 'question', 'options'],
      properties: {
        id: { type: 'string' }, header: { type: 'string' }, question: { type: 'string' },
        options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'description'], properties: { label: { type: 'string' }, description: { type: 'string' } } } },
      },
    } } },
  },
};
export function validateQuestions(questions) {
  return Array.isArray(questions) && questions.length > 0 && questions.length <= 3 &&
    questions.every(q => q && typeof q === 'object' && typeof q.id === 'string' && q.id && typeof q.question === 'string' &&
      (q.options == null || (Array.isArray(q.options) && q.options.every(o => o && typeof o.label === 'string' && o.label)))) &&
    new Set(questions.map(q => q.id)).size === questions.length;
}
export function validateAnswers(questions, answers) {
  return answers && typeof answers === 'object' && !Array.isArray(answers) &&
    Object.keys(answers).length === questions.length && questions.every(q =>
      Object.hasOwn(answers, q.id) && Array.isArray(answers[q.id]?.answers) &&
      answers[q.id].answers.length === 1 && typeof answers[q.id].answers[0] === 'string' &&
      answers[q.id].answers[0].trim() && answers[q.id].answers[0].length <= 10000);
}
