export const emptyDraft = () => ({ text: '', commands: [], commandMode: false });

export function applyStreamEvent(chat, event) {
  if (event.type === 'model.routing') return { ...chat, routing: true };
  if (event.type === 'model.changed') return { ...chat, routing: false, model: event.route.model, modelRoute: event.route, messages: event.message ? [...chat.messages, event.message] : chat.messages };
  if (event.type === 'chat' || event.type === 'done') return { ...event.chat, stream: event.type === 'done' ? {} : chat.stream || {} };
  if (event.type === 'questions') return { ...chat, pendingQuestions: [...(chat.pendingQuestions || []).filter(request => request.requestId !== event.request.requestId), event.request] };
  if (event.type === 'questions.resolved') return { ...chat, pendingQuestions: (chat.pendingQuestions || []).filter(request => request.requestId !== event.requestId) };
  const stream = { ...chat.stream };
  if (event.type === 'command') stream['command:' + event.id] = { role: 'tool', ...event, status: event.status || (event.exitCode == null ? 'running' : 'completed') };
  if (event.type === 'activity') stream['activity:' + event.item.id] = { role: 'activity', ...event.item };
  if (event.type === 'message') stream[event.id] = { id: event.id, role: 'assistant', text: event.text, phase: event.phase };
  if (event.type === 'image') {
    const images = chat.images || [];
    stream['image:' + event.image.id] = { role: 'assistant', text: '', images: [event.image] };
    return { ...chat, images: images.some(image => image.id === event.image.id) ? images : [...images, event.image], stream };
  }
  return { ...chat, stream };
}

export function recordAnswer(chat, requestId, message) {
  return {
    ...chat,
    pendingQuestions: (chat.pendingQuestions || []).filter(request => request.requestId !== requestId),
    messages: message && !chat.messages.some(item => item.questionResponse?.requestId === requestId) ? [...chat.messages, message] : chat.messages,
  };
}
