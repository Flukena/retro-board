import React from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/theme.js';
import { Maintainer } from './Maintainer.jsx';
import './maintainer.css';

createRoot(document.getElementById('root')).render(<Maintainer />);
