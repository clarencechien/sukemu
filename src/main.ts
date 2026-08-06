import './styles/tokens.css';
import './styles/base.css';
import './styles/login.css';
import './styles/viewer.css';
import { initLogin } from './ui/login';
import { initViewer } from './ui/viewer';
import { initCapture } from './ui/capture';
import { initHistory } from './ui/history';
import { initMode } from './ui/mode';
import { initPwa } from './ui/pwa';
import { persistEdits } from './db';

initLogin();
initMode();
const viewer = initViewer(persistEdits);
initHistory(viewer);
initCapture(viewer);
initPwa();
