import React from 'react';
import { t, useLang } from '../ui/i18n.js';
import { Button, Surface } from '../ui/UiPrimitives.jsx';
import '../session/client-resilience.css';

function RecoveryScreen() {
  useLang();
  return (
    <main className="rb-recovery">
      <Surface role="alert" className="rb-recovery__panel">
        <h1>{t('resilience.error.title')}</h1>
        <p>{t('resilience.error.body')}</p>
        <Button onClick={() => window.location.reload()}>{t('resilience.reload')}</Button>
      </Surface>
    </main>
  );
}

export class BoardErrorBoundary extends React.Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <RecoveryScreen /> : this.props.children;
  }
}
