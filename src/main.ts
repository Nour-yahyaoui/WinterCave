import './styles/app.css';
import { App } from './ui/app';

const host = document.querySelector<HTMLElement>('#app');
if (!host) throw new Error('WinterCave: #app container is missing');

new App(host);
