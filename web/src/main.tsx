import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Buffer } from 'buffer';
import { App } from './App';
import './styles/fonts.css';
import './styles/globals.css';

// @solana/web3.js and the wallet adapters reach for a global `Buffer` in a few
// places. Vite does not polyfill Node globals, so it is provided once here
// from the same package web3.js itself depends on.
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
