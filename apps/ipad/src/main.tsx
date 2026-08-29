import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LanguageProvider } from './context/LanguageContext';
import { DeviceAuthProvider } from './context/DeviceAuthContext';
import { App } from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <LanguageProvider>
          <DeviceAuthProvider>
            <App />
          </DeviceAuthProvider>
        </LanguageProvider>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
