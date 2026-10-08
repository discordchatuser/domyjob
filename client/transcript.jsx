import React, { useState } from 'react';
import { activityFromMessage, outputPreview } from './activity.js';
import { AnsweredQuestionCard } from './questions.jsx';
import { ImagePreview } from './gallery.jsx';

export function Message({ item, onOpenImage }) {
  const [open, setOpen] = useState(false);
  if (item.modelRoute) {
    const route = item.modelRoute;
    return <div className="model-change" role="status"><strong>{route.previousModel && route.previousModel !== route.model ? `${route.previousModel} → ${route.model}` : `Model: ${route.model}`}</strong>{route.source === 'jev' && <span className="model-tier">JEV{typeof route.confidence === 'number' ? ` · ${Math.round(route.confidence * 100)}% confidence` : ''}</span>}{route.tier && <span className="model-tier">{route.tier}</span>}{route.reason && <p>{route.reason}</p>}{route.warning && <p className="model-warning">{route.warning}</p>}</div>;
  }
  if (item.questionResponse) return <AnsweredQuestionCard request={item.questionResponse} />;
  const activity = activityFromMessage(item);
  if (activity) {
    const failed = (activity.exitCode != null && activity.exitCode !== 0) || activity.status === 'failed';
    let status = failed ? 'exit ' + (activity.exitCode ?? 'failed') : ['inProgress', 'running'].includes(activity.status) ? 'running' : activity.exitCode != null ? 'exit ' + activity.exitCode : activity.status || 'done';
    if (activity.durationMs != null) status += ' · ' + (activity.durationMs / 1000).toFixed(1) + 's';
    const preview = outputPreview(activity.output);
    return <>
      <details className={'activity' + (failed ? ' failed' : '')} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
        <summary><span className="activity-command" title={activity.command || activity.label}>{activity.command || activity.label}</span><span className="activity-status">{status}</span></summary>
        <pre className="activity-output">{activity.output || '(no output)'}</pre>
      </details>
      {preview.text && <pre className="activity-preview">{preview.text}{preview.more ? '\n… expand to see full output' : ''}</pre>}
    </>;
  }
  return <article className={item.role + (item.phase === 'commentary' ? ' commentary' : '')}>
    <span className="label">{{ user: '›', assistant: '•', error: '!' }[item.role]}</span>
    <div className="text">{item.text}
      {(item.commands || []).map((command, index) => <pre className="command-chip" key={index}>$ {command}</pre>)}
      {(item.images || []).map(image => <ImagePreview key={image.id} image={image} onOpen={onOpenImage} />)}
      {(item.imageErrors || []).map((error, index) => <p className="image-error" key={index}>{error}</p>)}
    </div>
  </article>;
}
