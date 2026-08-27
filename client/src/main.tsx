import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// "Ethereal Collaboration" design tokens — self-hosted Inter, only the 4
// weights the meeting-UI restyle actually specifies (Display/Headline/Title
// 600-700, Body 400, Label 500). Registers the @font-face only; nothing here
// changes the default `font-sans` the rest of the app still uses.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
// Login page restyle (Figma kxCY7H7D8ZHzGkMCBDA2Y8, node 4:8) — only the two
// weights that design specifies for the heading (SemiBold/Bold). Same
// self-hosted, @font-face-only, no-default-change posture as Inter above.
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/700.css';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
