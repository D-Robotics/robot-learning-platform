import { startExperimentView } from './experiment-view.mjs';
const ready = () => { void startExperimentView({ document, location: window.location }); };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
else ready();
