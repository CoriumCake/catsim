/* CatSim — entry point. */
import './style.css';
import { App, Audio } from './app.js';
import { DEFS } from './components.js';

// Debug/test handle (exposes nothing that isn't already in the page).
(window as unknown as { CatSim: unknown }).CatSim = { App, DEFS, Audio };
App.init();
