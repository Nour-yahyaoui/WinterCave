import './styles/app.css';
import { engineLabel, loadRustEngine } from './core/engine';
import { App } from './ui/app';

const host = document.querySelector<HTMLElement>('#app');
if (!host) throw new Error('WinterCave: #app container is missing');

// The engine is Rust compiled to WebAssembly once `npm run wasm:build` has run;
// otherwise the shell keeps working on the TypeScript reference core.
await loadRustEngine({ onError: (error) => console.info('WinterCave: TypeScript core —', error) });
console.info(`WinterCave: editor engine — ${engineLabel()}`);

new App(host);
