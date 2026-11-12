// First: Zod's settings must apply before any schema is built.
import './zodConfig';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { ThemeProvider } from './contexts/ThemeContext';
import { NuggetsTheme } from './theme';
import { AuthProvider } from './contexts/AuthContext';
import { queryClient } from './queries/queryClient';
import { registerServiceWorker } from './utils/serviceWorker';
import App from './App';
import './index.css';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

// Only use StrictMode in development to avoid double-rendering in production
const AppComponent = (
  <ThemeProvider>
    <NuggetsTheme>
      <BrowserRouter>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <App />
            <Toaster
              position="top-right"
              toastOptions={{
                duration: 4000,
                style: {
                  background: 'var(--gray-12)',
                  color: 'var(--gray-1)',
                  border: '1px solid var(--gray-a6)',
                },
                success: {
                  duration: 3000,
                },
              }}
            />
          </AuthProvider>
        </QueryClientProvider>
      </BrowserRouter>
    </NuggetsTheme>
  </ThemeProvider>
);

root.render(
  process.env.NODE_ENV === 'development' ? (
    <React.StrictMode>
      {AppComponent}
    </React.StrictMode>
  ) : (
    AppComponent
  )
);

registerServiceWorker();
