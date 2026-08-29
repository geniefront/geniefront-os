import React from 'react';
import ReactDOM from 'react-dom/client';
import { LanguageProvider } from './context/LanguageContext';
import { DeviceAuthProvider } from './context/DeviceAuthContext';
import { App } from './App';
import './index.css';

if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <LanguageProvider>
        <DeviceAuthProvider>
          <App />
        </DeviceAuthProvider>
      </LanguageProvider>
    </React.StrictMode>,
  );
}
