import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './styles/setup.css';
import './styles/discussion.css';
import './styles/report.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
